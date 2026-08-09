/**
 * Classification quality-telemetry repository (issue #17 work item F).
 *
 * READ-ONLY raw projections only: every query is workspace-scoped and
 * date-bounded. The pure aggregation in production-metrics.ts consumes these
 * shapes. No writes, no mutations — generating a report changes no row.
 */
import { getDb } from '../connection';
import type {
  QualityRunInput,
  QualityProposalInput,
  QualityLiveDecisionInput,
  QualityModelCallInput,
  QualitySnapshotDigest,
} from '../../classification/production-metrics';
import { computeQualityReport } from '../../classification/production-metrics';
import {
  QualityReportSchema,
  type QualityReport,
} from '../../shared/schemas/classification-metrics';

interface ProposalRow {
  id: string;
  run_id: string;
  proposal_type: string;
  target_id: string | null;
  confidence: number;
  status: string;
  is_stale: number;
  supporting_evidence_ids_json: string | null;
  contradicting_evidence_ids_json: string | null;
}

interface RunRow {
  id: string;
  source_kind: string;
  source_product_hash: string | null;
  product_sku: string;
  config_snapshot_hash: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
}

interface DecisionRow {
  proposal_id: string;
  decision: string;
  has_revised_value: number;
  has_revised_target: number;
}

interface ModelCallRow {
  run_id: string;
  provider: string | null;
  model: string | null;
  status: string;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated_cost_usd: number | null;
  cost_basis: string | null;
}

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Completed-or-terminal runs started within the window for the workspace. */
function getQualityRuns(workspaceId: string, startIso: string, endIso: string): QualityRunInput[] {
  const rows = getDb()
    .query(
      `SELECT id, source_kind, source_product_hash, product_sku, config_snapshot_hash, status, started_at, completed_at
       FROM classification_runs
       WHERE workspace_id = ? AND started_at >= ? AND started_at <= ?
       ORDER BY started_at ASC, id ASC`,
    )
    .all(workspaceId, startIso, endIso) as unknown as RunRow[];
  return rows.map(r => ({
    id: r.id,
    sourceKind: r.source_kind ?? null,
    sourceProductHash: r.source_product_hash ?? null,
    productSku: r.product_sku,
    configSnapshotHash: r.config_snapshot_hash ?? null,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null,
  }));
}

/** Proposals for the given runs, with supporting/contradicting role arrays. */
function getQualityProposals(
  workspaceId: string,
  runIds: string[],
  startIso: string,
  endIso: string,
): QualityProposalInput[] {
  if (runIds.length === 0) return [];
  const placeholders = runIds.map(() => '?').join(', ');
  const rows = getDb()
    .query(
      `SELECT p.id, p.run_id, p.proposal_type, p.target_id, p.confidence, p.status, p.is_stale,
              p.supporting_evidence_ids_json, p.contradicting_evidence_ids_json
       FROM classification_proposals p
       JOIN classification_runs r ON r.id = p.run_id
       WHERE r.workspace_id = ? AND p.run_id IN (${placeholders})
         AND p.created_at >= ? AND p.created_at <= ?
       ORDER BY p.created_at ASC, p.id ASC`,
    )
    .all(workspaceId, ...runIds, startIso, endIso) as unknown as ProposalRow[];
  return rows.map(p => ({
    id: p.id,
    runId: p.run_id,
    proposalType: p.proposal_type,
    targetId: p.target_id ?? null,
    confidence: p.confidence,
    status: p.status,
    isStale: p.is_stale === 1,
    supportingEvidenceIds: parseStringArray(p.supporting_evidence_ids_json),
    contradictingEvidenceIds: parseStringArray(p.contradicting_evidence_ids_json),
    configSnapshotHash: null, // filled by caller via run linkage if needed
    sourceKind: null,
  }));
}

/**
 * One latest LIVE decision per proposal (superseded rows never returned).
 * Decision creation timestamps are bounded to the window so no historical
 * decision outside the report window leaks in.
 */
