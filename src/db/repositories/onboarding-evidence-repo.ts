/**
 * Repository for distributor evidence lookups (ADR 0014).
 *
 * Stores one immutable row per attempt (item + provider + connection +
 * generation) so the worker can inspect past results and skip redundant
 * lookups. Evidence attempts are generation-scoped: only the CURRENT
 * generation may influence reconciliation, acceptance, conflict completion,
 * or routing. `insertEvidenceAttempt` is the SINGLE evidence writer and
 * never updates prior attempts.
 */

import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { EvidenceAttempt, InsertEvidenceAttempt } from '../../shared/schemas/distributor-evidence';

// ─── Row type ──────────────────────────────────────────────────────────────────

interface EvidenceAttemptRow {
  id: string;
  item_id: string;
  provider_id: string;
  distributor_connection_id: string | null;
  catalog_snapshot_id: string | null;
  lookup_upc: string;
  outcome: string;
  confidence: number;
  evidence_url: string | null;
  matched_fields_json: string;
  identity_json: string | null;
  warnings_json: string | null;
  error_code: string | null;
  error_message: string | null;
  catalog_version: string | null;
  observed_at: string | null;
  expires_at: string | null;
  sourcing_generation_id: string | null;
  duration_ms: number | null;
  /** Milestone E: connector-declared variant axes (rawField → normalizedAxis), JSON when the column exists. */
  variant_axis_declarations?: string | null;
  created_at: string;
}

/**
 * Milestone E: the `variant_axis_declarations` column may not exist on
 * databases created before the ME migration lands (the column addition lives
 * in migrations.ts, outside this repo's file scope). The write/read paths are
 * tolerant: they persist + hydrate ONLY when the column is present, so
 * connector-declared custom axes survive persistence immediately after the
 * migration, and hydration is a no-op (empty) otherwise. Mirrors the
 * PRAGMA-guarded ALTER discipline used elsewhere.
 */
let hasVariantAxisDeclarationsColumn: boolean | null = null;
function evidenceHasVariantAxisColumn(db: ReturnType<typeof getDb>): boolean {
  if (hasVariantAxisDeclarationsColumn === null) {
    const cols = db.query('PRAGMA table_info(onboarding_evidence_attempts)').all() as Array<{ name: string }>;
    hasVariantAxisDeclarationsColumn = cols.some((c) => c.name === 'variant_axis_declarations');
  }
  return hasVariantAxisDeclarationsColumn;
}

// ─── Row → domain mapping ──────────────────────────────────────────────────────

function mapRow(row: EvidenceAttemptRow): EvidenceAttempt {
  return {
    id: row.id,
    itemId: row.item_id,
    providerId: row.provider_id,
    distributorConnectionId: row.distributor_connection_id ?? null,
    catalogSnapshotId: row.catalog_snapshot_id ?? null,
    lookupUpc: row.lookup_upc,
    outcome: row.outcome as EvidenceAttempt['outcome'],
    confidence: Number(row.confidence),
    evidenceUrl: row.evidence_url,
    matchedFields: safeParseJsonArray(row.matched_fields_json),
    identityJson: row.identity_json,
    warningsJson: row.warnings_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    catalogVersion: row.catalog_version ?? null,
    observedAt: row.observed_at || row.created_at,
    expiresAt: row.expires_at ?? null,
    sourcingGenerationId: row.sourcing_generation_id ?? null,
    durationMs: row.duration_ms ?? undefined,
    // Milestone E: hydrate connector-declared variant axes when the column
    // exists (pre-migration databases hydrate empty — fail closed, never
    // fabricate declarations).
    variantAxisDeclarations: row.variant_axis_declarations
      ? parseVariantAxisDeclarations(row.variant_axis_declarations)
      : undefined,
    createdAt: row.created_at,
  };
}

