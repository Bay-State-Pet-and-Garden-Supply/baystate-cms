import { randomUUID } from 'node:crypto';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import { readProductFile } from '../../git/workspace-files';
import { listProducts } from '../../db/repositories/product-index-repo';
import {
  findActiveChangeSet, upsertChangeSetItem, listChangeSetItems,
} from '../../db/repositories/change-set-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { createChangeSet } from '../../db/repositories/change-set-repo';
import type { Product, ProductOperation } from '../../shared/types';
import type { ProductIndexRow } from '../../db/repositories/product-index-repo';

export interface DraftOverlay {
  changeSetId: string;
  sku: string;
  operation: ProductOperation;
  draftJson: Product;
  draftHash: string;
}

/**
 * Get the approved product with any active draft overlay applied.
 */
export function getProductWithDraft(workspaceId: string, workspacePath: string, sku: string): {
  approved: Product | null;
  draft: DraftOverlay | null;
  merged: Product | null;
} {
  const approved = readProductFile(workspacePath, sku);
  const activeChangeSet = findActiveChangeSet(workspaceId);
  let draft: DraftOverlay | null = null;

  if (activeChangeSet) {
    const items = listChangeSetItems(activeChangeSet.id);
    const item = items.find(i => i.sku === sku && i.operation !== 'discarded');
    if (item) {
      const draftProduct = JSON.parse(item.draftJson) as Product;
      draft = {
        changeSetId: activeChangeSet.id,
        sku: item.sku,
        operation: item.operation as ProductOperation,
        draftJson: draftProduct,
        draftHash: item.draftHash,
      };
    }
  }

  const merged = draft ? draft.draftJson : approved;
  return { approved, draft, merged };
}

/**
 * List products from index with optional filters.
 */
export function listProductIndex(filter?: { status?: string; search?: string }): ProductIndexRow[] {
  return listProducts(filter);
}

/**
 * Autosave a product draft into the active change set.
 * Does NOT write to Git or product files.
 */
export function autosaveDraft(
  workspaceId: string,
  workspacePath: string,
  sku: string,
  draftChanges: Partial<Product>,
  operation?: ProductOperation,
): { changeSetId: string; draftHash: string } {
  const approved = readProductFile(workspacePath, sku);
  const baseProduct = approved ?? createEmptyProduct(sku);
  const now = new Date().toISOString();
  const draftProduct: Product = {
    ...baseProduct,
    ...draftChanges,
    status: operation === 'archive' ? 'archived' : (draftChanges.status ?? baseProduct.status),
    core: { ...baseProduct.core, ...(draftChanges.core ?? {}) },
    customFields: { ...baseProduct.customFields, ...(draftChanges.customFields ?? {}) },
    shopsite: { ...baseProduct.shopsite, ...(draftChanges.shopsite ?? {}) },
    metadata: {
      ...baseProduct.metadata,
      ...(draftChanges.metadata ?? {}),
      updatedAt: now,
      archivedAt: operation === 'archive' ? now : (draftChanges.metadata?.archivedAt ?? baseProduct.metadata.archivedAt),
    },
  };

  const draftHash = hashJson(draftProduct);
  const draftJsonStr = deterministicStringify(draftProduct);

  // Find or create active change set
  let activeCs = findActiveChangeSet(workspaceId);
  if (!activeCs) {
    const ws = findWorkspace();
    const baseCommit = ws?.baselineCommit ?? 'unknown';
    activeCs = createChangeSet({ workspaceId, title: `Edit ${sku}`, baseCommit });
  }

  upsertChangeSetItem({
    changeSetId: activeCs.id,
    sku,
    operation: operation ?? (approved ? 'update' : 'create'),
    draftJson: draftJsonStr,
    baseJson: approved ? deterministicStringify(approved) : null,
    draftHash,
  });

  return { changeSetId: activeCs.id, draftHash };
}

function createEmptyProduct(sku: string): Product {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sku,
    status: 'draft',
    core: {
      name: '', price: null, salePrice: null, description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: null, weight: null, taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
    },
    customFields: {},
    shopsite: {
      productId: null, productGuid: null, xmlVersion: '15.0',
      lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}
