/** Durable domain-level dedupe/lease state for Profile Engineer workflows (#51). */
import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export type ProfileEngineerWorkflowStatus = 'running' | 'completed' | 'failed';

export interface ProfileEngineerWorkflow {
  id: string;
  domain: string;
  status: ProfileEngineerWorkflowStatus;
  runId: string;
  leaseExpiresAt: string | null;
  generationId: string | null;
  artifactJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DbWorkflow {
  id: string;
  domain: string;
  status: string;
  run_id: string;
  lease_expires_at: string | null;
  generation_id: string | null;
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
    domain: row.domain,
    status: row.status as ProfileEngineerWorkflowStatus,
    runId: row.run_id,
    leaseExpiresAt: row.lease_expires_at,
    generationId: row.generation_id,
    artifactJson: row.artifact_json,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS profile_engineer_domain_workflows (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
      run_id TEXT NOT NULL,
      lease_expires_at TEXT,
      generation_id TEXT,
      artifact_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_profile_engineer_workflows_status
      ON profile_engineer_domain_workflows(status, lease_expires_at);
  `);
}

export function findProfileEngineerWorkflow(domain: string): ProfileEngineerWorkflow | null {
  ensureTable();
  const row = getDb().query('SELECT * FROM profile_engineer_domain_workflows WHERE domain = ?').get(normalizeDomain(domain)) as DbWorkflow | undefined;
  return row ? map(row) : null;
}

/**
 * Atomically claim one workflow per domain. A live lease or a completed
 * proposal is returned to callers instead of starting duplicate generation.
 * Failed/expired work may be retried, while the row remains the durable audit
 * identity for the domain.
 */
export function claimProfileEngineerWorkflow(domain: string, runId: string, leaseMs = 120_000): { acquired: boolean; workflow: ProfileEngineerWorkflow; reason?: string } {
  ensureTable();
  const db = getDb();
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain || !runId.trim()) throw new Error('domain and runId are required');
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
  let outcome: { acquired: boolean; workflow: ProfileEngineerWorkflow; reason?: string } | null = null;

  db.transaction(() => {
    const existing = db.query('SELECT * FROM profile_engineer_domain_workflows WHERE domain = ?').get(normalizedDomain) as DbWorkflow | undefined;
    if (!existing) {
      const id = randomUUID();
      db.query(`INSERT INTO profile_engineer_domain_workflows
        (id, domain, status, run_id, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, 'running', ?, ?, ?, ?)`).run(id, normalizedDomain, runId, expires, now, now);
      const created = db.query('SELECT * FROM profile_engineer_domain_workflows WHERE id = ?').get(id) as DbWorkflow;
      outcome = { acquired: true, workflow: map(created) };
      return;
    }
    const liveLease = existing.status === 'running' && !!existing.lease_expires_at && existing.lease_expires_at > now;
    if (liveLease) {
      outcome = { acquired: false, workflow: map(existing), reason: 'domain_workflow_in_progress' };
      return;
    }
    if (existing.status === 'completed') {
      outcome = { acquired: false, workflow: map(existing), reason: 'domain_workflow_already_completed' };
      return;
    }
    db.query(`UPDATE profile_engineer_domain_workflows
      SET status = 'running', run_id = ?, lease_expires_at = ?, error_message = NULL, updated_at = ?
      WHERE id = ? AND (status = 'failed' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`)
      .run(runId, expires, now, existing.id, now);
    const retried = db.query('SELECT * FROM profile_engineer_domain_workflows WHERE id = ?').get(existing.id) as DbWorkflow;
    outcome = retried.status === 'running' && retried.run_id === runId
      ? { acquired: true, workflow: map(retried) }
      : { acquired: false, workflow: map(retried), reason: 'domain_workflow_in_progress' };
  })();
  if (!outcome) throw new Error('profile engineer workflow claim did not return a result');
  return outcome;
}

export function completeProfileEngineerWorkflow(workflowId: string, runId: string, artifactJson?: string | null, generationId?: string | null): boolean {
  ensureTable();
  const now = new Date().toISOString();
  const result = getDb().query(`UPDATE profile_engineer_domain_workflows
    SET status = 'completed', lease_expires_at = NULL, artifact_json = COALESCE(?, artifact_json), generation_id = COALESCE(?, generation_id), updated_at = ?
    WHERE id = ? AND run_id = ? AND status = 'running'`).run(artifactJson ?? null, generationId ?? null, now, workflowId, runId);
  return result.changes > 0;
}

export function failProfileEngineerWorkflow(workflowId: string, runId: string, reason: string): boolean {
  ensureTable();
  const now = new Date().toISOString();
  const result = getDb().query(`UPDATE profile_engineer_domain_workflows
    SET status = 'failed', lease_expires_at = NULL, error_message = ?, updated_at = ?
    WHERE id = ? AND run_id = ? AND status = 'running'`).run(reason.slice(0, 4096), now, workflowId, runId);
  return result.changes > 0;
}

/** Adapter for ProfileEngineerWorkflowLock; keeps DB concerns out of the specialist. */
export function profileEngineerWorkflowLock(leaseMs = 120_000) {
  return {
    claim: (domain: string, runId: string) => {
      const claimed = claimProfileEngineerWorkflow(domain, runId, leaseMs);
      return { acquired: claimed.acquired, workflowId: claimed.workflow.id, reason: claimed.reason };
    },
    complete: (workflowId: string, runId: string, artifactJson?: string) => { completeProfileEngineerWorkflow(workflowId, runId, artifactJson); },
    fail: (workflowId: string, runId: string, reason: string) => { failProfileEngineerWorkflow(workflowId, runId, reason); },
  };
}
