/**
 * Shared title prompt templates and format rules for curation.
 *
 * Single source of truth for the output format contract across both
 * cohort coordination (batch-level) and per-item consolidation paths.
 * Both `cohort-name-coordinator.ts` and `title-consolidation.ts`
 * import and use these functions so LLM prompts produce the same
 * format regardless of sibling count.
 */

export const FORMAT_RULES = `- NEVER use parentheses around variants, sizes, flavors, or any other attribute.
- Order: Brand -> Product Line/Product -> Form/Species -> Flavor/Color -> Size/Count
- Expand abbreviations: SM->Small, MD->Medium, LG->Large, XL->X-Large, XXL->XX-Large, CHKN/CKN->Chicken, SLMN->Salmon, TRKY->Turkey, DNTL->Dental
- Normalize quantities and units: 5CT->5-Count, 6PK->6-Pack, OZ->oz, LB->lb
- Clean casing: title case for normal words, preserve configured brand/trademark capitalization
- Include ALL identity-bearing tokens evidenced by the inputs: brand, product line, product form, species, flavor, color, size, count
- Include the brand exactly once
- Never invent a brand, product line, form, species, flavor, color, size, count, or claim not present in the inputs
- Size, weight, or count always appears at the end of the title
- Format must be consistent across ALL siblings in a product line (same order, same skeleton)
- Each sibling must get a unique name reflecting its specific variant attributes
- Do not include prices, UPCs, distributor codes, marketing fluff, or promotional text
- No parentheses, no quotes, no markdown in the final titles`;

export interface CohortSiblingInput {
  upc: string;
  name: string;
  expectedName?: string | null;
  webTitle: string | null;
  ocrTitle: string | null;
  brand: string | null;
}

/** Build a cohort coordination prompt for a group of sibling items. */
export function buildCohortPrompt(siblings: CohortSiblingInput[]): string {
  const variantLines = siblings
    .map((s, i) => {
      const expectedName = s.expectedName ?? 'N/A';
      const webTitle = s.webTitle ?? 'N/A';
      const ocrTitle = s.ocrTitle ?? 'N/A';
      const brand = s.brand ?? 'N/A';
      return `${i + 1}. [${s.upc}] Raw Spreadsheet: "${s.name}" | Expected: "${expectedName}" | Web: "${webTitle}" | OCR: "${ocrTitle}" | Brand: "${brand}"`;
    })
    .join('\n');

  const groupLabel = siblings[0]?.name ?? 'Unknown Product Line';

  return `You are a product cataloging assistant for a premium pet supply store.
Below are ${siblings.length} variants of the same product. Assign a clean, store-ready name to EACH.
ALL names MUST use the same format.

Product Line: "${groupLabel}"

${FORMAT_RULES}

Variants:
${variantLines}

Return ONLY valid JSON: {"UPC1": "name1", "UPC2": "name2", ...}`;
}

export interface PerItemPromptSignals {
  name: string;
  rawRegisterName?: string | null;
  brandHint?: string | null;
  webTitle?: string | null;
  ocrTitle?: string | null;
  ocrWeight?: string | null;
  ocrSize?: string | null;
  ocrCount?: string | null;
  siblingContext?: {
    groupLabel: string;
    siblingNames: string[];
  };
}

/** Build a per-item title consolidation prompt from evidence signals. */
export function buildPerItemPrompt(signals: PerItemPromptSignals): string {
  const siblingBlock = signals.siblingContext
    ? `\nProduct Line Context:\n- Product line: "${signals.siblingContext.groupLabel}"\n- Sibling names (each must get a UNIQUE final name):\n${signals.siblingContext.siblingNames.map(n => `  - "${n}"`).join('\n')}\n`
    : '';
  const rawNameBlock =
    signals.rawRegisterName && signals.rawRegisterName !== signals.name
      ? `\n- Raw Register Name (authoritative source): "${signals.rawRegisterName}"`
      : '';
  const ocrWeightBlock = signals.ocrWeight ? `\n- Packaging OCR Weight: "${signals.ocrWeight}"` : '';
  const ocrSizeBlock = signals.ocrSize ? `\n- Packaging OCR Size: "${signals.ocrSize}"` : '';
  const ocrCountBlock = signals.ocrCount ? `\n- Packaging OCR Count: "${signals.ocrCount}"` : '';

  return `You are a product cataloging assistant for a premium pet supply store.
Analyze the following title candidates for a product and consolidate them into a single, clean, store-ready product name.

Inputs:
- Original Spreadsheet Name: "${signals.name}"${rawNameBlock}
- Web Extracted Title: "${signals.webTitle || 'N/A'}"
- OCR Packaging Title: "${signals.ocrTitle || 'N/A'}"${ocrWeightBlock}${ocrSizeBlock}${ocrCountBlock}
- Brand Name: "${signals.brandHint || 'N/A'}"${siblingBlock}

${FORMAT_RULES}

Return ONLY the finalized product name. No parentheses. No quotes. No markdown. No explanation.`;
}
