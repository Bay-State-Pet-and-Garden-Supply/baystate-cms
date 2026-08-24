import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

/**
 * Status values for an LLM-generated selector profile proposal.
 *
 * Lifecycle:
 *   proposed  - LLM produced a selector set, not yet validated against expected product data
 *   validated - selector set passed at least one validation sample
 *   rejected  - selector set failed validation; the rejection reason is stored in error_message
 *   promoted  - the validated selector set was written into extractor_profiles
 *   failed    - the LLM call itself failed (no selectors to evaluate)
 */
export type ProfileGenerationStatus =
  | 'proposed'
  | 'validated'
  | 'rejected'
  | 'promoted'
  | 'failed';

const PROFILE_GENERATION_STATUSES: ReadonlyArray<ProfileGenerationStatus> = [
  'proposed',
  'validated',
  'rejected',
  'promoted',
  'failed',
];

/**
 * Snapshot of an LLM-generated selector profile proposal. Field samples and
 * validation payload are opaque JSON blobs whose shape is owned by the
 * profile generator module.
 */
export interface ProfileGenerationRecord {
  id: string;
  domain: string;
  sourceUrl: string;
  expectedName: string | null;
  brandHint: string | null;
  selectors: Record<string, unknown>;
  fieldSamples: Record<string, unknown> | null;
  validation: Record<string, unknown> | null;
  status: ProfileGenerationStatus;
  confidence: number;
  llmProvider: string | null;
  llmModel: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  promotedAt: string | null;
}

interface DbProfileGeneration {
  id: string;
  domain: string;
  source_url: string;
  expected_name: string | null;
  brand_hint: string | null;
  selectors_json: string;
  field_samples_json: string | null;
  validation_json: string | null;
  status: string;
  confidence: number;
  llm_provider: string | null;
  llm_model: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  promoted_at: string | null;
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

function safeParseJson<T>(raw: string | null): T | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mapToRecord(row: DbProfileGeneration): ProfileGenerationRecord {
  const selectors = safeParseJson<Record<string, unknown>>(row.selectors_json) ?? {};
  const fieldSamples = safeParseJson<Record<string, unknown>>(row.field_samples_json);
  const validation = safeParseJson<Record<string, unknown>>(row.validation_json);

  return {
    id: row.id,
    domain: row.domain,
    sourceUrl: row.source_url,
    expectedName: row.expected_name,
    brandHint: row.brand_hint,
    selectors,
    fieldSamples,
    validation,
    status: row.status as ProfileGenerationStatus,
    confidence: row.confidence,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    promotedAt: row.promoted_at,
  };
}

/**
 * Insert a new profile generation audit row. The caller is expected to
 * provide the selectors payload as a plain object (will be JSON.stringified)
 * and the initial status.
 */
export interface InsertProfileGenerationInput {
  domain: string;
  sourceUrl: string;
  expectedName?: string | null;
  brandHint?: string | null;
  selectors: Record<string, unknown>;
  fieldSamples?: Record<string, unknown> | null;
  validation?: Record<string, unknown> | null;
  status: ProfileGenerationStatus;
  confidence?: number;
  llmProvider?: string | null;
  llmModel?: string | null;
  errorMessage?: string | null;
}

export function insertProfileGeneration(
  input: InsertProfileGenerationInput,
): ProfileGenerationRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  const normalizedDomain = normalizeDomain(input.domain);

  const selectorsJson = JSON.stringify(input.selectors ?? {});
  const fieldSamplesJson = input.fieldSamples
    ? JSON.stringify(input.fieldSamples)
    : null;
  const validationJson = input.validation
    ? JSON.stringify(input.validation)
    : null;

