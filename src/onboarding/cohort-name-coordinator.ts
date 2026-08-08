/**
 * Cohort Name Coordinator
 *
 * Pre-pipeline coordination pass that groups curation items by product
 * line and makes ONE LLM call per group to produce consistent variant
 * names across all siblings.
 *
 * Exports:
 * - coordinateCohortItemsOnce(batchId, items) — cached per-fingerprint
 * - clearCohortCoordinationCache() — for tests
 *
 * For each multi-item group the result is ALL-OR-NOTHING: either every
 * sibling gets an LLM-coordinated title (source: 'llm_cohort') or every
 * sibling gets a deterministic fallback (source: 'cohort_fallback').
 * Singletons are never coordinated and return absent.
 */
import { getLlmConfigForTask, callLlmForTask } from './llm-client';
import { normalizeBrand, extractNameStem } from './product-line-grouper';
import { buildCohortPrompt, FORMAT_RULES } from './title-prompt-template';
import type { OnboardingItem } from '../shared/schemas/onboarding';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CoordinatedTitle {
  /** The store-ready product title. */
  title: string;
  /** How the title was produced. */
  source: 'llm_cohort' | 'cohort_fallback';
}

/** Stable fingerprint inputs for cache. Excludes volatile fields. */
interface FingerprintInput {
  id: string;
  upc: string;
  name: string;
  brandHint: string | null;
  expectedName: string | null;
  webTitle: string | null;
}

// ─── Cache ─────────────────────────────────────────────────────────────────────

const cohortCache = new Map<string, Promise<Map<string, CoordinatedTitle>>>();

function containsControlCharacters(value: string): boolean {
  return [...value].some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter(char => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
}

/**
 * Build a stable cache key from the batch ID and sorted fingerprints of every
 * item. Only title-significant fields participate; stage status, updatedAt,
 * curationData, and OCR fields do not change the key.
 */
function buildCacheKey(
  batchId: string,
  items: OnboardingItem[],
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
): string {
  const fingerprints: FingerprintInput[] = items.map(item => ({
    id: item.id,
    upc: item.upc,
    name: item.name ?? '',
    brandHint: item.brandHint ?? null,
    expectedName: item.expectedName ?? null,
    webTitle: item.extractionData?.title ?? null,
  }));
  fingerprints.sort((a, b) => a.id.localeCompare(b.id));

  const llmConfig = getLlmConfigForTask('product_curation', {
    allowFallback: true,
    modelPolicy,
    protectedOperation: 'cohort_title_consolidation',
  });
  const modelIdentity = llmConfig
    ? {
        provider: llmConfig.provider,
        model: llmConfig.model,
        policyDigest: modelPolicy?.policyDigest ?? null,
      }
    : null;
  return `${batchId}\u0000${JSON.stringify({ fingerprints, modelIdentity, formatRules: FORMAT_RULES })}`;
}

/**
 * Coordinate cohort names once per batch/fingerprint.
 *
 * Concurrent calls for the same batch with the same stable inputs share
 * one promise/LLM pass. The resolved map is reused until the stable
 * fingerprint changes (name, brandHint, expectedName, or web title).
 *
 * @param batchId - The onboarding batch ID.
 * @param items   - Items from the same batch.
 * @returns Map of UPC → CoordinatedTitle. Only multi-item groups appear.
 */
export function coordinateCohortItemsOnce(
  batchId: string,
  items: OnboardingItem[],
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
): Promise<Map<string, CoordinatedTitle>> {
  const key = buildCacheKey(batchId, items, modelPolicy);

  const existing = cohortCache.get(key);
  if (existing) return existing;

  // A changed stable fingerprint supersedes the prior cache entry for this
  // batch. Resolved promises remain cached so sequential workers reuse the
  // exact same cohort decision, not just concurrent callers.
  const batchPrefix = `${batchId}\u0000`;
  for (const cachedKey of cohortCache.keys()) {
    if (cachedKey.startsWith(batchPrefix) && cachedKey !== key) {
      cohortCache.delete(cachedKey);
    }
  }

  const promise = coordinateCohortItems(items, modelPolicy);
  cohortCache.set(key, promise);
  return promise;
}

/**
 * Clear the in-memory cache. Intended for tests.
 */
// fallow-ignore-next-line unused-export — used by tests
export function clearCohortCoordinationCache(): void {
  cohortCache.clear();
}

// ─── Deterministic Fallback Formatter ─────────────────────────────────────────

/**
 * Known abbreviation expansions for deterministic title cleaning.
 * Applied case-insensitively; the output uses the canonical form.
 */
const ABBREVIATIONS: Record<string, string> = {
  sm: 'Small',
  md: 'Medium',
  lg: 'Large',
  xl: 'X-Large',
  xxl: 'XX-Large',
  xs: 'X-Small',
  chkn: 'Chicken',
  ckn: 'Chicken',
  slmn: 'Salmon',
  trky: 'Turkey',
  dntl: 'Dental',
};

/** Units to normalize after title casing. */
const UNIT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(\d+(?:\.\d+)?)\s*oz\b/gi, '$1 oz'],
  [/\b(\d+(?:\.\d+)?)\s*lb\b/gi, '$1 lb'],
  [/\b(\d+(?:\.\d+)?)\s*kg\b/gi, '$1 kg'],
  [/\b(\d+(?:\.\d+)?)\s*g\b/gi, '$1 g'],
  [/\b(\d+(?:\.\d+)?)\s*ml\b/gi, '$1 mL'],
  [/\b(\d+)\s*ct\b/gi, '$1-Count'],
  [/\b(\d+)\s*pk\b/gi, '$1-Pack'],
];

