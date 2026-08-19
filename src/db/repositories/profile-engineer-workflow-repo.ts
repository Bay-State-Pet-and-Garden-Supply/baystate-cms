/** Durable workspace-scoped dedupe/lease state for Profile Engineer workflows (#51). */
import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { insertProfileGeneration } from './profile-generation-repo';
import { insertProfileGenerationRevision } from './profile-generation-revision-repo';

export type ProfileEngineerWorkflowStatus = 'running' | 'completed' | 'failed';

export interface ProfileEngineerWorkflow {
  id: string;
  workspaceId: string;
  domain: string;
  targetVersion: number;
  status: ProfileEngineerWorkflowStatus;
  runId: string;
  leaseExpiresAt: string | null;
  generationId: string | null;
  revisionId: string | null;
  artifactJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileEngineerWorkflowMutation {
  applied: boolean;
  reason?: string;
  generationId?: string | null;
  revisionId?: string | null;
}

interface DbWorkflow {
  id: string;
  workspace_id: string;
  domain: string;
  target_version?: number;
  status: string;
  run_id: string;
  lease_expires_at: string | null;
  generation_id: string | null;
  revision_id: string | null;
  artifact_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./u, '').trim();
}

function map(row: DbWorkflow): ProfileEngineerWorkflow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    domain: row.domain,
    targetVersion: row.target_version ?? 1,
    status: row.status as ProfileEngineerWorkflowStatus,
    runId: row.run_id,
    leaseExpiresAt: row.lease_expires_at,
    generationId: row.generation_id,
    revisionId: row.revision_id,
    artifactJson: row.artifact_json,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_engineer_domain_workflows (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      target_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
      run_id TEXT NOT NULL,
      lease_expires_at TEXT,
      generation_id TEXT,
      revision_id TEXT,
      artifact_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, domain)
    );
    CREATE INDEX IF NOT EXISTS idx_profile_engineer_workflows_status
      ON profile_engineer_domain_workflows(workspace_id, status, lease_expires_at);
  `);
  try {
    db.run('ALTER TABLE profile_engineer_domain_workflows ADD COLUMN target_version INTEGER NOT NULL DEFAULT 1');
  } catch {
    // Column already exists
  }
}

export function findProfileEngineerWorkflow(workspaceId: string, domain: string): ProfileEngineerWorkflow | null {
  ensureTable();
  const row = getDb().query('SELECT * FROM profile_engineer_domain_workflows WHERE workspace_id = ? AND domain = ?')
    .get(workspaceId, normalizeDomain(domain)) as DbWorkflow | undefined;
  return row ? map(row) : null;
}

export interface ClaimWorkflowOptions {
  leaseMs?: number;
  needsRepair?: boolean;
  forceNew?: boolean;
  targetVersion?: number;
}

/** Atomically claim one workflow per workspace/domain/version need. */
export function claimProfileEngineerWorkflow(
  workspaceId: string,
  domain: string,
  runId: string,
  options: number | ClaimWorkflowOptions = 120_000,
): { acquired: boolean; workflow: ProfileEngineerWorkflow; reason?: string } {
  ensureTable();
  const db = getDb();
  const normalizedDomain = normalizeDomain(domain);
  if (!workspaceId.trim() || !normalizedDomain || !runId.trim()) throw new Error('workspaceId, domain and runId are required');

  const leaseMs = typeof options === 'number' ? options : options.leaseMs ?? 120_000;
  const targetVersion = typeof options === 'object' ? options.targetVersion ?? 1 : 1;

  const now = new Date().toISOString();
  const expires = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
  let outcome: { acquired: boolean; workflow: ProfileEngineerWorkflow; reason?: string } | null = null;

  db.transaction(() => {
    const existing = db.query('SELECT * FROM profile_engineer_domain_workflows WHERE workspace_id = ? AND domain = ?')
      .get(workspaceId, normalizedDomain) as DbWorkflow | undefined;
    if (!existing) {
      const id = randomUUID();
      db.query(`INSERT INTO profile_engineer_domain_workflows
        (id, workspace_id, domain, target_version, status, run_id, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`).run(id, workspaceId, normalizedDomain, targetVersion, runId, expires, now, now);
      outcome = { acquired: true, workflow: map(db.query('SELECT * FROM profile_engineer_domain_workflows WHERE id = ?').get(id) as DbWorkflow) };
      return;
    }
    const isHigherVersion = targetVersion > (existing.target_version ?? 1);
    const isForced = Boolean(typeof options === 'object' && options.forceNew);
    const allowReclaim = isHigherVersion || isForced;
    const liveLease = existing.status === 'running' && !!existing.lease_expires_at && existing.lease_expires_at > now;
    if (liveLease) {
      outcome = { acquired: false, workflow: map(existing), reason: 'domain_workflow_in_progress' };
      return;
    }
    if (existing.status === 'completed' && !allowReclaim) {
      outcome = { acquired: false, workflow: map(existing), reason: 'domain_workflow_already_completed' };
      return;
    }
    db.query(`UPDATE profile_engineer_domain_workflows
      SET status = 'running', target_version = ?, run_id = ?, lease_expires_at = ?, error_message = NULL, updated_at = ?
      WHERE id = ? AND (status = 'failed' OR status = 'completed' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`)
      .run(targetVersion, runId, expires, now, existing.id, now);
    const retried = db.query('SELECT * FROM profile_engineer_domain_workflows WHERE id = ?').get(existing.id) as DbWorkflow;
    outcome = retried.status === 'running' && retried.run_id === runId
      ? { acquired: true, workflow: map(retried) }
      : { acquired: false, workflow: map(retried), reason: 'domain_workflow_in_progress' };
  })();
  if (!outcome) throw new Error('profile engineer workflow claim did not return a result');
  return outcome;
}

/** Completion is guarded by owner, status, and an unexpired lease. */
export function completeProfileEngineerWorkflow(
  workflowId: string,
  runId: string,
  artifactJson?: string | null,
  generationId?: string | null,
  revisionId?: string | null,
): ProfileEngineerWorkflowMutation {
  ensureTable();
  const now = new Date().toISOString();
  const result = getDb().query(`UPDATE profile_engineer_domain_workflows
    SET status = 'completed', lease_expires_at = NULL, artifact_json = COALESCE(?, artifact_json),
        generation_id = COALESCE(?, generation_id), revision_id = COALESCE(?, revision_id), updated_at = ?
    WHERE id = ? AND run_id = ? AND status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
    .run(artifactJson ?? null, generationId ?? null, revisionId ?? null, now, workflowId, runId, now);
  return result.changes > 0 ? { applied: true, generationId: generationId ?? null, revisionId: revisionId ?? null } : { applied: false, reason: 'workflow_lease_lost' };
}

export function failProfileEngineerWorkflow(workflowId: string, runId: string, reason: string): ProfileEngineerWorkflowMutation {
  ensureTable();
  const now = new Date().toISOString();
  const result = getDb().query(`UPDATE profile_engineer_domain_workflows
    SET status = 'failed', lease_expires_at = NULL, error_message = ?, updated_at = ?
    WHERE id = ? AND run_id = ? AND status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
    .run(reason.slice(0, 4096), now, workflowId, runId, now);
  return result.changes > 0 ? { applied: true } : { applied: false, reason: 'workflow_lease_lost' };
}

/**
 * Persist a proposal in the existing generation/revision governance tables as
 * part of the guarded completion transaction. The workflow artifact remains
 * an audit envelope; it is never the profile builder's authority.
 */
export function completeProfileEngineerWorkflowWithProposal(
  workflowId: string,
  runId: string,
  artifactJson: string,
): ProfileEngineerWorkflowMutation {
  ensureTable();
  const db = getDb();
  let outcome: ProfileEngineerWorkflowMutation = { applied: false, reason: 'workflow_lease_lost' };
  const now = new Date().toISOString();
  db.transaction(() => {
    const guarded = db.query(`UPDATE profile_engineer_domain_workflows
      SET status = 'completed', lease_expires_at = NULL, artifact_json = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
      .run(artifactJson, now, workflowId, runId, now);
    if (guarded.changes === 0) return;
    let envelope: { payload?: Record<string, unknown> };
    try { envelope = JSON.parse(artifactJson) as { payload?: Record<string, unknown> }; } catch { throw new Error('invalid_profile_engineer_artifact'); }
    const payload = envelope.payload;
    if (!payload || typeof payload.domain !== 'string' || !Array.isArray(payload.validation) || !payload.selectors || typeof payload.selectors !== 'object') {
      throw new Error('invalid_profile_engineer_proposal');
    }
    const firstUrl = (payload.validation[0] as { url?: unknown })?.url;
    if (typeof firstUrl !== 'string') throw new Error('profile_engineer_proposal_missing_source_url');
    const generation = insertProfileGeneration({
      domain: payload.domain,
      sourceUrl: firstUrl,
      selectors: payload.selectors as Record<string, unknown>,
      fieldSamples: { validation: payload.validation },
      validation: payload.validationSummary as Record<string, unknown>,
      status: 'proposed',
      confidence: 0,
      llmProvider: 'profile_engineer',
      llmModel: null,
    });
    const revision = insertProfileGenerationRevision({
      generationId: generation.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: payload.selectors as Record<string, unknown>,
      fieldSamples: { validation: payload.validation },
      validationSummary: payload.validationSummary as Record<string, unknown>,
      status: 'draft',
      confidence: 0,
      llmTask: 'profile_engineer',
    });
    db.query(`UPDATE profile_engineer_domain_workflows SET generation_id = ?, revision_id = ?, updated_at = ? WHERE id = ?`)
      .run(generation.id, revision.id, now, workflowId);
    outcome = { applied: true, generationId: generation.id, revisionId: revision.id };
  })();
  return outcome;
}

/** Adapter for ProfileEngineerWorkflowLock; all calls are workspace-owned. */
/** Adapter for ProfileEngineerWorkflowLock; all calls are workspace-owned. */
export function profileEngineerWorkflowLock(defaultLeaseMs = 120_000) {
  return {
    claim: (domain: string, runId: string, workspaceId: string, options?: ClaimWorkflowOptions) => {
      const claimOptions: ClaimWorkflowOptions = {
        leaseMs: options?.leaseMs ?? defaultLeaseMs,
        needsRepair: options?.needsRepair,
        forceNew: options?.forceNew,
        targetVersion: options?.targetVersion,
      };
      const claimed = claimProfileEngineerWorkflow(workspaceId, domain, runId, claimOptions);
      return { acquired: claimed.acquired, workflowId: claimed.workflow.id, reason: claimed.reason };
    },
    complete: (workflowId: string, runId: string, artifactJson?: string) => artifactJson
      ? completeProfileEngineerWorkflowWithProposal(workflowId, runId, artifactJson)
      : completeProfileEngineerWorkflow(workflowId, runId),
    fail: (workflowId: string, runId: string, reason: string) => failProfileEngineerWorkflow(workflowId, runId, reason),
  };
}
