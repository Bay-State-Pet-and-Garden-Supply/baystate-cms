/**
 * Product Intelligence persistence (PI-2).
 *
 * Durable data model for Product Intelligence runs: runs (immutable input +
 * policy snapshot), the replayable event stream, steps, tool calls, sources,
 * evidence, conflicts, results (schema version + content hash), and
 * Pi-vs-baseline comparisons. Normalized rows are authoritative; onboarding
 * imports reference the originating run and selected evidence.
 *
 * Idempotency: event rows and tool-call rows are keyed by (run_id, sequence);
 * result rows are keyed by run_id and upserted. Duplicate delivery can never
 * create duplicate records.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/19
 */
import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../../shared/stable-id';

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type PiRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type PiRunMode = 'shadow' | 'interactive' | 'onboarding';
export type PiResultDisposition = 'submitted' | 'abstained' | 'unavailable';

export interface PiRunRow {
  id: string;
  workspaceId: string;
  onboardingItemId: string | null;
  mode: PiRunMode;
  status: PiRunStatus;
  executor: string;
  inputJson: string;
  policyJson: string;
  configSnapshotId: string;
  configSnapshotHash: string;
  codeCommit: string | null;
  piVersion: string | null;
  extensionVersionsJson: string;
  startedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  estimatedCost: number | null;
  actualCost: number | null;
  tokenUsageJson: string | null;
}

export interface CreatePiRunInput {
  workspaceId: string;
  onboardingItemId?: string | null;
  mode: PiRunMode;
  executor: string;
  inputJson: string;
  policyJson: string;
  configSnapshotId: string;
  configSnapshotHash: string;
  codeCommit?: string | null;
  piVersion?: string | null;
  extensionVersionsJson?: string;
}

