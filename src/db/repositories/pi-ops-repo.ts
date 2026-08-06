/**
 * PI-10 operational persistence (budgets + retention).
 *
 * Small repository over the pi_budget_policies and pi_retention_policies
 * tables plus the per-category retention deletes and budget counters used by
 * src/product-intelligence/budgets.ts and retention.ts. Counters are derived
 * from the run / tool-call / asset tables so enforcement never trusts the
 * agent prompt.
 */
import { getDb } from '../connection';

const now = () => new Date().toISOString();

export interface PiOpsPolicyRow {
  workspaceId: string;
  policyJson: string;
  updatedAt: string;
}

/** The workspace budget policy row, if one was configured. */
export function getPiBudgetPolicyRow(workspaceId: string): PiOpsPolicyRow | undefined {
  const db = getDb();
  return db
    .query(
      `SELECT workspace_id AS workspaceId, policy_json AS policyJson, updated_at AS updatedAt
       FROM pi_budget_policies WHERE workspace_id = ?`,
    )
    .get(workspaceId) as PiOpsPolicyRow | undefined;
}

/** Upsert the workspace budget policy row. */
export function upsertPiBudgetPolicyRow(workspaceId: string, policyJson: string): void {
  const db = getDb();
  db.run(
    `INSERT INTO pi_budget_policies (workspace_id, policy_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       policy_json = excluded.policy_json,
       updated_at = excluded.updated_at`,
    [workspaceId, policyJson, now()],
  );
}

/** The workspace retention policy row, if one was configured. */
export function getPiRetentionPolicyRow(workspaceId: string): PiOpsPolicyRow | undefined {
  const db = getDb();
  return db
    .query(
      `SELECT workspace_id AS workspaceId, policy_json AS policyJson, updated_at AS updatedAt
       FROM pi_retention_policies WHERE workspace_id = ?`,
    )
    .get(workspaceId) as PiOpsPolicyRow | undefined;
}

/** Upsert the workspace retention policy row. */
export function upsertPiRetentionPolicyRow(workspaceId: string, policyJson: string): void {
  const db = getDb();
  db.run(
    `INSERT INTO pi_retention_policies (workspace_id, policy_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       policy_json = excluded.policy_json,
       updated_at = excluded.updated_at`,
    [workspaceId, policyJson, now()],
  );
}

/** Delete tool-call rows older than the cutoff (runs survive). Returns rows removed. */
export function deletePiToolCallsOlderThan(workspaceId: string, cutoffIso: string): number {
  const db = getDb();
  // Count matched rows first: bun:sqlite's .changes() also counts cascading FK
  // updates (e.g. ON DELETE SET NULL), which would inflate the reported total.
  const matched = db
    .query(
      `SELECT COUNT(*) AS c FROM product_intelligence_tool_calls
       WHERE started_at < ?
         AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
    )
    .get(cutoffIso, workspaceId) as { c: number };
  db.run(
    `DELETE FROM product_intelligence_tool_calls
     WHERE started_at < ?
       AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
    [cutoffIso, workspaceId],
  );
  return matched.c;
}

/**
 * Drop model request/response artifact refs on old tool calls without
 * deleting the call metadata. Returns rows updated.
 */
export function clearPiToolCallArtifactRefsOlderThan(workspaceId: string, cutoffIso: string): number {
  const db = getDb();
  return db
    .run(
      `UPDATE product_intelligence_tool_calls SET artifact_ref = NULL
       WHERE artifact_ref IS NOT NULL AND started_at < ?
         AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
      [cutoffIso, workspaceId],
    ).changes;
}

/** Delete source rows older than the cutoff (assets keep source_id via SET NULL). */
export function deletePiSourcesOlderThan(workspaceId: string, cutoffIso: string): number {
  const db = getDb();
  const matched = db
    .query(
      `SELECT COUNT(*) AS c FROM product_intelligence_sources
       WHERE created_at < ?
         AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
    )
    .get(cutoffIso, workspaceId) as { c: number };
  db.run(
    `DELETE FROM product_intelligence_sources
     WHERE created_at < ?
       AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
    [cutoffIso, workspaceId],
  );
  return matched.c;
}

/** Drop raw fetched-content refs (and content hashes) on old sources. */
export function clearPiSourceArtifactRefsOlderThan(workspaceId: string, cutoffIso: string): number {
  const db = getDb();
  return db
    .run(
      `UPDATE product_intelligence_sources SET artifact_ref = NULL, content_hash = NULL
       WHERE artifact_ref IS NOT NULL AND created_at < ?
         AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
      [cutoffIso, workspaceId],
    ).changes;
}

