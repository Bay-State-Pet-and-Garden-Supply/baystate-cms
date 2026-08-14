/**
 * Store Manager scheduler (operations console, Issue 4).
 *
 * ONE sequential dispatcher: it claims due occurrences one at a time and
 * dispatches each through the schedule service (which enters the common
 * runtime runner). Restart safety is provided by the unique occurrence key
 * (the DB constraint is the backstop) and atomic claims. A poller with an
 * injected clock, bounded catch-up window, and graceful stop. The kill switch
 * and `schedulesEnabled` flag dominate: when either disables automation, the
 * tick returns without taking claims.
 */

import {
  listDueOccurrences,
  claimOccurrence,
  expireStaleLeases,
  cancelOverdueOccurrences,
} from '../../db/repositories/store-manager-schedule-repo';
import {
  dispatchOccurrence,
  type ScheduleDispatchDeps,
} from './store-manager-schedule-service';
import { getStoreManagerFlags, type StoreManagerFlags } from '../../store-manager/flags';

export interface StoreManagerSchedulerOptions {
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Poll interval (default 60s). */
  pollIntervalMs?: number;
  /** Max catch-up window for missed occurrences (default 24h). */
  catchUpWindowMs?: number;
  /** Lease duration per claim (default 10min). */
  leaseMs?: number;
  /** Max retries before an occurrence is terminal-failed (default 3). */
  maxRetries?: number;
  /** Dispatch deps passed through to the schedule service (runtime seams). */
  dispatchDeps?: ScheduleDispatchDeps;
  /** Injectable flag getter (tests). Defaults to getStoreManagerFlags(). */
  flags?: () => StoreManagerFlags;
  /** Injectable per-occurrence dispatch (tests). Defaults to dispatchOccurrence. */
  dispatch?: typeof dispatchOccurrence;
  /** Logger (defaults to console). */
  log?: Pick<Console, 'error' | 'warn' | 'log'>;
}

export interface StoreManagerScheduler {
  start(): void;
  stop(): void;
  /** Run one dispatch pass synchronously; returns count of occurrences dispatched. */
  tick(): Promise<number>;
  get running(): boolean;
}

export function createStoreManagerScheduler(
  opts: StoreManagerSchedulerOptions = {},
): StoreManagerScheduler {
  const now = opts.now ?? (() => new Date());
  const pollIntervalMs = opts.pollIntervalMs ?? 60_000;
  const catchUpWindowMs = opts.catchUpWindowMs ?? 24 * 60 * 60 * 1000;
  const leaseMs = opts.leaseMs ?? 10 * 60 * 1000;
  const maxRetries = opts.maxRetries ?? 3;
  const flags = opts.flags ?? getStoreManagerFlags;
  const dispatch = opts.dispatch ?? dispatchOccurrence;
  const log = opts.log ?? console;
  const dispatchDeps: ScheduleDispatchDeps = {
    ...(opts.dispatchDeps ?? {}),
    now,
    leaseMs,
    maxRetries,
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let inFlight = false;

  async function tickOnce(): Promise<number> {
    if (inFlight) return 0; // one writer
    inFlight = true;
    let dispatched = 0;
    try {
      const f = flags();
      if (f.killSwitch || !f.schedulesEnabled) return 0;

      // Crash recovery: expired leases return to pending; occurrences older
      // than the catch-up window are cancelled (visible, never silent).
      const workspaceIds = workspaceIdsToProcess();
      for (const workspaceId of workspaceIds) {
        expireStaleLeases(workspaceId, now().toISOString());
        cancelOverdueOccurrences(
          workspaceId,
          new Date(now().getTime() - catchUpWindowMs).toISOString(),
        );
      }

      for (const workspaceId of workspaceIds) {
        const due = listDueOccurrences(workspaceId, now().toISOString(), { limit: 20 });
        for (const occurrence of due) {
          const claimed = claimOccurrence(workspaceId, occurrence.id, 'scheduler', leaseMs, now().toISOString());
          if (!claimed) continue; // another process/worker claimed it
          try {
            await dispatch(workspaceId, occurrence.id, dispatchDeps);
          } catch (err) {
            log.error(`[StoreManagerScheduler] occurrence ${occurrence.id} dispatch failed:`, err);
            // If dispatch itself threw outside its internal error handling,
            // leave the claim expired so a later tick retries it.
          }
          dispatched += 1;
        }
      }
      return dispatched;
    } finally {
      inFlight = false;
    }
  }

  /**
   * Workspaces are a single-row table in this local app. Derive them from the
   * DB (findWorkspace) rather than trusting a module global so reset/re-init
   * test suites behave. An absent workspace means nothing to schedule.
   */
  function workspaceIdsToProcess(): string[] {
    try {
      const { findWorkspace } = require('../../db/repositories/workspace-repo') as typeof import('../../db/repositories/workspace-repo');
      const ws = findWorkspace();
      return ws ? [ws.id] : [];
    } catch {
      return [];
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      // Immediate first tick (non-blocking), then poll on the interval.
      void tickOnce().catch((err) => log.error('[StoreManagerScheduler] initial tick failed:', err));
      timer = setInterval(() => {
        void tickOnce().catch((err) => log.error('[StoreManagerScheduler] tick failed:', err));
      }, pollIntervalMs);
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    async tick() {
      return tickOnce();
    },
    get running() {
      return running;
    },
  };
}
