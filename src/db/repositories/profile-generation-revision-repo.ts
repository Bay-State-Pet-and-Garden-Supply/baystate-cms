import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

/**
 * Status values for a single profile generation revision.
 *
 * Lifecycle:
 *   draft      - revision inserted but not yet evaluated
 *   validated  - revision has been validated across at least one sample
 *   rejected   - revision failed validation; see error_message
 *   superseded - revision has been replaced by a newer revision
 */
export type ProfileGenerationRevisionStatus =
  | 'draft'
  | 'validated'
  | 'rejected'
  | 'superseded';

const PROFILE_GENERATION_REVISION_STATUSES: ReadonlyArray<ProfileGenerationRevisionStatus> = [
  'draft',
  'validated',
  'rejected',
  'superseded',
];

/**
 * Origin of a revision. The initial AI proposal is `initial_generation`;
 * subsequent revisions may come from operator feedback, manual CSS edits,
 * or system-driven revalidation.
 */
export type ProfileGenerationRevisionSource =
  | 'initial_generation'
  | 'manager_feedback'
  | 'manual_css'
  | 'system_validation';

const PROFILE_GENERATION_REVISION_SOURCES: ReadonlyArray<ProfileGenerationRevisionSource> = [
  'initial_generation',
  'manager_feedback',
  'manual_css',
  'system_validation',
];

/**
 * Status of an individual field/sample validation result.
 *   pass    - the extracted value/preview matched expectations
 *   warning - extracted a value but flagged an issue (limited evidence, etc.)
 *   fail    - the selector returned nothing usable on this sample
 */
export type ProfileGenerationValidationStatus = 'pass' | 'warning' | 'fail';

const PROFILE_GENERATION_VALIDATION_STATUSES: ReadonlyArray<ProfileGenerationValidationStatus> = [
  'pass',
  'warning',
  'fail',
];

/**
 * Snapshot of a single profile generation revision. Selectors,
 * feedback, field samples, and validation summary are stored as JSON
 * strings on disk and parsed on read.
 */