export function createPiRun(input: CreatePiRunInput): PiRunRow {
  const db = getDb();
  const id = randomUUID();
  const startedAt = now();
  db.run(
    `INSERT INTO product_intelligence_runs
     (id, workspace_id, onboarding_item_id, mode, status, executor, input_json,
      policy_json, config_snapshot_id, config_snapshot_hash, code_commit,
      pi_version, extension_versions_json, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.onboardingItemId ?? null,
      input.mode,
      input.executor,
      input.inputJson,
      input.policyJson,
      input.configSnapshotId,
      input.configSnapshotHash,
      input.codeCommit ?? null,
      input.piVersion ?? null,
      input.extensionVersionsJson ?? '[]',
      startedAt,
    ],
  );
  return getPiRun(id) as PiRunRow;
}

const RUN_SELECT = `
  SELECT id, workspace_id AS workspaceId, onboarding_item_id AS onboardingItemId,
         mode, status, executor, input_json AS inputJson, policy_json AS policyJson,
         config_snapshot_id AS configSnapshotId, config_snapshot_hash AS configSnapshotHash,
         code_commit AS codeCommit, pi_version AS piVersion,
         extension_versions_json AS extensionVersionsJson,
         started_at AS startedAt, completed_at AS completedAt, cancelled_at AS cancelledAt,
         error_code AS errorCode, error_message AS errorMessage,
         estimated_cost AS estimatedCost, actual_cost AS actualCost,
         token_usage_json AS tokenUsageJson
  FROM product_intelligence_runs
`;

export function getPiRun(id: string): PiRunRow | undefined {
  const db = getDb();
  return db.query(`${RUN_SELECT} WHERE id = ?`).get(id) as PiRunRow | undefined;
}

export interface ListPiRunsOptions {
  workspaceId?: string;
  status?: PiRunStatus;
  limit?: number;
  offset?: number;
}

export function listPiRuns(options: ListPiRunsOptions = {}): PiRunRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.workspaceId) {
    clauses.push('workspace_id = ?');
    params.push(options.workspaceId);
  }
  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  return db
    .query(`${RUN_SELECT} ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as PiRunRow[];
}

export function countPiRuns(workspaceId: string): number {
  const db = getDb();
  const row = db
    .query('SELECT COUNT(*) AS count FROM product_intelligence_runs WHERE workspace_id = ?')
    .get(workspaceId) as { count: number };
  return Number(row.count);
}

/**
 * Terminal transitions only: running → completed | failed | cancelled.
 * Invalid transitions throw so a run's durable status can never be
 * double-completed or resurrected.
 */
export function transitionPiRunStatus(
  id: string,
  next: PiRunStatus,
  fields: {
    completedAt?: string | null;
    cancelledAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    piVersion?: string | null;
    actualCost?: number | null;
    tokenUsageJson?: string | null;
  } = {},
): PiRunRow {
  const db = getDb();
  const current = getPiRun(id);
  if (!current) throw new Error(`Product intelligence run not found: ${id}`);
  if (current.status !== 'running') {
    throw new Error(
      `Cannot transition run ${id} from '${current.status}' to '${next}': only running runs transition terminally`,
    );
  }
  const completedAt = next === 'completed' ? (fields.completedAt ?? now()) : null;
  const cancelledAt = next === 'cancelled' ? (fields.cancelledAt ?? now()) : null;
  db.run(
    `UPDATE product_intelligence_runs SET status = ?,
       completed_at = COALESCE(?, completed_at),
       cancelled_at = COALESCE(?, cancelled_at),
       error_code = COALESCE(?, error_code),
       error_message = COALESCE(?, error_message),
       pi_version = COALESCE(?, pi_version),
       actual_cost = COALESCE(?, actual_cost),
       token_usage_json = COALESCE(?, token_usage_json)
     WHERE id = ?`,
    [
      next,
      completedAt,
      cancelledAt,
      fields.errorCode ?? null,
      fields.errorMessage ?? null,
      fields.piVersion ?? null,
      fields.actualCost ?? null,
      fields.tokenUsageJson ?? null,
      id,
    ],
  );
  return getPiRun(id) as PiRunRow;
}

// ---------------------------------------------------------------------------
// Event stream (idempotent by (run_id, sequence))
// ---------------------------------------------------------------------------

export interface PiEventRow {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payloadJson: string;
  createdAt: string;
}

/**
 * Append an event. Idempotent: a duplicate (run_id, sequence) is ignored and
 * returns false, so re-delivery can never create duplicate records.
 */
export function appendPiEvent(runId: string, sequence: number, type: string, payload: unknown): boolean {
  const db = getDb();
  const result = db.run(
    `INSERT OR IGNORE INTO product_intelligence_events
     (id, run_id, sequence, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), runId, sequence, type, JSON.stringify(payload ?? {}), now()],
  );
  return result.changes > 0;
}

/** Events after a cursor, in order (replay source for SSE reconnect). */
export function listPiEvents(runId: string, afterSequence = -1): PiEventRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, run_id AS runId, sequence, type, payload_json AS payloadJson, created_at AS createdAt
       FROM product_intelligence_events
       WHERE run_id = ? AND sequence > ?
       ORDER BY sequence ASC`,
    )
    .all(runId, afterSequence) as PiEventRow[];
}

export function latestPiEventSequence(runId: string): number {
  const db = getDb();
  const row = db
    .query('SELECT COALESCE(MAX(sequence), -1) AS seq FROM product_intelligence_events WHERE run_id = ?')
    .get(runId) as { seq: number };
  return Number(row.seq);
}

// ---------------------------------------------------------------------------
// Steps and tool calls
// ---------------------------------------------------------------------------

export interface PiStepRow {
  id: string;
  runId: string;
  stepType: string;
  sequence: number;
  status: 'running' | 'completed' | 'failed';
  summary: string | null;
  inputHash: string | null;
  outputRef: string | null;
  startedAt: string;
  completedAt: string | null;
  errorJson: string | null;
}

export function insertPiStep(input: {
  runId: string;
  stepType: string;
  sequence: number;
  summary?: string | null;
  inputHash?: string | null;
}): PiStepRow {
  const db = getDb();
  const id = randomUUID();
  const startedAt = now();
  db.run(
    `INSERT OR IGNORE INTO product_intelligence_steps
     (id, run_id, step_type, sequence, status, summary, input_hash, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    [id, input.runId, input.stepType, input.sequence, input.summary ?? null, input.inputHash ?? null, startedAt],
  );
  const row = db
    .query(
      `SELECT id, run_id AS runId, step_type AS stepType, sequence, status,
              summary, input_hash AS inputHash, output_ref AS outputRef,
              started_at AS startedAt, completed_at AS completedAt, error_json AS errorJson
       FROM product_intelligence_steps WHERE id = ?`,
    )
    .get(id) as PiStepRow | undefined;
  return row as PiStepRow;
}

export function completePiStep(
  id: string,
  fields: { status?: 'completed' | 'failed'; summary?: string | null; outputRef?: string | null; errorJson?: string | null } = {},
): void {
  const db = getDb();
  db.run(
    `UPDATE product_intelligence_steps SET status = ?, completed_at = ?,
       summary = COALESCE(?, summary), output_ref = COALESCE(?, output_ref),
       error_json = COALESCE(?, error_json)
     WHERE id = ?`,
    [fields.status ?? 'completed', now(), fields.summary ?? null, fields.outputRef ?? null, fields.errorJson ?? null, id],
  );
}

export interface PiToolCallRow {
  id: string;
  runId: string;
  stepId: string | null;
  sequence: number;
  toolName: string;
  toolVersion: string | null;
  policyOutcome: 'allowed' | 'denied' | 'budget_exceeded';
  requestHash: string | null;
  responseHash: string | null;
  artifactRef: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  startedAt: string;
  completedAt: string | null;
  errorJson: string | null;
}

export function insertPiToolCall(input: {
  runId: string;
  stepId?: string | null;
  sequence: number;
  toolName: string;
  toolVersion?: string | null;
  policyOutcome?: 'allowed' | 'denied' | 'budget_exceeded';
  requestHash?: string | null;
  artifactRef?: string | null;
}): PiToolCallRow {
  const db = getDb();
  const id = randomUUID();
  const startedAt = now();
  db.run(
    `INSERT OR IGNORE INTO product_intelligence_tool_calls
     (id, run_id, step_id, sequence, tool_name, tool_version, policy_outcome,
      request_hash, artifact_ref, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.stepId ?? null,
      input.sequence,
      input.toolName,
      input.toolVersion ?? null,
      input.policyOutcome ?? 'allowed',
      input.requestHash ?? null,
      input.artifactRef ?? null,
      startedAt,
    ],
  );
  const row = db
    .query(
      `SELECT id, run_id AS runId, step_id AS stepId, sequence, tool_name AS toolName,
              tool_version AS toolVersion, policy_outcome AS policyOutcome,
              request_hash AS requestHash, response_hash AS responseHash,
              artifact_ref AS artifactRef, latency_ms AS latencyMs, cost_usd AS costUsd,
              started_at AS startedAt, completed_at AS completedAt, error_json AS errorJson
       FROM product_intelligence_tool_calls WHERE id = ?`,
    )
    .get(id) as PiToolCallRow | undefined;
  return row as PiToolCallRow;
}

export function completePiToolCall(
  id: string,
  fields: { isError?: boolean; responseHash?: string | null; latencyMs?: number | null; costUsd?: number | null; errorJson?: string | null } = {},
): void {
  const db = getDb();
  const started = db
    .query('SELECT started_at AS startedAt FROM product_intelligence_tool_calls WHERE id = ?')
    .get(id) as { startedAt: string } | undefined;
  const latencyMs = fields.latencyMs ?? (started ? Math.max(0, Date.now() - Date.parse(started.startedAt)) : null);
  db.run(
    `UPDATE product_intelligence_tool_calls SET completed_at = ?, latency_ms = ?,
       response_hash = COALESCE(?, response_hash), cost_usd = COALESCE(?, cost_usd),
       error_json = ?,
       policy_outcome = CASE WHEN ? = 1 AND policy_outcome = 'allowed' THEN 'denied' ELSE policy_outcome END
     WHERE id = ?`,
    [
      now(),
      latencyMs,
      fields.responseHash ?? null,
      fields.costUsd ?? null,
      fields.isError ? JSON.stringify({ message: fields.errorJson ?? 'tool execution failed' }) : null,
      fields.isError ? 1 : 0,
      id,
    ],
  );
}

export function listPiToolCalls(runId: string): PiToolCallRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, run_id AS runId, step_id AS stepId, sequence, tool_name AS toolName,
              tool_version AS toolVersion, policy_outcome AS policyOutcome,
              request_hash AS requestHash, response_hash AS responseHash,
              artifact_ref AS artifactRef, latency_ms AS latencyMs, cost_usd AS costUsd,
              started_at AS startedAt, completed_at AS completedAt, error_json AS errorJson
       FROM product_intelligence_tool_calls WHERE run_id = ? ORDER BY sequence ASC`,
    )
    .all(runId) as PiToolCallRow[];
}

// ---------------------------------------------------------------------------
// Sources, evidence, conflicts
// ---------------------------------------------------------------------------

export interface PiSourceRow {
  id: string;
  runId: string;
  url: string;
  canonicalUrl: string | null;
  domain: string;
  sourceType: string;
  gtinMatchStatus: string;
  variantMatchStatus: string;
  retrievedAt: string | null;
  contentHash: string | null;
  artifactRef: string | null;
  licenseRef: string | null;
  termsRef: string | null;
  createdAt: string;
}

export function insertPiSource(input: {
  runId: string;
  url: string;
  canonicalUrl?: string | null;
  domain: string;
  sourceType: string;
  gtinMatchStatus?: string;
  variantMatchStatus?: string;
  retrievedAt?: string | null;
  contentHash?: string | null;
  artifactRef?: string | null;
  licenseRef?: string | null;
  termsRef?: string | null;
}): PiSourceRow {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO product_intelligence_sources
     (id, run_id, url, canonical_url, domain, source_type, gtin_match_status,
      variant_match_status, retrieved_at, content_hash, artifact_ref, license_ref,
      terms_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.url,
      input.canonicalUrl ?? null,
      input.domain,
      input.sourceType,
      input.gtinMatchStatus ?? 'unknown',
      input.variantMatchStatus ?? 'unknown',
      input.retrievedAt ?? null,
      input.contentHash ?? null,
      input.artifactRef ?? null,
      input.licenseRef ?? null,
      input.termsRef ?? null,
      now(),
    ],
  );
  return db
    .query(
      `SELECT id, run_id AS runId, url, canonical_url AS canonicalUrl, domain,
              source_type AS sourceType, gtin_match_status AS gtinMatchStatus,
              variant_match_status AS variantMatchStatus, retrieved_at AS retrievedAt,
              content_hash AS contentHash, artifact_ref AS artifactRef,
              license_ref AS licenseRef, terms_ref AS termsRef, created_at AS createdAt
       FROM product_intelligence_sources WHERE id = ?`,
    )
    .get(id) as PiSourceRow;
}

export function listPiSources(runId: string): PiSourceRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, run_id AS runId, url, canonical_url AS canonicalUrl, domain,
              source_type AS sourceType, gtin_match_status AS gtinMatchStatus,
              variant_match_status AS variantMatchStatus, retrieved_at AS retrievedAt,
              content_hash AS contentHash, artifact_ref AS artifactRef,
              license_ref AS licenseRef, terms_ref AS termsRef, created_at AS createdAt
       FROM product_intelligence_sources WHERE run_id = ? ORDER BY created_at ASC`,
    )
    .all(runId) as PiSourceRow[];
}

