/**
 * Imported Agent Lab result gate (ADR-0030 Phase 1 relocation).
 *
 * Moved verbatim from src/product-intelligence/onboarding-import.ts: every
 * imported origin cited in an onboarding item's productIntelligenceEvidence
 * must still verify at promotion time (run exists, result hash matches,
 * import record active) or promotion fails closed for that item.
 *
 * The gate reads ONLY durable rows through the shared repositories — no PI
 * runtime code is involved, so it survives the Phase 3 PI deletion. The
 * `benchmark_*` tables and repositories it transitively relies on stay.
 */
import { getPiImportByRunAndItem, getPiResult, getPiRun } from '../db/repositories/product-intelligence-repo';
import type { OnboardingItem } from '../shared/schemas/onboarding';

export function verifyImportedResultGate(item: OnboardingItem): { ok: true } | { ok: false; error: string } {
  const payloads = item.extractionData?.productIntelligenceEvidence;
  if (!payloads || payloads.length === 0) return { ok: true };

  // Every imported origin must still verify (fail closed): a deleted run, a
  // mismatched result hash, or a stale import record blocks promotion.
  for (const payload of payloads) {
    const run = getPiRun(payload.runId);
    if (!run) return { ok: false, error: `imported Agent Lab result ${payload.runId.slice(0, 8)}… is missing (run deleted)` };

    const result = getPiResult(payload.runId);
    if (!result || result.resultHash !== payload.resultHash) {
      return { ok: false, error: `imported Agent Lab result ${payload.runId.slice(0, 8)}… hash no longer matches the run result` };
    }

    const record = getPiImportByRunAndItem(payload.runId, item.id);
    if (!record || record.status !== 'active') {
      return { ok: false, error: `imported Agent Lab record ${payload.runId.slice(0, 8)}… is stale or missing` };
    }
  }

  return { ok: true };
}
