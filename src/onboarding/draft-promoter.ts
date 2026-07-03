import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { findBatchById, isBatchComplete, setBatchArchived } from '../db/repositories/onboarding-batch-repo';
import { listItemsByBatch, completePromotionStage } from '../db/repositories/onboarding-item-repo';
import { createChangeSet, upsertChangeSetItem } from '../db/repositories/change-set-repo';
import { clearProductPages, assignProductToPage } from '../db/repositories/page-repo';
import { readProductFile } from '../git/workspace-files';
import { deterministicStringify, hashJson } from '../git/deterministic-json';
import { getAcceptedProposals, recordHistoryEvent } from '../db/repositories/classification-run-repo';
import { getCachedAttributeMappings } from '../db/repositories/classification-config-repo';
import type { Product } from '../shared/types';
import type { ExtractionData } from '../shared/schemas/onboarding';

/**
 * Promotes approved onboarding items to the CMS change-set/approval pipeline.
 * Creates a new change set containing all promoted items.
 */
export async function promoteItems(
  workspaceId: string,
  workspacePath: string,
  batchId: string,
  itemIds: string[],
): Promise<{ changeSetId: string; count: number }> {
  const db = getDb();

  const batch = findBatchById(batchId);
  if (!batch) {
    throw new Error(`Onboarding batch ${batchId} not found`);
  }

  const workspace = findWorkspace();
  const baseCommit = workspace?.baselineCommit ?? 'unknown';

  // 1. Create a new change set
  const dateStr = new Date().toLocaleDateString();
  const changeSetTitle = `Onboarding: ${batch.name} (${dateStr})`;
  const changeSet = createChangeSet({
    workspaceId,
    title: changeSetTitle,
    description: `Imported products from batch "${batch.name}" (${batch.fileName})`,
    baseCommit,
  });

  let promotedCount = 0;

  // Retrieve all items for the batch
  const allItems = listItemsByBatch(batchId);
  const itemsToPromote = allItems.filter(item => itemIds.includes(item.id));

  db.transaction(() => {
    for (const item of itemsToPromote) {
      if (!item.extractionData) {
        console.warn(`[DraftPromoter] Skipping item ${item.name} (${item.upc}) - missing extraction data`);
        continue;
      }

      const extractionData = item.extractionData;
      
      // Determine if product already exists
      const existingApproved = readProductFile(workspacePath, item.upc);
      
      const now = new Date().toISOString();
      
      const finalTitle = item.curationData?.curatedTitle || extractionData.title || item.name;

      // Construct core product details
      const coreProduct = {
        name: finalTitle,
        price: item.price || null,
        salePrice: null,
        description: extractionData.description || null,
        inventory: {
          quantityOnHand: item.quantity !== null ? item.quantity : null,
          lowStockThreshold: null,
          outOfStockLimit: null,
        },
        availability: 'instock',
        weight: extractionData.weight || null,
        taxable: true,
        media: {
          primary: extractionData.primaryImage || null,
          additional: extractionData.additionalImages || [],
        },
        seo: {
          fileName: extractionData.seoFileName || null,
          searchKeywords: extractionData.searchKeywords || null,
          googleProductCategory: null,
        },
      };

      // --- Apply accepted classification proposals ---
      // Build custom fields from accepted field assignment proposals
      const classificationCustomFields: Record<string, string> = {};
      const classificationPageNames: string[] = [];
      let acceptedProductType: string | null = null;

      try {
        const acceptedProposals = getAcceptedProposals(item.upc);
        if (acceptedProposals.length > 0) {
          const mappings = getCachedAttributeMappings(workspaceId);

          for (const proposal of acceptedProposals) {
            if (proposal.proposalType === 'field_assignment' && proposal.targetId) {
              const mapping = mappings.find(m => m.attributeId === proposal.targetId);
              if (mapping && !mapping.isStale && mapping.catalogField) {
                const value = proposal.proposedValue;
                const str = typeof value === 'string' ? value :
                  Array.isArray(value) ? value.join(', ') :
                  value !== null && value !== undefined ? String(value) : '';
                if (str) {
                  classificationCustomFields[mapping.catalogField] = str;
                }
              }
            } else if (proposal.proposalType === 'category_page' && proposal.targetId) {
              classificationPageNames.push(proposal.targetId);
            } else if (proposal.proposalType === 'primary_product_type' && proposal.targetId) {
              acceptedProductType = String(proposal.targetId);
            }
          }
        }
      } catch (err) {
        console.warn('[DraftPromoter] Failed to read classification proposals:', err);
      }

      // Merge classification custom fields with any existing custom fields
      const mergedCustomFields: Record<string, string> = {
        ...(existingApproved?.customFields ?? {}),
        ...classificationCustomFields,
      };

      // Construct final Product schema representation
      const product: Product = {
        schemaVersion: 1,
        id: existingApproved?.id || randomUUID(),
        sku: item.upc,
        status: 'draft',
        core: coreProduct,
        customFields: mergedCustomFields,
        shopsite: {
          productId: existingApproved?.shopsite?.productId || null,
          productGuid: existingApproved?.shopsite?.productGuid || null,
          xmlVersion: existingApproved?.shopsite?.xmlVersion || '15.0',
          lastPulledAt: existingApproved?.shopsite?.lastPulledAt || null,
          lastRemoteHash: existingApproved?.shopsite?.lastRemoteHash || null,
          lastSyncedAt: existingApproved?.shopsite?.lastSyncedAt || null,
          source: { dbname: 'products', uniqueName: 'SKU' },
          preserved: existingApproved?.shopsite?.preserved || {
            unknownElements: {},
            advancedBlocks: {},
            rawAttributes: {},
          },
        },
        metadata: {
          createdAt: existingApproved?.metadata?.createdAt || now,
          updatedAt: now,
          archivedAt: null,
        },
      };

      const draftJsonStr = deterministicStringify(product);
      const draftHash = hashJson(product);
      const baseJsonStr = existingApproved ? deterministicStringify(existingApproved) : null;
      const operation = existingApproved ? 'update' : 'create';

      // Insert/upsert Change Set Item
      upsertChangeSetItem({
        changeSetId: changeSet.id,
        sku: item.upc,
        operation,
        draftJson: draftJsonStr,
        baseJson: baseJsonStr,
        draftHash,
      });

      // Assign product to pages from classification proposals (preferred) or curated suggested pages
      const finalPages = classificationPageNames.length > 0
        ? classificationPageNames
        : (item.curationData?.suggestedPages ?? []);
      if (finalPages.length > 0) {
        clearProductPages(item.upc);
        for (const pageName of finalPages) {
          assignProductToPage(item.upc, pageName);
        }
      }

      // Record classification history for the promotion action
      try {
        recordHistoryEvent(workspaceId, item.upc, 'promotion', {
          acceptedProposalCount: classificationPageNames.length + Object.keys(classificationCustomFields).length,
          acceptedProductType,
          appliedFields: Object.keys(classificationCustomFields),
          appliedPages: classificationPageNames,
        });
      } catch {
        // Non-blocking
      }

      // Update item stage status to completed in promotion stage
      completePromotionStage(item.id, true);
      
      promotedCount++;
    }

    // Archive batch if all items are done (stage-based)
    if (isBatchComplete(batchId)) {
      setBatchArchived(batchId, true);
    }
  })();

  return {
    changeSetId: changeSet.id,
    count: promotedCount,
  };
}