export interface PiEvidenceRow {
  id: string;
  runId: string;
  sourceId: string;
  targetField: string;
  valueJson: string;
  extractionMethod: string | null;
  sourceField: string | null;
  reliability: string | null;
  directSupport: number;
  snippet: string | null;
  metadataJson: string | null;
  createdAt: string;
}

export function insertPiEvidence(input: {
  runId: string;
  sourceId: string;
  targetField: string;
  value: unknown;
  extractionMethod?: string | null;
  sourceField?: string | null;
  reliability?: string | null;
  directSupport?: boolean;
  snippet?: string | null;
  metadata?: unknown;
}): PiEvidenceRow {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO product_intelligence_evidence
     (id, run_id, source_id, target_field, value_json, extraction_method,
      source_field, reliability, direct_support, snippet, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.sourceId,
      input.targetField,
      JSON.stringify(input.value),
      input.extractionMethod ?? null,
      input.sourceField ?? null,
      input.reliability ?? null,
      input.directSupport ? 1 : 0,
      input.snippet ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now(),
    ],
  );
  return db
    .query(
      `SELECT id, run_id AS runId, source_id AS sourceId, target_field AS targetField,
              value_json AS valueJson, extraction_method AS extractionMethod,
              source_field AS sourceField, reliability, direct_support AS directSupport,
              snippet, metadata_json AS metadataJson, created_at AS createdAt
       FROM product_intelligence_evidence WHERE id = ?`,
    )
    .get(id) as PiEvidenceRow;
}