function getQualityLiveDecisions(
  workspaceId: string,
  runIds: string[],
  startIso: string,
  endIso: string,
): QualityLiveDecisionInput[] {
  if (runIds.length === 0) return [];
  const placeholders = runIds.map(() => '?').join(', ');
  const rows = getDb()
    .query(
      `SELECT d.proposal_id, d.decision,
              (CASE WHEN d.revised_value_json IS NULL THEN 0 ELSE 1 END) AS has_revised_value,
              d.has_revised_target
       FROM classification_proposal_decisions d
       JOIN classification_proposals p ON p.id = d.proposal_id
       JOIN classification_runs r ON r.id = p.run_id
       WHERE r.workspace_id = ? AND p.run_id IN (${placeholders})
         AND d.superseded_at IS NULL
         AND d.created_at >= ? AND d.created_at <= ?
       ORDER BY d.created_at DESC, d.rowid DESC`,
    )
    .all(workspaceId, ...runIds, startIso, endIso) as unknown as DecisionRow[];
  // Per-proposal selection: the query is ordered newest-first (created_at DESC,
  // rowid DESC — matching the canonical pattern in classification-run-repo), so
  // the FIRST row encountered for a proposal is the latest live decision. Keep
  // it and skip any older live row that follows.
  const byProposal = new Map<string, QualityLiveDecisionInput>();
  for (const r of rows) {
    if (byProposal.has(r.proposal_id)) continue;
    byProposal.set(r.proposal_id, {
      proposalId: r.proposal_id,
      decision: r.decision as 'accepted' | 'rejected' | 'deferred',
      hasRevisedValue: r.has_revised_value === 1,
      hasRevisedTargetId: r.has_revised_target === 1,
      evidenceIds: [],
    });
  }
  // Attach decision evidence citations (work item I join table).
  if (byProposal.size > 0) {
    const proposalIds = [...byProposal.keys()];
    const ph = proposalIds.map(() => '?').join(', ');
    const decisionRows = getDb()
      .query(
        `SELECT d.proposal_id, de.evidence_id
         FROM classification_proposal_decision_evidence de
         JOIN classification_proposal_decisions d ON d.id = de.decision_id
         WHERE d.proposal_id IN (${ph}) AND d.superseded_at IS NULL`,
      )
      .all(...proposalIds) as Array<{ proposal_id: string; evidence_id: string }>;
    for (const row of decisionRows) {
      const entry = byProposal.get(row.proposal_id);
      if (entry) entry.evidenceIds.push(String(row.evidence_id));
    }
  }
  for (const entry of byProposal.values()) {
    entry.evidenceIds = [...new Set(entry.evidenceIds)].sort();
  }
  return [...byProposal.values()].sort((a, b) => a.proposalId.localeCompare(b.proposalId));
}

/** Model calls bound to the given runs (all statuses; cost/latency filtered purely). */
function getQualityModelCalls(workspaceId: string, runIds: string[], startIso: string, endIso: string): QualityModelCallInput[] {
  if (runIds.length === 0) return [];
  const placeholders = runIds.map(() => '?').join(', ');
  const rows = getDb()
    .query(
      `SELECT c.run_id, c.provider, c.model, c.status, c.duration_ms, c.prompt_tokens, c.completion_tokens,
              c.estimated_cost_usd, c.cost_basis
       FROM classification_model_calls c
       JOIN classification_runs r ON r.id = c.run_id
       WHERE r.workspace_id = ? AND c.run_id IN (${placeholders})
         AND c.started_at >= ? AND c.started_at <= ?
       ORDER BY c.started_at ASC, c.id ASC`,
    )
    .all(workspaceId, ...runIds, startIso, endIso) as unknown as ModelCallRow[];
  return rows.map(c => ({
    runId: c.run_id,
    provider: c.provider ?? null,
    model: c.model ?? null,
    status: c.status,
    durationMs: c.duration_ms,
    promptTokens: c.prompt_tokens,
    completionTokens: c.completion_tokens,
    estimatedCostUsd: c.estimated_cost_usd,
    costBasis: c.cost_basis ?? null,
  }));
}

/**
 * Runtime snapshot digests for the config-snapshot hashes present in the
 * window. Unresolvable hashes simply have no entry (the pure aggregation
 * warns + excludes legacy denominators).
 */
