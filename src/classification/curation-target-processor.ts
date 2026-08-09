/**
 * Curation target processor coordinator.
 *
 * Combines the resolver → matcher → ranker → proposal builder pipeline
 * for each target kind. This is the "glue" that the thin stage wrappers
 * delegate to, so stage files contain orchestration only — no duplication
 * of matching, ranking, or proposal construction logic.
 */
import type { StageContext, StageInput } from './types';
import { type ClassificationProposal, CanonicalBrandEvidenceValueSchema } from '../shared/schemas/classification';
import { loadClassificationConfig } from './config-loader';
import {
  resolveEnabledTargets,
  type ResolvedTarget,
} from './curation-target-resolver';
import {
  matchKeywordOptions,
  matchAttributeOptions,
} from './curation-target-matcher';
import {
  buildEvidenceTargetPacket,
  buildPageEvidencePacket,
  tokenGroundingSupport,
  type EvidenceTargetPacket,
} from './evidence-targeting';
import { enrichProductDetails } from './detail-enrichment';
import { llmRankOptions } from './curation-target-ranker';
import { buildModelCallContext } from './runtime-snapshot';
import { modelPolicyViewFromConfig } from '../onboarding/model-policy-snapshot';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import {
  buildProductTypeProposal,
  buildFieldAssignmentProposal,
  buildCategoryPageProposal,
} from './curation-target-proposal';
import {
  buildPageHierarchy,
  extractProductContext,
  llmAssignCategoryPages,
  type PageAssignmentResult,
} from './page-assignment-llm';
import { coordinateCohortPagesOnce } from './cohort-page-coordinator';

// ─── Shared Target Constants ──────────────────────────────────────────────────

const KEYWORD_MATCH_MIN_CONFIDENCE = 0.7;

/**
 * Reviewed page-context source fields (issue #17 H): the Page stage uses only
 * identity/species/type/category context. Cross-species evidence is a
 * contradiction/rejection signal, never hidden concatenated text.
 */
const PAGE_CONTEXT_SOURCE_FIELDS = [
  'name',
  'title',
  'species',
  'productForm',
  'productType',
];

/** Reviewed species assertion for cross-species page-context detection. */
function pageSpeciesValue(evidence: StageInput['evidence']): unknown {
  const species = evidence.find(
    e => e.attributeId === 'species' || e.sourceField === 'species',
  );
  return species?.value ?? undefined;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TargetProcessResult {
  proposals: ClassificationProposal[];
  message: string;
}

// ─── Product Type Processing ──────────────────────────────────────────────────

/**
 * Process a product type curation target.
 *
 * Uses keyword matching against evidence first, then falls back to
 * the LLM ranker if no confident match is found.
 */
export function processProductTypeTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  return processTargetInternal(target, input, context, {
    kind: 'product_type',
    buildProposal: (value, confidence, evidence, modelCallIds) =>
      buildProductTypeProposal({
        runId: context.runId,
        sku: input.sku,
        productTypeId: value,
        confidence,
        evidenceIds: evidence.evidenceIds,
        ...(evidence.supportingEvidenceIds?.length
          ? { supportingEvidenceIds: evidence.supportingEvidenceIds }
          : {}),
        ...(evidence.contradictingEvidenceIds?.length
          ? { contradictingEvidenceIds: evidence.contradictingEvidenceIds }
          : {}),
        snapshotHash: context.snapshot?.snapshotHash ?? null,
        ...(modelCallIds?.length ? { modelCallIds } : {}),
      }),
    task: 'product_type_classification',
  });
}

// ─── Product Field Processing ─────────────────────────────────────────────────

/**
 * Process a product field (attribute) curation target.
 *
 * Uses alias + exact matching first, then LLM fallback.
 *
 * @param options.cardinality - Per-Product-Type cardinality from the accepted
 *   type's profile; overrides the global target selectionMode when supplied.
 */
