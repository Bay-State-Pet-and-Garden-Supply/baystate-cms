/**
 * Agent Lab: Agent Version & Training Repository.
 *
 * Enforces:
 * 1. Immutable content-addressed AgentVersionSnapshots.
 * 2. Workspace lifecycle states (at most one active version per workspace).
 * 3. Durable human corrections and teaching events.
 * 4. Atomic candidate promotion.
 */
import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../../shared/stable-id';
import type {
  AgentCorrection,
  AgentFewShotExample,
  AgentInstructionRule,
  AgentLifecycleStatus,
  AgentTeachingEvent,
  AgentVersionSnapshot,
  AgentVersionState,
  AgentVersionSummary,
  TeachingActionItem,
} from '../../shared/schemas/agent-training';

const now = () => new Date().toISOString();

// ─── Hash Computation ───────────────────────────────────────────────────────

export function computeSnapshotContentHash(data: {
  workspaceId: string;
  versionNumber: number;
  revisionNumber: number;
  parentVersionId: string | null;
  compilerVersion: string;
  instructions: AgentInstructionRule[];
  fewShotExamples: AgentFewShotExample[];
  fewShotTokenBudget: number;
  policyConfigId: string;
}): string {
  // Sort instructions and examples by ID for deterministic hash
  const sortedInstructions = [...data.instructions].sort((a, b) => a.id.localeCompare(b.id));
  const sortedExamples = [...data.fewShotExamples].sort((a, b) => a.id.localeCompare(b.id));

  return sha256Hex(
    JSON.stringify({
      workspaceId: data.workspaceId,
      versionNumber: data.versionNumber,
      revisionNumber: data.revisionNumber,
      parentVersionId: data.parentVersionId ?? null,
      compilerVersion: data.compilerVersion,
      instructions: sortedInstructions,
      fewShotExamples: sortedExamples,
      fewShotTokenBudget: data.fewShotTokenBudget,
      policyConfigId: data.policyConfigId,
    }),
  );
}

// ─── Mappers ────────────────────────────────────────────────────────────────

function mapSnapshotRow(row: Record<string, any>): AgentVersionSnapshot {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    versionNumber: Number(row.version_number),
    revisionNumber: Number(row.revision_number),
    parentVersionId: row.parent_version_id ? String(row.parent_version_id) : null,
    compilerVersion: String(row.compiler_version),
    instructions: JSON.parse(row.instructions_json || '[]'),
    fewShotExamples: JSON.parse(row.few_shot_examples_json || '[]'),
    fewShotTokenBudget: Number(row.few_shot_token_budget || 4000),
    policyConfigId: String(row.policy_config_id),
    contentHash: String(row.content_hash),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    changeSummary: String(row.change_summary || ''),
  };
}

function mapStateRow(row: Record<string, any>): AgentVersionState {
  return {
    versionId: String(row.version_id),
    workspaceId: String(row.workspace_id),
    lifecycleStatus: String(row.lifecycle_status) as AgentLifecycleStatus,
    activeEvaluationId: row.active_evaluation_id ? String(row.active_evaluation_id) : null,
    activatedAt: row.activated_at ? String(row.activated_at) : null,
    retiredAt: row.retired_at ? String(row.retired_at) : null,
    updatedAt: String(row.updated_at),
  };
}

// ─── Snapshots & Lifecycle State Queries ────────────────────────────────────

/**
 * Seed baseline v1 snapshot for a workspace if no active version exists.
 */
