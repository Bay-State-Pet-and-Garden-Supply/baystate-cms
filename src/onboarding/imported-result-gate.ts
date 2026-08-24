/**
 * Imported Agent Lab result gate (ADR-0030 Phase 1 relocation).
 *
 * Moved verbatim from src/product-intelligence/onboarding-import.ts: every
 * imported origin cited in an onboarding item's productIntelligenceEvidence
 * must still verify at promotion time (run exists, result hash matches,
 * import record active) or promotion fails closed for that item.
 *
 * The gate reads ONLY durable rows via narrow inline queries — no PI runtime
 * code or repository module is involved (ADR-0030 Phase 3 deleted the PI
 * repositories; the tables themselves are retired in Phase 4). The
 * `benchmark_*` tables and repositories it transitively relies on stay.
 */
import { getDb } from '../db/connection';
import type { OnboardingItem } from '../shared/schemas/onboarding';

export function verifyImportedResultGate(item: OnboardingItem): { ok: true } | { ok: false; error: string } {
  const payloads = item.extractionData?.productIntelligenceEvidence;
  if (!payloads || payloads.length === 0) return { ok: true };

  const db = getDb();

  // Every imported origin must still verify (fail closed): a deleted run, a
  // mismatched result hash, or a stale import record blocks promotion.
  for (const payload of payloads) {
    const run = db
      .query('SELECT id FROM product_intelligence_runs WHERE id = ?')
      .get(payload.runId) as { id: string } | undefined;
    if (!run) return { ok: false, error: `imported Agent Lab result ${payload.runId.slice(0, 8)}… is missing (run deleted)` };

    const result = db
      .query('SELECT result_hash AS resultHash FROM product_intelligence_results WHERE run_id = ?')
      .get(payload.runId) as { resultHash: string } | undefined;
    if (!result || result.resultHash !== payload.resultHash) {
      return { ok: false, error: `imported Agent Lab result ${payload.runId.slice(0, 8)}… hash no longer matches the run result` };
    }

    const record = db
      .query(
        'SELECT status FROM product_intelligence_imports WHERE run_id = ? AND onboarding_item_id = ?',
      )
      .get(payload.runId, item.id) as { status: 'active' | 'superseded' | 'stale' } | undefined;
    if (!record || record.status !== 'active') {
      return { ok: false, error: `imported Agent Lab record ${payload.runId.slice(0, 8)}… is stale or missing` };
    }
  }

  return { ok: true };
}