function getQualitySnapshotDigests(workspaceId: string, configSnapshotHashes: string[]): QualitySnapshotDigest[] {
  const unique = [...new Set(configSnapshotHashes.filter(Boolean))];
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => '?').join(', ');
  const rows = getDb()
    .query(
      `SELECT snapshot_hash, config_json FROM classification_config_snapshots
       WHERE workspace_id = ? AND snapshot_hash IN (${placeholders})`,
    )
    .all(workspaceId, ...unique) as Array<{ snapshot_hash: string; config_json: string }>;
  const out: QualitySnapshotDigest[] = [];
  for (const row of rows) {
    let parsed: any;
    try {
      parsed = JSON.parse(row.config_json);
    } catch {
      continue; // malformed snapshot → no entry (legacy/unavailable)
    }
    if (!parsed || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || typeof parsed.snapshotHash !== 'string') {
      continue;
    }
    const enabledTargets =
      Array.isArray(parsed.config?.curationTargets) &&
      parsed.config.curationTargets.some((t: any) => t && t.enabled === true);
    out.push({
      configSnapshotHash: row.snapshot_hash,
      schemaVersion: parsed.schemaVersion,
      modelPlanDigest: parsed.modelExecutionPlan?.digest ?? null,
      ruleVersionsDigest: parsed.runtimeRuleVersions?.digest ?? null,
      enabledTargets: enabledTargets === true,
    });
  }
  return out;
}

/**
 * Source watermark: the latest created/updated timestamp across the tables a
 * report reads, bounded to the window and workspace. Used for deterministic
 * "as of" labeling; a null watermark means no data was found.
 */
function getQualitySourceWatermark(workspaceId: string, startIso: string, endIso: string): string | null {
  const db = getDb();
  const rows = db
    .query(
      `SELECT MAX(ts) AS m FROM (
         SELECT started_at AS ts FROM classification_runs WHERE workspace_id = ? AND started_at BETWEEN ? AND ?
         UNION ALL
         SELECT p.created_at AS ts FROM classification_proposals p
           JOIN classification_runs r ON r.id = p.run_id
           WHERE r.workspace_id = ? AND p.created_at BETWEEN ? AND ?
         UNION ALL
         SELECT d.created_at AS ts FROM classification_proposal_decisions d
           JOIN classification_proposals p ON p.id = d.proposal_id
           JOIN classification_runs r ON r.id = p.run_id
           WHERE r.workspace_id = ? AND d.created_at BETWEEN ? AND ?
         UNION ALL
         SELECT c.started_at AS ts FROM classification_model_calls c
           JOIN classification_runs r ON r.id = c.run_id
           WHERE r.workspace_id = ? AND c.started_at BETWEEN ? AND ?
       )`,
    )
    .get(workspaceId, startIso, endIso, workspaceId, startIso, endIso, workspaceId, startIso, endIso, workspaceId, startIso, endIso) as
    | { m: string | null }
    | undefined;
  return rows?.m ?? null;
}

/** Run ids for the window/workspace (used to bound proposal/decision/call joins). */
export function getQualityRunIds(workspaceId: string, startIso: string, endIso: string): string[] {
  return (getDb()
    .query(
      'SELECT id FROM classification_runs WHERE workspace_id = ? AND started_at BETWEEN ? AND ? ORDER BY started_at ASC, id ASC',
    )
    .all(workspaceId, startIso, endIso) as Array<{ id: string }>).map(r => r.id);
}

/**
 * Build the versioned production quality report for a workspace/window.
 *
 * Read-only: every projection is workspace-scoped and date-bounded, and the
 * pure aggregation never writes. The result is validated against the shared
 * Zod schema before return. `generatedAt` is an explicit parameter so tests
 * and callers stay deterministic.
 */
export function buildQualityReport(
  workspaceId: string,
  start: string,
  end: string,
  generatedAt: string = new Date().toISOString(),
): QualityReport {
  const runIds = getQualityRunIds(workspaceId, start, end);
  const runs = getQualityRuns(workspaceId, start, end);
  const proposals = getQualityProposals(workspaceId, runIds, start, end);
  const decisions = getQualityLiveDecisions(workspaceId, runIds, start, end);
  const modelCalls = getQualityModelCalls(workspaceId, runIds, start, end);
  const snapshots = getQualitySnapshotDigests(
    workspaceId,
    runs.map(r => r.configSnapshotHash ?? '').filter(Boolean),
  );
  const sourceWatermark = getQualitySourceWatermark(workspaceId, start, end);

  const report = computeQualityReport({
    workspaceId,
    start,
    end,
    sourceWatermark,
    generatedAt,
    runs,
    proposals,
    decisions,
    modelCalls,
    snapshots,
  });

  const parsed = QualityReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(
      `Quality report failed schema validation: ${parsed.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ')}`,
    );
  }
  return parsed.data;
}
