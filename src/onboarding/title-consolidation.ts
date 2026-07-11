/**
 * Shared title consolidation logic used by both the legacy and modular curation paths.
 *
 * Synthesizes the optimal store product title from all available name signals:
 * spreadsheet name, web-extracted title, packaging OCR title, and brand hint.
 *
 * Exported as a standalone helper so it can be reused by the modular
 * name-consolidation classification stage without duplicating LLM prompts.
 */
import { getLlmConfigForTask, callLlmForTask } from './llm-client';
import { buildPerItemPrompt } from './title-prompt-template';

export interface TitleSignals {
  /** Original name from the spreadsheet import (always available) */
  name: string;
  /**
   * Raw unabbreviated register name from the spreadsheet import.
   * This is the authoritative source of truth for size/weight/count/flavor
   * tokens that the expected name should never lose. When the cleaned
   * `name` (expected_name) has already dropped details like "2.64OZ",
   * this field preserves the original signal.
   */
  rawRegisterName?: string | null;
  /** Brand hint from the spreadsheet import */
  brandHint?: string | null;
  /** Title extracted from the brand's official product page */
  webTitle?: string | null;
  /** Title extracted from packaging image OCR */
  ocrTitle?: string | null;
  /** Weight extracted from VLM packaging OCR (e.g. "2 oz / 56.7 g") */
  ocrWeight?: string | null;
  /** Size extracted from VLM packaging OCR (e.g. "2 oz") */
  ocrSize?: string | null;
  /** Count extracted from VLM packaging OCR (e.g. "20-PIECE VALUE PACK", "6 Pack") */
  ocrCount?: string | null;
  /** Optional product-line sibling context for variant-consistent naming */
  siblingContext?: {
    groupLabel: string;
    siblingNames: string[];
    siblingWebTitles: string[];
    siblingOcrTitles: string[];
    siblingSkus: string[];
  };
}

export interface TitleResult {
  title: string;
  source: 'web' | 'ocr' | 'llm';
}

/**
 * Synthesizes the optimal store product title using all available name signals.
 *
 * When LLM is configured, delegates to the model for intelligent consolidation.
 * Otherwise uses a simple fallback: OCR title > web title > spreadsheet name.
 *
 * This is the shared implementation used by:
 * - Legacy `curateItem()` (imported directly)
 * - Modular `nameConsolidationStage` (imported directly)
 *
 * The LLM prompt rules have been updated from the original `finalizeTitle()`
 * to preserve variant attributes and enforce consistent formatting.
 */
export async function consolidateProductTitle(signals: TitleSignals): Promise<TitleResult> {
  const llmConfig = getLlmConfigForTask('product_curation', { allowFallback: true });

  // If LLM is not configured, prefer spreadsheet name (has variant tokens like LG, SM, YELLOW)
  // over web title which may strip them. OCR title still wins when available.
  if (!llmConfig) {
    if (signals.ocrTitle) {
      return { title: signals.ocrTitle, source: 'ocr' };
    }
    return { title: signals.name, source: 'web' };
  }

  try {
    const prompt = buildPerItemPrompt({
      name: signals.name,
      rawRegisterName: signals.rawRegisterName,
      brandHint: signals.brandHint,
      webTitle: signals.webTitle,
      ocrTitle: signals.ocrTitle,
      ocrWeight: signals.ocrWeight,
      ocrSize: signals.ocrSize,
      ocrCount: signals.ocrCount,
      siblingContext: signals.siblingContext
        ? { groupLabel: signals.siblingContext.groupLabel, siblingNames: signals.siblingContext.siblingNames }
        : undefined,
    });

    const cleanTitle = await callLlmForTask('product_curation', prompt, 'You are a clean product taxonomy assistant.', { allowFallback: true });
    if (cleanTitle && cleanTitle.length > 2) {
      console.log(`[TitleConsolidation] LLM consolidated title: "${cleanTitle}"`);
      return { title: cleanTitle, source: 'llm' };
    }
  } catch (err: any) {
    console.warn(`[TitleConsolidation] LLM title consolidation failed: ${err.message}`);
  }

  // Fallback: spreadsheet name has the richest variant tokens
  return { title: signals.name, source: 'web' };
}
