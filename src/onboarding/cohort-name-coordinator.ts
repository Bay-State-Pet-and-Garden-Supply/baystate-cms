/**
 * Cohort Name Coordinator
 *
 * Pre-pipeline coordination pass that groups curation items by product
 * line and makes ONE LLM call per group to produce consistent variant
 * names across all siblings. Eliminates the per-item LLM inconsistency.
 *
 * Called by the worker BEFORE curateItemWithPipeline() runs.
 * Titles are written to onboarding_items.coordinated_title by the worker;
 * the pipeline reads them via StageContext.preComputedTitle and skips
 * the name_consolidation LLM call.
 *
 * Singletons (groups with 1 item) are NOT coordinated — they fall
 * through to the normal per-item path in the pipeline.
 */
import { getLlmConfigForTask, callLlmForTask } from './llm-client';
import { normalizeBrand, extractNameStem } from './product-line-grouper';
import type { OnboardingItem } from '../shared/schemas/onboarding';

/** Maximum variants per LLM call to keep prompt size reasonable. */
const MAX_GROUP_SIZE = 15;

/**
 * Coordinate cohort names for a set of onboarding items.
 *
 * Groups items by product line, then makes ONE LLM call per
 * multi-item group to produce consistent names for all variants.
 *
 * @param items - Items from the same batch (any stage)
 * @returns Map of UPC → coordinated title. Only includes items
 *   from multi-item groups. Missing entries fall back to per-item.
 */
export async function coordinateCohortItems(
  items: OnboardingItem[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  if (items.length === 0) return result;

  const llmConfig = getLlmConfigForTask('product_curation', { allowFallback: true });
  if (!llmConfig) {
    console.log('[CohortCoordinator] No LLM configured — skipping cohort coordination');
    return result;
  }

  const groups = groupByProductLine(items);

  for (const [groupKey, groupItems] of groups) {
    if (groupItems.length <= 1) continue;

    const capped = groupItems.slice(0, MAX_GROUP_SIZE);
    if (groupItems.length > MAX_GROUP_SIZE) {
      console.warn(
        `[CohortCoordinator] Group "${groupKey}" has ${groupItems.length} items, capping to ${MAX_GROUP_SIZE}`,
      );
    }

    try {
      const titles = await coordinateGroup(capped);
      for (const [upc, title] of titles) {
        result.set(upc, title);
      }
      console.log(
        `[CohortCoordinator] Coordinated ${titles.size} titles for group "${groupKey}"`,
      );
    } catch (err: any) {
      console.warn(
        `[CohortCoordinator] Failed for group "${groupKey}": ${err.message}`,
      );
    }
  }

  return result;
}

/**
 * Group items by product line using normalizeBrand + extractNameStem.
 */
function groupByProductLine(
  items: OnboardingItem[],
): Map<string, OnboardingItem[]> {
  const groups = new Map<string, OnboardingItem[]>();

  for (const item of items) {
    const brand = normalizeBrand(item.brandHint);
    const stem = extractNameStem(item.name || '');

    if (!stem) {
      groups.set(`single-${item.upc}`, [item]);
      continue;
    }

    const key = `${brand}|${stem}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  return groups;
}

/**
 * Make ONE LLM call for a group of sibling items.
 * LLM sees all variants at once and returns consistent names.
 */
async function coordinateGroup(
  items: OnboardingItem[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  const variantLines = items
    .map((item, i) => {
      const ext = item.extractionData;
      const webTitle = ext?.title ?? 'N/A';
      const ocrTitle =
        ext?.packagingOcrData?.productName ?? ext?.packagingTitle ?? 'N/A';
      const brand = item.brandHint ?? 'N/A';
      return `${i + 1}. [${item.upc}] Spreadsheet: "${item.name}" | Web: "${webTitle}" | OCR: "${ocrTitle}" | Brand: "${brand}"`;
    })
    .join('\n');

  const groupLabel = items[0]?.name ?? 'Unknown Product Line';

  const prompt = `You are a product cataloging assistant for a premium pet supply store.
Below are ${items.length} variants of the same product. Assign a clean, store-ready name to EACH.
ALL names MUST use the exact same format.

Product Line: "${groupLabel}"

Variants:
${variantLines}

Rules:
1. EVERY name MUST use the format: "Brand ProductName (Variant)" — no exceptions, no mixing.
2. The variant in parentheses is the distinguishing attribute (size, color, flavor, or count).
3. Expand size abbreviations: SM→Small, LG→Large, XL→X-Large, MD→Medium.
4. DO NOT drop any words from the spreadsheet name that distinguish the product (e.g. "Forager", "Flyball", "Pupsicle").
5. Clean up casing (e.g. "WOOF" → "Woof", "PUPSICLE" → "Pupsicle", "GREEN" → "Green").
6. ALL names in the response MUST use the same format — no mixing parenthetical and non-parenthetical.
7. Return ONLY valid JSON: {"upc1": "name1", "upc2": "name2", ...}`;

  const response = await callLlmForTask(
    'product_curation',
    prompt,
    'You are a clean product taxonomy assistant.',
    { allowFallback: true },
  );

  if (!response || response.length < 2) {
    throw new Error('LLM returned empty response');
  }

  // Strip markdown code blocks if present
  const cleaned = response
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Failed to parse LLM JSON response: ${cleaned.slice(0, 200)}`,
    );
  }

  const expectedUpcs = new Set(items.map(i => i.upc));
  for (const [upc, title] of Object.entries(parsed)) {
    if (
      expectedUpcs.has(upc) &&
      typeof title === 'string' &&
      title.trim().length > 0
    ) {
      result.set(upc, title.trim());
    }
  }

  const missingUpcs = items.filter(i => !result.has(i.upc)).map(i => i.upc);
  if (missingUpcs.length > 0) {
    console.warn(
      `[CohortCoordinator] LLM response missing titles for UPCs: ${missingUpcs.join(', ')}`,
    );
  }

  return result;
}
