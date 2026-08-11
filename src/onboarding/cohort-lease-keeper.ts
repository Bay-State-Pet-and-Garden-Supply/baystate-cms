/**
 * Scoped ownership-guarded lease keeper (issue #30, PR3 hardening Commit A2).
 *
 * Shared by every long-awaited cohort operation: the freeze member's OCR
 * pull-forward, the freeze product-type ranker, the cohort member's execution
 * pipeline, and the PR6 parent title op (`ensureCohortTitlesCoordinated`).
 * Defined in its OWN module (not `cohort-curator.ts`) so the PR6 title
 * coordinator can use it WITHOUT a runtime circular import (cohort-curator
 * imports the coordinator, so the coordinator must not import back).
 *
 * While the wrapped operation is in flight the keeper renews the parent
 * cohort run's lease via `heartbeatCohortRun` on a TTL/3 cadence, so a
 * live-but-slow owner can no longer silently outlive the lease and be
 * legitimately reclaimed mid-call. A renewal that returns false means the run
 * is no longer ours (a sibling worker reclaimed it, or it went
 * terminal/superseded): the keeper marks `lost`, and the operation's
 * continuation calls `assertHeld()` before EVERY subsequent write —
 * `assertHeld()` performs an immediate ownership re-assertion (so a loss
 * between renewal ticks is still caught) and throws `HeartbeatLostError` when
 * the claim is gone, aborting with NO further side effects. `stop()` (called
 * in `finally`) clears the renewal timer.
 */
import { heartbeatCohortRun } from '../db/repositories/classification-cohort-run-repo';
import { HeartbeatLostError } from '../classification/heartbeat-errors';

export class CohortLeaseKeeper {
  private readonly runId: string;
  private readonly workerId: string;
  private readonly leaseTtlMs: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lost = false;

  constructor(runId: string, workerId: string, leaseTtlMs: number) {
    this.runId = runId;
    this.workerId = workerId;
    this.leaseTtlMs = leaseTtlMs;
    this.intervalMs = Math.max(1, Math.floor(leaseTtlMs / 3));
  }

  /** Start the periodic renewal; the wrapped operation always begins with a
   *  freshly asserted lease. Idempotent. PR3 hardening C: the INITIAL renewal
   *  runs BEFORE the timer is installed and a rejected renewal throws
   *  `HeartbeatLostError` IMMEDIATELY — callers must never begin OCR/pipeline
   *  side effects after ownership is already known lost. */
  start(): this {
    if (this.timer) return this;
    // Renew BEFORE installing the timer: if the run is no longer claimed by
    // us (a sibling reclaimed it, or it went terminal/superseded), ownership
    // is already lost — throw before any side effect begins.
    if (!this.renew()) {
      this.lost = true;
      throw new HeartbeatLostError(
        `Claim ownership already lost at operation start (run ${this.runId} is no longer claimed by ${this.workerId}).`,
      );
    }
    this.timer = setInterval(() => {
      this.renew();
    }, this.intervalMs);
    return this;
  }

  /** Attempt one lease renewal. Marks `lost` on rejection. */
  renew(): boolean {
    if (this.stopped || this.lost) return false;
    const held = heartbeatCohortRun(this.runId, this.workerId, this.leaseTtlMs);
    if (!held) this.lost = true;
    return held;
  }

  /**
   * Ownership assertion for a continuation write. Throws `HeartbeatLostError`
   * when the lease was lost — including a loss that happened between renewal
   * ticks (this is an immediate ownership re-assertion, never a flag-only
   * check), so NO write can occur after the claim moved to another worker.
   */
  assertHeld(): void {
    if (this.lost || !this.renew()) {
      throw new HeartbeatLostError(
        `Claim ownership lost during a long-running operation (run ${this.runId} is no longer claimed by ${this.workerId}).`,
      );
    }
  }

  /** Clear the renewal timer (always called from the operation's `finally`). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
