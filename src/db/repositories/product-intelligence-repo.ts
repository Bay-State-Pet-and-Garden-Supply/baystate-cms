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
  promptHash: string | null;
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
  /** PI-10 replay lineage: the run this run was replayed from (NULL = original). */
  originRunId: string | null;
  /** PI-10 replay depth: 0 for originals, +1 per replay hop. */
  replayDepth: number;
  /** Review finding 7: the approved-policy record this run's policy was
   *  derived from, and the reducing overrides applied (atomic with insert). */
  basePolicyId: string | null;
  basePolicyVersion: number | null;
  policyOverridesJson: string | null;
  /** Round-8 (review P1): effective research/terminal tool versions + schema
   *  hashes, captured at session creation (see setRunToolsJson). */
  toolsJson: string | null;
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
  promptHash?: string | null;
  piVersion?: string | null;
  extensionVersionsJson?: string;
  /** PI-10: origin run for replays (originals leave null). */
  originRunId?: string | null;
  /** PI-10: replay hop depth; 0 for originals. */
  replayDepth?: number;
  /** PI-10: deterministic replays insert an already-terminal run. */
  status?: 'completed';
  completedAt?: string | null;
  /** Review finding 7: approved-policy lineage, atomic with the insert. */
  basePolicyId?: string | null;
  basePolicyVersion?: number | null;
  policyOverridesJson?: string | null;
  /** Round-8 (review P1): effective tool versions/schema hashes (JSON array). */
  toolsJson?: string | null;
}

