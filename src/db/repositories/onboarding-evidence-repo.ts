/**
 * Repository for distributor evidence lookups.
 *
 * Stores one row per attempt (item + provider + UPC) so the worker can
 * inspect past results and skip redundant lookups. Follows the same
 * repository pattern as onboarding-source-repo and other module repos.
 */

import { getDb } from '../connection';
import type { EvidenceAttempt } from '../../shared/schemas/distributor-evidence';

// ─── Row type ──────────────────────────────────────────────────────────────────

interface EvidenceAttemptRow {
  id: string;
  item_id: string;
  provider_id: string;
  lookup_upc: string;
  outcome: string;
  confidence: number;
  evidence_url: string | null;
  matched_fields_json: string;
  identity_json: string | null;
  warnings_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

// ─── Row → domain mapping ──────────────────────────────────────────────────────

function mapRow(row: EvidenceAttemptRow): EvidenceAttempt {
  return {
    id: row.id,
    itemId: row.item_id,
    providerId: row.provider_id,
    lookupUpc: row.lookup_upc,
    outcome: row.outcome as EvidenceAttempt['outcome'],
    confidence: Number(row.confidence),
    evidenceUrl: row.evidence_url,
    matchedFields: safeParseJsonArray(row.matched_fields_json),
    identityJson: row.identity_json,
    warningsJson: row.warnings_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function safeParseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Get all attempts for an onboarding item, newest first.
 */
export function getEvidenceAttemptsForItem(itemId: string): EvidenceAttempt[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM onboarding_evidence_attempts WHERE item_id = ? ORDER BY created_at DESC',
  ).all(itemId) as EvidenceAttemptRow[];
  return rows.map(mapRow);
}

/**
 * Get evidence attempts by immutable IDs for a specific item/UPC, returned
 * in the requested order. Validates every ID exists, belongs to the item,
 * matches the UPC, and has outcome='found'.
 *
 * Throws a descriptive error on the first violation so callers can fail closed.
 */
export function getEvidenceAttemptsByIdsForItem(
  itemId: string,
  upc: string,
  ids: string[],
): EvidenceAttempt[] {
  if (ids.length === 0) return [];

  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.query(
    `SELECT * FROM onboarding_evidence_attempts
     WHERE id IN (${placeholders})`,
  ).all(...ids) as EvidenceAttemptRow[];

  // Build a map for validation and reordering
  const rowMap = new Map<string, EvidenceAttemptRow>();
  for (const row of rows) {
    rowMap.set(row.id, row);
  }

  // Validate and reorder in requested order
  const result: EvidenceAttempt[] = [];
  for (const id of ids) {
    const row = rowMap.get(id);
    if (!row) {
      throw new Error(`Evidence attempt ${id} not found for item ${itemId}`);
    }
    if (row.item_id !== itemId) {
      throw new Error(`Evidence attempt ${id} does not belong to item ${itemId}`);
    }
    if (row.lookup_upc !== upc) {
      throw new Error(`Evidence attempt ${id} lookup UPC mismatch: expected ${upc}, got ${row.lookup_upc}`);
    }
    if (row.outcome !== 'found') {
      throw new Error(`Evidence attempt ${id} outcome is '${row.outcome}', expected 'found'`);
    }
    result.push(mapRow(row));
  }

  return result;
}