export async function processProductFieldTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
  options: { cardinality?: 'single' | 'multiple' } = {},
): Promise<TargetProcessResult> {
  const { config: targetConfig, options: targetOptions, attribute } = target;
  const options2 = targetOptions;

  if (!options2 || options2.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const selectionMode = options.cardinality ?? (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';
  const snapshotHash = context.snapshot?.snapshotHash ?? null;

  // Brand assertions that disagreed in the shortcut pre-pass (visible conflict).
  let brandConflictEvidenceIds: string[] = [];

  // ── Brand shortcut: if this target looks like a brand field AND resolved
  // brand evidence exists, use it directly instead of keyword/LLM matching.
  const targetLabel = targetConfig.label.toLowerCase();
  const targetId = (targetConfig.attributeId ?? targetConfig.id).toLowerCase();
  const isBrandField = targetLabel.includes('brand') || targetId.includes('brand');

  if (isBrandField) {
    // Evaluate EVERY relevant brand assertion, never `.find()` first: a
    // disagreement between brand statements is a visible conflict that must
    // force individual review, not a silent first-wins shortcut.
    const brandEvidence = input.evidence.filter(
      e => e.sourceField === 'resolved_brand' || e.attributeId === (targetConfig.attributeId ?? targetConfig.id),
    );
    if (brandEvidence.length > 0) {
      const parsedBrands: Array<{ id: string; brandName: string }> = [];
      for (const record of brandEvidence) {
        const parsed = CanonicalBrandEvidenceValueSchema.safeParse(record.value);
        const name = parsed.success
          ? parsed.data.brandName
          : ((record.value as any)?.brandName ?? (record.value as any)?.name);
        if (typeof name === 'string' && name.trim().length > 0) {
          parsedBrands.push({ id: record.id, brandName: name.trim() });
        }
      }
      if (parsedBrands.length > 0) {
        const uniqueBrands = [...new Set(parsedBrands.map(p => p.brandName.toLocaleLowerCase()))];
        const allBrandIds = parsedBrands.map(p => p.id).filter(Boolean);
        if (uniqueBrands.length === 1) {
          // All assertions agree: shortcut is safe, and every assertion is
          // supporting (not just the first one found).
          const brandName = parsedBrands[0].brandName;
          const matchedOption = options2.find(o =>
            o.label.toLocaleLowerCase() === brandName.toLocaleLowerCase(),
          );
          const value = matchedOption?.label ?? brandName;
          const proposal = buildFieldAssignmentProposal({
            runId: context.runId,
            sku: input.sku,
            attributeId: targetConfig.attributeId ?? targetConfig.id,
            value,
            confidence: 0.9,
            evidenceIds: allBrandIds,
            supportingEvidenceIds: allBrandIds,
            isMultiple: false,
            isBulkAcceptable: false, // Guardrail: requires manual review until Issue #10 lands
            snapshotHash,
          });
          return {
            proposals: [proposal],
            message: `Brand: "${brandName}" (resolved, 90%)`,
          };
        }
        // Disagreement between brand assertions: fall through to the normal
        // matching path and mark the conflict so the resulting proposal is
        // never bulk-acceptable and the disagreeing assertions are visible as
        // contradicting evidence.
        brandConflictEvidenceIds = allBrandIds;
      }
    }
  }

  // Bounded target-specific packet: the LLM prompt and proposal evidence are
  // selected by attributeId/sourceField, never a run-wide union.
  const attrId = targetConfig.attributeId ?? targetConfig.id;
  const fieldPacket = buildEvidenceTargetPacket(input.evidence, {
    attributeId: attrId,
    sourceField: attrId,
    selectionMode,
    aliases: attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });
  const text = fieldPacket.promptText;
  if (!text) {
    return { proposals: [], message: `No evidence text for "${targetConfig.label}".` };
  }

  const optionStrings = options2.map(o => o.label);

  // Try deterministic alias/exact matching first
  const aliasMatches = attribute
    ? matchAttributeOptions(attribute, text, optionStrings, selectionMode)
    : [];

  let values: string[] = [];
  let confidence = 0;
  let llmModelCallIds: string[] | undefined;

  if (aliasMatches.length > 0) {
    values = aliasMatches.map(m => m.value);
    confidence = Math.max(...aliasMatches.map(m => m.confidence));
  }

  // Fall back to deterministic detail enrichment
  if (values.length === 0 && attribute) {
    const attrId = targetConfig.attributeId ?? targetConfig.id;
    const enrichmentParams = {
      evidenceText: text,
      packagingOcrData: null as any,
      curatedTitle: null,
      allowedValues: optionStrings,
      aliases: attribute.valueAliases ?? [],
    };
    const enrichmentCandidates = enrichProductDetails(enrichmentParams);
    const matching = enrichmentCandidates.filter(
      c => c.attributeId === attrId || c.attributeId === 'all',
    );
    if (matching.length > 0) {
      values = [...new Set(matching.map(m => m.value))].slice(
        0, selectionMode === 'multiple' ? 10 : 1,
      );
      confidence = Math.max(...matching.map(m => m.confidence));
    }
  }

  // Fall back to LLM ranker if no deterministic match
  if (values.length === 0) {
    const llmResult = await llmRankOptions({
      targetLabel: targetConfig.label,
      options: options2,
      selectionMode,
      evidenceText: text,
      task: 'attribute_value_classification',
      modelPolicy: context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null,
      protectedOperation: 'attribute_ranking',
      ...(context.snapshot
        ? {
            modelCall: buildModelCallContext(context.snapshot, context.runId, 'attribute_ranking', 1),
            snapshot: context.snapshot,
          }
        : {}),
    });

    if (llmResult && llmResult.values.length > 0) {
      values = llmResult.values;
      confidence = llmResult.confidence;
      llmModelCallIds = llmResult.modelCallIds;
    }
  }

  if (values.length === 0) {
    return { proposals: [], message: `No value match found for "${targetConfig.label}".` };
  }

  // Rebuild the packet with the SELECTED value so target-matching evidence is
  // grounded into supporting/contradicting roles and single-cardinality
  // assertion conflicts are detected (never resolved by source order).
  const rolePacket = buildEvidenceTargetPacket(input.evidence, {
    attributeId: attrId,
    sourceField: attrId,
    selectionMode,
    proposedValue: selectionMode === 'multiple' ? values : values[0],
    aliases: attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });
  let contradictingEvidenceIds = rolePacket.contradictingEvidenceIds;
  const supportingEvidenceIds = rolePacket.supportingEvidenceIds;
  let hasConflict = rolePacket.hasConflict;
  if (brandConflictEvidenceIds.length > 0) {
    // Disagreeing brand assertions are visible contradicting evidence and the
    // proposal is forced to individual review.
    contradictingEvidenceIds = [...new Set([...contradictingEvidenceIds, ...brandConflictEvidenceIds])];
    hasConflict = true;
  }

  const proposal = buildFieldAssignmentProposal({
    runId: context.runId,
    sku: input.sku,
    attributeId: targetConfig.attributeId ?? targetConfig.id,
    value: selectionMode === 'multiple' ? values : values[0],
    confidence,
    evidenceIds: [...new Set([...supportingEvidenceIds, ...contradictingEvidenceIds, ...rolePacket.context.map(r => r.id).filter(Boolean)])],
    supportingEvidenceIds,
    contradictingEvidenceIds,
    isMultiple: selectionMode === 'multiple',
    isBulkAcceptable: hasConflict ? false : undefined,
    snapshotHash,
    ...(llmModelCallIds?.length ? { modelCallIds: llmModelCallIds } : {}),
  });

  return { proposals: [proposal], message: `"${targetConfig.label}": ${values.join(', ')} (${(confidence * 100).toFixed(0)}%)${hasConflict ? ' [conflicting evidence]' : ''}` };
}

// ─── Page Processing ──────────────────────────────────────────────────────────

/**
 * Process a category page curation target.
 *
 * Uses LLM-first page assignment with rich product context (VLM OCR data,
 * product type, web description, store page hierarchy). The LLM is given
 * structured product data and the full page tree so it can make informed
 * specificity- and species-aware decisions.
 *
 * Page options carry page ID as value and page name as label.
 * Both are passed to the proposal for identity-based promotion.
 */
export async function processPageTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  const { config: targetConfig, options } = target;
  const snapshotHash = context.snapshot?.snapshotHash ?? null;

  if (!options || options.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const selectionMode = (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';
  const maxPages = selectionMode === 'multiple' ? 5 : 1;

  // ── Build page hierarchy from FROZEN verified snapshot records ────────
  // Pure over the immutable Page snapshot; no DB reads during the stage.
  const pageHierarchy = buildPageHierarchy(
    options,
    context.snapshot?.pages.state === 'verified' ? context.snapshot.pages.records : [],
  );

  // ── Extract product context from evidence and proposals ────────────────
  const productContext = extractProductContext(input.evidence, input.allProposals);

  const groupedSkus = context.productLineContext?.siblingSkus ?? [];
  const isMultiItemGroup = groupedSkus.length >= 2;
  let llmResult: PageAssignmentResult | null;
  let assignmentSource = 'LLM';

  if (isMultiItemGroup) {
    const products = context.productLineItems ?? [];
    const productSkus = new Set(products.map(product => product.sku));
    if (products.length !== groupedSkus.length || groupedSkus.some(sku => !productSkus.has(sku))) {
      return {
        proposals: [],
        message: 'Cohort page coordination abstained: the frozen product-line snapshot is incomplete.',
      };
    }
    const coordinated = await coordinateCohortPagesOnce({
      groupId: context.productLineContext!.groupId,
      products,
      pages: pageHierarchy,
      selectionMode,
      maxPages,
      modelPolicy: context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null,
      ...(context.snapshot
        ? {
            modelCall: buildModelCallContext(context.snapshot, context.runId, 'cohort_page_assignment', 1),
            snapshot: context.snapshot,
          }
        : {}),
    });
    const member = coordinated.get(input.sku);
    if (!member || member.status === 'abstained') {
      return {
        proposals: [],
        message: `Cohort page coordination abstained: ${member?.reason ?? `missing result for SKU ${input.sku}`}`,
      };
    }
    llmResult = { pages: member.pages, modelCallIds: member.modelCallIds };
    assignmentSource = 'cohort LLM';
  } else {
    llmResult = await llmAssignCategoryPages({
      productName: productContext.productName,
      productDescription: productContext.productDescription,
      ocrSummary: productContext.ocrSummary,
      productType: productContext.productType,
      pages: pageHierarchy,
      selectionMode,
      maxPages,
      modelPolicy: context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null,
      ...(context.snapshot
        ? {
            modelCall: buildModelCallContext(context.snapshot, context.runId, 'page_assignment', 1),
            snapshot: context.snapshot,
          }
        : {}),
    });
  }

  if (!llmResult || llmResult.pages.length === 0) {
    const packet = buildPageEvidencePacket(input.evidence, {
      pageContextSourceFields: PAGE_CONTEXT_SOURCE_FIELDS,
      sourceField: null,
      speciesValue: pageSpeciesValue(input.evidence),
    });
    return {
      proposals: [],
      message: `No page assignment from ${assignmentSource}. Evidence length: ${input.evidence.length} records, ${packet.evidenceIds.length} linked.`,
    };
  }

  // ── Build proposals from LLM results ───────────────────────────────────
  // Verified identity is stamped only for pageIds present in the frozen
  // verified snapshot (never inferred from a name or a mutable DB read).
  const verifiedPageIdSet = new Set(
    context.snapshot?.pages.state === 'verified'
      ? context.snapshot.pages.records.map(r => r.pageId)
      : [],
  );
  const pagePacket = buildPageEvidencePacket(input.evidence, {
    pageContextSourceFields: PAGE_CONTEXT_SOURCE_FIELDS,
    sourceField: null,
    speciesValue: pageSpeciesValue(input.evidence),
  });
  const proposals = llmResult.pages.map((p: any) =>
    buildCategoryPageProposal({
      runId: context.runId,
      sku: input.sku,
      pageId: p.pageId,
      pageName: p.pageName,
      confidence: p.confidence,
      evidenceIds: pagePacket.evidenceIds,
      ...(pagePacket.contradictingEvidenceIds.length
        ? { contradictingEvidenceIds: pagePacket.contradictingEvidenceIds }
        : {}),
      verifiedPageIdentity: verifiedPageIdSet.has(p.pageId),
      isBulkAcceptable: (p.isBrandShortcut || p.pageName.startsWith('Brand -')) ? false : undefined,
      snapshotHash,
      ...(llmResult.modelCallIds?.length ? { modelCallIds: llmResult.modelCallIds } : {}),
    }),
  );

  const pageNames = llmResult.pages.map(p => p.pageName);
  return {
    proposals,
    message: `${pageNames.join(', ')} (${assignmentSource}, ${(llmResult.pages[0].confidence * 100).toFixed(0)}%)`,
  };
}

// ─── Internal Generic Processor ───────────────────────────────────────────────

interface TargetProposalBuilder {
  kind: string;
  buildProposal: (
    value: string,
    confidence: number,
    evidence: {
      evidenceIds: string[];
      supportingEvidenceIds?: string[];
      contradictingEvidenceIds?: string[];
    },
    modelCallIds?: string[],
  ) => ClassificationProposal;
  /** LLM task name for routing, or undefined to use 'category_classification' fallback */
  task?: string;
}

/**
 * Generic target processing pipeline shared by product type and page targets.
 * Product field targets use a separate path because they need alias matching.
 */
async function processTargetInternal(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
  builder: TargetProposalBuilder,
): Promise<TargetProcessResult> {
  const { config: targetConfig, options } = target;

  if (!options || options.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const selectionMode = (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';

  // Bounded target packet. General title/description evidence is context
  // unless the deterministic grounding rule links it to the selected value.
  const buildPacket = (proposedValue?: unknown): EvidenceTargetPacket =>
    buildEvidenceTargetPacket(input.evidence, {
      attributeId: targetConfig.attributeId ?? null,
      sourceField: targetConfig.catalogField ?? null,
      selectionMode,
      proposedValue,
      isGroundingSupport: tokenGroundingSupport,
    });
  const matchingPacket = buildPacket();
  const text = matchingPacket.promptText;
  if (!text || text.length < 3) {
    return { proposals: [], message: `Insufficient evidence text for "${targetConfig.label}".` };
  }

  // Try deterministic keyword/token matching first
  const keywordMatches = matchKeywordOptions({
    options,
    text,
    selectionMode,
  });

  if (keywordMatches.length > 0 && keywordMatches[0].confidence >= KEYWORD_MATCH_MIN_CONFIDENCE) {
    const proposals = keywordMatches.map(m => {
      const singlePacket = buildPacket(m.value);
      return builder.buildProposal(m.value, m.confidence, {
        evidenceIds: singlePacket.evidenceIds,
        supportingEvidenceIds: singlePacket.supportingEvidenceIds,
        contradictingEvidenceIds: singlePacket.contradictingEvidenceIds,
      });
    });
    const values = keywordMatches.map(m => m.label);
    return {
      proposals,
      message: `${values.join(', ')} (keyword, ${(keywordMatches[0].confidence * 100).toFixed(0)}%)`,
    };
  }

  // Fall back to LLM ranker
  const llmResult = await llmRankOptions({
    targetLabel: targetConfig.label,
    options,
    selectionMode,
    evidenceText: text,
    task: builder.task,
    modelPolicy: context.snapshot
      ? modelPolicyViewFromConfig(
          context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
          context.snapshot.snapshotHash,
        )
      : null,
    protectedOperation: builder.task === 'category_page_assignment' ? 'page_assignment' : 'product_type_ranking',
    ...(context.snapshot
      ? {
          modelCall: buildModelCallContext(
            context.snapshot,
            context.runId,
            builder.task === 'category_page_assignment' ? 'page_assignment' : 'product_type_ranking',
            1,
          ),
          snapshot: context.snapshot,
        }
      : {}),
  });

  if (!llmResult || llmResult.values.length === 0) {
    return { proposals: [], message: `No match found for "${targetConfig.label}".` };
  }

  const proposals = llmResult.values.map(v => {
    const singlePacket = buildPacket(v);
    return builder.buildProposal(v, llmResult.confidence, {
      evidenceIds: singlePacket.evidenceIds,
      supportingEvidenceIds: singlePacket.supportingEvidenceIds,
      contradictingEvidenceIds: singlePacket.contradictingEvidenceIds,
    }, llmResult.modelCallIds);
  });

  return {
    proposals,
    message: `${llmResult.values.join(', ')} (LLM, ${(llmResult.confidence * 100).toFixed(0)}%)`,
  };
}

// ─── Convenience: Check if Product Type is an enabled target ──────────────────

/**
 * Check whether Product Type is an enabled curation target for the given workspace.
 * Returns false when no config exists or the target is disabled.
 */
// fallow-ignore-next-line unused-export — used by tests
export function isProductTypeTargetEnabled(workspacePath: string): boolean {
  const config = loadClassificationConfig(workspacePath);
  const resolved = resolveEnabledTargets(config, '');
  return resolved.productTypes.length > 0;
}

/**
 * Check whether any curation targets are enabled.
 */
// fallow-ignore-next-line unused-export — used by tests
export function hasAnyEnabledTarget(workspacePath: string): boolean {
  const config = loadClassificationConfig(workspacePath);
  const resolved = resolveEnabledTargets(config, '');
  return resolved.hasAny;
}