export interface ProfileGenerationRevision {
  id: string;
  generationId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  source: ProfileGenerationRevisionSource;
  feedback: Record<string, unknown> | null;
  selectors: Record<string, unknown>;
  fieldSamples: Record<string, unknown> | null;
  validationSummary: Record<string, unknown> | null;
  status: ProfileGenerationRevisionStatus;
  confidence: number;
  llmTask: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DbProfileGenerationRevision {
  id: string;
  generation_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  source: string;
  feedback_json: string | null;
  selectors_json: string;
  field_samples_json: string | null;
  validation_summary_json: string | null;
  status: string;
  confidence: number;
  llm_task: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function safeParseJson<T>(raw: string | null): T | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mapToRevision(row: DbProfileGenerationRevision): ProfileGenerationRevision {
  const selectors = safeParseJson<Record<string, unknown>>(row.selectors_json) ?? {};
  return {
    id: row.id,
    generationId: row.generation_id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    source: row.source as ProfileGenerationRevisionSource,
    feedback: safeParseJson<Record<string, unknown>>(row.feedback_json),
    selectors,
    fieldSamples: safeParseJson<Record<string, unknown>>(row.field_samples_json),
    validationSummary: safeParseJson<Record<string, unknown>>(row.validation_summary_json),
    status: row.status as ProfileGenerationRevisionStatus,
    confidence: row.confidence,
    llmTask: row.llm_task,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertProfileGenerationRevisionInput {
  generationId: string;
  revisionNumber: number;
  parentRevisionId?: string | null;
  source: ProfileGenerationRevisionSource;
  selectors: Record<string, unknown>;
  feedback?: Record<string, unknown> | null;
  fieldSamples?: Record<string, unknown> | null;
  validationSummary?: Record<string, unknown> | null;
  status?: ProfileGenerationRevisionStatus;
  confidence?: number;
  llmTask?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  errorMessage?: string | null;
}

export function insertProfileGenerationRevision(
  input: InsertProfileGenerationRevisionInput,
): ProfileGenerationRevision {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  const status = input.status ?? 'draft';

  db.query(`
    INSERT INTO profile_generation_revisions (
      id, generation_id, revision_number, parent_revision_id, source,
      feedback_json, selectors_json, field_samples_json, validation_summary_json,
      status, confidence, llm_task, llm_provider, llm_model, error_message,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.generationId,
    input.revisionNumber,
    input.parentRevisionId ?? null,
    input.source,
    input.feedback ? JSON.stringify(input.feedback) : null,
    JSON.stringify(input.selectors ?? {}),
    input.fieldSamples ? JSON.stringify(input.fieldSamples) : null,
    input.validationSummary ? JSON.stringify(input.validationSummary) : null,
    status,
    input.confidence ?? 0,
    input.llmTask ?? null,
    input.llmProvider ?? null,
    input.llmModel ?? null,
    input.errorMessage ?? null,
    now,
    now,
  );

  return {
    id,
    generationId: input.generationId,
    revisionNumber: input.revisionNumber,
    parentRevisionId: input.parentRevisionId ?? null,
    source: input.source,
    feedback: input.feedback ?? null,
    selectors: input.selectors ?? {},
    fieldSamples: input.fieldSamples ?? null,
    validationSummary: input.validationSummary ?? null,
    status,
    confidence: input.confidence ?? 0,
    llmTask: input.llmTask ?? null,
    llmProvider: input.llmProvider ?? null,
    llmModel: input.llmModel ?? null,
    errorMessage: input.errorMessage ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function findProfileGenerationRevisionById(
  id: string,
): ProfileGenerationRevision | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM profile_generation_revisions WHERE id = ?')
    .get(id) as DbProfileGenerationRevision | undefined;
  return row ? mapToRevision(row) : null;
}

export interface ListRevisionsByGenerationOptions {
  status?: ProfileGenerationRevisionStatus;
  orderDirection?: 'ASC' | 'DESC';
}

export function listRevisionsByGeneration(
  generationId: string,
  options: ListRevisionsByGenerationOptions = {},
): ProfileGenerationRevision[] {
  const db = getDb();
  const orderDir = options.orderDirection === 'ASC' ? 'ASC' : 'DESC';

  let rows: DbProfileGenerationRevision[];
  if (options.status) {
    rows = db
      .query(
        `SELECT * FROM profile_generation_revisions
         WHERE generation_id = ? AND status = ?
         ORDER BY revision_number ${orderDir}, rowid ${orderDir}`,
      )
      .all(generationId, options.status) as DbProfileGenerationRevision[];
  } else {
    rows = db
      .query(
        `SELECT * FROM profile_generation_revisions
         WHERE generation_id = ?
         ORDER BY revision_number ${orderDir}, rowid ${orderDir}`,
      )
      .all(generationId) as DbProfileGenerationRevision[];
  }

  return rows.map(mapToRevision);
}

/**
 * Return the most recent validated revision for a generation, or null
 * if none has been validated. Used by the promoter to know which
 * revision's selectors are the candidates for promotion.
 */
export function findLatestValidatedRevision(
  generationId: string,
): ProfileGenerationRevision | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT * FROM profile_generation_revisions
       WHERE generation_id = ? AND status = 'validated'
       ORDER BY revision_number DESC, rowid DESC
       LIMIT 1`,
    )
    .get(generationId) as DbProfileGenerationRevision | undefined;
  return row ? mapToRevision(row) : null;
}

export interface UpdateProfileGenerationRevisionStatusFields {
  status?: ProfileGenerationRevisionStatus;
  confidence?: number;
  validationSummary?: Record<string, unknown> | null;
  errorMessage?: string | null;
  fieldSamples?: Record<string, unknown> | null;
}

export function updateProfileGenerationRevisionStatus(
  id: string,
  status: ProfileGenerationRevisionStatus,
  fields: UpdateProfileGenerationRevisionStatusFields = {},
): ProfileGenerationRevision | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .query('SELECT * FROM profile_generation_revisions WHERE id = ?')
    .get(id) as DbProfileGenerationRevision | undefined;
  if (!existing) return null;

  const nextStatus = fields.status ?? status;
  const nextConfidence =
    fields.confidence !== undefined ? fields.confidence : existing.confidence;
  const nextValidationSummaryJson =
    fields.validationSummary === undefined
      ? existing.validation_summary_json
      : fields.validationSummary === null
        ? null
        : JSON.stringify(fields.validationSummary);
  const nextErrorMessage =
    fields.errorMessage === undefined ? existing.error_message : fields.errorMessage;
  const nextFieldSamplesJson =
    fields.fieldSamples === undefined
      ? existing.field_samples_json
      : fields.fieldSamples === null
        ? null
        : JSON.stringify(fields.fieldSamples);

  db.query(`
    UPDATE profile_generation_revisions
    SET status = ?,
        confidence = ?,
        validation_summary_json = ?,
        error_message = ?,
        field_samples_json = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    nextStatus,
    nextConfidence,
    nextValidationSummaryJson,
    nextErrorMessage,
    nextFieldSamplesJson,
    now,
    id,
  );

  return findProfileGenerationRevisionById(id);
}

export interface UpdateRevisionSelectorsFields {
  status?: ProfileGenerationRevisionStatus;
  confidence?: number;
  llmTask?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
}

/**
 * Update a revision's selectors JSON and optionally its status and
 * LLM metadata. Used when an LLM call revises the selectors after
 * the operator submits feedback.
 */
export function updateRevisionSelectors(
  id: string,
  selectors: Record<string, unknown>,
  fields: UpdateRevisionSelectorsFields = {},
): ProfileGenerationRevision | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .query('SELECT * FROM profile_generation_revisions WHERE id = ?')
    .get(id) as DbProfileGenerationRevision | undefined;
  if (!existing) return null;

  const nextStatus = fields.status ?? existing.status;
  const nextConfidence =
    fields.confidence !== undefined ? fields.confidence : existing.confidence;
  const nextLlmTask = fields.llmTask !== undefined ? fields.llmTask : existing.llm_task;
  const nextLlmProvider = fields.llmProvider !== undefined ? fields.llmProvider : existing.llm_provider;
  const nextLlmModel = fields.llmModel !== undefined ? fields.llmModel : existing.llm_model;

  db.query(`
    UPDATE profile_generation_revisions
    SET selectors_json = ?,
        status = ?,
        confidence = ?,
        llm_task = ?,
        llm_provider = ?,
        llm_model = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(selectors),
    nextStatus,
    nextConfidence,
    nextLlmTask,
    nextLlmProvider,
    nextLlmModel,
    now,
    id,
  );

  return findProfileGenerationRevisionById(id);
}

/**
 * Snapshot of an individual per-field/per-sample validation result.
 * Validation result rows are append-only once inserted; status changes
 * require a new row rather than mutating the existing one.
 */
export interface ProfileGenerationValidationResult {
  id: string;
  revisionId: string;
  selectorField: string;
  sampleUrl: string;
  itemId: string | null;
  expectedName: string | null;
  brandHint: string | null;
  extractedValue: Record<string, unknown> | null;
  imagePreviews: string[] | null;
  warnings: string[] | null;
  status: ProfileGenerationValidationStatus;
  createdAt: string;
}

interface DbProfileGenerationValidationResult {
  id: string;
  revision_id: string;
  selector_field: string;
  sample_url: string;
  item_id: string | null;
  expected_name: string | null;
  brand_hint: string | null;
  extracted_value_json: string | null;
  image_previews_json: string | null;
  warnings_json: string | null;
  status: string;
  created_at: string;
}

function mapToValidationResult(
  row: DbProfileGenerationValidationResult,
): ProfileGenerationValidationResult {
  return {
    id: row.id,
    revisionId: row.revision_id,
    selectorField: row.selector_field,
    sampleUrl: row.sample_url,
    itemId: row.item_id,
    expectedName: row.expected_name,
    brandHint: row.brand_hint,
    extractedValue: safeParseJson<Record<string, unknown>>(row.extracted_value_json),
    imagePreviews: safeParseJson<string[]>(row.image_previews_json),
    warnings: safeParseJson<string[]>(row.warnings_json),
    status: row.status as ProfileGenerationValidationStatus,
    createdAt: row.created_at,
  };
}

export interface InsertValidationResultInput {
  /** Optional for batch insertion; required for single insertion. */
  revisionId?: string;
  selectorField: string;
  sampleUrl: string;
  itemId?: string | null;
  expectedName?: string | null;
  brandHint?: string | null;
  extractedValue?: Record<string, unknown> | null;
  imagePreviews?: string[] | null;
  warnings?: string[] | null;
  status: ProfileGenerationValidationStatus;
}

// fallow-ignore-next-line unused-export
export function insertRevisionValidationResult(
  input: InsertValidationResultInput,
): ProfileGenerationValidationResult {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  // revisionId is required at runtime. The interface marks it optional
  // only so the batch helper (insertRevisionValidationResults) can
  // pass items without it and have the helper fill it in.
  if (!input.revisionId) {
    throw new Error('insertRevisionValidationResult requires a revisionId');
  }
  const revisionId = input.revisionId;

  db.query(`
    INSERT INTO profile_generation_validation_results (
      id, revision_id, selector_field, sample_url, item_id, expected_name,
      brand_hint, extracted_value_json, image_previews_json, warnings_json,
      status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    revisionId,
    input.selectorField,
    input.sampleUrl,
    input.itemId ?? null,
    input.expectedName ?? null,
    input.brandHint ?? null,
    input.extractedValue ? JSON.stringify(input.extractedValue) : null,
    input.imagePreviews ? JSON.stringify(input.imagePreviews) : null,
    input.warnings ? JSON.stringify(input.warnings) : null,
    input.status,
    now,
  );

  return {
    id,
    revisionId,
    selectorField: input.selectorField,
    sampleUrl: input.sampleUrl,
    itemId: input.itemId ?? null,
    expectedName: input.expectedName ?? null,
    brandHint: input.brandHint ?? null,
    extractedValue: input.extractedValue ?? null,
    imagePreviews: input.imagePreviews ?? null,
    warnings: input.warnings ?? null,
    status: input.status,
    createdAt: now,
  };
}

export function insertRevisionValidationResults(
  revisionId: string,
  results: InsertValidationResultInput[],
): ProfileGenerationValidationResult[] {
  return results.map((r) =>
    insertRevisionValidationResult({ ...r, revisionId }),
  );
}

export function listValidationResultsByRevision(
  revisionId: string,
): ProfileGenerationValidationResult[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT * FROM profile_generation_validation_results
       WHERE revision_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(revisionId) as DbProfileGenerationValidationResult[];
  return rows.map(mapToValidationResult);
}
