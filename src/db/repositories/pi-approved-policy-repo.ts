/**
 * PI approved-policy persistence (P0-2 review remediation).
 *
 * Server-authoritative execution policies as immutable, versioned records.
 * Callers never supply a policy object; they select an approved record by id
 * (or the workspace default) and may apply strictly-reducing overrides that
 * the server validates (src/product-intelligence/policy). Policy records are
 * append-only per name+version: changing a policy creates a new version row
 * and deactivates the previous ones — only the newest version of a record may
 * be active, and an active version's policy_json is never mutated in place.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

const now = () => new Date().toISOString();

/** Name of the seeded default policy record for each workspace. */
export const DEFAULT_POLICY_NAME = 'default';

export interface ApprovedPolicyRow {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  policyJson: string;
  policyConfigId: string;
  /** 1 = active (the newest version of the record), 0 = superseded. */
  active: number;
  createdAt: string;
}

const ROW_SELECT = `
  SELECT id, workspace_id AS workspaceId, name, version,
         policy_json AS policyJson, policy_config_id AS policyConfigId,
         active, created_at AS createdAt
  FROM pi_approved_policies
`;

function mapRow(row: Record<string, unknown>): ApprovedPolicyRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    name: String(row.name),
    version: Number(row.version),
    policyJson: String(row.policyJson),
    policyConfigId: String(row.policyConfigId),
    active: Number(row.active),
    createdAt: String(row.createdAt),
  };
}

/** All approved-policy rows for a workspace, newest version first per name. */
export function listApprovedPolicies(workspaceId: string): ApprovedPolicyRow[] {
  const db = getDb();
  const rows = db
    .query(`${ROW_SELECT} WHERE workspace_id = ? ORDER BY name, version DESC`)
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * The single active (newest) approved policy record for the workspace, or
 * undefined when none has been seeded yet.
 */
export function getActiveApprovedPolicy(workspaceId: string): ApprovedPolicyRow | undefined {
  const db = getDb();
  const row = db
    .query(`${ROW_SELECT} WHERE workspace_id = ? AND active = 1 ORDER BY version DESC LIMIT 1`)
    .get(workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : undefined;
}

/**
 * True when a policy with the given content configId is currently active for
 * the workspace. Used by replay/rerun checks: a rerun must never resurrect a
 * policy that was superseded or revoked (P0-4 + P0-2 interaction).
 */
export function isApprovedPolicyActive(workspaceId: string, configId: string): boolean {
  const db = getDb();
  const row = db
    .query('SELECT COUNT(*) AS c FROM pi_approved_policies WHERE workspace_id = ? AND policy_config_id = ? AND active = 1')
    .get(workspaceId, configId) as { c: number };
  return row.c > 0;
}

/**
 * Create a new immutable version of a named policy record. Every previous
 * version of that name is deactivated (the newest version is the only active
 * one). Returns the new active row.
 */
export function createApprovedPolicyVersion(
  workspaceId: string,
  name: string,
  policyJson: string,
  configId: string,
): ApprovedPolicyRow {
  const db = getDb();
  const current = db
    .query('SELECT COALESCE(MAX(version), 0) AS v FROM pi_approved_policies WHERE workspace_id = ? AND name = ?')
    .get(workspaceId, name) as { v: number };
  const version = current.v + 1;
  db.transaction(() => {
    db.run('UPDATE pi_approved_policies SET active = 0 WHERE workspace_id = ? AND name = ?', [workspaceId, name]);
    db.run(
      `INSERT INTO pi_approved_policies (id, workspace_id, name, version, policy_json, policy_config_id, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [randomUUID(), workspaceId, name, version, policyJson, configId, now()],
    );
  })();
  const active = getActiveApprovedPolicy(workspaceId);
  if (!active) throw new Error(`Failed to create approved policy version for workspace ${workspaceId}`);
  return active;
}

/**
 * Idempotent seeding of the workspace default policy. No-op when a record
 * already exists for the workspace default name (seeding never supersedes an
 * operator-managed policy). Returns the active row.
 */
export function seedDefaultApprovedPolicy(
  workspaceId: string,
  policyJson: string,
  configId: string,
): ApprovedPolicyRow {
  const db = getDb();
  const existing = db
    .query('SELECT id FROM pi_approved_policies WHERE workspace_id = ? AND name = ?')
    .get(workspaceId, DEFAULT_POLICY_NAME) as { id: string } | undefined;
  if (existing) {
    const active = getActiveApprovedPolicy(workspaceId);
    if (!active) throw new Error(`Approved policy record exists but none is active for workspace ${workspaceId}`);
    return active;
  }
  return createApprovedPolicyVersion(workspaceId, DEFAULT_POLICY_NAME, policyJson, configId);
}

/** Look up a specific approved-policy row by record id within a workspace. */
export function getApprovedPolicyById(workspaceId: string, policyId: string): ApprovedPolicyRow | undefined {
  const db = getDb();
  const row = db
    .query(`${ROW_SELECT} WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, policyId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : undefined;
}
