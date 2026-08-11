/**
 * Cohort claim-ownership loss signal (issue #30, PR3 hardening).
 *
 * `HeartbeatLostError` is thrown when a heartbeat attempt returns false: a
 * reclaiming sibling worker owns the cohort run now (or it went
 * terminal/superseded). The caller aborts the member/cohort deterministically
 * and initiates NO further side effects after the loss.
 *
 * Defined in a classification module (not `src/onboarding/cohort-curator.ts`)
 * so the shared LLM ranker seam (`src/classification/curation-target-ranker.ts`)
 * can rethrow ownership-loss exceptions WITHOUT importing the onboarding
 * module that imports the ranker — a clean, cycle-free import graph:
 * `cohort-curator.ts` imports the class here and re-exports it for existing
 * callers/tests.
 */
export class HeartbeatLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeartbeatLostError';
  }
}