export function listPiEvidence(runId: string): PiEvidenceRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, run_id AS runId, source_id AS sourceId, target_field AS targetField,
              value_json AS valueJson, extraction_method AS extractionMethod,
              source_field AS sourceField, reliability, direct_support AS directSupport,
              snippet, metadata_json AS metadataJson, created_at AS createdAt
       FROM product_intelligence_evidence WHERE run_id = ? ORDER BY created_at ASC`,
    )
    .all(runId) as PiEvidenceRow[];
}

export interface PiConflictRow {
  id: string;
  runId: string;
  field: string;
  severity: 'low' | 'medium' | 'high';
  status: 'open' | 'resolved' | 'dismissed';
  competingValuesJson: string;
  evidenceIdsJson: string;
  resolutionJson: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export function insertPiConflict(input: {
  runId: string;
  field: string;
  severity: 'low' | 'medium' | 'high';
  competingValues?: unknown[];
  evidenceIds?: string[];
  resolution?: unknown;
  resolvedBy?: string | null;
}): PiConflictRow {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO product_intelligence_conflicts
     (id, run_id, field, severity, status, competing_values_json, evidence_ids_json,
      resolution_json, resolved_by, resolved_at, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.field,
      input.severity,
      JSON.stringify(input.competingValues ?? []),
      JSON.stringify(input.evidenceIds ?? []),
      input.resolution ? JSON.stringify(input.resolution) : null,
      input.resolvedBy ?? null,
      input.resolution ? now() : null,
      now(),
    ],
  );
  return db
    .query(
      `SELECT id, run_id AS runId, field, severity, status,
              competing_values_json AS competingValuesJson,
              evidence_ids_json AS evidenceIdsJson, resolution_json AS resolutionJson,
              resolved_by AS resolvedBy, resolved_at AS resolvedAt, created_at AS createdAt
       FROM product_intelligence_conflicts WHERE id = ?`,
    )
    .get(id) as PiConflictRow;
}

/** Durable resolution of a conflict by a human reviewer (never auto-applied). */
export function resolvePiConflict(
  id: string,
  resolution: { status: 'resolved' | 'dismissed'; resolution?: unknown; resolvedBy: string },
): void {
  const db = getDb();
  db.run(
    `UPDATE product_intelligence_conflicts SET status = ?, resolution_json = ?,
       resolved_by = ?, resolved_at = ? WHERE id = ?`,
    [
      resolution.status,
      resolution.resolution ? JSON.stringify(resolution.resolution) : null,
      resolution.resolvedBy,
      now(),
      id,
    ],
  );
}

export function listPiConflicts(runId: string): PiConflictRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, run_id AS runId, field, severity, status,
              competing_values_json AS competingValuesJson,
              evidence_ids_json AS evidenceIdsJson, resolution_json AS resolutionJson,
              resolved_by AS resolvedBy, resolved_at AS resolvedAt, created_at AS createdAt
       FROM product_intelligence_conflicts WHERE run_id = ? ORDER BY created_at ASC`,
    )
    .all(runId) as PiConflictRow[];
}

