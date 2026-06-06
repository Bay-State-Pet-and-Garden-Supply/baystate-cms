import { hashJson } from '../../git/deterministic-json';
import { writeProductFile } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import {
  findChangeSetById, listChangeSets, listChangeSetItems,
  updateChangeSetStatus, deleteChangeSet,
} from '../../db/repositories/change-set-repo';
import {
  findProductBySku, insertProductIndex, updateProductIndex,
} from '../../db/repositories/product-index-repo';
import { reopenDriftForChangeSet, findLinkedDrift, resolveDrift } from '../../db/repositories/drift-repo';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import { GitClient } from '../../git/git-client';
import { validateChangeSet } from '../../validation/change-set-validation';
import type { ChangeSetRow, ChangeSetItemRow } from '../../db/repositories/change-set-repo';
import type { Product } from '../../shared/types';

/**
 * List change sets for a workspace.
 */
export function listWorkspaceChangeSets(workspaceId: string) {
  return listChangeSets(workspaceId);
}

/**
 * Get change set details with items.
 */
export function getChangeSetDetail(changeSetId: string): {
  changeSet: ChangeSetRow | null;
  items: ChangeSetItemRow[];
} {
  const changeSet = findChangeSetById(changeSetId);
  const items = changeSet ? listChangeSetItems(changeSetId) : [];
  return { changeSet, items };
}

/**
 * Approve a change set after validation:
 * - Writes deterministic product JSON files
 * - Updates product index
 * - Creates one Git commit
 */
export function approveChangeSet(
  changeSetId: string,
  workspacePath: string,
): { success: boolean; commitHash?: string; errors: string[] } {
  const changeSet = findChangeSetById(changeSetId);
  if (!changeSet) {
    return { success: false, errors: ['Change set not found'] };
  }

  if (changeSet.status !== 'draft') {
    return { success: false, errors: [`Cannot approve change set in status "${changeSet.status}"`] };
  }

  // Validate first
  const validation = validateChangeSet(changeSetId);
  if (!validation.canApprove) {
    return {
      success: false,
      errors: [`Change set has ${validation.blockers} blocker(s) preventing approval`],
    };
  }

  const items = listChangeSetItems(changeSetId);
  const errors: string[] = [];
  const committedSkus: string[] = [];

  // Write product files and update index
  for (const item of items) {
    try {
      const product = JSON.parse(item.draftJson) as Product;
      writeProductFile(workspacePath, product);

      // Update product index
      const existing = findProductBySku(item.sku);
      const productHash = hashJson(product);
      const hasAdvanced = product.shopsite.preserved.advancedBlocks
        && Object.keys(product.shopsite.preserved.advancedBlocks).length > 0;
      const hasWarnings = item.validationStatus === 'warning' ? 1 : 0;

      if (existing) {
        updateProductIndex({
          sku: item.sku,
          title: product.core.name,
          status: product.status,
          price: product.core.price,
          inventoryQuantity: product.core.inventory.quantityOnHand,
          primaryImage: product.core.media.primary,
          productHash,
          hasAdvancedBlocks: hasAdvanced ? 1 : 0,
          hasWarnings,
          syncStatus: existing.syncStatus,
          lastApprovedCommit: undefined, // Will be set after commit
        });
      } else {
        insertProductIndex({
          id: product.id,
          sku: item.sku,
          filePath: skuToProductFilePath(item.sku),
          title: product.core.name,
          status: product.status,
          price: product.core.price,
          inventoryQuantity: product.core.inventory.quantityOnHand,
          primaryImage: product.core.media.primary,
          productHash,
          lastApprovedCommit: null,
          lastPulledRemoteHash: null,
          lastSyncedRemoteHash: null,
          lastSyncedAt: null,
          syncStatus: 'not_synced',
          hasAdvancedBlocks: hasAdvanced ? 1 : 0,
          hasWarnings,
          createdAt: product.metadata.createdAt,
          updatedAt: product.metadata.updatedAt,
        });
      }

      committedSkus.push(item.sku);
    } catch (err) {
      errors.push(`Failed to write product ${item.sku}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0 && committedSkus.length === 0) {
    return { success: false, errors };
  }

  // Git commit
  const git = new GitClient(workspacePath);
  const stagedFiles: string[] = ['products/', 'store/', '.gitignore'];

  // Only add changed product files
  for (const sku of committedSkus) {
    stagedFiles.push(skuToProductFilePath(sku));
  }

  try {
    git.add(stagedFiles);
    const commitMessage = `Change set: ${changeSet.title} (${committedSkus.length} product(s))`;
    git.commit(commitMessage);
    const commitHash = git.getHeadHash();

    // Update change set status
    updateChangeSetStatus(changeSetId, 'approved', commitHash);

    // Update product index with commit hash
    for (const sku of committedSkus) {
      try {
        updateProductIndex({ sku, lastApprovedCommit: commitHash });
      } catch { /* skip */ }
    }

        // Resolve any linked drift rows on successful approval
    try {
      const linkedDrift = findLinkedDrift(changeSet.workspaceId, changeSetId);
      if (linkedDrift) {
        resolveDrift(linkedDrift.id, 'resolved');
      }
    } catch { /* skip */ }

    // Audit log
    addAuditLog({
      workspaceId: changeSet.workspaceId,
      entityType: 'change_set',
      entityId: changeSetId,
      action: 'approved',
      message: `Change set "${changeSet.title}" approved with ${committedSkus.length} product(s). Commit: ${commitHash}`,
      detailsJson: JSON.stringify({ committedSkus, commitHash, errors: errors.length > 0 ? errors : undefined }),
    });

    return { success: true, commitHash, errors };
  } catch (err) {
    return {
      success: false,
      errors: [`Git commit failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Discard a draft change set.
 * Reopens any linked drift rows so the same remote differences remain blocking.
 */
export function discardChangeSet(changeSetId: string): { success: boolean; reopenedDrift?: boolean } {
  const cs = findChangeSetById(changeSetId);
  if (!cs || cs.status !== 'draft') return { success: false };
  const workspaceId = cs.workspaceId;
  deleteChangeSet(changeSetId);

  // Reopen linked drift so remote differences stay blocking
  reopenDriftForChangeSet(workspaceId, changeSetId);
  return { success: true, reopenedDrift: true };
}
