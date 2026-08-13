import { listProducts } from '../../db/repositories/product-index-repo';
import { generateProductFieldAuditReport } from './catalog-insight-service';
import { autosaveDraft, getProductWithDraft } from './product-service';
import { findActiveChangeSet, createChangeSet } from '../../db/repositories/change-set-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import {
  findProposalById,
  listProposals as listProposalsInRepo,
  dismissProposal as dismissProposalInRepo,
  updateProposalStatus,
  deleteGeneratedProposals,
  findDuplicateProposal,
  insertProposal,
  type CatalogProposal,
} from '../../db/repositories/catalog-health-proposal-repo';

export type { CatalogProposal } from '../../db/repositories/catalog-health-proposal-repo';

/**
 * Thrown when a proposal cannot be found in the caller's workspace. The same
 * error is raised for foreign-owned and unknown ids so ownership is never
 * disclosed.
 */
export class ProposalNotFoundError extends Error {
  constructor() {
    super('Proposal not found.');
    this.name = 'ProposalNotFoundError';
  }
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
 * List proposals for the given workspace with optional filters.
 */
export function listProposals(
  workspaceId: string,
  filter?: { field?: string; status?: string }
): CatalogProposal[] {
  return listProposalsInRepo(workspaceId, filter);
}

/**
 * Fetch a single proposal by ID within the caller's workspace. A proposal
 * owned by another workspace returns null (same external result as unknown).
 */
export function getProposalById(workspaceId: string, id: string): CatalogProposal | null {
  return findProposalById(workspaceId, id);
}

/**
 * Dismiss/reject a proposal within the caller's workspace. Throws
 * ProposalNotFoundError when the id is not in the workspace so callers fail
 * closed instead of silently succeeding with no effect.
 */
export function dismissProposal(workspaceId: string, id: string): void {
  const dismissed = dismissProposalInRepo(workspaceId, id);
  if (!dismissed) {
    throw new ProposalNotFoundError();
  }
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

  // 4. Save to Database through the workspace-scoped repository.
  // Clear previous unapplied proposed changes for this field in this workspace.
  deleteGeneratedProposals(workspaceId, field, 'deterministic');

  const inserted: CatalogProposal[] = [];

  for (const p of proposals) {
    // Check if an identical proposal already exists in this workspace to avoid duplicate suggestions
    const existingId = findDuplicateProposal(workspaceId, p.field, p.oldValue, p.newValue);
    if (existingId) {
      continue;
    }

    inserted.push(
      insertProposal({
        workspaceId: p.workspaceId,
        field: p.field,
        oldValue: p.oldValue,
        newValue: p.newValue,
        affectedSkus: p.affectedSkus,
        reason: p.reason,
        confidence: p.confidence,
        source: p.source,
        status: 'proposed',
      }),
    );
  }

  return inserted;
}

/**
 * Apply a proposal by saving product drafts to the active change set.
 *
 * Workspace ownership is enforced at the repository/service boundary: the
 * proposal is re-read scoped to the active workspace and its SKU set is
 * validated against the workspace data source before any draft write. A
 * foreign or unknown id throws ProposalNotFoundError before side effects.
 */
export function applyProposal(
  workspaceId: string,
  workspacePath: string,
  id: string
): { changeSetId: string } {
  const proposal = findProposalById(workspaceId, id);
  if (!proposal) {
    throw new ProposalNotFoundError();
  }

  if (proposal.status !== 'proposed') {
    throw new Error(`Proposal is already ${proposal.status} and cannot be applied.`);
  }

  // Fail closed before side effects: every affected SKU must resolve in the
  // current workspace data source.
  for (const sku of proposal.affectedSkus) {
    const productWithDraft = getProductWithDraft(workspaceId, workspacePath, sku);
    if (!productWithDraft.merged && !productWithDraft.approved) {
      throw new Error(
        `Proposal references SKU "${sku}" that is not present in the current workspace; not applied.`,
      );
    }
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

  // Update proposal status in DB, scoped to this workspace (both keys).
  const updated = updateProposalStatus(workspaceId, id, 'applied', targetChangeSetId);
  if (!updated) {
    throw new Error('Proposal could not be updated in the current workspace.');
  }

  return { changeSetId: targetChangeSetId };
}