/** Parse the stored variant-axis declaration JSON (tolerant). */
function parseVariantAxisDeclarations(raw: string): EvidenceAttempt['variantAxisDeclarations'] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const valid = parsed.filter(
      (d): d is { rawField: string; normalizedAxis: string } =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as { rawField?: unknown }).rawField === 'string' &&
        typeof (d as { normalizedAxis?: unknown }).normalizedAxis === 'string',
    );
    return valid.length > 0 ? valid : undefined;
  } catch {
    return undefined;
  }
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

// ─── Single evidence writer (ADR 0014) ─────────────────────────────────────────

/**
 * The ONLY evidence writer. Appends exactly once and never updates prior
 * attempts: the unique (item_id, distributor_connection_id,
 * sourcing_generation_id) index makes a re-insert a no-op that returns the
 * existing attempt (idempotent worker retries).
 *
 * Validates ownership before insert: the item must exist, the connection
 * (when given) must belong to the item's workspace, and the generation
 * (when given) must belong to the item.
 */
export function insertEvidenceAttempt(attempt: InsertEvidenceAttempt): EvidenceAttempt {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  const observedAt = attempt.observedAt || now;

  const item = db.query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(attempt.itemId) as
    | { batch_id: string }
    | undefined;
  if (!item) {
    throw new Error(`Cannot insert evidence attempt: item ${attempt.itemId} not found`);
  }

  if (attempt.distributorConnectionId) {
    // The connection must belong to the ITEM's workspace (cross-workspace
    // evidence writes fail closed).
    const connection = db
      .query(
        `SELECT c.id FROM distributor_connections c
         JOIN onboarding_batches b ON b.id = ?
         WHERE c.id = ? AND c.workspace_id = b.workspace_id`,
      )
      .get(item.batch_id, attempt.distributorConnectionId) as { id: string } | undefined;
    if (!connection) {
      throw new Error(
        `Cannot insert evidence attempt: connection ${attempt.distributorConnectionId} not found for item ${attempt.itemId}`,
      );
    }
  }

  if (attempt.sourcingGenerationId) {
    const gen = db
      .query('SELECT item_id FROM sourcing_generations WHERE id = ?')
      .get(attempt.sourcingGenerationId) as { item_id: string } | undefined;
    if (!gen || gen.item_id !== attempt.itemId) {
      throw new Error(
        `Cannot insert evidence attempt: generation ${attempt.sourcingGenerationId} does not belong to item ${attempt.itemId}`,
      );
    }
  }

  // Milestone E: persist connector-declared variant axes when the column
  // exists (tolerant to pre-migration databases). The unique-index dedupe
  // guard below still applies. `variantAxisDeclarations` is now a typed
  // first-class field on `InsertEvidenceAttempt` (Amendment B, M2) — the
  // former type-cast escape hatch is removed.
  const persistVariantAxes = evidenceHasVariantAxisColumn(db);
  const variantAxesJson =
    persistVariantAxes &&
    attempt.variantAxisDeclarations &&
    attempt.variantAxisDeclarations.length > 0
      ? JSON.stringify(attempt.variantAxisDeclarations)
      : null;

  db.query(
    persistVariantAxes
      ? `INSERT INTO onboarding_evidence_attempts
        (id, item_id, provider_id, distributor_connection_id, catalog_snapshot_id, lookup_upc, outcome, confidence, evidence_url,
         matched_fields_json, identity_json, warnings_json, error_code, error_message, catalog_version, observed_at, expires_at, sourcing_generation_id, duration_ms, variant_axis_declarations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, distributor_connection_id, sourcing_generation_id)
         WHERE distributor_connection_id IS NOT NULL AND sourcing_generation_id IS NOT NULL
       DO NOTHING`
      : `INSERT INTO onboarding_evidence_attempts
        (id, item_id, provider_id, distributor_connection_id, catalog_snapshot_id, lookup_upc, outcome, confidence, evidence_url,
         matched_fields_json, identity_json, warnings_json, error_code, error_message, catalog_version, observed_at, expires_at, sourcing_generation_id, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, distributor_connection_id, sourcing_generation_id)
         WHERE distributor_connection_id IS NOT NULL AND sourcing_generation_id IS NOT NULL
       DO NOTHING`,
  ).run(
    id,
    attempt.itemId,
    attempt.providerId,
    attempt.distributorConnectionId ?? null,
    attempt.catalogSnapshotId ?? null,
    attempt.lookupUpc,
    attempt.outcome,
    attempt.confidence,
    attempt.evidenceUrl,
    JSON.stringify(attempt.matchedFields),
    attempt.identityJson,
    attempt.warningsJson,
    attempt.errorCode,
    attempt.errorMessage,
    attempt.catalogVersion ?? null,
    observedAt,
    attempt.expiresAt ?? null,
    attempt.sourcingGenerationId ?? null,
    attempt.durationMs ?? null,
    // variant_axis_declarations (only in the extended column list)
    ...(persistVariantAxes ? [variantAxesJson] : []),
    now,
  );

  // If the insert was deduplicated by the unique index, return the existing
  // attempt (immutability: the prior row is the truth).
  const inserted = db.query('SELECT * FROM onboarding_evidence_attempts WHERE id = ?').get(id) as
    | EvidenceAttemptRow
    | undefined;
  if (inserted) return mapRow(inserted);

  const existing = db
    .query(
      `SELECT * FROM onboarding_evidence_attempts
       WHERE item_id = ? AND distributor_connection_id IS ? AND sourcing_generation_id IS ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(attempt.itemId, attempt.distributorConnectionId ?? null, attempt.sourcingGenerationId ?? null) as EvidenceAttemptRow | undefined;
  if (existing) return mapRow(existing);

  throw new Error('Evidence attempt insert failed without a durable row');
}

// ─── Lookups ───────────────────────────────────────────────────────────────────

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
 * Get attempts belonging to the CURRENT (non-superseded) sourcing
 * generation of an item, newest first. Stale-generation attempts are
 * audit-visible via `getEvidenceAttemptsForItem` but can never influence
 * reconciliation/acceptance/routing.
 */
export function getCurrentGenerationAttempts(itemId: string): EvidenceAttempt[] {
  const db = getDb();
  const current = db
    .query(
      `SELECT id FROM sourcing_generations
       WHERE item_id = ?
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(itemId) as { id: string } | undefined;
  if (!current) return [];
  const rows = db.query(
    'SELECT * FROM onboarding_evidence_attempts WHERE item_id = ? AND sourcing_generation_id = ? ORDER BY created_at ASC',
  ).all(itemId, current.id) as EvidenceAttemptRow[];
  return rows.map(mapRow);
}

/**
 * Get evidence attempts by immutable IDs for a specific item/UPC, returned
 * in the requested order. Validates every ID exists, belongs to the item,
 * matches the UPC, and has outcome='found'.
 *
 * Throws a descriptive error on the first violation so callers can fail closed.
 */export function getEvidenceAttemptsByIdsForItem(
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
 * Exact item + generation read (Amendment A): all attempts for an item that
 * belong to the given generation, in deterministic insert order. Never falls
 * back to a lookup UPC; the generation must be exact (stale generations are
 * audit-only, never the current authority).
 */
export function getEvidenceAttemptsByItemAndGeneration(itemId: string, generationId: string): EvidenceAttempt[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM onboarding_evidence_attempts WHERE item_id = ? AND sourcing_generation_id = ? ORDER BY created_at ASC',
  ).all(itemId, generationId) as EvidenceAttemptRow[];
  return rows.map(mapRow);
}

/**
 * Get the most recent successful ('found') attempt for a specific
 * provider + UPC combination, generation-scoped. Used for
 * cache-before-lookup. Returns null if no unexpired successful attempt
 * exists in the item's current generation.
 */
export function getLatestSuccessfulAttempt(
  itemId: string,
  providerId: string,
  lookupUpc: string,
): EvidenceAttempt | null {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db.query(
    `SELECT a.* FROM onboarding_evidence_attempts a
     JOIN sourcing_generations g ON g.id = a.sourcing_generation_id
     WHERE a.item_id = ? AND a.provider_id = ? AND a.lookup_upc = ? AND a.outcome = 'found'
       AND g.id = (SELECT id FROM sourcing_generations WHERE item_id = a.item_id ORDER BY rowid DESC LIMIT 1)
       AND (a.expires_at IS NULL OR a.expires_at > ?)
     ORDER BY a.created_at DESC LIMIT 1`,
  ).get(itemId, providerId, lookupUpc, now) as EvidenceAttemptRow | undefined;
  return row ? mapRow(row) : null;
}

// ─── Sourcing generations (ADR 0014) ───────────────────────────────────────────

export interface SourcingGenerationRow {
  id: string;
  item_id: string;
  status: string;
  supersedes_id: string | null;
  reason: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

function mapGenerationRow(row: SourcingGenerationRow) {
  return {
    id: row.id,
    itemId: row.item_id,
    status: row.status,
    supersedesId: row.supersedes_id,
    reason: row.reason,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

/**
 * Start a fresh sourcing generation for an item. Any prior generation that
 * is still running is left untouched; the new row becomes the current
 * generation by recency. `supersedesId` is set from the explicitly
 * superseded prior generation (retry path) or the newest running one.
 */
export function startSourcingGeneration(itemId: string, reason: string | null = null, supersedesId: string | null = null) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = `gen_${randomUUID().slice(0, 12)}`;
  const prior =
    supersedesId ??
    ((db
      .query(
        `SELECT id FROM sourcing_generations
         WHERE item_id = ? AND status = 'running'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(itemId) as { id: string } | undefined)?.id ?? null);

  db.query(
    `INSERT INTO sourcing_generations (id, item_id, status, supersedes_id, reason, started_at, completed_at, created_at)
     VALUES (?, ?, 'running', ?, ?, ?, NULL, ?)`,
  ).run(id, itemId, prior, reason, now, now);

  return mapGenerationRow(
    db.query('SELECT * FROM sourcing_generations WHERE id = ?').get(id) as SourcingGenerationRow,
  );
}

/**
 * Supersede the item's current generation (retry/reset) and start a fresh
 * one. The superseded generation remains audit-visible but can never
 * influence future decisions. Returns the new generation.
 */
export function supersedeCurrentSourcingGeneration(itemId: string, reason: string = 'operator_retry') {
  const db = getDb();
  const now = new Date().toISOString();
  // ADR 0014: retry/reset supersedes the CURRENT generation — the latest
  // generation row regardless of its status (the worker may have completed
  // it). Superseded generations stay audit-visible but can never influence
  // reconciliation, acceptance, conflict completion, or routing.
  const prior = db
    .query(
      `SELECT id FROM sourcing_generations
       WHERE item_id = ?
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(itemId) as { id: string } | undefined;

  if (prior) {
    db.query(
      `UPDATE sourcing_generations
       SET status = 'superseded', completed_at = ?, reason = COALESCE(reason, ?)
       WHERE id = ?`,
    ).run(now, reason, prior.id);
  }

  return startSourcingGeneration(itemId, reason, prior?.id ?? null);
}

/** Mark a generation completed (terminal success or exhausted errors). */
export function completeSourcingGeneration(generationId: string, status: 'completed' | 'failed') {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE sourcing_generations SET status = ?, completed_at = ? WHERE id = ? AND status = ?',
  ).run(status, now, generationId, 'running');
}

/**
 * The item's CURRENT generation: the LATEST generation row by started_at
 * (supersede/complete/fail only changes status — the newest row is always
 * the current one by construction). Returns null when the item has none.
 */
export function getCurrentSourcingGeneration(itemId: string) {
  const db = getDb();
  const row = db
    .query(
      `SELECT * FROM sourcing_generations
       WHERE item_id = ?
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(itemId) as SourcingGenerationRow | undefined;
  return row ? mapGenerationRow(row) : null;
}

/** All generations for an item, oldest first (audit view). */
export function listGenerationsForItem(itemId: string) {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM sourcing_generations WHERE item_id = ? ORDER BY started_at ASC, rowid ASC',
  ).all(itemId) as SourcingGenerationRow[];
  return rows.map(mapGenerationRow);
}