/** Delete image/asset rows older than the cutoff. */
export function deletePiAssetsOlderThan(workspaceId: string, cutoffIso: string): number {
  const db = getDb();
  const matched = db
    .query(
      `SELECT COUNT(*) AS c FROM product_intelligence_assets
       WHERE created_at < ?
         AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
    )
    .get(cutoffIso, workspaceId) as { c: number };
  db.run(
    `DELETE FROM product_intelligence_assets
     WHERE created_at < ?
       AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
    [cutoffIso, workspaceId],
  );
  return matched.c;
}

/** Tool calls in the given day for the given tool names (daily request budgets). */
export function countPiDailyToolCalls(workspaceId: string, dayStartIso: string, toolNames: string[]): number {
  if (toolNames.length === 0) return 0;
  const db = getDb();
  const dayEndIso = new Date(Date.parse(dayStartIso) + 86_400_000).toISOString();
  const placeholders = toolNames.map(() => '?').join(', ');
  return (
    db
      .query(
        `SELECT COUNT(*) AS c FROM product_intelligence_tool_calls
         WHERE started_at >= ? AND started_at < ?
           AND tool_name IN (${placeholders})
           AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
      )
      .get(dayStartIso, dayEndIso, ...toolNames, workspaceId) as { c: number }
  ).c;
}

/** Runs started within the given day. */
export function countPiDailyRuns(workspaceId: string, dayStartIso: string): number {
  const db = getDb();
  const dayEndIso = new Date(Date.parse(dayStartIso) + 86_400_000).toISOString();
  return (
    db
      .query(
        // PI-10: replays consume no execution quota, so they are excluded.
        `SELECT COUNT(*) AS c FROM product_intelligence_runs
         WHERE started_at >= ? AND started_at < ? AND workspace_id = ?
           AND origin_run_id IS NULL`,
      )
      .get(dayStartIso, dayEndIso, workspaceId) as { c: number }
  ).c;
}

/** Currently running runs for the workspace (concurrency budget). */
export function countPiRunningRuns(workspaceId: string): number {
  const db = getDb();
  return (
    db
      .query(
        `SELECT COUNT(*) AS c FROM product_intelligence_runs
         WHERE status = 'running' AND workspace_id = ?`,
      )
      .get(workspaceId) as { c: number }
  ).c;
}

/** Sum of the given cost column for runs started today. */
export function sumPiDailyCost(workspaceId: string, dayStartIso: string, column: 'estimated_cost' | 'actual_cost'): number {
  const db = getDb();
  const dayEndIso = new Date(Date.parse(dayStartIso) + 86_400_000).toISOString();
  return (
    db
      .query(
        `SELECT COALESCE(SUM(${column}), 0) AS s FROM product_intelligence_runs
         WHERE started_at >= ? AND started_at < ? AND workspace_id = ?`,
      )
      .get(dayStartIso, dayEndIso, workspaceId) as { s: number }
  ).s;
}

/** Total model tokens (input + output) reported by runs started today. */
export function sumPiDailyTokens(workspaceId: string, dayStartIso: string): number {
  const db = getDb();
  const dayEndIso = new Date(Date.parse(dayStartIso) + 86_400_000).toISOString();
  const rows = db
    .query(
      `SELECT token_usage_json AS t FROM product_intelligence_runs
       WHERE started_at >= ? AND started_at < ? AND workspace_id = ?`,
    )
    .all(dayStartIso, dayEndIso, workspaceId) as Array<{ t: string | null }>;
  let total = 0;
  for (const row of rows) {
    if (!row.t) continue;
    try {
      const usage = JSON.parse(row.t) as { input_tokens?: unknown; output_tokens?: unknown };
      const inputTokens = typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
      const outputTokens = typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
      total += inputTokens + outputTokens;
    } catch {
      // Malformed token JSON: ignore this row rather than failing enforcement.
    }
  }
  return total;
}

/** Total payload bytes stored by workspace assets (artifact storage budget). */
export function sumPiAssetPayloadBytes(workspaceId: string): number {
  const db = getDb();
  return (
    db
      .query(
        `SELECT COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS s FROM product_intelligence_assets
         WHERE payload_json IS NOT NULL
           AND run_id IN (SELECT id FROM product_intelligence_runs WHERE workspace_id = ?)`,
      )
      .get(workspaceId) as { s: number }
  ).s;
}
