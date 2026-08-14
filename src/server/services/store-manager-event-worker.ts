/**
 * Store Manager event-trigger worker (operations console, Issue 5).
 *
 * ONE sequential poller per process (mirrors the schedule scheduler): it
 * observes committed durable sources for every enabled trigger, inserts
 * idempotent occurrences + advances source cursors, then claims and
 * dispatches due occurrences one at a time through the trigger service (which
 * enters the common runtime runner). Restart safety is provided by unique
 * occurrence keys (the DB constraint is the backstop) and atomic claims.
 *
 * The kill switch and `eventTriggersEnabled` flag dominate: when either
 * disables automation, the tick returns without observing or dispatching.
 * Store Manager's own Inbox/report/artifact rows are NEVER trigger sources —
 * no self-trigger loop is possible by construction.
 */

import {
  listEnabledTriggers,
  listDueTriggerOccurrences,
  claimTriggerOccurrence,
  expireStaleTriggerLeases,
  cancelOverdueTriggerOccurrences,
} from '../../db/repositories/store-manager-trigger-repo';
import {
  observeTrigger,
  dispatchTriggerOccurrence,
  type TriggerDispatchDeps,
} from './store-manager-trigger-service';
import { getStoreManagerFlags, type StoreManagerFlags } from '../../store-manager/flags';

export interface StoreManagerEventWorkerOptions {
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
  /** Dispatch deps passed through to the trigger service (runtime seams). */
  dispatchDeps?: TriggerDispatchDeps;
  /** Injectable flag getter (tests). Defaults to getStoreManagerFlags(). */
  flags?: () => StoreManagerFlags;
  /** Injectable per-occurrence dispatch (tests). Defaults to dispatchTriggerOccurrence. */
  dispatch?: typeof dispatchTriggerOccurrence;
  /** Logger (defaults to console). */
  log?: Pick<Console, 'error' | 'warn' | 'log'>;
}

export interface StoreManagerEventWorker {
  start(): void;
  stop(): void;
  /** Run one observation+dispatch pass synchronously; returns occurrences dispatched. */
  tick(): Promise<number>;
  get running(): boolean;
}

export function createStoreManagerEventWorker(
  opts: StoreManagerEventWorkerOptions = {},
): StoreManagerEventWorker {
  const now = opts.now ?? (() => new Date());
  const pollIntervalMs = opts.pollIntervalMs ?? 60_000;
  const catchUpWindowMs = opts.catchUpWindowMs ?? 24 * 60 * 60 * 1000;
  const leaseMs = opts.leaseMs ?? 10 * 60 * 1000;
  const maxRetries = opts.maxRetries ?? 3;
  const flags = opts.flags ?? getStoreManagerFlags;
  const dispatch = opts.dispatch ?? dispatchTriggerOccurrence;
  const log = opts.log ?? console;
  const dispatchDeps: TriggerDispatchDeps = {
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
      if (f.killSwitch || !f.eventTriggersEnabled) return 0;

      const workspaceIds = workspaceIdsToProcess();
      for (const workspaceId of workspaceIds) {
        expireStaleTriggerLeases(workspaceId, now().toISOString());
        cancelOverdueTriggerOccurrences(
          workspaceId,
          new Date(now().getTime() - catchUpWindowMs).toISOString(),
        );
      }

      for (const workspaceId of workspaceIds) {
        // Observation pass: scan enabled triggers against committed state.
        const enabled = listEnabledTriggers(workspaceId);
        for (const trigger of enabled) {
          try {
            observeTrigger(workspaceId, trigger, { now });
          } catch (err) {
            log.error(`[StoreManagerEventWorker] trigger ${trigger.id} observation failed:`, err);
          }
        }
        // Dispatch pass: claim + dispatch due occurrences.
        const due = listDueTriggerOccurrences(workspaceId, now().toISOString(), { limit: 20 });
        for (const occurrence of due) {
          const claimed = claimTriggerOccurrence(workspaceId, occurrence.id, 'event-worker', leaseMs, now().toISOString());
          if (!claimed) continue; // another process/worker claimed it
          try {
            await dispatch(workspaceId, occurrence.id, dispatchDeps);
          } catch (err) {
            log.error(`[StoreManagerEventWorker] occurrence ${occurrence.id} dispatch failed:`, err);
            // Dispatch threw outside its internal handling: leave the claim to
            // expire so a later tick retries it.
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
   * test suites behave. An absent workspace means nothing to observe.
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
      void tickOnce().catch((err) => log.error('[StoreManagerEventWorker] initial tick failed:', err));
      timer = setInterval(() => {
        void tickOnce().catch((err) => log.error('[StoreManagerEventWorker] tick failed:', err));
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
