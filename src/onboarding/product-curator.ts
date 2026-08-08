import { listPages } from '../db/repositories/page-repo';
import { convertToLbs } from '../shared/weight-converter';
import { callLlmForTask, getLlmConfigForTask } from './llm-client';
import { coordinateCohortItemsOnce, formatDeterministicTitle } from './cohort-name-coordinator';
import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import { getEvidenceAttemptsByIdsForItem } from '../db/repositories/onboarding-evidence-repo';
import { extractPackagingOcr } from './packaging-ocr';
import { getDb } from '../db/connection';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../classification/config-loader';
import { createConfigSnapshot, syncConfigToCache, getPersistedConfigSnapshotId } from '../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../classification/runtime-snapshot';
import {
  createRun,
  completeRun,
  getEvidenceByRun,
  getProposalsByRun,
  getStageResults,
} from '../db/repositories/classification-run-repo';
import { runPipeline } from '../classification/pipeline-runner';
import {
  evidenceExtractionStage,
  nameConsolidationStage,
  primaryProductTypeStage,
  attributeApplicabilityStage,
  productAttributeProposalsStage,
  categoryPageProposalsStage,
  productDraftProjectionStage,
} from '../classification';
import { consolidateProductTitle } from './title-consolidation';
import { consolidateDistributorCopy } from './distributor-copy-consolidator';
import { selectPrimaryProductTypeProposal } from '../classification/proposal-selection';
import { determineProductGroup } from './product-line-grouper';
import type { ProductLineItemSnapshot, StageDefinition } from '../classification/types';
import type { OnboardingItem, CurationData } from '../shared/schemas/onboarding';
import type { ClassificationEvidence } from '../shared/schemas/classification';

// ─── Page Assignment Validation ───────────────────────────────────────────────

/**
 * Validate page assignments against the product's species from VLM OCR evidence.
 * Cross-species pages (e.g., a Dog product assigned to "Cat Food") are dropped
 * with a warning. This is a safety net that catches LLM or downstream mistakes.
 */
function validatePageAssignmentsBySpecies(
  proposedPages: string[],
  allEvidence: ClassificationEvidence[],
): string[] {
  const speciesEntries = allEvidence.filter(
    e => e.source === 'visual_product_evidence' && e.sourceField === 'species',
  );
  const species = speciesEntries
    .map(e => (typeof e.value === 'string' ? e.value.toLowerCase() : ''))
    .filter(Boolean);

  if (species.length === 0) return proposedPages;

  const primarySpecies = species[0];

  const speciesIncompatible: Record<string, string[]> = {
    dog: ['cat', 'fish', 'bird', 'small animal', 'small pet', 'reptile', 'caged bird', 'wild bird', 'wildlife'],
    cat: ['dog', 'fish', 'bird', 'small animal', 'small pet', 'reptile', 'caged bird', 'wild bird', 'wildlife'],
    fish: ['dog', 'cat', 'bird', 'small animal', 'small pet', 'reptile', 'caged bird', 'farm animal', 'horse', 'wildlife'],
    bird: ['dog', 'cat', 'fish', 'reptile', 'farm animal', 'horse'],
    reptile: ['dog', 'cat', 'bird', 'farm animal', 'horse'],
    horse: ['dog', 'cat', 'fish', 'bird', 'small pet', 'reptile'],
  };

  const incompatibleTerms = speciesIncompatible[primarySpecies] ?? [];
  if (incompatibleTerms.length === 0) return proposedPages;

  return proposedPages.filter(pageName => {
    const nameLower = pageName.toLowerCase();
    const isCompatible = !incompatibleTerms.some(term => nameLower.includes(term));
    if (!isCompatible) {
      console.warn(
        `[ProductCurator] Dropping cross-species page assignment: "${pageName}" for species "${primarySpecies}"`,
      );
    }
    return isCompatible;
  });
}

/**
 * Run VLM OCR on the primary image as a fallback, persisting results back
 * to the item's extraction_data_json so classification stages can consume
 * the same data without duplicate VLM calls.
 */
