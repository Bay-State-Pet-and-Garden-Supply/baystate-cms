import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import {
  OnboardingItemEvidenceAcceptanceSchema,
  type OnboardingItemEvidenceAcceptance,
} from '../../shared/schemas/distributor';
import type { EvidenceAttempt } from '../../shared/schemas/distributor-evidence';
import { getEvidenceAttemptsByIdsForItem } from './onboarding-evidence-repo';

interface AcceptanceRow {
  id: string;
  item_id: string;
  evidence_attempt_id: string;
  sourcing_generation_id: string | null;
  accepted_by: string;
  accepted_at: string;
  reason: string | null;
  created_at: string;
}

function mapRow(row: AcceptanceRow): OnboardingItemEvidenceAcceptance {
  return OnboardingItemEvidenceAcceptanceSchema.parse({
    id: row.id,
    itemId: row.item_id,
    evidenceAttemptId: row.evidence_attempt_id,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at,
    reason: row.reason,
    createdAt: row.created_at,
  });
}

/**
 * Check if the distributor v2 migration has completed.
 * Once completed, relational acceptances are 100% authoritative (an empty array
 * means zero accepted evidence, NEVER falling back to legacy JSON).
 */
export function isAcceptanceMigrationCompleted(): boolean {
  const db = getDb();
  try {
    const row = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('distributor_v2_schema_version') as { value: string } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Record evidence acceptances for an onboarding item (ADR 0014 single
 * authority). Validates every attempt exists and belongs to the item before
 * insertion, then inserts with ON CONFLICT(item_id, evidence_attempt_id)
 * DO NOTHING for strict idempotency. Never updates prior rows.
 */
export function recordAcceptances(
  itemId: string,
  evidenceAttemptIds: string[],
  acceptedBy = 'system',
  reason: string | null = null,
): OnboardingItemEvidenceAcceptance[] {
  if (evidenceAttemptIds.length === 0) return [];

  const db = getDb();
  const now = new Date().toISOString();

  // Validate ownership: every attempt must exist for this item.
  const placeholders = evidenceAttemptIds.map(() => '?').join(', ');
  const found = db
    .query(`SELECT id FROM onboarding_evidence_attempts WHERE id IN (${placeholders}) AND item_id = ?`)
    .all(...evidenceAttemptIds, itemId) as Array<{ id: string }>;
  const foundSet = new Set(found.map((r) => r.id));
  for (const attemptId of evidenceAttemptIds) {
    if (!foundSet.has(attemptId)) {
      throw new Error(`Cannot accept evidence attempt ${attemptId}: not found for item ${itemId}`);
    }
  }

  // Generation scope: mirror each attempt's generation onto the acceptance row.
  const genRows = db
    .query(`SELECT id, sourcing_generation_id FROM onboarding_evidence_attempts WHERE id IN (${placeholders})`)
    .all(...evidenceAttemptIds) as Array<{ id: string; sourcing_generation_id: string | null }>;
  const generationByAttempt = new Map(genRows.map((r) => [r.id, r.sourcing_generation_id]));

  // Strict current-generation guard (ADR 0014): an accepted attempt's
  // generation must be the item's CURRENT generation. A NULL-generation
  // attempt is only acceptable when the item has NO generations at all
  // (fully legacy item); stale/superseded generations can never be accepted.
  const currentGen = db
    .query('SELECT id FROM sourcing_generations WHERE item_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(itemId) as { id: string } | undefined;
  for (const attemptId of evidenceAttemptIds) {
    const attemptGen = generationByAttempt.get(attemptId) ?? null;
    if (attemptGen !== null && attemptGen !== currentGen?.id) {
      throw new Error(
        `Cannot accept evidence attempt ${attemptId}: its generation is not the item's current generation`,
      );
    }
    if (attemptGen === null && currentGen) {
      throw new Error(
        `Cannot accept evidence attempt ${attemptId}: legacy attempt (no generation) while the item has a current generation`,
      );
    }
  }

  const stmt = db.query(
    `INSERT INTO onboarding_item_evidence_acceptances
      (id, item_id, evidence_attempt_id, sourcing_generation_id, accepted_by, accepted_at, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, evidence_attempt_id) DO NOTHING`,
  );

  db.transaction(() => {
    for (const attemptId of evidenceAttemptIds) {
      stmt.run(
        randomUUID(),
        itemId,
        attemptId,
        generationByAttempt.get(attemptId) ?? null,
        acceptedBy,
        now,
        reason,
        now,
      );
    }
  })();

  const rows = db
    .query(
      `SELECT * FROM onboarding_item_evidence_acceptances
       WHERE item_id = ? AND evidence_attempt_id IN (${placeholders})`,
    )
    .all(itemId, ...evidenceAttemptIds) as AcceptanceRow[];

  return rows.map(mapRow);
}

/**
 * List all raw acceptance records for an onboarding item.
 */
export function listAcceptancesForItem(itemId: string): OnboardingItemEvidenceAcceptance[] {
  const db = getDb();
  const rows = db
    .query('SELECT * FROM onboarding_item_evidence_acceptances WHERE item_id = ? ORDER BY created_at ASC')
    .all(itemId) as AcceptanceRow[];

  return rows.map(mapRow);
}

/**
 * Get the accepted evidence attempt IDs for an item.
 * Adheres strictly to the migration authority rule (ADR 0014):
 * - When distributor_v2_schema_version is present: normalized table is 100%
 *   authoritative (empty = 0 acceptances).
 * - Only when migration is not completed (pre-migration database): falls back
 *   to the legacy item JSON column.
 */
export function getAcceptedAttemptIdsForItem(itemId: string): string[] {
  const db = getDb();

  if (isAcceptanceMigrationCompleted()) {
    const rows = db
      .query('SELECT evidence_attempt_id FROM onboarding_item_evidence_acceptances WHERE item_id = ? ORDER BY created_at ASC')
      .all(itemId) as Array<{ evidence_attempt_id: string }>;
    return rows.map((r) => r.evidence_attempt_id);
  }

  // Pre-migration fallback: the legacy `accepted_evidence_attempt_ids_json`
  // column no longer exists in the current schema, so a pre-marker database
  // can only report zero acceptances (fail closed, never resurrect).
  return [];
}

/**
 * Accepted attempt IDs scoped to the item's CURRENT (non-superseded)
 * generation only. Stale-generation acceptances remain audit-visible via
 * `listAcceptancesForItem` but never influence decisions.
 */
export function getCurrentGenerationAcceptedAttemptIds(itemId: string): string[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT a.evidence_attempt_id
       FROM onboarding_item_evidence_acceptances a
       JOIN sourcing_generations g ON g.id = a.sourcing_generation_id
       WHERE a.item_id = ? AND g.id = (
         SELECT id FROM sourcing_generations WHERE item_id = a.item_id ORDER BY rowid DESC LIMIT 1
       )
       ORDER BY a.created_at ASC`,
    )
    .all(itemId) as Array<{ evidence_attempt_id: string }>;
  return rows.map((r) => r.evidence_attempt_id);
}

/**
 * Get full EvidenceAttempt objects for an item's accepted evidence attempts.
 */
export function getAcceptedAttemptsForItem(itemId: string, upc?: string): EvidenceAttempt[] {
  const ids = getAcceptedAttemptIdsForItem(itemId);
  if (ids.length === 0) return [];

  // If UPC wasn't provided, fetch item's UPC
  let targetUpc = upc;
  if (!targetUpc) {
    const db = getDb();
    const itemRow = db.query('SELECT upc FROM onboarding_items WHERE id = ?').get(itemId) as { upc: string } | undefined;
    targetUpc = itemRow?.upc || '';
  }

  return getEvidenceAttemptsByIdsForItem(itemId, targetUpc, ids);
}
