/**
 * Name Consolidation Stage (modular replacement for curateItem's title synthesis).
 *
 * Builds title signals from accumulated evidence (spreadsheet name, web title,
 * packaging OCR title, brand hint) and calls the shared `consolidateProductTitle()`
 * helper to produce a store-ready curated title.
 *
 * This stage produces NO proposals and NO new evidence — it returns compatibility
 * metadata for the orchestrator to merge into `curation_data_json`.
 *
 * Dependencies: evidence_extraction (needs spreadsheet/web/OCR evidence signals)
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { consolidateProductTitle } from '../../onboarding/title-consolidation';

/**
 * Extract the best title signal from evidence of a given sourceField.
 */
function evidenceValue(
  evidence: StageInput['evidence'],
  sourceField: string,
  source?: string,
): string | null {
  const matches = evidence.filter(e => {
    if (e.sourceField !== sourceField) return false;
    if (source && e.source !== source) return false;
    return true;
  });
  if (matches.length === 0) return null;
  // Return the value of the first match, converted to string if needed
  const val = matches[0].value;
  if (typeof val === 'string' && val.trim().length > 0) return val.trim();
  if (val != null) return String(val).trim();
  return null;
}

/**
 * Name Consolidation Stage
 *
 * Reads evidence from the evidence_extraction stage and produces a curated
 * product title using the shared consolidateProductTitle() helper.
 *
 * Returns metadata (not proposals) for orchestrator compatibility:
 * - curatedTitle: the final consolidated title
 * - packagingOcrTitle: the raw OCR title (if available)
 * - titleSource: how the title was derived
 * - signalsUsed: which signals were available
 */
export const nameConsolidationStage: StageDefinition = {
  name: 'name_consolidation',
  requires: ['evidence_extraction'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    // ── Cohort coordination short-circuit ────────────────────────────
    // If a pre-computed coordinated title was set by the cohort
    // coordinator, use it directly — skip the per-item LLM call.
    if (context.preComputedTitle) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: `Using pre-computed coordinated title: "${context.preComputedTitle}"`,
          metadata: {
            curatedTitle: context.preComputedTitle,
            titleSource: 'llm',
            packagingOcrTitle: null,
            signalsUsed: { source: 'cohort_coordination' },
          },
        },
      };
    }

    // Gather title signals from accumulated evidence
    // Prefer expected_name (refined during discovery consolidation) over
    // the raw spreadsheet name, as it represents a more curated identity.
    const spreadsheetName =
      evidenceValue(input.evidence, 'expected_name', 'spreadsheet') ??
      evidenceValue(input.evidence, 'name', 'spreadsheet');

    const webTitle = evidenceValue(input.evidence, 'title', 'official_product_page');
    const ocrTitle = evidenceValue(input.evidence, 'name', 'visual_product_evidence');
    const ocrWeight = evidenceValue(input.evidence, 'weight', 'visual_product_evidence');
    const ocrSize = evidenceValue(input.evidence, 'size', 'visual_product_evidence');
    const ocrCount = evidenceValue(input.evidence, 'count', 'visual_product_evidence');
    const brandHint = evidenceValue(input.evidence, 'brand', 'spreadsheet') ??
      evidenceValue(input.evidence, 'brand', 'official_product_page');

    const fallbackName = spreadsheetName ?? webTitle ?? 'Unknown Product';

    if (!spreadsheetName && !webTitle && !ocrTitle) {
      return {
        status: 'abstained',
        reason: 'No title signals available from evidence (no spreadsheet name, web title, or OCR title).',
      };
    }

    // Check for product-line sibling context
    const productLine = context.productLineContext;
    const siblingContext = productLine && productLine.siblingNames.length > 0
      ? {
          groupLabel: productLine.groupLabel,
          siblingNames: productLine.siblingNames,
          siblingWebTitles: productLine.siblingWebTitles,
          siblingOcrTitles: productLine.siblingOcrTitles,
          siblingSkus: productLine.siblingSkus,
        }
      : undefined;

    try {
      const result = await consolidateProductTitle({
        name: spreadsheetName ?? fallbackName,
        brandHint: brandHint ?? undefined,
        webTitle: webTitle ?? undefined,
        ocrTitle: ocrTitle ?? undefined,
        ocrWeight: ocrWeight ?? undefined,
        ocrSize: ocrSize ?? undefined,
        ocrCount: ocrCount ?? undefined,
        siblingContext,
      });

      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: siblingContext
            ? `Title consolidated via ${result.source} with sibling context (${siblingContext.siblingNames.length} siblings): "${result.title}"`
            : `Title consolidated via ${result.source}: "${result.title}"`,
          metadata: {
            curatedTitle: result.title,
            titleSource: result.source,
            packagingOcrTitle: ocrTitle ?? null,
            signalsUsed: {
              spreadsheetName: spreadsheetName ?? null,
              webTitle: webTitle ?? null,
              ocrTitle: ocrTitle ?? null,
              ocrWeight: ocrWeight ?? null,
              ocrSize: ocrSize ?? null,
              ocrCount: ocrCount ?? null,
              brandHint: brandHint ?? null,
              groupId: productLine?.groupId ?? null,
              siblingCount: productLine?.siblingNames.length ?? 0,
            },
          },
        },
      };
    } catch (err: any) {
      console.error(`[NameConsolidation] Failed to consolidate title: ${err.message}`);

      // Fallback: use best available signal
      const fallback = ocrTitle ?? webTitle ?? spreadsheetName ?? 'Unknown Product';
      const fallbackSource = ocrTitle ? 'ocr' : 'web';

      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: siblingContext
            ? `Title consolidation failed (sibling context available), using fallback: "${fallback}"`
            : `Title consolidation failed, using fallback: "${fallback}"`,
          metadata: {
            curatedTitle: fallback,
            titleSource: fallbackSource,
            packagingOcrTitle: ocrTitle ?? null,
            signalsUsed: {
              spreadsheetName: spreadsheetName ?? null,
              webTitle: webTitle ?? null,
              ocrTitle: ocrTitle ?? null,
              ocrWeight: ocrWeight ?? null,
              ocrSize: ocrSize ?? null,
              ocrCount: ocrCount ?? null,
              brandHint: brandHint ?? null,
              groupId: productLine?.groupId ?? null,
              siblingCount: productLine?.siblingNames.length ?? 0,
            },
          },
        },
      };
    }
  },
};