export function createPiRun(input: CreatePiRunInput): PiRunRow {
  const db = getDb();
  const id = randomUUID();
  const startedAt = now();
  const completedAt = input.status === 'completed' ? (input.completedAt ?? startedAt) : null;
  db.run(
    `INSERT INTO product_intelligence_runs
     (id, workspace_id, onboarding_item_id, mode, status, executor, input_json,
      policy_json, config_snapshot_id, config_snapshot_hash, code_commit,
      prompt_hash, pi_version, extension_versions_json, started_at, completed_at,
      origin_run_id, replay_depth, base_policy_id, base_policy_version, policy_overrides_json,
      tools_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.onboardingItemId ?? null,
      input.mode,
      input.status ?? 'running',
      input.executor,
      input.inputJson,
      input.policyJson,
      input.configSnapshotId,
      input.configSnapshotHash,
      input.codeCommit ?? null,
      input.promptHash ?? null,
      input.piVersion ?? null,
      input.extensionVersionsJson ?? '[]',
      startedAt,
      completedAt,
      input.originRunId ?? null,
      input.replayDepth ?? 0,
      input.basePolicyId ?? null,
      input.basePolicyVersion ?? null,
      input.policyOverridesJson ?? null,
      input.toolsJson ?? null,
    ],
  );
  return getPiRun(id) as PiRunRow;
}

const RUN_SELECT = `
  SELECT id, workspace_id AS workspaceId, onboarding_item_id AS onboardingItemId,
         mode, status, executor, input_json AS inputJson, policy_json AS policyJson,
         config_snapshot_id AS configSnapshotId, config_snapshot_hash AS configSnapshotHash,
         code_commit AS codeCommit, prompt_hash AS promptHash, pi_version AS piVersion,
         extension_versions_json AS extensionVersionsJson,
         started_at AS startedAt, completed_at AS completedAt, cancelled_at AS cancelledAt,
         error_code AS errorCode, error_message AS errorMessage,
         estimated_cost AS estimatedCost, actual_cost AS actualCost,
         token_usage_json AS tokenUsageJson,
         origin_run_id AS originRunId, replay_depth AS replayDepth,
         base_policy_id AS basePolicyId, base_policy_version AS basePolicyVersion,
         policy_overrides_json AS policyOverridesJson,
         tools_json AS toolsJson
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

/** Round-8 (review P1): capture the session's effective research/terminal
 *  tools ({ name, version, schemaHash }[]) on the run. Called by the Pi
 *  executor once the session exists (the tools are not knowable at
 *  createPiRun time). Best-effort capture — a failure never breaks the run. */
export function setRunToolsJson(runId: string, tools: unknown): void {
  const db = getDb();
  db.run('UPDATE product_intelligence_runs SET tools_json = ? WHERE id = ?', [
    JSON.stringify(tools ?? []),
    runId,
  ]);
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
    /** PI-10: provider-reported cost as the pre-billing estimate (same figure
     *  as actualCost until real billing arrives). */
    estimatedCost?: number | null;
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
       estimated_cost = COALESCE(?, estimated_cost),
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
      fields.estimatedCost ?? null,
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

/** Evidence rows whose durable metadata carries one of the tool evidence ids
 *  (PI smoke fix: terminal submissions cite deterministic evidenceId() strings
 *  that must resolve to durable rows). */
export function listPiEvidenceByToolEvidenceId(runId: string, toolEvidenceIds: string[]): PiEvidenceRow[] {
  const db = getDb();
  if (toolEvidenceIds.length === 0) return [];
  const placeholders = toolEvidenceIds.map(() => '?').join(', ');
  return db
    .query(
      `SELECT id, run_id AS runId, source_id AS sourceId, target_field AS targetField,
              value_json AS valueJson, extraction_method AS extractionMethod,
              source_field AS sourceField, reliability, direct_support AS directSupport,
              snippet, metadata_json AS metadataJson, created_at AS createdAt
       FROM product_intelligence_evidence
       WHERE run_id = ? AND json_extract(metadata_json, '$.toolEvidenceId') IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .all(runId, ...toolEvidenceIds) as PiEvidenceRow[];
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
// Image assets (PI-6)
// ---------------------------------------------------------------------------

export interface PiAssetRow {
  id: string;
  runId: string;
  sourceId: string | null;
  sourceUrl: string;
  sourcePageUrl: string | null;
  sourceType: string;
  sourcePath: string | null;
  sourceArtifactId: string | null;
  extractionMethod: string;
  retrievedAt: string;
  originalContentHash: string;
  perceptualHash: string | null;
  variantReference: string | null;
  rightsStatus: string;
  rightsBasis: string | null;
  rightsEvidenceRef: string | null;
  observedBrand: string | null;
  observedProductName: string | null;
  observedVariant: string | null;
  observedNetContentJson: string | null;
  observedPackCount: number | null;
  observedGtin: string | null;
  exactProductMatch: number;
  exactVariantMatch: number | null;
  qualityStatus: string;
  commerceApproved: number;
  conflictsJson: string;
  payloadJson: string;
  createdAt: string;
  /** Round-4: canonical identity snapshot (runId+gtin+name) the asset was
   *  verified against — binds the asset to the run's immutable identity. */
  verifiedAgainstJson: string | null;
  verifiedAgainstHash: string | null;
  /** Round-4: durable source-kind derived from the source row at
   *  verification time (never the agent's declared string). */
  declaredSourceType: string | null;
  /** Round-10/11: exact pi_image_candidates FK the asset was verified from
   *  (same-run + image_url === source_url enforced by trigger). */
  candidateId: string | null;
  /** Round-12: qualifying brand evidence binding (row id + content hash). */
  brandEvidenceId?: string | null;
  brandEvidenceHash?: string | null;
}

const ASSET_SELECT = `
  SELECT id, run_id AS runId, source_id AS sourceId, source_url AS sourceUrl,
         source_page_url AS sourcePageUrl, source_type AS sourceType,
         source_path AS sourcePath, source_artifact_id AS sourceArtifactId,
         extraction_method AS extractionMethod, retrieved_at AS retrievedAt,
         original_content_hash AS originalContentHash, perceptual_hash AS perceptualHash,
         variant_reference AS variantReference, rights_status AS rightsStatus,
         rights_basis AS rightsBasis, rights_evidence_ref AS rightsEvidenceRef,
         observed_brand AS observedBrand, observed_product_name AS observedProductName,
         observed_variant AS observedVariant, observed_net_content_json AS observedNetContentJson,
         observed_pack_count AS observedPackCount, observed_gtin AS observedGtin,
         exact_product_match AS exactProductMatch, exact_variant_match AS exactVariantMatch,
         quality_status AS qualityStatus, commerce_approved AS commerceApproved,
         conflicts_json AS conflictsJson, payload_json AS payloadJson, created_at AS createdAt,
         verified_against_json AS verifiedAgainstJson, verified_against_hash AS verifiedAgainstHash,
         declared_source_type AS declaredSourceType,
         candidate_id AS candidateId, brand_evidence_id AS brandEvidenceId,
         brand_evidence_hash AS brandEvidenceHash
  FROM product_intelligence_assets
`;

// ---------------------------------------------------------------------------
// Round-7 (review P0): server-CREATED image-candidate provenance. The
// candidate -> discovering-page relationship is established by the server
// when discover_image_candidates runs; verify_image_candidate cites the
// durable record and source tier / rights resolve from its discovering
// source — never from agent-supplied provenance strings.
// ---------------------------------------------------------------------------

export interface PiImageCandidateRow {
  id: string;
  runId: string;
  imageUrl: string;
  discoveringSourceId: string | null;
  sourceArtifactId: string | null;
  sourcePath: string | null;
  extractionMethod: string | null;
  variantReference: string | null;
  attestationArtifactId: string | null;
  attestedContentHash: string | null;
  entityId: string | null;
  createdAt: string;
}

const IMAGE_CANDIDATE_SELECT = `
  SELECT id, run_id AS runId, image_url AS imageUrl,
         discovering_source_id AS discoveringSourceId,
         source_artifact_id AS sourceArtifactId,
         source_path AS sourcePath,
         extraction_method AS extractionMethod,
         variant_reference AS variantReference,
         entity_id AS entityId,
         attestation_artifact_id AS attestationArtifactId,
         attested_content_hash AS attestedContentHash,
         created_at AS createdAt
  FROM pi_image_candidates
`;

export function insertPiImageCandidate(input: {
  runId: string;
  imageUrl: string;
  discoveringSourceId?: string | null;
  sourceArtifactId?: string | null;
  sourcePath?: string | null;
  extractionMethod?: string | null;
  variantReference?: string | null;
  entityId?: string | null;
  attestationArtifactId?: string | null;
  attestedContentHash?: string | null;
}): PiImageCandidateRow {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO pi_image_candidates
     (id, run_id, image_url, discovering_source_id, source_artifact_id,
      source_path, extraction_method, variant_reference, entity_id,
      attestation_artifact_id, attested_content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.imageUrl,
      input.discoveringSourceId ?? null,
      input.sourceArtifactId ?? null,
      input.sourcePath ?? null,
      input.extractionMethod ?? null,
      input.variantReference ?? null,
      input.entityId ?? null,
      input.attestationArtifactId ?? null,
      input.attestedContentHash ?? null,
      now(),
    ],
  );
  return db.query(`${IMAGE_CANDIDATE_SELECT} WHERE id = ?`).get(id) as PiImageCandidateRow;
}

export function getPiImageCandidate(id: string): PiImageCandidateRow | undefined {
  const db = getDb();
  return db.query(`${IMAGE_CANDIDATE_SELECT} WHERE id = ?`).get(id) as PiImageCandidateRow | undefined;
}

export function listPiImageCandidatesByRun(runId: string): PiImageCandidateRow[] {
  const db = getDb();
  return db.query(`${IMAGE_CANDIDATE_SELECT} WHERE run_id = ? ORDER BY created_at`).all(runId) as PiImageCandidateRow[];
}

// ---------------------------------------------------------------------------
// Round-9 (P1-1/P1-5): retained page artifacts for artifact-driven image
// discovery. The server stores bounded page bytes + hash; the agent never
// supplies artifact bytes — discovery loads these records by id.
// ---------------------------------------------------------------------------

export interface PiPageArtifactRow {
  id: string;
  runId: string;
  url: string;
  contentHash: string;
  content: string;
  sizeBytes: number;
  /** Round-10 (P1-6): 'page_html' today; future browser-network captures get 'browser_network_capture'. */
  artifactType?: string;
  createdAt: string;
}

const PAGE_ARTIFACT_SELECT = `
  SELECT id, run_id AS runId, url, content_hash AS contentHash,
         content, size_bytes AS sizeBytes, artifact_type AS artifactType,
         created_at AS createdAt
  FROM pi_page_artifacts
`;

/** Cap for retained page content (bytes). Larger pages are not retained —
 *  artifact-driven discovery is simply unavailable for them (no artifact id). */
export const MAX_PI_PAGE_ARTIFACT_BYTES = 2 * 1024 * 1024;

export function insertPiPageArtifact(input: {
  runId: string;
  url: string;
  contentHash: string;
  content: string;
  artifactType?: string;
}): PiPageArtifactRow {
  const sizeBytes = Buffer.byteLength(input.content, 'utf8');
  if (sizeBytes > MAX_PI_PAGE_ARTIFACT_BYTES) {
    throw new Error(`page artifact exceeds ${MAX_PI_PAGE_ARTIFACT_BYTES} bytes (${sizeBytes}) — not retained`);
  }
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO pi_page_artifacts
     (id, run_id, url, content_hash, content, size_bytes, artifact_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.runId, input.url, input.contentHash, input.content, sizeBytes, input.artifactType ?? 'page_html', now()],
  );
  return db.query(`${PAGE_ARTIFACT_SELECT} WHERE id = ?`).get(id) as PiPageArtifactRow;
}

export function getPiPageArtifact(id: string): PiPageArtifactRow | undefined {
  const db = getDb();
  return db.query(`${PAGE_ARTIFACT_SELECT} WHERE id = ?`).get(id) as PiPageArtifactRow | undefined;
}

/** Round-10 (review P0): artifact lookup is scoped to the CURRENT run —
 *  possession of an artifact UUID from another run/workspace is never
 *  authorization to load its retained content or mint rows in this run. */
export function getPiPageArtifactForRun(runId: string, id: string): PiPageArtifactRow | undefined {
  const db = getDb();
  return db.query(`${PAGE_ARTIFACT_SELECT} WHERE id = ? AND run_id = ?`).get(id, runId) as
    | PiPageArtifactRow
    | undefined;
}

export function listPiPageArtifactsByRun(runId: string): PiPageArtifactRow[] {
  const db = getDb();
  return db.query(`${PAGE_ARTIFACT_SELECT} WHERE run_id = ? ORDER BY created_at`).all(runId) as PiPageArtifactRow[];
}

export function insertPiAsset(input: {
  runId: string;
  sourceId?: string | null;
  sourceUrl: string;
  sourcePageUrl?: string | null;
  sourceType: string;
  sourcePath?: string | null;
  sourceArtifactId?: string | null;
  extractionMethod: string;
  retrievedAt: string;
  originalContentHash: string;
  perceptualHash?: string | null;
  variantReference?: string | null;
  rightsStatus: 'approved' | 'restricted' | 'unknown';
  rightsBasis?: string | null;
  rightsEvidenceRef?: string | null;
  observedBrand?: string | null;
  observedProductName?: string | null;
  observedVariant?: string | null;
  observedNetContent?: unknown;
  observedPackCount?: number | null;
  observedGtin?: string | null;
  exactProductMatch?: boolean;
  exactVariantMatch?: boolean | null;
  qualityStatus: 'usable' | 'low_quality' | 'invalid';
  commerceApproved?: boolean;
  conflicts?: string[];
  payload?: unknown;
  /** Round-4: canonical identity snapshot + hash the asset was verified
   *  against (server-derived); declaredSourceType = durable source-kind. */
  verifiedAgainstJson?: string | null;
  verifiedAgainstHash?: string | null;
  declaredSourceType?: string | null;
  /** Round-10 (review P1): exact FK to the pi_image_candidates row this
   *  asset was verified from (same-run enforced by trigger). */
  candidateId?: string | null;
  /** Round-12 (review P0-3): the QUALIFYING brand evidence binding — the
   *  exact evidence row + content hash that established the observed brand
   *  (byte-bound OCR/decoder observation or entity-linked structured
   *  evidence). Never reconstructed from observedBrand later. */
  brandEvidenceId?: string | null;
  brandEvidenceHash?: string | null;
}): PiAssetRow {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO product_intelligence_assets
     (id, run_id, source_id, source_url, source_page_url, source_type,
      source_path, source_artifact_id, extraction_method, retrieved_at,
      original_content_hash, perceptual_hash, variant_reference, rights_status,
      rights_basis, rights_evidence_ref, observed_brand, observed_product_name,
      observed_variant, observed_net_content_json, observed_pack_count,
      observed_gtin, exact_product_match, exact_variant_match, quality_status,
      commerce_approved, conflicts_json, payload_json, created_at,
      verified_against_json, verified_against_hash, declared_source_type,
      candidate_id, brand_evidence_id, brand_evidence_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runId,
      input.sourceId ?? null,
      input.sourceUrl,
      input.sourcePageUrl ?? null,
      input.sourceType,
      input.sourcePath ?? null,
      input.sourceArtifactId ?? null,
      input.extractionMethod,
      input.retrievedAt,
      input.originalContentHash,
      input.perceptualHash ?? null,
      input.variantReference ?? null,
      input.rightsStatus,
      input.rightsBasis ?? null,
      input.rightsEvidenceRef ?? null,
      input.observedBrand ?? null,
      input.observedProductName ?? null,
      input.observedVariant ?? null,
      input.observedNetContent ? JSON.stringify(input.observedNetContent) : null,
      input.observedPackCount ?? null,
      input.observedGtin ?? null,
      input.exactProductMatch ? 1 : 0,
      input.exactVariantMatch === null || input.exactVariantMatch === undefined ? null : input.exactVariantMatch ? 1 : 0,
      input.qualityStatus,
      input.commerceApproved ? 1 : 0,
      JSON.stringify(input.conflicts ?? []),
      input.payload ? JSON.stringify(input.payload) : '{}',
      now(),
      input.verifiedAgainstJson ?? null,
      input.verifiedAgainstHash ?? null,
      input.declaredSourceType ?? null,
      input.candidateId ?? null,
      input.brandEvidenceId ?? null,
      input.brandEvidenceHash ?? null,
    ],
  );
  return db.query(`${ASSET_SELECT} WHERE id = ?`).get(id) as PiAssetRow;
}

export function listPiAssetsByRun(runId: string): PiAssetRow[] {
  const db = getDb();
  return db.query(`${ASSET_SELECT} WHERE run_id = ? ORDER BY created_at ASC`).all(runId) as PiAssetRow[];
}

/** Round-3 (review finding 5): resolve durable verified asset rows by id,
 *  independent of run — the terminal bundle cites server-verified asset ids
 *  and the validator/persistence re-derive authority from these rows. */
export function getPiAssetsByIds(ids: string[]): PiAssetRow[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  return db.query(`${ASSET_SELECT} WHERE id IN (${placeholders})`).all(...ids) as PiAssetRow[];
}

export function countPiAssets(runId: string): number {
  const db = getDb();
  const row = db.query('SELECT COUNT(*) AS c FROM product_intelligence_assets WHERE run_id = ?').get(runId) as { c: number };
  return Number(row.c);
}

// ---------------------------------------------------------------------------
// Onboarding imports (PI-8)
// ---------------------------------------------------------------------------

export interface PiImportRow {
  id: string;
  runId: string | null;
  onboardingItemId: string;
  resultHash: string;
  mode: 'create' | 'augment';
  importingUser: string | null;
  status: 'active' | 'superseded' | 'stale';
  fieldSelectionJson: string;
  excludedValuesJson: string;
  overriddenValuesJson: string;
  importedSourceIdsJson: string;
  importedEvidenceIdsJson: string;
  importedImageIdsJson: string;
  createdAt: string;
}

export type PiImportStatus = PiImportRow['status'];

const IMPORT_SELECT = `
  SELECT id, run_id AS runId, onboarding_item_id AS onboardingItemId,
         result_hash AS resultHash, mode, importing_user AS importingUser,
         status, field_selection_json AS fieldSelectionJson,
         excluded_values_json AS excludedValuesJson,
         overridden_values_json AS overriddenValuesJson,
         imported_source_ids_json AS importedSourceIdsJson,
         imported_evidence_ids_json AS importedEvidenceIdsJson,
         imported_image_ids_json AS importedImageIdsJson,
         created_at AS createdAt
  FROM product_intelligence_imports
`;

export function insertPiImport(input: {
  runId: string | null;
  onboardingItemId: string;
  resultHash: string;
  mode: 'create' | 'augment';
  importingUser?: string | null;
  fieldSelectionJson?: string;
  excludedValuesJson?: string;
  overriddenValuesJson?: string;
  importedSourceIdsJson?: string;
  importedEvidenceIdsJson?: string;
  importedImageIdsJson?: string;
}): PiImportRow {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO product_intelligence_imports
       (id, run_id, onboarding_item_id, result_hash, mode, importing_user, status,
        field_selection_json, excluded_values_json, overridden_values_json,
        imported_source_ids_json, imported_evidence_ids_json, imported_image_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.runId, input.onboardingItemId, input.resultHash, input.mode,
      input.importingUser ?? null,
      input.fieldSelectionJson ?? '[]',
      input.excludedValuesJson ?? '{}',
      input.overriddenValuesJson ?? '{}',
      input.importedSourceIdsJson ?? '[]',
      input.importedEvidenceIdsJson ?? '[]',
      input.importedImageIdsJson ?? '[]',
      now(),
    ],
  );
  return getPiImport(id) as PiImportRow;
}

export function getPiImport(id: string): PiImportRow | undefined {
  const db = getDb();
  return db.query(`${IMPORT_SELECT} WHERE id = ?`).get(id) as PiImportRow | undefined;
}

export function getPiImportByRunAndItem(runId: string, onboardingItemId: string): PiImportRow | undefined {
  const db = getDb();
  return db
    .query(`${IMPORT_SELECT} WHERE run_id = ? AND onboarding_item_id = ?`)
    .get(runId, onboardingItemId) as PiImportRow | undefined;
}

export function listPiImportsByItem(onboardingItemId: string): PiImportRow[] {
  const db = getDb();
  return db
    .query(`${IMPORT_SELECT} WHERE onboarding_item_id = ? ORDER BY created_at DESC`)
    .all(onboardingItemId) as PiImportRow[];
}

export function listPiImportsByRun(runId: string): PiImportRow[] {
  const db = getDb();
  return db
    .query(`${IMPORT_SELECT} WHERE run_id = ? ORDER BY created_at ASC`)
    .all(runId) as PiImportRow[];
}

export function updatePiImportStatus(id: string, status: PiImportStatus): boolean {
  const db = getDb();
  const result = db.run('UPDATE product_intelligence_imports SET status = ? WHERE id = ?', [status, id]);
  return result.changes > 0;
}

/** Mark every active import of a run stale (run deletion / retention). */
export function markPiImportsStaleByRun(runId: string): number {
  const db = getDb();
  const result = db.run(
    "UPDATE product_intelligence_imports SET status = 'stale' WHERE run_id = ? AND status = 'active'",
    [runId],
  );
  return Number(result.changes);
}

/** All runs that ever imported into an onboarding item (newest first). */
export function listPiRunsByItem(onboardingItemId: string): PiRunRow[] {
  const db = getDb();
  return db
    .query(
      `${RUN_SELECT} WHERE id IN (SELECT run_id FROM product_intelligence_imports WHERE onboarding_item_id = ? AND run_id IS NOT NULL) ORDER BY started_at DESC`,
    )
    .all(onboardingItemId) as PiRunRow[];
}

// ---------------------------------------------------------------------------
// Retention and deletion (explicit policy)
// ---------------------------------------------------------------------------

/**
 * Hard-delete one run and everything that references it (cascade).
 * Running runs are never deleted — cancel them first. This guard applies at
 * the repository level so no caller (API, retention, import cleanup) can
 * delete an in-flight run.
 *
 * PI-8: imports of the run are marked stale BEFORE the delete (the FK is
 * ON DELETE SET NULL) so promotion rejects the now-missing origin.
 */
export function deletePiRun(id: string): boolean {
  const db = getDb();
  const current = getPiRun(id);
  if (!current) return false;
  if (current.status === 'running') {
    throw new Error(`Cannot delete running run ${id}: cancel it first`);
  }
  markPiImportsStaleByRun(id);
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
  // PI-8: import records must be marked stale BEFORE their origin runs vanish
  // (the FK SET NULLs run_id; the status would otherwise lie as 'active').
  const doomed = db
    .query(
      `SELECT id FROM product_intelligence_runs
       WHERE workspace_id = ? AND started_at < ? AND status != 'running'`,
    )
    .all(workspaceId, cutoffIso) as Array<{ id: string }>;
  for (const { id } of doomed) {
    db.run(`UPDATE product_intelligence_imports SET status = 'stale' WHERE run_id = ? AND status = 'active'`, [id]);
  }
  db.run(
    `DELETE FROM product_intelligence_runs
     WHERE workspace_id = ? AND started_at < ? AND status != 'running'`,
    [workspaceId, cutoffIso],
  );
  return Number(matched.c);
}

// ---------------------------------------------------------------------------
// Round-9 (review P0): durable source authority. Rights tiers never derive
// from generic evidence kinds; trusted CMS records (check_source_priority
// with a brand-matched registry entry) establish authority here. The source
// row's source_type is upgraded to the authority type so existing resolvers
// (which read the row) observe the effective tier — the first-writer bug is
// closed: authority wins regardless of which tool created the row first.
// ---------------------------------------------------------------------------

export interface PiSourceAuthorityRow {
  id: string;
  sourceId: string;
  authorityType: string;
  authorityRef: string | null;
  brandName: string | null;
  establishedBy: string;
  establishedAt: string;
  /** Round-11: the durable evidence that established the brand. */
  brandEvidenceId: string | null;
  brandEvidenceHash: string | null;
  brandEvidenceKind: string | null;
}

export function upsertSourceAuthority(input: {
  sourceId: string;
  authorityType: string;
  authorityRef?: string | null;
  brandName?: string | null;
  establishedBy: string;
  brandEvidenceId?: string | null;
  brandEvidenceHash?: string | null;
  brandEvidenceKind?: string | null;
}): PiSourceAuthorityRow | null {
  const db = getDb();
  const id = randomUUID();
  const establishedAt = new Date().toISOString();
  db.run(
    `INSERT INTO pi_source_authorities
       (id, source_id, authority_type, authority_ref, brand_name, established_by,
        established_at, brand_evidence_id, brand_evidence_hash, brand_evidence_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, authority_type) DO UPDATE SET
       authority_ref = excluded.authority_ref,
       brand_name = excluded.brand_name,
       established_by = excluded.established_by,
       established_at = excluded.established_at,
       brand_evidence_id = excluded.brand_evidence_id,
       brand_evidence_hash = excluded.brand_evidence_hash,
       brand_evidence_kind = excluded.brand_evidence_kind`,
    [
      id,
      input.sourceId,
      input.authorityType,
      input.authorityRef ?? null,
      input.brandName ?? null,
      input.establishedBy,
      establishedAt,
      input.brandEvidenceId ?? null,
      input.brandEvidenceHash ?? null,
      input.brandEvidenceKind ?? null,
    ],
  );
  // Upgrade the source row's tier so resolvers reading source_type observe
  // the authority. The source_type CHECK allows the authority tiers.
  db.run(`UPDATE product_intelligence_sources SET source_type = ? WHERE id = ?`, [
    input.authorityType,
    input.sourceId,
  ]);
  // Round-10 (review cleanup): an upsert must return the DURABLE row — when
  // ON CONFLICT retained an existing row, the pre-insert UUID was never
  // persisted. Re-read the surviving row by (source_id, authority_type).
  const durable = db
    .query(
      `SELECT id, source_id AS sourceId, authority_type AS authorityType,
              authority_ref AS authorityRef, brand_name AS brandName,
              established_by AS establishedBy, established_at AS establishedAt,
              brand_evidence_id AS brandEvidenceId, brand_evidence_hash AS brandEvidenceHash,
              brand_evidence_kind AS brandEvidenceKind
       FROM pi_source_authorities
       WHERE source_id = ? AND authority_type = ?`,
    )
    .get(input.sourceId, input.authorityType) as PiSourceAuthorityRow | undefined;
  return (
    durable ?? {
      id,
      sourceId: input.sourceId,
      authorityType: input.authorityType,
      authorityRef: input.authorityRef ?? null,
      brandName: input.brandName ?? null,
      establishedBy: input.establishedBy,
      establishedAt,
      brandEvidenceId: input.brandEvidenceId ?? null,
      brandEvidenceHash: input.brandEvidenceHash ?? null,
      brandEvidenceKind: input.brandEvidenceKind ?? null,
    }
  );
}

/** Round-10 (review P0): the canonical product brand resolved from DURABLE
 *  exact-GTIN-linked evidence — verified assets whose exact_product_match=1
 *  and whose observed GTIN equals the run's requested GTIN. Returns distinct
 *  normalized observed brands; empty when the brand is unresolved. The
 *  run's untrusted brandHint NEVER appears here (hints cannot mint
 *  authority). */
export interface ResolvedProductBrand {
  /** Normalized (lowercased) brand value. */
  brand: string;
  /** Durable evidence anchor: the verified asset id + its original content
   *  hash (round-11: authority retains the evidence that established the
   *  brand — "Brand A observed from evidence E on asset bytes H whose GTIN X
   *  was independently exact"). */
  assetId: string;
  contentHash: string;
  sourcePageUrl: string | null;
  /** Round-12 (review P0-3): the QUALIFYING brand evidence binding persisted
   *  on the asset (evidence row id + content hash), never reconstructed. */
  brandEvidenceId: string | null;
  brandEvidenceHash: string | null;
}
export function listResolvedProductBrands(runId: string, requestedGtin?: string | null): ResolvedProductBrand[] {
  if (!requestedGtin) return [];
  const db = getDb();
  const rows = db
    .query(
      `SELECT observed_brand AS brand, id AS assetId,
              original_content_hash AS contentHash, source_page_url AS sourcePageUrl,
              brand_evidence_id AS brandEvidenceId, brand_evidence_hash AS brandEvidenceHash
       FROM product_intelligence_assets
       WHERE run_id = ? AND exact_product_match = 1
         AND observed_gtin = ? AND observed_brand IS NOT NULL
         AND trim(observed_brand) <> ''
       ORDER BY created_at DESC`,
    )
    .all(runId, requestedGtin) as Array<{
    brand: string;
    assetId: string;
    contentHash: string;
    sourcePageUrl: string | null;
    brandEvidenceId: string | null;
    brandEvidenceHash: string | null;
  }>;
  // One resolution per normalized brand, newest asset wins.
  const byBrand = new Map<string, ResolvedProductBrand>();
  for (const r of rows) {
    const key = r.brand.trim().toLowerCase();
    if (!byBrand.has(key)) {
      byBrand.set(key, {
        brand: key,
        assetId: r.assetId,
        contentHash: r.contentHash,
        sourcePageUrl: r.sourcePageUrl,
        brandEvidenceId: r.brandEvidenceId,
        brandEvidenceHash: r.brandEvidenceHash,
      });
    }
  }
  return [...byBrand.values()];
}

/** Round-12 (review P1-2): REVOKE a source authority when the current
 *  evidence no longer supports it (ambiguous brand, registry mismatch, or
 *  unresolved). Deletes the authority row and downgrades the source row's
 *  tier back to neutral 'other' — but ONLY when the source's current tier
 *  equals the revoked authority tier (never clobbering a tier set by
 *  another path). */
export function revokeSourceAuthority(sourceId: string, authorityType: string): void {
  const db = getDb();
  db.run(`DELETE FROM pi_source_authorities WHERE source_id = ? AND authority_type = ?`, [sourceId, authorityType]);
  db.run(`UPDATE product_intelligence_sources SET source_type = 'other' WHERE id = ? AND source_type = ?`, [
    sourceId,
    authorityType,
  ]);
}

export function getSourceAuthorities(sourceId: string): PiSourceAuthorityRow[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT id, source_id, authority_type, authority_ref, brand_name, established_by,
              established_at, brand_evidence_id, brand_evidence_hash, brand_evidence_kind
       FROM pi_source_authorities WHERE source_id = ? ORDER BY established_at ASC`,
    )
    .all(sourceId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    authorityType: String(row.authority_type),
    authorityRef: row.authority_ref !== null && row.authority_ref !== undefined ? String(row.authority_ref) : null,
    brandName: row.brand_name !== null && row.brand_name !== undefined ? String(row.brand_name) : null,
    establishedBy: String(row.established_by),
    establishedAt: String(row.established_at),
    brandEvidenceId: row.brand_evidence_id ? String(row.brand_evidence_id) : null,
    brandEvidenceHash: row.brand_evidence_hash ? String(row.brand_evidence_hash) : null,
    brandEvidenceKind: row.brand_evidence_kind ? String(row.brand_evidence_kind) : null,
  }));
}

export function listSourceAuthoritiesByRun(runId: string): PiSourceAuthorityRow[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT a.id, a.source_id, a.authority_type, a.authority_ref, a.brand_name, a.established_by, a.established_at,
              a.brand_evidence_id, a.brand_evidence_hash, a.brand_evidence_kind
       FROM pi_source_authorities a
       JOIN product_intelligence_sources s ON s.id = a.source_id
       WHERE s.run_id = ? ORDER BY a.established_at ASC`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    authorityType: String(row.authority_type),
    authorityRef: row.authority_ref !== null && row.authority_ref !== undefined ? String(row.authority_ref) : null,
    brandName: row.brand_name !== null && row.brand_name !== undefined ? String(row.brand_name) : null,
    establishedBy: String(row.established_by),
    establishedAt: String(row.established_at),
    brandEvidenceId: row.brand_evidence_id ? String(row.brand_evidence_id) : null,
    brandEvidenceHash: row.brand_evidence_hash ? String(row.brand_evidence_hash) : null,
    brandEvidenceKind: row.brand_evidence_kind ? String(row.brand_evidence_kind) : null,
  }));
}
