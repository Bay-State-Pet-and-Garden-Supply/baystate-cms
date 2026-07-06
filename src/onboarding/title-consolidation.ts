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

export interface TitleSignals {
  /** Original name from the spreadsheet import (always available) */
  name: string;
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
    // Build sibling context block if available
    const siblingBlock = signals.siblingContext
      ? `
Product Line Context:
- This product belongs to the product line: "${signals.siblingContext.groupLabel}"
- Sibling names in this product line (each must get a UNIQUE final name):
${signals.siblingContext.siblingNames.map(n => `  - "${n}"`).join('\n')}
`
      : '';

    const ocrWeightBlock = signals.ocrWeight ? `\n- Packaging OCR Weight: "${signals.ocrWeight}"` : '';
    const ocrSizeBlock = signals.ocrSize ? `\n- Packaging OCR Size: "${signals.ocrSize}"` : '';

    const prompt = `You are a product cataloging assistant for a premium pet supply store.
Analyze the following title candidates for a product and consolidate them into a single, clean, store-ready product name.

Inputs:
- Original Spreadsheet Name: "${signals.name}"
- Web Extracted Title: "${signals.webTitle || 'N/A'}"
- OCR Packaging Title: "${signals.ocrTitle || 'N/A'}"${ocrWeightBlock}${ocrSizeBlock}
- Brand Name: "${signals.brandHint || 'N/A'}"${siblingBlock}
Rules for final product name:
1. It must be clean, readable, professional, and customer-friendly.
2. It must align closely with the packaging OCR title if provided and accurate, but should sound like a natural product name.
3. The Brand Name ("${signals.brandHint || ''}") MUST be included at the very beginning, unless the brand is already embedded in the product name.
4. The product SIZE or WEIGHT from the spreadsheet (e.g. "2OZ", "10.5OZ", "12OZ", "3.5OZ", "30PK") MUST be included at the end of the final name. Expand shorthand: "OZ" → "oz", "PK" → "-Pack", "LB" → "lb", "SM" → "Small", "LG" → "Large", "XL" → "X-Large".
5. CRITICAL — NEVER USE PARENTHESES: Do not put parentheses anywhere in the final name. Not for flavor, not for size, not for variants. NEVER. Correct examples: "Woof Lavender Pupsicle Large" · "Honest Kitchen Beef Protein Plus 12 oz" · "Woof Green Poomergency" · "Honest Kitchen Cheddar Biscuits 3.5 oz". Wrong examples: "Woof Pupsicle Lavender (Large)" · "Honest Kitchen Protein Plus 12 oz (Beef)" · "Honest Kitchen Protein Plus Grain Free Fish Topper (12 oz)".
6. The FLAVOR or VARIANT (e.g. "Beef", "Chicken", "Turkey", "Lavender", "Green", "Cheddar", "Gouda", "4th of July") MUST be placed immediately after the brand name, before the product type/name. Structure: Brand → Flavor → Product Type → Size.
7. DO NOT drop any words from the Original Spreadsheet Name that distinguish this product — preserve the full product identity including descriptors like "Forager", "Flyball", "Pupsicle", "Poomergency", "Butcher Block", "Crunchy", etc.
8. When sibling context is provided (multiple variants of the same product), use a CONSISTENT format across all siblings. The differentiating attribute (flavor/color/size) should be in the same structural position for every sibling WITHOUT parentheses: flavor/color between brand and product name, size at the very end. Example sibling format: "Woof Lavender Pupsicle Large", "Woof Green Poomergency", "Woof 4th of July Pupsicle Small". Absolutely never put size in parentheses even for siblings.
9. Clean up casing and spacing issues: "DR MARTY" → "Dr. Marty", "YAK DNTL" → "Yak Dental", "CHKN" or "CKN" → "Chicken", "TRKY" → "Turkey", "C/B" → "Crackers", "FLYBALLORANGE" → "Orange Forager Flyball", "FLYBALLLAVENDER" → "Lavender Forager Flyball", "FLYBALLYELLOW" → "Yellow Forager Flyball", "4TH OF JULYSM" → "4th of July Small", "FLY N FEED" → "Fly n' Feed", "POOMERGENCY" → "Poomergency".
10. The SIZE or WEIGHT in the Original Spreadsheet Name is AUTHORITATIVE. This is the size the store actually sells — not the packaging OCR weight. Distributors often list case quantities (e.g. "12/3oz cans" = 36oz total) when the store sells individual units (3oz). Always extract the individual sellable size from the spreadsheet name, not the VLM OCR weight.
11. Return ONLY the finalized product name. No parentheses. No quotes. No markdown. No explanation.`;

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
