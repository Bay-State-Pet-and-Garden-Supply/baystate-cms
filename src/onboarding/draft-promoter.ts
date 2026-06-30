import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import { listItemsByBatch, updateItemStatus } from '../db/repositories/onboarding-item-repo';
import { createChangeSet, upsertChangeSetItem } from '../db/repositories/change-set-repo';
import { findProductBySku } from '../db/repositories/product-index-repo';
import { clearProductPages, assignProductToPage } from '../db/repositories/page-repo';
import { readProductFile } from '../git/workspace-files';
import { deterministicStringify, hashJson } from '../git/deterministic-json';
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
        price: extractionData.price || item.price || null,
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

      // Construct final Product schema representation
      const product: Product = {
        schemaVersion: 1,
        id: existingApproved?.id || randomUUID(),
        sku: item.upc,
        status: 'draft',
        core: coreProduct,
        customFields: {},
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

      // Assign product to pages if curated suggested pages exist
      if (item.curationData?.suggestedPages && item.curationData.suggestedPages.length > 0) {
        clearProductPages(item.upc);
        for (const pageName of item.curationData.suggestedPages) {
          assignProductToPage(item.upc, pageName);
        }
      }

      // Update item status in onboarding tables
      updateItemStatus(item.id, 'promoted');
      
      promotedCount++;
    }

    // Update batch status if all items are promoted/skipped
    const remainingItems = db.query(
      `SELECT COUNT(*) as count FROM onboarding_items WHERE batch_id = ? AND status NOT IN ('promoted', 'skipped')`
    ).get(batchId) as { count: number };

    if (remainingItems.count === 0) {
      db.query("UPDATE onboarding_batches SET status = 'completed', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        batchId
      );
    }
  })();

  return {
    changeSetId: changeSet.id,
    count: promotedCount,
  };
}