async function runAndPersistOcrFallback(
  itemId: string,
  primaryImage: string,
  workspacePath: string,
  ext: Record<string, unknown>,
): Promise<string | null> {
  console.log(`[ProductCurator] Running fallback packaging OCR for item ${itemId}`);
  const ocrData = await extractPackagingOcr({
    imageUrl: primaryImage,
    workspacePath,
    imageSourceUrl: primaryImage,
  });

  if (ocrData) {
    // Persist to the item's extraction_data_json so future runs skip OCR
    try {
      const updatedExt = { ...ext, packagingOcrData: ocrData, packagingTitle: ocrData.productName };
      const db = getDb();
      const now = new Date().toISOString();
      db.query(
        'UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify(updatedExt), now, itemId);
      console.log(`[ProductCurator] Persisted fallback OCR data for item ${itemId}`);
    } catch (err: any) {
      console.warn(`[ProductCurator] Failed to persist fallback OCR: ${err.message}`);
    }

    return ocrData.productName;
  }

  return null;
}

/**
  workspacePath: string,
  options: { skipLegacyClassification?: boolean } = {},
): Promise<CurationData> {
  const ext = item.extractionData;
  if (!ext) {
    throw new Error('Cannot curate item without extraction data.');
  }

  console.log(`[ProductCurator] Starting curation for: "${item.name}"`);

  // Step 1: Packaging OCR — use cached data first, fall back to live OCR
  let ocrTitle: string | null = ext.packagingOcrData?.productName ?? ext.packagingTitle ?? null;
  if (!ocrTitle && ext.primaryImage) {
    ocrTitle = await runAndPersistOcrFallback(item.id, ext.primaryImage, workspacePath, ext as unknown as Record<string, unknown>);
  }

  // Step 1.5: Fallback brand resolution from item name if brandHint is missing
  let activeBrandHint = item.brandHint;
  if (!activeBrandHint && item.name) {
    try {
      const workspace = findWorkspace();
      if (workspace) {
        const brands = getCachedBrands(workspace.id);
        const resolved = resolveBrand(item.name, brands);
        if (resolved?.brandName) {
          activeBrandHint = resolved.brandName;
          updateItemBrandHint(item.id, activeBrandHint);
          console.log(`[ProductCurator] Resolved brand "${activeBrandHint}" from title for item ${item.upc}`);
        }
      }
    } catch (err: any) {
      console.warn(`[ProductCurator] Title brand resolution failed: ${err.message}`);
    }
  }

  // Step 2: Title finalization (uses shared helper)
  const finalized = await consolidateProductTitle({
    name: item.name,
    brandHint: activeBrandHint,
    webTitle: ext.title,
    ocrTitle: ocrTitle,
    ocrWeight: ext.packagingOcrData?.weight ?? null,
    ocrSize: ext.packagingOcrData?.size ?? null,
  });

  // Step 3: Page & Category Classification. The modular pipeline can disable
  // this legacy free-form classification so only manager-selected targets are
  // filled during curation.
  const classification = options.skipLegacyClassification
    ? { suggestedPages: [], suggestedProductType: null }
    : await classifyProduct(finalized.title, ext.description);

  // Synthesize search keywords from curated data
  const searchKeywords = synthesizeSearchKeywords({
    title: finalized.title,
    brand: item.brandHint,
    description: ext.description,
    suggestedPages: classification.suggestedPages,
    suggestedProductType: classification.suggestedProductType,
    species: ext.packagingOcrData?.species,
    lifeStage: ext.packagingOcrData?.lifeStage,
    productForm: ext.packagingOcrData?.productForm,
  });

  return {
    curatedTitle: finalized.title,
    searchKeywords,
    packagingOcrTitle: ocrTitle,
    curatedWeight: convertToLbs(
      ext.packagingOcrData?.weight || ext.weight || extractWeightFromName(item.name) || null,
    ),
    titleSource: finalized.source,
    suggestedPages: classification.suggestedPages,
    suggestedProductType: classification.suggestedProductType,
    curatedAt: new Date().toISOString(),
    curationMethod: 'auto',
    // Phase 1 classification containers (defaulted)
    classificationRunId: null,
    classificationConfigSnapshot: null,
    classificationEvidence: [],
    classificationProposals: [],
    classificationDecisions: [],
    classificationHistory: [],
  };
}

/**
 * Runs the modular classification pipeline for a curated item.
 * Uses the Classification Configuration from store/classification/
 * to produce structured proposals, evidence, and history records.
 *
 * Does NOT call legacy `curateItem()` — instead runs the full modular
 * pipeline including the name_consolidation stage for title synthesis.
 *
 * Falls back to a minimal compatibility object if no classification
 * config exists or the pipeline throws, so curation never blocks
 * the onboarding worker.
 */
export async function curateItemWithPipeline(
  item: OnboardingItem,
  workspacePath: string,
  workspaceId: string,
): Promise<CurationData> {
  const ext = item.extractionData;
  if (!ext) {
    throw new Error('Cannot curate item without extraction data.');
  }

  console.log(`[ProductCurator] Starting classification pipeline for: "${item.name}"`);

  // Load the authoritative runtime config (ACTIVE v2 bundle when present,
  // transitional v1 otherwise). The modular pipeline works even without
  // full product types/attributes — name_consolidation always runs.
  const activationContext = createRuntimeActivationContext(workspacePath);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  let configSnapshotRef: {
    id: string;
    hash: string;
    sourceCommit: string | null;
    createdAt: string;
  };
  let focusedFileHashes: Record<string, string>;
  let catalogEvidenceHash: string | null;
  if (authority.kind === 'v2') {
    const bundle = authority.bundle;
    const persistedId = getPersistedConfigSnapshotId(workspaceId, bundle.manifest.bundleHash);
    configSnapshotRef = {
      id: persistedId ?? bundle.manifest.bundleHash,
      hash: bundle.manifest.bundleHash,
      sourceCommit: bundle.manifest.sourceCatalogCommit,
      createdAt: new Date().toISOString(),
    };
    focusedFileHashes = bundle.manifest.fileVersions;
    catalogEvidenceHash = bundle.manifest.catalogEvidenceHash;
    // The derived cache was written transactionally at activation.
  } else {
    try {
      syncConfigToCache(workspaceId, authority.config);
    } catch (err: any) {
      console.warn(`[ProductCurator] Failed to sync config to cache: ${err.message}`);
    }
    const { id: snapshotId, hash: snapshotHash } = createConfigSnapshot(workspaceId, authority.config);
    configSnapshotRef = {
      id: snapshotId,
      hash: snapshotHash,
      sourceCommit: null,
      createdAt: new Date().toISOString(),
    };
    focusedFileHashes = authority.config.manifest.fileVersions ?? {};
    catalogEvidenceHash = null;
  }

  // Build + freeze + persist ONE immutable runtime snapshot before run
  // creation so every stage reads the same frozen config, options, and facts.
  const runtimeSnapshot = buildRuntimeSnapshot({
    workspaceId,
    workspacePath,
    productSku: item.upc,
    authority,
    configSnapshotRef,
    focusedFileHashes,
    catalogEvidenceHash,
    sourceProductHash: '',
    searchKeywords: ext.searchKeywords ? String(ext.searchKeywords) : null,
    productPageNames: [],
    pages: { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
  });
  const { id: runtimeSnapId, hash: runtimeSnapHash } = persistRuntimeSnapshot(runtimeSnapshot);

  // Fail any existing running classification runs for this onboarding item to ensure
  // we do not violate the UNIQUE constraint from a stale run.
  if (item.id) {
    try {
      getDb().run(
        `UPDATE classification_runs
         SET status = 'failed', completed_at = ?, error_message = 'Superseded by new run'
         WHERE onboarding_item_id = ? AND status = 'running'`,
        [new Date().toISOString(), item.id]
      );
    } catch (err: any) {
      console.warn(`[ProductCurator] Failed to clean up existing running runs: ${err.message}`);
    }
  }

  // Create a classification run bound to the immutable runtime snapshot.
  // The onboarding source hash is null (no product source identity), matching
  // the snapshot's normalized representation so reviewed facts carry forward.
  const run = createRun(workspaceId, item.upc, runtimeSnapId, runtimeSnapHash, {
    onboardingItemId: item.id,
    sourceKind: 'onboarding',
    sourceProductHash: runtimeSnapshot.sourceProductHash ?? null,
  });

  try {
    // ── Product-line grouping for family-aware curation ───────────────────
    // Determine sibling context before running the pipeline so
    // name_consolidation and page assignment can produce consistent
    // results across variants. Prefer context passed from the worker
    // (item.siblingGroup) to avoid re-querying. Fall back to internal
    // batch query when set directly (tests, API calls).
    let productLineGroup: ReturnType<typeof determineProductGroup> | null =
      (item as any).siblingGroup ?? null;

    if (!productLineGroup) {
      try {
        const db = getDb();
        const batchRows = db.query(
          `SELECT id, upc, name, brand_hint, extraction_data_json FROM onboarding_items WHERE batch_id = (SELECT batch_id FROM onboarding_items WHERE id = ?)`
        ).all(item.id) as Array<{
          id: string;
          upc: string;
          name: string;
          brand_hint: string | null;
          extraction_data_json: string | null;
        }>;

        const batchItems: OnboardingItem[] = batchRows.map(r => ({
          id: r.id,
          batchId: item.batchId,
          upc: r.upc,
          name: r.name,
          price: null,
          quantity: null,
          brandHint: r.brand_hint,
          departmentHint: null,
          sourceUrl: null,
          expectedName: null,
          sourceType: 'official_page',
          acceptedEvidenceAttemptId: null,
          acceptedEvidenceAttemptIds: [],
          sourcingDecision: null,
          stage: 'curation' as const,
          stageStatus: 'pending' as const,
          rowNumber: 0,
          isDuplicate: false,
          existingSku: null,
          extractionData: r.extraction_data_json ? JSON.parse(r.extraction_data_json) : null,
          curationData: null,
          status: 'active' as any,
          errorMessage: null,
          retryCount: 0,
          createdAt: '',
          updatedAt: '',
        }));

        productLineGroup = determineProductGroup(item, batchItems);
        if (productLineGroup) {
          console.log(`[ProductCurator] Product line group "${productLineGroup.groupId}": ${productLineGroup.siblingNames.length} siblings`);
        }
      } catch (err: any) {
        console.warn(`[ProductCurator] Product-line grouping failed (non-blocking): ${err.message}`);
      }
    } else {
      console.log(`[ProductCurator] Using sibling context from worker for ${item.upc}: group "${productLineGroup.groupId}"`);
    }

    const attachedBatchItems = (item as any).batchItems as OnboardingItem[] | undefined;
    let batchItemsForCoordination: OnboardingItem[] = attachedBatchItems ?? [];
    if (productLineGroup && batchItemsForCoordination.length === 0) {
      try {
        batchItemsForCoordination = listItemsByBatch(item.batchId);
      } catch (error) {
        console.warn(`[ProductCurator] Failed to load batch snapshot for cohort coordination: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const productLineItems: ProductLineItemSnapshot[] | undefined = productLineGroup
      ? productLineGroup.siblingSkus.map((sku, index) => {
          const sibling = batchItemsForCoordination.find(candidate => candidate.upc === sku);
          const extraction = sibling?.extractionData;
          const ocr = extraction?.packagingOcrData;
          return {
            sku,
            name: sibling?.expectedName ?? sibling?.name ?? productLineGroup!.siblingNames[index] ?? sku,
            webTitle: extraction?.title ?? productLineGroup!.siblingWebTitles[index] ?? null,
            brand: extraction?.brand ?? sibling?.brandHint ?? (productLineGroup!.normalizedBrand || null),
            description: extraction?.description ?? '',
            species: ocr?.species ?? [],
            flavor: ocr?.flavorVariety ?? null,
            lifeStage: ocr?.lifeStage ?? null,
            productForm: ocr?.productForm ?? null,
            healthConcern: ocr?.healthConcernFunction ?? [],
          };
        })
      : undefined;

    // Coordinate every title in a multi-item group through one cached,
    // all-or-nothing cohort decision. No sibling title is written here; each
    // item's own pipeline persists only its selected title metadata.
    let preComputedTitle: string | undefined;
    let preComputedTitleSource: 'llm_cohort' | 'cohort_fallback' | undefined;
    if ((productLineGroup?.siblingSkus.length ?? 0) >= 2) {
      try {
        const coordinated = await coordinateCohortItemsOnce(item.batchId, batchItemsForCoordination);
        const selected = coordinated.get(item.upc);
        if (selected) {
          preComputedTitle = selected.title;
          preComputedTitleSource = selected.source;
        } else {
          // A grouped item must never fall through to an independent title LLM.
          preComputedTitle = formatDeterministicTitle(item.name ?? item.upc, item.brandHint);
          preComputedTitleSource = 'cohort_fallback';
        }
      } catch (err) {
        console.warn(
          `[ProductCurator] Cohort title coordination failed for ${item.upc}; using deterministic fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
        preComputedTitle = formatDeterministicTitle(item.name ?? item.upc, item.brandHint);
        preComputedTitleSource = 'cohort_fallback';
      }
    }

    // Build the pipeline context
    const context: import('../classification/types').StageContext = {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef,
      snapshot: runtimeSnapshot,
      productLineContext: productLineGroup
        ? {
            groupId: productLineGroup.groupId,
            groupLabel: productLineGroup.groupLabel,
            siblingNames: productLineGroup.siblingNames,
            siblingWebTitles: productLineGroup.siblingWebTitles,
            siblingOcrTitles: productLineGroup.siblingOcrTitles,
            siblingSkus: productLineGroup.siblingSkus,
          }
        : undefined,
      productLineItems,
      preComputedTitle,
      preComputedTitleSource,
    };

    // Initial evidence starts empty — evidence_extraction stage handles
    // reading the onboarding item's extraction_data_json from the DB
    // and producing spreadsheet, web, and visual evidence entries.

    // Run the full modular pipeline including name_consolidation
    const stages: StageDefinition[] = [
      evidenceExtractionStage,
      nameConsolidationStage,
      primaryProductTypeStage,
      attributeApplicabilityStage,
      productAttributeProposalsStage,
      categoryPageProposalsStage,
      productDraftProjectionStage,
    ];

    const result = await runPipeline(stages, context, {
      sku: item.upc,
      onboardingItemId: item.id,
      evidence: [],
      acceptedProposals: [],
      allProposals: [],
    });

    // Determine final status
    const hasAbstentions = result.proposals.some(p => p.proposalType === 'reviewable_abstention');
    const finalStatus = hasAbstentions ? 'completed_with_abstentions' : 'completed';
    completeRun(run.id, finalStatus);

    // Collect persisted evidence and proposals
    const allEvidence = getEvidenceByRun(run.id);
    const allProposals = getProposalsByRun(run.id);
    const stageResults = getStageResults(run.id);

    // Build compatibility CurationData from pipeline outputs
    // Name consolidation metadata comes from the name_consolidation stage output
    const nameMeta = result.stageOutputs.name_consolidation?.metadata as Record<string, unknown> | undefined;
    const curatedTitle = nameMeta?.curatedTitle as string ?? ext.title ?? item.name;
    const titleSource = (nameMeta?.titleSource as string) ?? 'web';
    const packagingOcrTitle = (nameMeta?.packagingOcrTitle as string | null) ??
      ext.packagingOcrData?.productName ?? ext.packagingTitle ?? null;

    // ── Collect and deduplicate page proposals ────────────────────────────
    const pageProposals = allProposals
      .filter(p => p.proposalType === 'category_page' && p.targetId)
      .sort((a, b) => {
        // Accepted first, then by confidence descending
        if (a.status === 'accepted' && b.status !== 'accepted') return -1;
        if (a.status !== 'accepted' && b.status === 'accepted') return 1;
        return b.confidence - a.confidence;
      });
    const seenPages = new Set<string>();
    const rawSuggestedPages: string[] = [];
    for (const p of pageProposals) {
      if (p.targetId && !seenPages.has(p.targetId)) {
        seenPages.add(p.targetId);
        rawSuggestedPages.push(p.targetId);
      }
    }

    // ── Validate page assignments against species from VLM OCR evidence ───
    const validatedPages = validatePageAssignmentsBySpecies(rawSuggestedPages, allEvidence);

    // ── Validate that pages actually exist in the page_index (ADR 0005) ────
    const existingPageNames = new Set(listPages().map(p => p.name));
    const suggestedPages: string[] = [];
    for (const pageName of validatedPages) {
      if (existingPageNames.has(pageName)) {
        suggestedPages.push(pageName);
      } else {
        console.warn(`[ProductCurator] Dropping non-existent page: "${pageName}"`);
      }
    }
    // Limit to top 5 to keep suggestions reasonable
    suggestedPages.splice(5);

    // ── Refresh extraction data from DB ────────────────────────────────
    // The evidence_extraction stage may have updated the DB with fresh VLM OCR
    // results during pipeline execution. Re-read the extraction data so that
    // curatedWeight and other downstream fields use the most recent OCR data.
    try {
      const freshRow = getDb().query(
        'SELECT extraction_data_json FROM onboarding_items WHERE id = ?',
      ).get(item.id) as { extraction_data_json: string | null } | undefined;
      if (freshRow?.extraction_data_json) {
        const freshExt = JSON.parse(freshRow.extraction_data_json);
        if (freshExt && typeof freshExt === 'object') {
          // Merge fresh VLM/OCR data into the ext reference
          if (freshExt.packagingOcrData) {
            ext.packagingOcrData = freshExt.packagingOcrData;
          }
          if (freshExt.packagingTitle) {
            ext.packagingTitle = freshExt.packagingTitle;
          }
          if (freshExt.weight !== undefined) {
            ext.weight = freshExt.weight;
          }
        }
      }
    } catch (refreshErr: any) {
      console.warn(`[ProductCurator] Failed to refresh extraction data: ${refreshErr.message}`);
    }

    // Suggested product type from the best available proposal
    const typeSelection = selectPrimaryProductTypeProposal({
      sku: item.upc,
      onboardingItemId: item.id,
      evidence: allEvidence,
      acceptedProposals: [],
      allProposals: allProposals,
    });
    const suggestedProductType = typeSelection.proposal?.targetId ?? null;
    // Synthesize search keywords from richer pipeline data
    const attributeProposals = allProposals.filter(p => p.proposalType === 'field_assignment' && p.status === 'accepted');
    const attributeKeywords = attributeProposals
      .map(p => {
        const v = p.proposedValue;
        return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : null;
      })
      .filter((v): v is string => !!v);
    const speciesLabels = ext.packagingOcrData?.species ?? [];

    // ── Distributor record: consolidate multi-provider copy ───────────────
    // This runs AFTER the classification pipeline intentionally.
    // During classification, raw per-provider evidence (from the
    // evidence_extraction stage and buildClassificationEvidenceFromAttempts)
    // is consumed by name_consolidation, product-type classification, and
    // page-assignment stages. Consolidating here creates the final
    // curatedDescription and source-attempt provenance for draft copy —
    // it does not feed back into classification.
    let curatedDescription: string | null = null;
    let curatedDescriptionSourceAttemptIds: string[] = [];
    let curationWarnings: string[] = [];

    const distAttemptIds: string[] = Array.isArray(ext.distributorEvidenceAttemptIds)
      ? ext.distributorEvidenceAttemptIds
      : [];

    if (distAttemptIds.length > 0) {
      try {
        const distAttempts = getEvidenceAttemptsByIdsForItem(
          item.id,
          item.upc,
          distAttemptIds,
        );
        const consolidation = await consolidateDistributorCopy(
          distAttempts,
          item.name,
          item.brandHint,
        );
        curatedDescription = consolidation.curatedDescription;
        curatedDescriptionSourceAttemptIds = consolidation.sourceAttemptIds;
        curationWarnings = consolidation.warnings;
      } catch (err: any) {
        console.warn(`[ProductCurator] Distributor copy consolidation failed: ${err.message}`);
        // Fall through — curatedDescription stays null
      }
    }

    const searchKeywords = synthesizeSearchKeywords({
      title: curatedTitle,
      brand: ext.brand ?? item.brandHint,
      description: ext.description,
      suggestedPages,
      suggestedProductType,
      species: speciesLabels,
      lifeStage: ext.packagingOcrData?.lifeStage,
      productForm: ext.packagingOcrData?.productForm,
      attributes: attributeKeywords,
    });

    return {
      curatedTitle,
      searchKeywords,
      packagingOcrTitle,
      curatedWeight: convertToLbs(
        ext.packagingOcrData?.weight || ext.weight || extractWeightFromName(item.name) || null,
      ),
      titleSource: titleSource as 'web' | 'ocr' | 'llm' | 'manual' | 'llm_cohort' | 'cohort_fallback',
      curatedDescription,
      curatedDescriptionSourceAttemptIds,
      suggestedPages,
      suggestedProductType,
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
      classificationRunId: run.id,
      classificationConfigSnapshot: context.configSnapshotRef,
      classificationEvidence: allEvidence,
      classificationProposals: allProposals,
      classificationDecisions: [],
      classificationHistory: stageResults.map(sr => ({
        id: String(sr.id),
        runId: run.id,
        proposalId: null,
        decisionId: null,
        eventType: `stage_${sr.stage_name}`,
        eventJson: { status: sr.status, output: sr.output_json },
        createdAt: String(sr.started_at),
      })),
    };
  } catch (err) {
    console.error(`[ProductCurator] Classification pipeline failed:`, err);
    completeRun(run.id, 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Extract a weight string from a product's spreadsheet import name.
 *
 * Handles common patterns like "6OZ", "16OZ", "48OZ", "23 OZ", "5LB", "2kg"
 * that appear embedded in distributor product names. Avoids false matches
 * on non-weight suffixes like "MD2CT" (2-count), "SM5CT" (5-count), "30PK"
 * (30-pack), or ordinals like "4TH".
 *
 * Returns the normalised weight string (e.g. "6 oz") or null.
 */
function extractWeightFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const match = /(\d+(?:\.\d+)?)\s*(OZ|OZS?|LB|LBS?|OUNCE|OUNCES|GRAM|GRAMS|G|KG)\b/i.exec(name);
  if (!match) return null;
  // Normalise unit to lowercase
  return `${match[1]} ${match[2].toLowerCase()}`;
}

/**
 * Synthesize search keywords from curated product data for ShopSite SearchKeywords.
 * Combines title, brand, species/attributes, page names, and product type into
 * a concise keyword string (capped at 250 chars).
 */
function synthesizeSearchKeywords(options: {
  title: string;
  brand?: string | null;
  description?: string | null;
  suggestedPages?: string[];
  suggestedProductType?: string | null;
  species?: string[];
  lifeStage?: string | null;
  productForm?: string | null;
  attributes?: string[];
}): string {
  const parts: string[] = [];

  // 1. Title + brand
  if (options.title) parts.push(options.title);
  if (options.brand && !options.title.toLowerCase().includes(options.brand.toLowerCase())) {
    parts.push(options.brand);
  }

  // 2. Species + life stage + product form (from VLM OCR)
  if (options.species && options.species.length > 0) {
    const uniqueSpecies = [...new Set(options.species.map(s => s.toLowerCase()))];
    for (const s of uniqueSpecies) {
      if (!parts.some(p => p.toLowerCase().includes(s))) {
        parts.push(s.charAt(0).toUpperCase() + s.slice(1));
      }
    }
  }
  if (options.lifeStage && !parts.some(p => p.toLowerCase().includes(options.lifeStage!.toLowerCase()))) {
    parts.push(options.lifeStage);
  }
  if (options.productForm && !parts.some(p => p.toLowerCase().includes(options.productForm!.toLowerCase()))) {
    parts.push(options.productForm);
  }

  // 3. Attribute values from classification
  if (options.attributes && options.attributes.length > 0) {
    for (const attr of options.attributes) {
      if (attr && !parts.some(p => p.toLowerCase().includes(attr.toLowerCase()))) {
        parts.push(attr);
      }
    }
  }

  // 4. Suggested product type
  if (options.suggestedProductType && !parts.some(p => p.toLowerCase().includes(options.suggestedProductType!.toLowerCase()))) {
    parts.push(options.suggestedProductType);
  }

  // 5. Page / category names
  if (options.suggestedPages && options.suggestedPages.length > 0) {
    const pageKeywords = options.suggestedPages
      .filter(p => !parts.some(part => part.toLowerCase().includes(p.toLowerCase())))
      .slice(0, 3); // limit to top 3 pages to avoid noise
    parts.push(...pageKeywords);
  }

  // 6. Key phrases from description (extract noun phrases, limit to one)
  if (options.description) {
    const words = options.description.replace(/[<>[\]]/g, '').split(/\s+/).filter(w => w.length > 3);
    const uniqueWords = [...new Set(words)];
    const hasDescriptionContent = parts.some(p => {
      const pWords = p.toLowerCase().split(/\s+/);
      return pWords.some(w => uniqueWords.some(uw => uw.toLowerCase() === w));
    });
    if (!hasDescriptionContent && uniqueWords.length > 0) {
      // Add up to 3 distinctive keywords from the description not already in parts
      const allPartLower = parts.join(' ').toLowerCase();
      const fresh = uniqueWords.filter(w => !allPartLower.includes(w.toLowerCase())).slice(0, 3);
      parts.push(...fresh);
    }
  }

  // Deduplicate and join, capped at 250 chars so it fits ShopSite's practical limit
  const seen = new Set<string>();
  const deduped = parts.filter(p => {
    const key = p.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let result = deduped.join(', ');
  if (result.length > 250) {
    result = result.substring(0, 250).replace(/,\s*[^,]*$/, '');
  }

  return result;
}