  db.query(`
    INSERT INTO profile_generations (
      id, domain, source_url, expected_name, brand_hint,
      selectors_json, field_samples_json, validation_json,
      status, confidence, llm_provider, llm_model, error_message,
      created_at, updated_at, promoted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    normalizedDomain,
    input.sourceUrl,
    input.expectedName ?? null,
    input.brandHint ?? null,
    selectorsJson,
    fieldSamplesJson,
    validationJson,
    input.status,
    input.confidence ?? 0,
    input.llmProvider ?? null,
    input.llmModel ?? null,
    input.errorMessage ?? null,
    now,
    now,
  );

  return {
    id,
    domain: normalizedDomain,
    sourceUrl: input.sourceUrl,
    expectedName: input.expectedName ?? null,
    brandHint: input.brandHint ?? null,
    selectors: input.selectors ?? {},
    fieldSamples: input.fieldSamples ?? null,
    validation: input.validation ?? null,
    status: input.status,
    confidence: input.confidence ?? 0,
    llmProvider: input.llmProvider ?? null,
    llmModel: input.llmModel ?? null,
    errorMessage: input.errorMessage ?? null,
    createdAt: now,
    updatedAt: now,
    promotedAt: null,
  };
}

export interface UpdateProfileGenerationStatusFields {
  status?: ProfileGenerationStatus;
  confidence?: number;
  fieldSamples?: Record<string, unknown> | null;
  validation?: Record<string, unknown> | null;
  errorMessage?: string | null;
  promotedAt?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
}

/**
 * Update the status and/or related audit fields of an existing row.
 * `updated_at` is always refreshed. JSON fields, when provided, are
 * re-serialized; when explicitly null, they are cleared.
 */
export function updateProfileGenerationStatus(
  id: string,
  status: ProfileGenerationStatus,
  fields: UpdateProfileGenerationStatusFields = {},
): ProfileGenerationRecord | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .query('SELECT * FROM profile_generations WHERE id = ?')
    .get(id) as DbProfileGeneration | undefined;
  if (!existing) return null;

  const nextStatus = fields.status ?? status;
  const nextConfidence =
    fields.confidence !== undefined ? fields.confidence : existing.confidence;
  const nextFieldSamplesJson =
    fields.fieldSamples === undefined
      ? existing.field_samples_json
      : fields.fieldSamples === null
        ? null
        : JSON.stringify(fields.fieldSamples);
  const nextValidationJson =
    fields.validation === undefined
      ? existing.validation_json
      : fields.validation === null
        ? null
        : JSON.stringify(fields.validation);
  const nextErrorMessage =
    fields.errorMessage === undefined
      ? existing.error_message
      : fields.errorMessage;
  const nextPromotedAt =
    fields.promotedAt === undefined ? existing.promoted_at : fields.promotedAt;
  const nextProvider =
    fields.llmProvider === undefined ? existing.llm_provider : fields.llmProvider;
  const nextModel =
    fields.llmModel === undefined ? existing.llm_model : fields.llmModel;

  db.query(`
    UPDATE profile_generations
    SET status = ?,
        confidence = ?,
        field_samples_json = ?,
        validation_json = ?,
        error_message = ?,
        promoted_at = ?,
        llm_provider = ?,
        llm_model = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    nextStatus,
    nextConfidence,
    nextFieldSamplesJson,
    nextValidationJson,
    nextErrorMessage,
    nextPromotedAt,
    nextProvider,
    nextModel,
    now,
    id,
  );

  return findProfileGenerationById(id);
}

export function findProfileGenerationById(
  id: string,
): ProfileGenerationRecord | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM profile_generations WHERE id = ?')
    .get(id) as DbProfileGeneration | undefined;
  return row ? mapToRecord(row) : null;
}

export interface ListProfileGenerationsOptions {
  status?: ProfileGenerationStatus;
  limit?: number;
  orderBy?: 'created_at' | 'updated_at' | 'confidence';
  orderDirection?: 'ASC' | 'DESC';
}

function safeListOrder(options: ListProfileGenerationsOptions): {
  safeOrderBy: NonNullable<ListProfileGenerationsOptions['orderBy']>;
  safeOrderDir: 'ASC' | 'DESC';
  tiebreaker: string;
  limit: number;
} {
  const orderBy = options.orderBy ?? 'created_at';
  const orderDir = options.orderDirection ?? 'DESC';
  const limit = options.limit ?? 100;
  const allowedOrderBy: ReadonlyArray<NonNullable<ListProfileGenerationsOptions['orderBy']>> = [
    'created_at',
    'updated_at',
    'confidence',
  ];
  const safeOrderBy = allowedOrderBy.includes(orderBy) ? orderBy : 'created_at';
  const safeOrderDir = orderDir === 'ASC' ? 'ASC' : 'DESC';
  const tiebreaker = safeOrderDir === 'ASC' ? 'rowid ASC' : 'rowid DESC';
  return { safeOrderBy, safeOrderDir, tiebreaker, limit };
}

/**
 * List generated profile proposals across all domains. Used by the
 * domain-level governance queue so proposals are visible even before a
 * domain has an active `extractor_profiles` row.
 */
export function listAllProfileGenerations(
  options: ListProfileGenerationsOptions = {},
): ProfileGenerationRecord[] {
  const db = getDb();
  const { safeOrderBy, safeOrderDir, tiebreaker, limit } = safeListOrder(options);
  let rows: DbProfileGeneration[];
  if (options.status) {
    rows = db
      .query(
        `SELECT * FROM profile_generations
         WHERE status = ?
         ORDER BY ${safeOrderBy} ${safeOrderDir}, ${tiebreaker}
         LIMIT ?`,
      )
      .all(options.status, limit) as DbProfileGeneration[];
  } else {
    rows = db
      .query(
        `SELECT * FROM profile_generations
         ORDER BY ${safeOrderBy} ${safeOrderDir}, ${tiebreaker}
         LIMIT ?`,
      )
      .all(limit) as DbProfileGeneration[];
  }
  return rows.map(mapToRecord);
}

