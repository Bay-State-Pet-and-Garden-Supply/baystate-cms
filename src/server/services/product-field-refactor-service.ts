import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection';
import { listProducts } from '../../db/repositories/product-index-repo';
import { generateProductFieldAuditReport } from './catalog-insight-service';
import { autosaveDraft, getProductWithDraft } from './product-service';
import { findActiveChangeSet, createChangeSet } from '../../db/repositories/change-set-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';

export interface CatalogProposal {
  id: string;
  workspaceId: string;
  field: string;
  oldValue: string;
  newValue: string;
  affectedSkus: string[];
  reason: string;
  confidence: number;
  source: 'deterministic' | 'ai';
  status: 'proposed' | 'applied' | 'dismissed';
  changeSetId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Find all active product SKUs that match a specific custom field value exactly.
 */
// fallow-ignore-next-line unused-export — used by tests
export function findExactSkusWithFieldValue(field: string, value: string): string[] {
  const { products } = listProducts();
  const skus: string[] = [];
  for (const p of products) {
    if (p.status === 'active') {
      const val = p.customFields?.[field];
      if (val === value) {
        skus.push(p.sku);
      }
    }
  }
  return skus;
}

/**
 * Find all active product SKUs that match a specific custom field value case-insensitively.
 */
export function findSkusWithFieldValueCaseInsensitive(field: string, value: string): string[] {
  const { products } = listProducts();
  const skus: string[] = [];
  const target = value.toLowerCase().trim();
  for (const p of products) {
    if (p.status === 'active') {
      const val = p.customFields?.[field];
      if (val !== undefined && val !== null && val.toLowerCase().trim() === target) {
        skus.push(p.sku);
      }
    }
  }
  return skus;
}

/**
 * List proposals from the database with optional filters.
 */
export function listProposals(
  workspaceId: string,
  filter?: { field?: string; status?: string }
): CatalogProposal[] {
  const db = getDb();
  let sql = 'SELECT * FROM catalog_health_proposals WHERE workspace_id = ?';
  const params: any[] = [workspaceId];

  if (filter?.field) {
    sql += ' AND field = ?';
    params.push(filter.field);
  }
  if (filter?.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }

  sql += ' ORDER BY confidence DESC, created_at DESC';

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Fetch a single proposal by ID.
 */
export function getProposalById(id: string): CatalogProposal | null {
  const db = getDb();
  const row = db.query('SELECT * FROM catalog_health_proposals WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return mapRow(row);
}

/**
 * Dismiss/reject a proposal.
 */
export function dismissProposal(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    "UPDATE catalog_health_proposals SET status = 'dismissed', updated_at = ? WHERE id = ?",
    [now, id]
  );
}

/**
 * Generate and store deterministic proposals for a given ProductField.
 */
export function generateDeterministicProposals(
  workspaceId: string,
  field: string
): CatalogProposal[] {
  const report = generateProductFieldAuditReport(workspaceId, field);
  const proposals: Omit<CatalogProposal, 'id' | 'createdAt' | 'updatedAt' | 'changeSetId'>[] = [];

  // 1. Casing Normalization
  for (const group of report.casingDuplicates) {
    // Pick the value with the highest frequency as canonical
    const sorted = [...group.values].sort((a, b) => b.frequency - a.frequency);
    const canonical = sorted[0];

    // For all other values in the casing group, propose renaming to canonical
    for (let i = 1; i < sorted.length; i++) {
      const item = sorted[i];
      proposals.push({
        workspaceId,
        field,
        oldValue: item.value,
        newValue: canonical.value,
        affectedSkus: findExactSkusWithFieldValue(field, item.value),
        reason: 'casing normalization',
        confidence: 0.95,
        source: 'deterministic',
        status: 'proposed',
      });
    }
  }

  // 2. Near duplicates / Typo correction
  for (const pair of report.nearDuplicates) {
    const freqA = pair.frequencyA;
    const freqB = pair.frequencyB;

    // We only propose if there's a type consensus frequency imbalance (e.g. at least 3x difference)
    if (freqA >= 3 * freqB) {
      // Propose changing B to A
      proposals.push({
        workspaceId,
        field,
        oldValue: pair.valueB,
        newValue: pair.valueA,
        affectedSkus: findExactSkusWithFieldValue(field, pair.valueB),
        reason: 'typo correction',
        confidence: 0.85,
        source: 'deterministic',
        status: 'proposed',
      });
    } else if (freqB >= 3 * freqA) {
      // Propose changing A to B
      proposals.push({
        workspaceId,
        field,
        oldValue: pair.valueA,
        newValue: pair.valueB,
        affectedSkus: findExactSkusWithFieldValue(field, pair.valueA),
        reason: 'typo correction',
        confidence: 0.85,
        source: 'deterministic',
        status: 'proposed',
      });
    }
  }

  // 3. Leading/trailing whitespace trimming
  for (const suspicious of report.suspiciousValues) {
    if (suspicious.reasons.includes('Leading or trailing whitespace')) {
      const trimmed = suspicious.value.trim();
      if (trimmed !== suspicious.value) {
        proposals.push({
          workspaceId,
          field,
          oldValue: suspicious.value,
          newValue: trimmed,
          affectedSkus: findExactSkusWithFieldValue(field, suspicious.value),
          reason: 'trim whitespace',
          confidence: 0.99,
          source: 'deterministic',
          status: 'proposed',
        });
      }
    }
  }

  // 4. Save to Database
  const db = getDb();
  const now = new Date().toISOString();

  // Clear previous unapplied proposed changes for this field
  db.run(
    "DELETE FROM catalog_health_proposals WHERE workspace_id = ? AND field = ? AND status = 'proposed'",
    [workspaceId, field]
  );

  const inserted: CatalogProposal[] = [];

  for (const p of proposals) {
    // Check if a identical applied or dismissed proposal already exists to avoid duplicate suggestions
    const existing = db.query(
      'SELECT id FROM catalog_health_proposals WHERE workspace_id = ? AND field = ? AND old_value = ? AND new_value = ? LIMIT 1'
    ).get(workspaceId, p.field, p.oldValue, p.newValue) as { id: string } | undefined;

    if (existing) {
      continue;
    }

    const id = randomUUID();
    db.run(
      `INSERT INTO catalog_health_proposals (id, workspace_id, field, old_value, new_value, affected_skus, reason, confidence, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        p.workspaceId,
        p.field,
        p.oldValue,
        p.newValue,
        JSON.stringify(p.affectedSkus),
        p.reason,
        p.confidence,
        p.source,
        p.status,
        now,
        now,
      ]
    );

    inserted.push({
      id,
      ...p,
      changeSetId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return inserted;
}

/**
 * Apply a proposal by saving product drafts to the active change set.
 */
export function applyProposal(
  workspaceId: string,
  workspacePath: string,
  id: string
): { changeSetId: string } {
  const proposal = getProposalById(id);
  if (!proposal) {
    throw new Error(`Proposal with ID "${id}" not found.`);
  }

  if (proposal.status !== 'proposed') {
    throw new Error(`Proposal is already ${proposal.status} and cannot be applied.`);
  }

  let lastChangeSetId = '';

  // Apply change to all affected products
  for (const sku of proposal.affectedSkus) {
    const productWithDraft = getProductWithDraft(workspaceId, workspacePath, sku);
    const currentVal = productWithDraft.merged?.customFields?.[proposal.field];
    if (currentVal === proposal.newValue) {
      continue;
    }

    const changes = {
      customFields: {
        [proposal.field]: proposal.newValue,
      },
    };

    const res = autosaveDraft(workspaceId, workspacePath, sku, changes);
    lastChangeSetId = res.changeSetId;
  }

  // If no products were modified (all were already correct), we still want to mark the proposal as applied!
  let targetChangeSetId = lastChangeSetId;
  if (!targetChangeSetId) {
    const activeCs = findActiveChangeSet(workspaceId);
    if (activeCs) {
      targetChangeSetId = activeCs.id;
    } else {
      const ws = findWorkspace();
      const baseCommit = ws?.baselineCommit ?? 'unknown';
      const newCs = createChangeSet({
        workspaceId,
        title: `Refactor ${proposal.field}`,
        baseCommit
      });
      targetChangeSetId = newCs.id;
    }
  }

  // Update proposal status in DB
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    "UPDATE catalog_health_proposals SET status = 'applied', change_set_id = ?, updated_at = ? WHERE id = ?",
    [targetChangeSetId, now, id]
  );

  return { changeSetId: targetChangeSetId };
}

function mapRow(row: Record<string, unknown>): CatalogProposal {
  let affectedSkus: string[] = [];
  try {
    affectedSkus = JSON.parse(String(row.affected_skus));
  } catch {
    // fallback
  }

  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    field: String(row.field),
    oldValue: String(row.old_value),
    newValue: String(row.new_value),
    affectedSkus,
    reason: String(row.reason),
    confidence: Number(row.confidence),
    source: row.source as any,
    status: row.status as any,
    changeSetId: row.change_set_id ? String(row.change_set_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
