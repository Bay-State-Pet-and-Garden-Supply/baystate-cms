/**
 * Repository for distributor evidence lookups.
 *
 * Stores one row per attempt (item + provider + UPC) so the worker can
 * inspect past results and skip redundant lookups. Follows the same
 * repository pattern as onboarding-source-repo and other module repos.
 */

import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type {
  EvidenceAttempt,
  InsertEvidenceAttempt,
  ProductEvidenceLookupResult,
} from '../../shared/schemas/distributor-evidence';

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

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Insert a new evidence attempt. Returns the created row.
 */
export function insertEvidenceAttempt(attempt: InsertEvidenceAttempt): EvidenceAttempt {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();

  db.query(
    `INSERT INTO onboarding_evidence_attempts
      (id, item_id, provider_id, lookup_upc, outcome, confidence, evidence_url,
       matched_fields_json, identity_json, warnings_json, error_code, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    attempt.itemId,
    attempt.providerId,
    attempt.lookupUpc,
    attempt.outcome,
    attempt.confidence,
    attempt.evidenceUrl,
    JSON.stringify(attempt.matchedFields),
    attempt.identityJson,
    attempt.warningsJson,
    attempt.errorCode,
    attempt.errorMessage,
    now,
  );

  const row = db.query('SELECT * FROM onboarding_evidence_attempts WHERE id = ?').get(id) as EvidenceAttemptRow | undefined;
  if (!row) throw new Error(`Failed to insert evidence attempt ${id}`);
  return mapRow(row);
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
 * Find a single evidence attempt by its immutable ID.
 * Returns null when the attempt does not exist.
 */
export function findEvidenceAttemptById(id: string): EvidenceAttempt | null {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM onboarding_evidence_attempts WHERE id = ?',
  ).get(id) as EvidenceAttemptRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Get the most recent successful ('found') attempt for a specific
 * provider + UPC combination. Used for cache-before-lookup.
 * Returns null if no successful attempt exists.
 */
export function getLatestSuccessfulAttempt(
  itemId: string,
  providerId: string,
  lookupUpc: string,
): EvidenceAttempt | null {
  const db = getDb();
  const row = db.query(
    `SELECT * FROM onboarding_evidence_attempts
     WHERE item_id = ? AND provider_id = ? AND lookup_upc = ? AND outcome = 'found'
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(itemId, providerId, lookupUpc) as EvidenceAttemptRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Get the latest attempt per provider for an item/UPC combination.
 * Returns a map of providerId → latest attempt (any outcome).
 */
export function getLatestAttemptsPerProvider(
  itemId: string,
  upc: string,
): Map<string, EvidenceAttempt> {
  const db = getDb();
  const rows = db.query(
    `SELECT e.* FROM onboarding_evidence_attempts e
     INNER JOIN (
       SELECT provider_id, MAX(created_at) AS max_created
       FROM onboarding_evidence_attempts
       WHERE item_id = ? AND lookup_upc = ?
       GROUP BY provider_id
     ) latest ON e.provider_id = latest.provider_id AND e.created_at = latest.max_created
     WHERE e.item_id = ? AND e.lookup_upc = ?`,
  ).all(itemId, upc, itemId, upc) as EvidenceAttemptRow[];

  const result = new Map<string, EvidenceAttempt>();
  for (const row of rows) {
    result.set(row.provider_id, mapRow(row));
  }
  return result;
}

/**
 * Get the latest attempt per provider for all items in a batch, grouped by item ID.
 * Avoids N+1 queries for the staged route.
 */
export function getLatestProviderAttemptsForBatch(
  batchId: string,
): Record<string, EvidenceAttempt[]> {
  const db = getDb();
  // Subquery: max created_at per (item_id, provider_id) for items in the batch
  const rows = db.query(
    `SELECT e.* FROM onboarding_evidence_attempts e
     INNER JOIN (
       SELECT ea.item_id, ea.provider_id, MAX(ea.created_at) AS max_created
       FROM onboarding_evidence_attempts ea
       INNER JOIN onboarding_items oi ON ea.item_id = oi.id
       WHERE oi.batch_id = ?
       GROUP BY ea.item_id, ea.provider_id
     ) latest
     ON e.item_id = latest.item_id
        AND e.provider_id = latest.provider_id
        AND e.created_at = latest.max_created
     ORDER BY e.item_id, e.provider_id`,
  ).all(batchId) as EvidenceAttemptRow[];

  const result: Record<string, EvidenceAttempt[]> = {};
  for (const row of rows) {
    const attempt = mapRow(row);
    const key = row.item_id;
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(attempt);
  }
  return result;
}

/**
 * Check if a specific provider already has a successful recent attempt
 * for this item/UPC. Used for cache-before-lookup logic.
 */
export function hasRecentSuccess(itemId: string, providerId: string, lookupUpc: string): boolean {
  const db = getDb();
  const row = db.query(
    `SELECT 1 FROM onboarding_evidence_attempts
     WHERE item_id = ? AND provider_id = ? AND lookup_upc = ?
       AND outcome = 'found'
     LIMIT 1`,
  ).get(itemId, providerId, lookupUpc);
  return !!row;
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

/**
 * Build a ProductEvidenceLookupResult from a stored attempt.
 * Used to reconstruct the full result for identity-bundle creation
 * without re-querying the provider.
 */
export function attemptToResult(attempt: EvidenceAttempt): ProductEvidenceLookupResult {
  let identity: ProductEvidenceLookupResult['identity'] = {};
  if (attempt.identityJson) {
    try {
      identity = JSON.parse(attempt.identityJson);
    } catch {
      // Return empty identity on parse failure
    }
  }

  let warnings: string[] = [];
  if (attempt.warningsJson) {
    try {
      const parsed = JSON.parse(attempt.warningsJson);
      warnings = Array.isArray(parsed) ? parsed : [];
    } catch {
      // Ignore parse failure
    }
  }

  return {
    providerId: attempt.providerId,
    providerType: 'distributor',
    outcome: attempt.outcome,
    confidence: attempt.confidence,
    identity,
    evidenceUrl: attempt.evidenceUrl,
    matchedFields: attempt.matchedFields,
    warnings,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
  };
}
