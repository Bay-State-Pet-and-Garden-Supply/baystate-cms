import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { readProductFile } from '../git/workspace-files';
import { deterministicStringify, hashJson } from '../git/deterministic-json';
import { getAcceptedProposals, recordHistoryEvent } from '../db/repositories/classification-run-repo';
import { getCachedAttributeMappings } from '../db/repositories/classification-config-repo';
import { createChangeSet, upsertChangeSetItem } from '../db/repositories/change-set-repo';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { loadClassificationConfig } from './config-loader';
import { createConfigSnapshot } from '../db/repositories/classification-config-repo';
import { computeConfigHash } from '../db/repositories/classification-config-repo';
import { mergeProductOnPages } from '../shopsite/product-page-assignments';
import { serializeAttributeValue } from './assignment-projection';
import { computeProductHash } from './catalog-product-source';
import type { Product } from '../shared/types';

const now = () => new Date().toISOString();

export interface ApplyClassificationResult {
  changeSetId: string;
  appliedFields: string[];
  appliedPages: string[];
  skipped: Array<{ proposalId: string; reason: string }>;
}

/**
 * Apply accepted classification proposals to an existing catalog product.
 *
 * 1. Re-reads the product and verifies source/config hashes match
 * 2. Creates an update change-set draft (never writes directly)
 * 3. Merges accepted field assignments into customFields
 * 4. Adds accepted pages to ProductOnPages (additive only)
 * 5. Returns change-set ID for the user to approve
 */
export async function applyCatalogClassification(
  workspacePath: string,
  workspaceId: string,
  sku: string,
  runId: string,
): Promise<ApplyClassificationResult> {
  const db = getDb();

  // Verify run
  const run = db.query(
    `SELECT id, status, source_kind, source_product_hash, config_snapshot_hash
     FROM classification_runs WHERE id = ?`,
  ).get(runId) as {
    id: string; status: string; source_kind: string;
    source_product_hash: string | null; config_snapshot_hash: string | null;
  } | undefined;

  if (!run) throw new Error(`Run ${runId} not found.`);
  if (run.source_kind !== 'catalog_product') throw new Error('Run is not a catalog product run.');
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    throw new Error(`Run status is "${run.status}". Cannot apply.`);
  }

  // Read current product
  const product = readProductFile(workspacePath, sku);
  if (!product) throw new Error(`Product not found for SKU: ${sku}`);

  // Source hash drift check — must use same hash function as classifier
  if (run.source_product_hash) {
    const currentHash = computeProductHash(product);
    if (currentHash !== run.source_product_hash) {
      throw new Error('Product has changed since classification. Please rerun classification.');
    }
  }

  // Config hash drift check — use pure hashing, no DB side effects
  if (run.config_snapshot_hash) {
    const classConfig = loadClassificationConfig(workspacePath);
    const currentConfigHash = computeConfigHash(classConfig);
    if (currentConfigHash !== run.config_snapshot_hash) {
      throw new Error('Classification config has changed since classification. Please rerun classification.');
    }
  }

  // Get accepted proposals
  const acceptedProposals = getAcceptedProposals(sku, runId);
  if (acceptedProposals.length === 0) {
    throw new Error('No accepted proposals to apply.');
  }

  const mappings = getCachedAttributeMappings(workspaceId);
  const appliedFields: string[] = [];
  const appliedPages: string[] = [];
  const skipped: Array<{ proposalId: string; reason: string }> = [];

  // Apply field assignments
  const mergedCustomFields = { ...(product.customFields || {}) };
  for (const proposal of acceptedProposals) {
    if (proposal.proposalType !== 'field_assignment' || !proposal.targetId) continue;

    const mapping = mappings.find(m => m.attributeId === proposal.targetId);
    if (!mapping) {
      skipped.push({ proposalId: proposal.id, reason: 'No attribute mapping found' });
      continue;
    }
    if (mapping.isStale) {
      skipped.push({ proposalId: proposal.id, reason: 'Attribute mapping is stale' });
      continue;
    }
    if (!mapping.catalogField) {
      skipped.push({ proposalId: proposal.id, reason: 'No catalog field in mapping' });
      continue;
    }

    const value = serializeAttributeValue(proposal.proposedValue, mapping.serialization);
    if (value) {
      mergedCustomFields[mapping.catalogField] = value;
      appliedFields.push(mapping.catalogField);
    }
  }

  // Apply page assignments (additive only)
  const additionalPages: string[] = [];
  for (const proposal of acceptedProposals) {
    if (proposal.proposalType !== 'category_page' || !proposal.targetId) continue;
    const pv = proposal.proposedValue as Record<string, unknown> | undefined;
    const pageName = pv?.pageName ? String(pv.pageName) : String(proposal.targetId);
    const pageId = pv?.pageId ? String(pv.pageId) : null;
    if (!additionalPages.includes(pageName)) {
      additionalPages.push(pageName);
    }
  }

  // Merge into ProductOnPages
  const currentUnknownElements: Record<string, unknown> = product.shopsite?.preserved?.unknownElements ?? {};
  const updatedPagesXml = mergeProductOnPages(
    { unknownElements: currentUnknownElements },
    additionalPages,
  );

  // Build updated product
  const updatedProduct: Product = {
    ...product,
    customFields: mergedCustomFields,
    metadata: {
      ...product.metadata,
      updatedAt: now(),
    },
  };

  if (updatedPagesXml) {
    updatedProduct.shopsite = {
      ...updatedProduct.shopsite,
      preserved: {
        ...updatedProduct.shopsite.preserved,
        unknownElements: {
          ...updatedProduct.shopsite.preserved.unknownElements,
          ProductOnPages: updatedPagesXml,
        },
      },
    };
  }

  // Create change set
  const workspace = findWorkspace();
  const baseCommit = workspace?.baselineCommit ?? 'unknown';
  const dateStr = new Date().toLocaleDateString();

  const changeSet = createChangeSet({
    workspaceId,
    title: `Classification: ${sku} (${dateStr})`,
    description: `Applied accepted classification proposals for product ${sku}.`,
    baseCommit,
  });

  const draftJsonStr = deterministicStringify(updatedProduct);
  const draftHash = hashJson(updatedProduct);
  const baseJsonStr = deterministicStringify(product);

  upsertChangeSetItem({
    changeSetId: changeSet.id,
    sku,
    operation: 'update',
    draftJson: draftJsonStr,
    baseJson: baseJsonStr,
    draftHash,
  });

  // Track applied page names for the result (page data is embedded in the
  // ProductOnPages draft — product_pages table is updated when the change
  // set is approved, not during draft creation)
  for (const pageName of additionalPages) {
    appliedPages.push(pageName);
  }

  // Record history
  try {
    recordHistoryEvent(workspaceId, sku, 'classification_draft_created', {
      runId,
      changeSetId: changeSet.id,
      appliedFields,
      appliedPages,
      skippedCount: skipped.length,
    });
  } catch {
    // non-blocking
  }

  return { changeSetId: changeSet.id, appliedFields, appliedPages, skipped };
}