// ---------------------------------------------------------------------------
// Results and comparisons
// ---------------------------------------------------------------------------

export interface PiResultRow {
  id: string;
  runId: string;
  schemaVersion: number;
  disposition: PiResultDisposition;
  resultJson: string;
  resultHash: string;
  createdAt: string;
}

/** Upsert by run_id: re-delivery of the same result replaces, never duplicates. */
export function insertPiResult(input: {
  runId: string;
  schemaVersion: number;
  disposition: PiResultDisposition;
  result: unknown;
}): PiResultRow {
  const db = getDb();
  const id = randomUUID();
  const resultJson = JSON.stringify(input.result);
  const resultHash = sha256Hex(resultJson);
  db.run(
    `INSERT INTO product_intelligence_results
       (id, run_id, schema_version, disposition, result_json, result_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       disposition = excluded.disposition,
       result_json = excluded.result_json,
       result_hash = excluded.result_hash,
       created_at = excluded.created_at`,
    [id, input.runId, input.schemaVersion, input.disposition, resultJson, resultHash, now()],
  );
  return db
    .query(
      `SELECT id, run_id AS runId, schema_version AS schemaVersion, disposition,
              result_json AS resultJson, result_hash AS resultHash, created_at AS createdAt
       FROM product_intelligence_results WHERE run_id = ?`,
    )
    .get(input.runId) as PiResultRow;
}