/**
 * List audit rows for a domain, newest first by default. Domain is
 * normalized the same way as extractor_profile_repo to keep lookups
 * consistent across both tables.
 */
export function listProfileGenerationsByDomain(
  domain: string,
  options: ListProfileGenerationsOptions = {},
): ProfileGenerationRecord[] {
  const db = getDb();
  const normalizedDomain = normalizeDomain(domain);
  const { safeOrderBy, safeOrderDir, tiebreaker, limit } = safeListOrder(options);

  let rows: DbProfileGeneration[];
  if (options.status) {
    rows = db
      .query(
        `SELECT * FROM profile_generations
         WHERE domain = ? AND status = ?
         ORDER BY ${safeOrderBy} ${safeOrderDir}, ${tiebreaker}
         LIMIT ?`,
      )
      .all(normalizedDomain, options.status, limit) as DbProfileGeneration[];
  } else {
    rows = db
      .query(
        `SELECT * FROM profile_generations
         WHERE domain = ?
         ORDER BY ${safeOrderBy} ${safeOrderDir}, ${tiebreaker}
         LIMIT ?`,
      )
      .all(normalizedDomain, limit) as DbProfileGeneration[];
  }

  return rows.map(mapToRecord);
}

/**
 * List validated (or promoted) generations for a domain. Used by
 * multi-sample promotion logic in the profile generator.
 */
// fallow-ignore-next-line unused-export
export function listValidatedGenerationsByDomain(
  domain: string,
  limit = 20,
): ProfileGenerationRecord[] {
  const db = getDb();
  const normalizedDomain = normalizeDomain(domain);
  const rows = db
    .query(
      `SELECT * FROM profile_generations
       WHERE domain = ? AND status IN ('validated', 'promoted')
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(normalizedDomain, limit) as DbProfileGeneration[];
  return rows.map(mapToRecord);
}

/**
 * Per-domain aggregate of `profile_generations` rows. Used by the
 * Domain Diagnostics surface to show generation counts and the most
 * recent status/timestamp without loading every selector JSON blob.
 */
export interface ProfileGenerationDomainSummary {
  domain: string;
  generationCount: number;
  latestGenerationStatus: ProfileGenerationStatus | null;
  latestGenerationAt: string | null;
}

/**
 * Return one summary per domain that has at least one row in
 * `profile_generations`. The summary carries the full row count
 * (no implicit `LIMIT`) and the latest status/timestamp selected
 * by `created_at DESC, rowid DESC` so domains with many generations
 * are not undercounted and identical timestamps still pick a
 * deterministic winner.
 */
export function listProfileGenerationDomainSummaries(): ProfileGenerationDomainSummary[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT domain,
              COUNT(*) AS generation_count,
              (SELECT status
                 FROM profile_generations pg2
                WHERE pg2.domain = pg1.domain
                ORDER BY created_at DESC, rowid DESC
                LIMIT 1) AS latest_status,
              (SELECT created_at
                 FROM profile_generations pg2
                WHERE pg2.domain = pg1.domain
                ORDER BY created_at DESC, rowid DESC
                LIMIT 1) AS latest_created_at
         FROM profile_generations pg1
         GROUP BY domain
         ORDER BY domain ASC`,
    )
    .all() as Array<{
      domain: string;
      generation_count: number;
      latest_status: string | null;
      latest_created_at: string | null;
    }>;

  return rows.map((row) => ({
    domain: row.domain,
    generationCount: row.generation_count,
    latestGenerationStatus:
      (row.latest_status as ProfileGenerationStatus | null) ?? null,
    latestGenerationAt: row.latest_created_at ?? null,
  }));
}

/**
 * Delete a profile generation and all of its cascade children:
 * revisions, validation results, and field decisions.
 *
 * The deletion order is top-down so no FK violations occur:
 *   1. validation_results  (references revision_id)
 *   2. revisions           (references generation_id)
 *   3. field_decisions     (references generation_id)
 *   4. the generation itself
 *
 * Returns `true` when at least the generation row was deleted.
 */
export function deleteProfileGeneration(id: string): boolean {
  const db = getDb();
  let deleted = false;
  db.transaction(() => {
    db.query(
      `DELETE FROM profile_generation_validation_results
       WHERE revision_id IN (
         SELECT id FROM profile_generation_revisions WHERE generation_id = ?
       )`,
    ).run(id);
    db.query('DELETE FROM profile_generation_revisions WHERE generation_id = ?').run(id);
    db.query(
      'DELETE FROM profile_generation_field_decisions WHERE generation_id = ?',
    ).run(id);
    const result = db.query('DELETE FROM profile_generations WHERE id = ?').run(id);
    deleted = result.changes > 0;
  })();
  return deleted;
}
