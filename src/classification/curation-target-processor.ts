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
  buildEvidenceText,
  matchKeywordOptions,
  matchAttributeOptions,
} from './curation-target-matcher';
import { enrichProductDetails } from './detail-enrichment';
import { llmRankOptions } from './curation-target-ranker';
import {
  buildProductTypeProposal,
  buildFieldAssignmentProposal,
  buildCategoryPageProposal,
} from './curation-target-proposal';
import {
  buildPageHierarchy,
  extractProductContext,
  llmAssignCategoryPages,
} from './page-assignment-llm';
import { coordinateCohortPagesOnce } from './cohort-page-coordinator';

// ─── Shared Target Constants ──────────────────────────────────────────────────

const KEYWORD_MATCH_MIN_CONFIDENCE = 0.7;

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
    buildProposal: (value, confidence, evIds) =>
      buildProductTypeProposal({
        runId: context.runId,
        sku: input.sku,
        productTypeId: value,
        confidence,
        evidenceIds: evIds,
      }),
    task: 'product_type_classification',
  });
}

// ─── Product Field Processing ─────────────────────────────────────────────────

/**
 * Process a product field (attribute) curation target.
 *
 * Uses alias + exact matching first, then LLM fallback.
 */
export async function processProductFieldTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  const { config: targetConfig, options, attribute } = target;

  if (!options || options.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  // ── Brand shortcut: if this target looks like a brand field AND resolved
  // brand evidence exists, use it directly instead of keyword/LLM matching.
  const targetLabel = targetConfig.label.toLowerCase();
  const targetId = (targetConfig.attributeId ?? targetConfig.id).toLowerCase();
  const isBrandField = targetLabel.includes('brand') || targetId.includes('brand');

  if (isBrandField) {
    const brandEvidence = input.evidence.find(e => e.sourceField === 'resolved_brand');
    if (brandEvidence) {
      const parsed = CanonicalBrandEvidenceValueSchema.safeParse(brandEvidence.value);
      const brandName = parsed.success ? parsed.data.brandName : ((brandEvidence.value as any)?.brandName ?? (brandEvidence.value as any)?.name);
      if (brandName) {
        // Match the resolved brand name to an allowed option if possible
        const matchedOption = options.find(o =>
          o.label.toLowerCase() === brandName.toLowerCase(),
        );
        const value = matchedOption?.label ?? brandName;
        const proposal = buildFieldAssignmentProposal({
          runId: context.runId,
          sku: input.sku,
          attributeId: targetConfig.attributeId ?? targetConfig.id,
          value,
          confidence: 0.9,
          evidenceIds: [brandEvidence.id],
          isMultiple: false,
          isBulkAcceptable: false, // Guardrail: requires manual review until Issue #10 lands
        });
        return {
          proposals: [proposal],
          message: `Brand: "${brandName}" (resolved, 90%)`,
        };
      }
    }
  }

  const { text, evidenceIds } = buildEvidenceText(input.evidence);
  if (!text) {
    return { proposals: [], message: `No evidence text for "${targetConfig.label}".` };
  }

  const selectionMode = (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';
  const optionStrings = options.map(o => o.label);

  // Try deterministic alias/exact matching first
  const aliasMatches = attribute
    ? matchAttributeOptions(attribute, text, optionStrings, selectionMode)
    : [];

  let values: string[] = [];
  let confidence = 0;

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
      options,
      selectionMode,
      evidenceText: text,
      task: 'attribute_value_classification',
    });

    if (llmResult && llmResult.values.length > 0) {
      values = llmResult.values;
      confidence = llmResult.confidence;
    }
  }

  if (values.length === 0) {
    return { proposals: [], message: `No value match found for "${targetConfig.label}".` };
  }

  const proposal = buildFieldAssignmentProposal({
    runId: context.runId,
    sku: input.sku,
    attributeId: targetConfig.attributeId ?? targetConfig.id,
    value: selectionMode === 'multiple' ? values : values[0],
    confidence,
    evidenceIds,
    isMultiple: selectionMode === 'multiple',
  });

  return { proposals: [proposal], message: `"${targetConfig.label}": ${values.join(', ')} (${(confidence * 100).toFixed(0)}%)` };
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

  if (!options || options.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const selectionMode = (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';
  const maxPages = selectionMode === 'multiple' ? 5 : 1;

  // ── Build page hierarchy from store pages ──────────────────────────────
  const pageHierarchy = buildPageHierarchy(options);

  // ── Extract product context from evidence and proposals ────────────────
  const productContext = extractProductContext(input.evidence, input.allProposals);

  const groupedSkus = context.productLineContext?.siblingSkus ?? [];
  const isMultiItemGroup = groupedSkus.length >= 2;
  let llmResult: { pages: Array<{ pageId: string; pageName: string; confidence: number }> } | null;
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
    });
    const member = coordinated.get(input.sku);
    if (!member || member.status === 'abstained') {
      return {
        proposals: [],
        message: `Cohort page coordination abstained: ${member?.reason ?? `missing result for SKU ${input.sku}`}`,
      };
    }
    llmResult = { pages: member.pages };
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
    });
  }

  if (!llmResult || llmResult.pages.length === 0) {
    const { evidenceIds } = buildEvidenceText(input.evidence);
    return {
      proposals: [],
      message: `No page assignment from ${assignmentSource}. Evidence length: ${input.evidence.length} records, ${evidenceIds.length} linked.`,
    };
  }

  // ── Build proposals from LLM results ───────────────────────────────────
  const { evidenceIds } = buildEvidenceText(input.evidence);
  const proposals = llmResult.pages.map(p =>
    buildCategoryPageProposal({
      runId: context.runId,
      sku: input.sku,
      pageId: p.pageId,
      pageName: p.pageName,
      confidence: p.confidence,
      evidenceIds,
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
  buildProposal: (value: string, confidence: number, evidenceIds: string[]) => ClassificationProposal;
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

  const { text, evidenceIds } = buildEvidenceText(input.evidence);
  if (!text || text.length < 3) {
    return { proposals: [], message: `Insufficient evidence text for "${targetConfig.label}".` };
  }

  const selectionMode = (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';

  // Try deterministic keyword/token matching first
  const keywordMatches = matchKeywordOptions({
    options,
    text,
    selectionMode,
  });

  if (keywordMatches.length > 0 && keywordMatches[0].confidence >= KEYWORD_MATCH_MIN_CONFIDENCE) {
    const proposals = keywordMatches.map(m =>
      builder.buildProposal(m.value, m.confidence, evidenceIds),
    );
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
  });

  if (!llmResult || llmResult.values.length === 0) {
    return { proposals: [], message: `No match found for "${targetConfig.label}".` };
  }

  const proposals = llmResult.values.map(v =>
    builder.buildProposal(v, llmResult.confidence, evidenceIds),
  );

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