/**
 * Deterministically produce a store-ready title from a spreadsheet name.
 *
 * Handles: SM/MD/LG/XL expansion, CHKN/CKN/SLMN/TRKY/DNTL expansion,
 * OZ/LB/CT/PK normalization, parenthesis removal (content preserved),
 * brand prefixing, whitespace normalization, title casing.
 */
export function formatDeterministicTitle(
  spreadsheetName: string,
  brandHint: string | null,
): string {
  let t = spreadsheetName.trim();

  // 0. Pre-process attached abbreviation+unit patterns (e.g. SM5CT, MD2CT,
  // LG30PK, SM6PK). Convert to the canonical expanded form immediately.
  t = t.replace(
    /(SM|MD|LG|XL|XS|XXL)(\d+(?:\.\d+)?)(PK|CT|OZ|LB|G|KG|ML|GAL)/gi,
    (_match, prefix, digits, unit) => {
      const abbrMap: Record<string, string> = {
        SM: 'Small', MD: 'Medium', LG: 'Large', XL: 'X-Large', XS: 'X-Small', XXL: 'XX-Large',
      };
      const unitMap: Record<string, string> = {
        PK: '-Pack', CT: '-Count', OZ: ' oz', LB: ' lb', G: ' g', KG: ' kg', ML: ' mL', GAL: ' gal',
      };
      return `${abbrMap[prefix.toUpperCase()] || prefix} ${digits}${unitMap[unit.toUpperCase()] || ` ${unit}`}`;
    },
  );

  // 1. Remove parentheses delimiters but keep inner text
  t = t.replace(/\(([^)]*)\)/g, '$1');

  // 2. Expand known abbreviations (case-insensitive, word-boundary)
  for (const [abbr, expanded] of Object.entries(ABBREVIATIONS)) {
    const re = new RegExp(`\\b${abbr}\\b`, 'gi');
    t = t.replace(re, expanded);
  }

  // 3. Remove non-printable/control characters and normalize whitespace.
  t = stripControlCharacters(t).replace(/\s+/g, ' ').trim();

  // 4. Apply deterministic title casing. Unit/count formatting is restored
  // afterwards so hyphenated quantity suffixes keep their canonical case.
  t = t
    .toLowerCase()
    .replace(/\b([a-z])/g, letter => letter.toUpperCase());

  // 5. Normalize attached and separated unit/count tokens, including decimals.
  for (const [pattern, replacement] of UNIT_PATTERNS) {
    t = t.replace(pattern, replacement);
  }
  t = t.replace(/\s+/g, ' ').trim();

  // 6. Prefix the brand only when absent; when already present, restore the
  // configured brand's exact casing rather than retaining distributor ALL CAPS.
  if (brandHint?.trim()) {
    const brand = brandHint.trim();
    const brandWords = brand.match(/[a-z0-9]+/gi) ?? [];
    const flexibleBrand = brandWords
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^a-z0-9]+');
    const prefix = flexibleBrand
      ? new RegExp(`^${flexibleBrand}(?=\\s|$)`, 'i')
      : null;
    t = prefix?.test(t) ? t.replace(prefix, brand) : `${brand} ${t}`;
  }

  return t;
}

// ─── Core Coordination Logic ──────────────────────────────────────────────────

/**
 * Validate that the LLM response covers every expected UPC, contains no
 * duplicate titles (case/whitespace-insensitive), and has no structural issues.
 * Returns null on validation failure (caller must use fallback for the group).
 */