export function ensureBaselineVersion(workspaceId: string): AgentVersionSummary {
  const db = getDb();
  const existing = getActiveVersion(workspaceId);
  if (existing) return existing;

  const snapshotId = `v1_rev1_${workspaceId}`;
  const nowIso = now();
  const contentHash = computeSnapshotContentHash({
    workspaceId,
    versionNumber: 1,
    revisionNumber: 1,
    parentVersionId: null,
    compilerVersion: 'compiler_v1',
    instructions: [],
    fewShotExamples: [],
    fewShotTokenBudget: 4000,
    policyConfigId: 'default',
  });

  db.transaction(() => {
    db.query(`
      INSERT OR IGNORE INTO agent_version_snapshots (
        id, workspace_id, version_number, revision_number, parent_version_id,
        compiler_version, instructions_json, few_shot_examples_json, few_shot_token_budget,
        policy_config_id, content_hash, created_by, created_at, change_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      workspaceId,
      1,
      1,
      null,
      'compiler_v1',
      '[]',
      '[]',
      4000,
      'default',
      contentHash,
      'system',
      nowIso,
      'Baseline compiler_v1 version snapshot',
    );

    db.query(`
      INSERT OR IGNORE INTO agent_version_states (
        version_id, workspace_id, lifecycle_status, active_evaluation_id,
        activated_at, retired_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(snapshotId, workspaceId, 'active', null, nowIso, null, nowIso);
  })();

  return getVersionSnapshot(workspaceId, snapshotId)!;
}

export function getActiveVersion(workspaceId: string): AgentVersionSummary | null {
  const db = getDb();
  const row = db
    .query(`
      SELECT s.*, st.lifecycle_status, st.active_evaluation_id, st.activated_at, st.retired_at, st.updated_at
      FROM agent_version_states st
      JOIN agent_version_snapshots s ON st.version_id = s.id
      WHERE st.workspace_id = ? AND st.lifecycle_status = 'active'
    `)
    .get(workspaceId) as Record<string, any> | undefined;

  if (!row) return null;
  return {
    snapshot: mapSnapshotRow(row),
    state: mapStateRow(row),
  };
}

export function getLatestCandidateVersion(workspaceId: string): AgentVersionSummary | null {
  const db = getDb();
  const row = db
    .query(`
      SELECT s.*, st.lifecycle_status, st.active_evaluation_id, st.activated_at, st.retired_at, st.updated_at
      FROM agent_version_states st
      JOIN agent_version_snapshots s ON st.version_id = s.id
      WHERE st.workspace_id = ? AND st.lifecycle_status IN ('draft', 'evaluating', 'qualified')
      ORDER BY s.version_number DESC, s.revision_number DESC, s.created_at DESC
      LIMIT 1
    `)
    .get(workspaceId) as Record<string, any> | undefined;

  if (!row) return null;
  return {
    snapshot: mapSnapshotRow(row),
    state: mapStateRow(row),
  };
}

export function getVersionSnapshot(workspaceId: string, versionId: string): AgentVersionSummary | null {
  const db = getDb();
  const row = db
    .query(`
      SELECT s.*, st.lifecycle_status, st.active_evaluation_id, st.activated_at, st.retired_at, st.updated_at
      FROM agent_version_snapshots s
      JOIN agent_version_states st ON st.version_id = s.id
      WHERE s.workspace_id = ? AND s.id = ?
    `)
    .get(workspaceId, versionId) as Record<string, any> | undefined;

  if (!row) return null;
  return {
    snapshot: mapSnapshotRow(row),
    state: mapStateRow(row),
  };
}

export function listVersionSnapshots(workspaceId: string): AgentVersionSummary[] {
  const db = getDb();
  const rows = db
    .query(`
      SELECT s.*, st.lifecycle_status, st.active_evaluation_id, st.activated_at, st.retired_at, st.updated_at
      FROM agent_version_snapshots s
      JOIN agent_version_states st ON st.version_id = s.id
      WHERE s.workspace_id = ?
      ORDER BY s.version_number DESC, s.revision_number DESC, s.created_at DESC
    `)
    .all(workspaceId) as Record<string, any>[];

  return rows.map((row) => ({
    snapshot: mapSnapshotRow(row),
    state: mapStateRow(row),
  }));
}

/**
 * Creates an immutable candidate snapshot.
 */
export function createCandidateSnapshot(
  workspaceId: string,
  input: {
    parentVersionId?: string | null;
    compilerVersion?: string;
    instructions: AgentInstructionRule[];
    fewShotExamples: AgentFewShotExample[];
    fewShotTokenBudget?: number;
    policyConfigId?: string;
    createdBy: string;
    changeSummary: string;
  },
): AgentVersionSummary {
  const db = getDb();
  const active = ensureBaselineVersion(workspaceId);

  let parentSummary = active;
  if (input.parentVersionId) {
    const found = getVersionSnapshot(workspaceId, input.parentVersionId);
    if (!found) {
      throw new Error(`Parent agent version snapshot ${input.parentVersionId} not found in workspace`);
    }
    parentSummary = found;
  }
  const parent = parentSummary.snapshot;
  const isParentActiveOrRetired = parentSummary.state.lifecycleStatus === 'active' || parentSummary.state.lifecycleStatus === 'retired';

  // If forking from active/retired, increment versionNumber and start at rev 1;
  // if revising an existing candidate, keep versionNumber and increment revisionNumber.
  const versionNumber = isParentActiveOrRetired ? parent.versionNumber + 1 : parent.versionNumber;
  const revisionNumber = isParentActiveOrRetired ? 1 : parent.revisionNumber + 1;

  const compilerVersion = input.compilerVersion ?? parent.compilerVersion ?? 'compiler_v1';
  const fewShotTokenBudget = input.fewShotTokenBudget ?? parent.fewShotTokenBudget ?? 4000;
  const policyConfigId = input.policyConfigId ?? parent.policyConfigId ?? 'default';

  const contentHash = computeSnapshotContentHash({
    workspaceId,
    versionNumber,
    revisionNumber,
    parentVersionId: parent.id,
    compilerVersion,
    instructions: input.instructions,
    fewShotExamples: input.fewShotExamples,
    fewShotTokenBudget,
    policyConfigId,
  });

  const snapshotId = `v${versionNumber}_rev${revisionNumber}_${contentHash.slice(0, 8)}`;
  const createdAt = now();

  db.transaction(() => {
    db.query(`
      INSERT INTO agent_version_snapshots (
        id, workspace_id, version_number, revision_number, parent_version_id,
        compiler_version, instructions_json, few_shot_examples_json, few_shot_token_budget,
        policy_config_id, content_hash, created_by, created_at, change_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      workspaceId,
      versionNumber,
      revisionNumber,
      parent.id,
      compilerVersion,
      JSON.stringify(input.instructions),
      JSON.stringify(input.fewShotExamples),
      fewShotTokenBudget,
      policyConfigId,
      contentHash,
      input.createdBy,
      createdAt,
      input.changeSummary,
    );

    db.query(`
      INSERT INTO agent_version_states (
        version_id, workspace_id, lifecycle_status, active_evaluation_id,
        activated_at, retired_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(snapshotId, workspaceId, 'draft', null, null, null, createdAt);
  })();

  return getVersionSnapshot(workspaceId, snapshotId)!;
}

export function updateCandidateLifecycleStatus(
  workspaceId: string,
  versionId: string,
  newStatus: AgentLifecycleStatus,
  activeEvaluationId: string | null = null,
): AgentVersionSummary {
  const db = getDb();
  const current = getVersionSnapshot(workspaceId, versionId);
  if (!current) throw new Error(`Version ${versionId} not found`);

  // Protect active versions from ad-hoc status change outside promoteVersion
  if (current.state.lifecycleStatus === 'active' && newStatus !== 'retired') {
    throw new Error('Active version cannot be mutated; use promoteVersion to transition active versions');
  }

  db.query(`
    UPDATE agent_version_states
    SET lifecycle_status = ?, active_evaluation_id = COALESCE(?, active_evaluation_id), updated_at = ?
    WHERE workspace_id = ? AND version_id = ?
  `).run(newStatus, activeEvaluationId, now(), workspaceId, versionId);

  return getVersionSnapshot(workspaceId, versionId)!;
}

// ─── Corrections & Teaching Events ──────────────────────────────────────────

export function createCorrection(
  workspaceId: string,
  input: {
    runId: string;
    versionId: string;
    originalResultHash: string;
    correctedFields: AgentCorrection['correctedFields'];
    failureMode: string;
    notes?: string;
    createdBy: string;
  },
): AgentCorrection {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();

  db.query(`
    INSERT INTO agent_corrections (
      id, workspace_id, run_id, version_id, original_result_hash,
      corrected_fields_json, failure_mode, notes, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    workspaceId,
    input.runId,
    input.versionId,
    input.originalResultHash,
    JSON.stringify(input.correctedFields),
    input.failureMode,
    input.notes ?? '',
    input.createdBy,
    createdAt,
  );

  return {
    id,
    workspaceId,
    runId: input.runId,
    versionId: input.versionId,
    originalResultHash: input.originalResultHash,
    correctedFields: input.correctedFields,
    failureMode: input.failureMode,
    notes: input.notes ?? '',
    createdBy: input.createdBy,
    createdAt,
  };
}

export function getCorrection(workspaceId: string, correctionId: string): AgentCorrection | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM agent_corrections WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, correctionId) as Record<string, any> | undefined;

  if (!row) return null;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    versionId: String(row.version_id),
    originalResultHash: String(row.original_result_hash),
    correctedFields: JSON.parse(row.corrected_fields_json || '{}'),
    failureMode: String(row.failure_mode),
    notes: String(row.notes || ''),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}

export function listCorrections(workspaceId: string, runId?: string, limit = 50): AgentCorrection[] {
  const db = getDb();
  if (runId) {
    const rows = db
      .query('SELECT * FROM agent_corrections WHERE workspace_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(workspaceId, runId, limit) as Record<string, any>[];
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      runId: String(row.run_id),
      versionId: String(row.version_id),
      originalResultHash: String(row.original_result_hash),
      correctedFields: JSON.parse(row.corrected_fields_json || '{}'),
      failureMode: String(row.failure_mode),
      notes: String(row.notes || ''),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
    }));
  }
  const rows = db
    .query('SELECT * FROM agent_corrections WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(workspaceId, limit) as Record<string, any>[];

  return rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    versionId: String(row.version_id),
    originalResultHash: String(row.original_result_hash),
    correctedFields: JSON.parse(row.corrected_fields_json || '{}'),
    failureMode: String(row.failure_mode),
    notes: String(row.notes || ''),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  }));
}

export function recordTeachingEvent(
  workspaceId: string,
  input: {
    correctionId: string;
    resultingVersionId: string;
    actions: TeachingActionItem[];
    rationale: string;
    createdBy: string;
  },
): AgentTeachingEvent {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();

  db.query(`
    INSERT INTO agent_teaching_events (
      id, workspace_id, correction_id, resulting_version_id,
      actions_json, rationale, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    workspaceId,
    input.correctionId,
    input.resultingVersionId,
    JSON.stringify(input.actions),
    input.rationale,
    input.createdBy,
    createdAt,
  );

  return {
    id,
    workspaceId,
    correctionId: input.correctionId,
    resultingVersionId: input.resultingVersionId,
    actions: input.actions,
    rationale: input.rationale,
    createdBy: input.createdBy,
    createdAt,
  };
}

export function listTeachingEvents(workspaceId: string, limit = 50): AgentTeachingEvent[] {
  const db = getDb();
  const rows = db
    .query('SELECT * FROM agent_teaching_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(workspaceId, limit) as Record<string, any>[];

  return rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    correctionId: String(row.correction_id),
    resultingVersionId: String(row.resulting_version_id),
    actions: JSON.parse(row.actions_json || '[]'),
    rationale: String(row.rationale || ''),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  }));
}

// ─── Promotion ──────────────────────────────────────────────────────────────

export function promoteCandidateVersion(
  workspaceId: string,
  candidateVersionId: string,
  actor: string,
  evaluationId: string,
): AgentVersionSummary {
  const db = getDb();
  const target = getVersionSnapshot(workspaceId, candidateVersionId);
  if (!target) throw new Error(`Candidate version ${candidateVersionId} not found in workspace`);

  // Verify evaluation exists and is valid
  const evalRow = db
    .query('SELECT * FROM agent_evaluation_snapshots WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, evaluationId) as Record<string, any> | undefined;
  if (!evalRow) {
    throw new Error(`Evaluation ${evaluationId} not found in workspace`);
  }

  if (evalRow.candidate_version_id !== candidateVersionId) {
    throw new Error(
      `Evaluation candidate version ${evalRow.candidate_version_id} does not match candidate version ${candidateVersionId}`,
    );
  }

  if (evalRow.split_group !== 'promotion_test') {
    throw new Error(
      `Promotion requires an evaluation on the promotion_test split, got: ${evalRow.split_group}`,
    );
  }

  if (evalRow.status !== 'passed') {
    throw new Error(`Evaluation status is not passed: ${evalRow.status}`);
  }

  const gateVerdict = JSON.parse(evalRow.promotion_gate_verdict_json || '{}');
  if (!gateVerdict.allowed || !gateVerdict.complete) {
    throw new Error(
      `Promotion gate verdict is not allowed or incomplete: ${JSON.stringify(gateVerdict.reasons ?? [])}`,
    );
  }

  const nowIso = now();

  db.transaction(() => {
    // 1. Retire any currently active version in this workspace
    db.query(`
      UPDATE agent_version_states
      SET lifecycle_status = 'retired', retired_at = ?, updated_at = ?
      WHERE workspace_id = ? AND lifecycle_status = 'active'
    `).run(nowIso, nowIso, workspaceId);

    // 2. Promote candidate version to active
    db.query(`
      UPDATE agent_version_states
      SET lifecycle_status = 'active', active_evaluation_id = ?, activated_at = ?, updated_at = ?
      WHERE workspace_id = ? AND version_id = ?
    `).run(evaluationId, nowIso, nowIso, workspaceId, candidateVersionId);
  })();

  return getVersionSnapshot(workspaceId, candidateVersionId)!;
}