export function getPiResult(runId: string): PiResultRow | undefined {
  const db = getDb();
  return db
    .query(
      `SELECT id, run_id AS runId, schema_version AS schemaVersion, disposition,
              result_json AS resultJson, result_hash AS resultHash, created_at AS createdAt
       FROM product_intelligence_results WHERE run_id = ?`,
    )
    .get(runId) as PiResultRow | undefined;
}

export interface PiComparisonRow {
  id: string;
  runId: string;
  baselineType: string;
  baselineRef: string;
  metricsJson: string;
  createdAt: string;
}

export function insertPiComparison(input: {
  runId: string;
  baselineType: string;
  baselineRef: string;
  metrics: unknown;
}): PiComparisonRow {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO product_intelligence_comparisons
     (id, run_id, baseline_type, baseline_ref, metrics_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.runId, input.baselineType, input.baselineRef, JSON.stringify(input.metrics ?? {}), now()],
  );
  return db
    .query(
      `SELECT id, run_id AS runId, baseline_type AS baselineType, baseline_ref AS baselineRef,
              metrics_json AS metricsJson, created_at AS createdAt
       FROM product_intelligence_comparisons WHERE id = ?`,
    )
    .get(id) as PiComparisonRow;
}

export function listPiComparisons(runId: string): PiComparisonRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, run_id AS runId, baseline_type AS baselineType, baseline_ref AS baselineRef,
              metrics_json AS metricsJson, created_at AS createdAt
       FROM product_intelligence_comparisons WHERE run_id = ? ORDER BY created_at ASC`,
    )
    .all(runId) as PiComparisonRow[];
}

// ---------------------------------------------------------------------------
// Retention and deletion (explicit policy)
// ---------------------------------------------------------------------------

/** Hard-delete one run and everything that references it (cascade). */
export function deletePiRun(id: string): boolean {
  const db = getDb();
  const result = db.run('DELETE FROM product_intelligence_runs WHERE id = ?', [id]);
  return result.changes > 0;
}

/**
 * Retention policy: delete completed/failed/cancelled runs older than the
 * cutoff. Running runs are never deleted. Returns the number of runs removed
 * (counted before the delete — bun:sqlite's `changes` includes cascade
 * child rows, which would over-report).
 */
export function deletePiRunsOlderThan(workspaceId: string, cutoffIso: string): number {
  const db = getDb();
  const matched = db
    .query(
      `SELECT COUNT(*) AS c FROM product_intelligence_runs
       WHERE workspace_id = ? AND started_at < ? AND status != 'running'`,
    )
    .get(workspaceId, cutoffIso) as { c: number };
  db.run(
    `DELETE FROM product_intelligence_runs
     WHERE workspace_id = ? AND started_at < ? AND status != 'running'`,
    [workspaceId, cutoffIso],
  );
  return Number(matched.c);
}