function validateCohortResponse(
  parsed: unknown,
  expectedUpcs: string[],
): Map<string, string> | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const entries = Object.entries(parsed as Record<string, unknown>);
  const expected = new Set(expectedUpcs);
  if (entries.length !== expected.size || entries.some(([upc]) => !expected.has(upc))) {
    return null;
  }

  const result = new Map<string, string>();
  const seenTitles = new Set<string>();
  for (const [upc, rawTitle] of entries) {
    if (typeof rawTitle !== 'string' || containsControlCharacters(rawTitle)) {
      return null;
    }
    const title = rawTitle
      .replace(/\(([^)]*)\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (title.length < 2 || /[{}[\]]/.test(title)) return null;

    const duplicateKey = title.toLowerCase();
    if (seenTitles.has(duplicateKey)) return null;
    seenTitles.add(duplicateKey);
    result.set(upc, title);
  }

  return result.size === expected.size ? result : null;
}

/**
 * Coordinate cohort names for a set of onboarding items.
 *
 * @param items - Items from the same batch (any stage)
 * @returns Map of UPC → CoordinatedTitle. Only includes items
 *   from multi-item groups. Missing entries fall back to per-item.
 */
// fallow-ignore-next-line unused-export — used by tests
export async function coordinateCohortItems(
  items: OnboardingItem[],
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
): Promise<Map<string, CoordinatedTitle>> {
  const result = new Map<string, CoordinatedTitle>();

  if (items.length === 0) return result;

  const groups = groupByProductLine(items);

  for (const [, groupItems] of groups) {
    if (groupItems.length <= 1) continue;

    try {
      const groupResult = await coordinateGroup(groupItems, modelPolicy);
      for (const [upc, ct] of groupResult) {
        result.set(upc, ct);
      }
    } catch (err: any) {
      console.warn(
        `[CohortCoordinator] Coordination failed for group, using fallbacks: ${err.message}`,
      );
      // All-or-nothing: deterministic fallback for every sibling
      for (const item of groupItems) {
        result.set(item.upc, {
          title: formatDeterministicTitle(item.name ?? item.upc, item.brandHint),
          source: 'cohort_fallback',
        });
      }
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
 * Throws on any failure so the caller provides all-or-nothing fallback.
 */
async function coordinateGroup(
  items: OnboardingItem[],
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
): Promise<Map<string, CoordinatedTitle>> {
  const llmConfig = getLlmConfigForTask('product_curation', {
    allowFallback: true,
    modelPolicy,
    protectedOperation: 'cohort_title_consolidation',
  });
  if (!llmConfig) {
    throw new Error('No LLM configured for product_curation');
  }

  const siblings = items.map(item => ({
    upc: item.upc,
    name: item.name,
    expectedName: item.expectedName ?? null,
    webTitle: item.extractionData?.title ?? null,
    ocrTitle: item.extractionData?.packagingOcrData?.productName ?? item.extractionData?.packagingTitle ?? null,
    brand: item.brandHint,
  }));

  // All items in one prompt (no cap). Individual signal strings are
  // truncated at 500 characters to keep prompt size reasonable.
  const truncatedSiblings = siblings.map(s => ({
    ...s,
    name: s.name.slice(0, 500),
    expectedName: s.expectedName?.slice(0, 500) ?? null,
    webTitle: s.webTitle?.slice(0, 500) ?? null,
    ocrTitle: s.ocrTitle?.slice(0, 500) ?? null,
    brand: s.brand?.slice(0, 200) ?? null,
  }));

  const prompt = buildCohortPrompt(truncatedSiblings);

  const response = await callLlmForTask(
    'product_curation',
    prompt,
    'You are a clean product taxonomy assistant.',
    {
      allowFallback: true,
      modelPolicy,
      protectedOperation: 'cohort_title_consolidation',
    },
  );

  if (!response || response.length < 2) {
    throw new Error('LLM returned empty response');
  }

  // Strip markdown code blocks
  const cleaned = response
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse LLM JSON: ${cleaned.slice(0, 200)}`);
  }

  const expectedUpcs = items.map(i => i.upc);
  const validated = validateCohortResponse(parsed, expectedUpcs);

  if (!validated) {
    throw new Error('LLM response validation failed (missing UPCs or duplicate titles)');
  }

  const result = new Map<string, CoordinatedTitle>();
  for (const [upc, title] of validated) {
    result.set(upc, { title, source: 'llm_cohort' });
  }

  console.log(
    `[CohortCoordinator] Coordinated ${result.size} titles via LLM for group`,
  );
  return result;
}
