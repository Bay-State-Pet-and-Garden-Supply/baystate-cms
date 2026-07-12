import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { ClassificationEvidence, ClassificationProposal, ClassificationProposalDecision } from '../../shared/types';

const now = () => new Date().toISOString();

// ─── Classification Runs ───────────────────────────────────────────────────────

export interface ClassificationRunRow {
  id: string;
  workspaceId: string;
  onboardingItemId: string | null;
  sourceKind: 'onboarding' | 'catalog_product';
  sourceProductHash: string | null;
  productSku: string;
  configSnapshotId: string | null;
  configSnapshotHash: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export function createRun(
  workspaceId: string,
  sku: string,
  configSnapshotId: string | null,
  configSnapshotHash: string | null,
  onboardingItemId?: string,
): ClassificationRunRow;
export function createRun(
  workspaceId: string,
  sku: string,
  configSnapshotId: string | null,
  configSnapshotHash: string | null,
  options?: {
    onboardingItemId?: string;
    sourceKind?: 'onboarding' | 'catalog_product';
    sourceProductHash?: string;
  },
): ClassificationRunRow;
export function createRun(
  workspaceId: string,
  sku: string,
  configSnapshotId: string | null,
  configSnapshotHash: string | null,
  optionsOrItemId?: string | {
    onboardingItemId?: string;
    sourceKind?: 'onboarding' | 'catalog_product';
    sourceProductHash?: string;
  },
): ClassificationRunRow {
  let onboardingItemId: string | undefined;
  let sourceKind: 'onboarding' | 'catalog_product' = 'onboarding';
  let sourceProductHash: string | null = null;

  if (typeof optionsOrItemId === 'string') {
    onboardingItemId = optionsOrItemId;
  } else if (optionsOrItemId) {
    onboardingItemId = optionsOrItemId.onboardingItemId;
    sourceKind = optionsOrItemId.sourceKind ?? (optionsOrItemId.onboardingItemId ? 'onboarding' : 'catalog_product');
    sourceProductHash = optionsOrItemId.sourceProductHash ?? null;
  }

  const id = randomUUID();
  const db = getDb();
  db.run(
    `INSERT INTO classification_runs
     (id, workspace_id, onboarding_item_id, source_kind, source_product_hash,
      product_sku, config_snapshot_id, config_snapshot_hash, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    [id, workspaceId, onboardingItemId ?? null, sourceKind, sourceProductHash, sku, configSnapshotId, configSnapshotHash, now()],
  );
  return { id, workspaceId, onboardingItemId: onboardingItemId ?? null, sourceKind, sourceProductHash, productSku: sku, configSnapshotId, configSnapshotHash, status: 'running', startedAt: now(), completedAt: null, errorMessage: null };
}

export function completeRun(
  runId: string,
  status: 'completed' | 'completed_with_abstentions' | 'failed',
  errorMessage?: string,
): void {
  getDb().run(
    'UPDATE classification_runs SET status = ?, completed_at = ?, error_message = ? WHERE id = ?',
    [status, now(), errorMessage ?? null, runId],
  );
}

export function getRecentRun(workspaceId: string, sku: string): ClassificationRunRow | null {
  const row = getDb()
    .query('SELECT * FROM classification_runs WHERE workspace_id = ? AND product_sku = ? ORDER BY started_at DESC LIMIT 1')
    .get(workspaceId, sku) as Record<string, any> | undefined;
  if (!row) return null;
  return mapRun(row);
}

export function getRun(id: string): ClassificationRunRow | null {
  const row = getDb()
    .query('SELECT * FROM classification_runs WHERE id = ?')
    .get(id) as Record<string, any> | undefined;
  if (!row) return null;
  return mapRun(row);
}

export function getRecentCatalogRun(workspaceId: string, sku: string): ClassificationRunRow | null {
  const row = getDb()
    .query("SELECT * FROM classification_runs WHERE workspace_id = ? AND product_sku = ? AND source_kind = 'catalog_product' ORDER BY started_at DESC LIMIT 1")
    .get(workspaceId, sku) as Record<string, any> | undefined;
  if (!row) return null;
  return mapRun(row);
}

export function supersedeCatalogProposals(workspaceId: string, sku: string, newRunId: string): void {
  const db = getDb();
  db.run(
    `UPDATE classification_proposals SET is_stale = 1, staleness_reason = 'Superseded by newer catalog run ' || ?, status = 'stale'
     WHERE product_sku = ? AND run_id IN (
       SELECT id FROM classification_runs WHERE workspace_id = ? AND product_sku = ? AND source_kind = 'catalog_product' AND id != ?
     )`,
    [newRunId, sku, workspaceId, sku, newRunId],
  );
}

// ─── Stage Results ─────────────────────────────────────────────────────────────

export function getStageResults(runId: string): Record<string, any>[] {
  return getDb()
    .query('SELECT * FROM classification_stage_results WHERE run_id = ? ORDER BY started_at ASC')
    .all(runId) as Record<string, any>[];
}

// ─── Evidence ──────────────────────────────────────────────────────────────────

export function getEvidenceByRun(runId: string): ClassificationEvidence[] {
  const rows = getDb()
    .query('SELECT * FROM classification_evidence WHERE run_id = ?')
    .all(runId) as Record<string, any>[];
  return rows.map(mapEvidence);
}

function getEvidenceBySku(productSku: string): ClassificationEvidence[] {
  const rows = getDb()
    .query('SELECT * FROM classification_evidence WHERE product_sku = ? ORDER BY created_at DESC')
    .all(productSku) as Record<string, any>[];
  return rows.map(mapEvidence);
}

// ─── Proposals ─────────────────────────────────────────────────────────────────

export function getProposalsByRun(runId: string): ClassificationProposal[] {
  const rows = getDb()
    .query('SELECT * FROM classification_proposals WHERE run_id = ?')
    .all(runId) as Record<string, any>[];
  return rows.map(mapProposal);
}

function getProposalsBySku(productSku: string): ClassificationProposal[] {
  const rows = getDb()
    .query('SELECT * FROM classification_proposals WHERE product_sku = ? ORDER BY created_at DESC')
    .all(productSku) as Record<string, any>[];
  return rows.map(mapProposal);
}

// fallow-ignore-next-line unused-export — used by tests
export function getPendingPageProposals(productSku: string): ClassificationProposal[] {
  const rows = getDb()
    .query("SELECT * FROM classification_proposals WHERE product_sku = ? AND proposal_type = ? AND status = ? ORDER BY confidence DESC")
    .all(productSku, 'category_page', 'pending') as Record<string, any>[];
  return rows.map(mapProposal);
}

export function getAcceptedProposals(productSku: string, runId?: string): ClassificationProposal[] {
  if (runId) {
    const rows = getDb()
      .query('SELECT * FROM classification_proposals WHERE product_sku = ? AND run_id = ? AND status = ?')
      .all(productSku, runId, 'accepted') as Record<string, any>[];
    return rows.map(mapProposal);
  }
  const rows = getDb()
    .query('SELECT * FROM classification_proposals WHERE product_sku = ? AND status = ?')
    .all(productSku, 'accepted') as Record<string, any>[];
  console.warn(`[ClassificationRunRepo] getAcceptedProposals called without runId for SKU ${productSku} — results are unscoped and may span multiple runs.`);
  return rows.map(mapProposal);
}

export function updateProposalReviewValue(
  proposalId: string,
  proposedValue: unknown,
  targetId?: string | null,
): void {
  if (targetId !== undefined) {
    getDb().run(
      'UPDATE classification_proposals SET proposed_value_json = ?, target_id = ? WHERE id = ?',
      [JSON.stringify(proposedValue), targetId, proposalId],
    );
    return;
  }
  getDb().run(
    'UPDATE classification_proposals SET proposed_value_json = ? WHERE id = ?',
    [JSON.stringify(proposedValue), proposalId],
  );
}

// ─── Decisions ─────────────────────────────────────────────────────────────────

export function recordDecision(decision: ClassificationProposalDecision): void {
  getDb().run(
    `INSERT INTO classification_proposal_decisions
     (id, proposal_id, decision, revised_from_id, reviewer_id, reviewer_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      decision.id || randomUUID(),
      decision.proposalId,
      decision.decision,
      decision.revisedFromId ?? null,
      decision.reviewerId ?? null,
      decision.reviewerNote ?? null,
      now(),
    ],
  );
  // Update proposal status
  const newStatus = decision.decision === 'accepted' ? 'accepted' : decision.decision === 'rejected' ? 'rejected' : 'deferred';
  getDb().run('UPDATE classification_proposals SET status = ? WHERE id = ?', [newStatus, decision.proposalId]);
}

function getDecisionsByProposal(proposalId: string): ClassificationProposalDecision[] {
  const rows = getDb()
    .query('SELECT * FROM classification_proposal_decisions WHERE proposal_id = ? ORDER BY created_at DESC')
    .all(proposalId) as Record<string, any>[];
  return rows.map(mapDecision);
}

// ─── History Events ────────────────────────────────────────────────────────────

export function recordHistoryEvent(
  workspaceId: string,
  productSku: string,
  eventType: string,
  eventJson: Record<string, unknown>,
  runId?: string,
  proposalId?: string,
  decisionId?: string,
): void {
  getDb().run(
    `INSERT INTO classification_history_events
     (id, workspace_id, product_sku, run_id, proposal_id, decision_id, event_type, event_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      workspaceId,
      productSku,
      runId ?? null,
      proposalId ?? null,
      decisionId ?? null,
      eventType,
      JSON.stringify(eventJson),
      now(),
    ],
  );
}

function getHistoryBySku(productSku: string): Record<string, any>[] {
  return getDb()
    .query('SELECT * FROM classification_history_events WHERE product_sku = ? ORDER BY created_at DESC')
    .all(productSku) as Record<string, any>[];
}

// ─── Mappers ───────────────────────────────────────────────────────────────────

function mapRun(row: Record<string, any>): ClassificationRunRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    onboardingItemId: row.onboarding_item_id ? String(row.onboarding_item_id) : null,
    sourceKind: String(row.source_kind || 'onboarding') as 'onboarding' | 'catalog_product',
    sourceProductHash: row.source_product_hash ? String(row.source_product_hash) : null,
    productSku: String(row.product_sku),
    configSnapshotId: row.config_snapshot_id ? String(row.config_snapshot_id) : null,
    configSnapshotHash: row.config_snapshot_hash ? String(row.config_snapshot_hash) : null,
    status: String(row.status),
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
  };
}

function mapEvidence(row: Record<string, any>): ClassificationEvidence {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageName: String(row.stage_name) as ClassificationEvidence['stageName'],
    productSku: String(row.product_sku),
    attributeId: row.attribute_id ? String(row.attribute_id) : null,
    source: String(row.source) as ClassificationEvidence['source'],
    reliability: String(row.reliability) as ClassificationEvidence['reliability'],
    sourceUrl: row.source_url ? String(row.source_url) : null,
    sourceField: row.source_field ? String(row.source_field) : null,
    snippet: row.snippet ? String(row.snippet) : null,
    value: row.value_json ? JSON.parse(String(row.value_json)) : null,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null,
    capturedAt: String(row.created_at),
  };
}

function mapProposal(row: Record<string, any>): ClassificationProposal {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    productSku: String(row.product_sku),
    proposalType: String(row.proposal_type) as ClassificationProposal['proposalType'],
    targetId: row.target_id ? String(row.target_id) : null,
    proposedValue: row.proposed_value_json ? JSON.parse(String(row.proposed_value_json)) : null,
    confidence: Number(row.confidence),
    evidenceIds: row.evidence_ids_json ? JSON.parse(String(row.evidence_ids_json)) : [],
    status: String(row.status) as ClassificationProposal['status'],
    isBulkAcceptable: Number(row.is_bulk_acceptable) === 1,
    isStale: Number(row.is_stale) === 1,
    stalenessReason: row.staleness_reason ? String(row.staleness_reason) : null,
    createdAt: String(row.created_at),
  };
}

function mapDecision(row: Record<string, any>): ClassificationProposalDecision {
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    decision: String(row.decision) as ClassificationProposalDecision['decision'],
    revisedFromId: row.revised_from_id ? String(row.revised_from_id) : null,
    reviewerId: row.reviewer_id ? String(row.reviewer_id) : null,
    reviewerNote: row.reviewer_note ? String(row.reviewer_note) : null,
    createdAt: String(row.created_at),
  };
}
