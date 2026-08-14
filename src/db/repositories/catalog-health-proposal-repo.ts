import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { hashCanonicalJson } from '../../shared/stable-id';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import {
  CatalogProposalSchema,
  InsertCatalogProposalSchema,
  type CatalogProposal,
  type InsertCatalogProposal,
  type ProposalSource,
  type ProposalStatus,
  type NormalizationKind,
} from '../../shared/schemas/catalog-health-proposal';

// ---------------------------------------------------------------------------
// catalog_health_proposals repository (epic #42, #35 + #39)
//
// Workspace identity is part of every read/mutation contract: lookups and
// updates predicate on `workspace_id` so a proposal from another workspace is
// indistinguishable from a missing one. Every mutating helper reports whether
// a row in the caller's workspace was actually affected so services can fail
// closed.
//
// The persisted row type is the shared Zod schema (single contract with the
// client); `insertProposal` validates its input against the schema so no
// model-controlled field reaches SQL without structural validation.
// ---------------------------------------------------------------------------

export type { ProposalStatus, ProposalSource, CatalogProposal };

/** Input accepted by the repository insert path (see shared schema). */
export type InsertProposalInput = InsertCatalogProposal;


/**
 * List proposals for one workspace with optional field/status filters.
 */
export function listProposals(
  workspaceId: string,
  filter?: { field?: string; status?: string },
): CatalogProposal[] {
  const db = getDb();
  let sql = 'SELECT * FROM catalog_health_proposals WHERE workspace_id = ?';
  const params: unknown[] = [workspaceId];

  if (filter?.field) {
    sql += ' AND field = ?';
    params.push(filter.field);
  }
  if (filter?.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }

  sql += ' ORDER BY confidence DESC, created_at DESC';

  const rows = db.query(sql).all(...(params as any[])) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Fetch a single proposal by ID, scoped to the caller's workspace. A proposal
 * owned by another workspace returns null (same external result as unknown).
 */
export function findProposalById(workspaceId: string, id: string): CatalogProposal | null {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM catalog_health_proposals WHERE workspace_id = ? AND id = ?',
  ).get(workspaceId, id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

/**
 * Dismiss a proposal within the caller's workspace. Returns true only when a
 * row was actually updated; foreign/unknown ids return false without a side
 * effect.
 */
export function dismissProposal(workspaceId: string, id: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE catalog_health_proposals SET status = 'dismissed', updated_at = ? WHERE workspace_id = ? AND id = ?",
    [now, workspaceId, id],
  );
  return Number(result.changes ?? 0) > 0;
}

/**
 * Delete generated `proposed` proposals for a workspace/field, optionally
 * restricted to one source. Returns the number of deleted rows.
 */
export function deleteGeneratedProposals(
  workspaceId: string,
  field: string,
  source?: ProposalSource,
): number {
  const db = getDb();
  let sql = "DELETE FROM catalog_health_proposals WHERE workspace_id = ? AND field = ? AND status = 'proposed'";
  const params: any[] = [workspaceId, field];
  if (source) {
    sql += ' AND source = ?';
    params.push(source);
  }
  const result = db.run(sql, ...params);
  return Number(result.changes ?? 0);
}

/**
 * Returns the id of an existing proposal matching the exact workspace, field,
 * old value, and new value, or null. Used to avoid duplicate suggestions.
 */
export function findDuplicateProposal(
  workspaceId: string,
  field: string,
  oldValue: string,
  newValue: string,
): string | null {
  const db = getDb();
  const row = db.query(
    'SELECT id FROM catalog_health_proposals WHERE workspace_id = ? AND field = ? AND old_value = ? AND new_value = ? LIMIT 1',
  ).get(workspaceId, field, oldValue, newValue) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Deterministic content digest for a proposal's mapping + evidence identity
 * (operations console, Issue 8). Bulk previews bind this exact row: if the
 * mapping or affected-SKU set changes after the preview, the digest mismatch
 * refuses the WHOLE batch. Unknown/null metadata yields a stable digest over
 * whatever is present, so legacy rows can never be reclassified as eligible.
 */
export function computeProposalDigest(proposal: {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  affectedSkus: string[];
  normalizationKind: NormalizationKind | null;
  ruleVersion: string | null;
  evidenceKey: string | null;
}): string {
  return hashCanonicalJson({
    id: proposal.id,
    field: proposal.field,
    oldValue: proposal.oldValue,
    newValue: proposal.newValue,
    affectedSkus: proposal.affectedSkus,
    normalizationKind: proposal.normalizationKind ?? null,
    ruleVersion: proposal.ruleVersion ?? null,
    evidenceKey: proposal.evidenceKey ?? null,
  });
}

/**
 * Insert a proposal and return the stored row. The input is validated against
 * the shared schema before any SQL runs (defense in depth; the AI path
 * additionally runs business-rule validation before calling here). The bulk-
 * review metadata columns default to `manual_review_required = 1` when the
 * caller does not supply them (fail closed: unknown provenance is ineligible).
 */
export function insertProposal(input: InsertProposalInput): CatalogProposal {
  const parsed = InsertCatalogProposalSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Invalid proposal input: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  // The bulk-review metadata columns are additive (operations schema);
  // self-heal so any caller (legacy suites, collectors) stays safe.
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  const normalizationKind: NormalizationKind | null = parsed.data.normalizationKind ?? null;
  const ruleVersion: string | null = parsed.data.ruleVersion ?? null;
  const evidenceKey: string | null = parsed.data.evidenceKey ?? null;
  const manualReviewRequired = parsed.data.manualReviewRequired ?? true;
  const digestRow = {
    id,
    field: parsed.data.field,
    oldValue: parsed.data.oldValue,
    newValue: parsed.data.newValue,
    affectedSkus: parsed.data.affectedSkus,
    normalizationKind,
    ruleVersion,
    evidenceKey,
  };
  const currentDigest = computeProposalDigest(digestRow);
  db.run(
    `INSERT INTO catalog_health_proposals (id, workspace_id, field, old_value, new_value, affected_skus, reason, confidence, source, status, normalization_kind, rule_version, evidence_key, manual_review_required, current_digest, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      parsed.data.workspaceId,
      parsed.data.field,
      parsed.data.oldValue,
      parsed.data.newValue,
      JSON.stringify(parsed.data.affectedSkus),
      parsed.data.reason,
      parsed.data.confidence,
      parsed.data.source,
      parsed.data.status ?? 'proposed',
      normalizationKind,
      ruleVersion,
      evidenceKey,
      manualReviewRequired ? 1 : 0,
      currentDigest,
      now,
      now,
    ],
  );
  return findProposalById(parsed.data.workspaceId, id)!;
}

/**
 * Atomically replace prior AI-generated `proposed` rows for a workspace/field
 * with the validated accepted candidates, inside ONE transaction. Structural
 * validation happens BEFORE this call; on any throw the whole replace rolls
 * back and prior proposals are preserved.
 */
export function replaceAiProposalsForField(
  workspaceId: string,
  field: string,
  candidates: Array<Omit<InsertCatalogProposal, 'workspaceId' | 'field' | 'source' | 'status'>>,
): CatalogProposal[] {
  const db = getDb();
  return db.transaction(() => {
    deleteGeneratedProposals(workspaceId, field, 'ai');
    const inserted: CatalogProposal[] = [];
    for (const candidate of candidates) {
      // Avoid re-proposing a mapping that already exists in this workspace
      // (proposed, applied, or dismissed) inside the same transaction.
      const existing = findDuplicateProposal(
        workspaceId,
        field,
        candidate.oldValue,
        candidate.newValue,
      );
      if (existing) continue;
      inserted.push(
        insertProposal({
          ...candidate,
          workspaceId,
          field,
          source: 'ai',
          status: 'proposed',
        }),
      );
    }
    return inserted;
  })();
}

/**
 * Update a proposal's status (optionally recording the Change Set it was
 * staged into), scoped to the caller's workspace. Returns true only when a
 * row was actually updated.
 */
export function updateProposalStatus(
  workspaceId: string,
  id: string,
  status: ProposalStatus,
  changeSetId?: string | null,
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result =
    changeSetId !== undefined
      ? db.run(
          'UPDATE catalog_health_proposals SET status = ?, change_set_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
          [status, changeSetId, now, workspaceId, id],
        )
      : db.run(
          'UPDATE catalog_health_proposals SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
          [status, now, workspaceId, id],
        );
  return Number(result.changes ?? 0) > 0;
}

/**
 * Count proposals in one workspace by status.
 */
export function countProposalsByStatus(workspaceId: string, status: string): number {
  const db = getDb();
  const row = db.query(
    'SELECT COUNT(*) as count FROM catalog_health_proposals WHERE workspace_id = ? AND status = ?',
  ).get(workspaceId, status) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * Bounded workspace-scoped proposal review summary (operations console,
 * Issue 3 — Inbox collector). Returns the total count of `proposed` rows plus
 * a bounded set of recent samples with truncated values for display only.
 */
export function getProposalReviewSummary(
  workspaceId: string,
  limit = 10,
): { count: number; samples: Array<{ id: string; field: string; oldValue: string; newValue: string; createdAt: string }> } {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 50);
  const count = countProposalsByStatus(workspaceId, 'proposed');
  const rows = db.query(
    "SELECT id, field, old_value, new_value, created_at FROM catalog_health_proposals WHERE workspace_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT ?",
  ).all(...[workspaceId, bounded]) as Array<Record<string, unknown>>;
  return {
    count,
    samples: rows.map((r) => ({
      id: String(r.id),
      field: String(r.field),
      oldValue: String(r.old_value).slice(0, 200),
      newValue: String(r.new_value).slice(0, 200),
      createdAt: String(r.created_at),
    })),
  };
}

/**
 * Count proposals per field in one workspace (optionally restricted to one
 * status), used by the evidence-grounded cleanup report (epic #42, #38).
 */
export function countProposalsByField(workspaceId: string, status?: string): Record<string, number> {
  const db = getDb();
  let sql = 'SELECT field, COUNT(*) as count FROM catalog_health_proposals WHERE workspace_id = ?';
  const params: any[] = [workspaceId];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' GROUP BY field';
  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  const byField: Record<string, number> = {};
  for (const row of rows) {
    byField[String(row.field)] = Number(row.count) || 0;
  }
  return byField;
}

function mapRow(row: Record<string, unknown>): CatalogProposal {
  let affectedSkus: string[] = [];
  try {
    affectedSkus = JSON.parse(String(row.affected_skus));
  } catch {
    // fallback to empty list
  }

  const kindRaw = row.normalization_kind;
  const normalizationKind = kindRaw === null || kindRaw === undefined ? null : (String(kindRaw) as NormalizationKind);
  const manualReviewRequired =
    row.manual_review_required === null || row.manual_review_required === undefined
      ? true
      : Number(row.manual_review_required) === 1;

  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    field: String(row.field),
    oldValue: String(row.old_value),
    newValue: String(row.new_value),
    affectedSkus,
    reason: String(row.reason),
    confidence: Number(row.confidence),
    source: row.source as ProposalSource,
    status: row.status as ProposalStatus,
    changeSetId: row.change_set_id ? String(row.change_set_id) : null,
    normalizationKind,
    ruleVersion: row.rule_version ? String(row.rule_version) : null,
    evidenceKey: row.evidence_key ? String(row.evidence_key) : null,
    manualReviewRequired,
    currentDigest: row.current_digest ? String(row.current_digest) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
