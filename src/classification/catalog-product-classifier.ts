/**
 * Catalog Product Classifier
 *
 * Orchestrates a classification run for an existing catalog product
 * (no onboarding item required). Loads the product from the Git workspace,
 * snapshots classification config, creates a catalog run, and executes
 * 6 pipeline stages (omitting name_consolidation).
 */
import { loadClassificationConfig } from './config-loader';
import { syncConfigToCache, createConfigSnapshot } from '../db/repositories/classification-config-repo';
import {
  createRun,
  completeRun,
  getRecentCatalogRun,
  supersedeCatalogProposals,
} from '../db/repositories/classification-run-repo';
import { recordHistoryEvent } from '../db/repositories/classification-run-repo';
import { listPages } from '../db/repositories/page-repo';
import { runPipeline } from './pipeline-runner';
import { createCatalogEvidenceExtractionStage } from './stages/catalog-product-evidence-extraction';
import { primaryProductTypeStage } from './stages/primary-product-type';
import { attributeApplicabilityStage } from './stages/attribute-applicability';
import { productAttributeProposalsStage } from './stages/attribute-proposals';
import { categoryPageProposalsStage } from './stages/category-page-proposals';
import { productDraftProjectionStage } from './stages/draft-projection';
import { buildCatalogProductEvidenceInput, computeProductHash } from './catalog-product-source';
import type { StageDefinition, StageContext, StageInput } from './types';
import type { Product } from '../shared/types';

/**
 * Run classification for a catalog product.
 *
 * @param workspaceId - The workspace ID
 * @param workspacePath - The workspace path (for reading product files)
 * @param product - The Product object to classify
 * @returns Object with runId and success status
 */
export async function classifyCatalogProduct(
  workspaceId: string,
  workspacePath: string,
  product: Product,
): Promise<{ runId: string; success: boolean; error?: string }> {
  const sku = product.sku;

  // 1. Load and sync classification config
  const config = loadClassificationConfig(workspacePath);
  syncConfigToCache(workspaceId, config);
  const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);

  // 2. Compute product hash for drift detection
  const productHash = computeProductHash(product);

  // 3. Check for existing running catalog run
  const existing = getRecentCatalogRun(workspaceId, sku);
  if (existing && existing.status === 'running') {
    return { runId: existing.id, success: false, error: 'A classification run is already in progress for this product' };
  }

  // 4. Create a catalog classification run
  const run = createRun(workspaceId, sku, snapId, snapHash, {
    sourceKind: 'catalog_product',
    sourceProductHash: productHash,
  });

  try {
    // 5. Build page index for existing page context
    const pages = listPages();

    // 6. Build stage context
    const stageContext: StageContext = {
      workspacePath,
      workspaceId,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      runId: run.id,
      catalogContext: {
        sourceProductHash: productHash,
        existingPageIds: pages.map(p => ({ pageId: p.id, pageName: p.name })),
      },
    };

    // 7. Create catalog evidence extraction stage (captures product snapshot)
    const catalogEvidenceStage = createCatalogEvidenceExtractionStage(product, workspacePath, pages);

    // 8. Run pipeline with 6 stages (omit name_consolidation and cohort logic)
    const stages: StageDefinition[] = [
      catalogEvidenceStage,
      primaryProductTypeStage,
      attributeApplicabilityStage,
      productAttributeProposalsStage,
      categoryPageProposalsStage,
      productDraftProjectionStage,
    ];

    const stageInput: StageInput = {
      sku,
      sourceKind: 'catalog_product',
      evidence: [],
      acceptedProposals: [],
      allProposals: [],
    };

    const result = await runPipeline(stages, stageContext, stageInput);

    // 9. Determine final status
    const hasAbstentions = result.proposals.some(p => p.proposalType === 'reviewable_abstention');
    const finalStatus = hasAbstentions ? 'completed_with_abstentions' as const : 'completed' as const;

    // 10. Supersede older catalog proposals (mark as stale)
    supersedeCatalogProposals(workspaceId, sku, run.id);

    // 11. Complete the run
    completeRun(run.id, finalStatus);

    // 12. Record history
    recordHistoryEvent(workspaceId, sku, 'catalog_classification_run', {
      runId: run.id,
      sourceKind: 'catalog_product',
      sourceProductHash: productHash,
      configSnapshotHash: snapHash,
      status: finalStatus,
      evidenceCount: result.evidence.length,
      proposalCount: result.proposals.length,
    }, run.id);

    return { runId: run.id, success: true };

  } catch (err) {
    completeRun(run.id, 'failed', err instanceof Error ? err.message : String(err));
    return { runId: run.id, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
