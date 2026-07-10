/**
 * customFieldNormalizer.ts — Normalizes and validates LLM-proposed
 * custom field selectors.
 *
 * Each proposed custom field goes through:
 * 1. Key normalization (camelCase + "Selector" suffix)
 * 2. Reserved key rejection
 * 3. Collision detection against catalog + existing custom fields
 * 4. Semantic alias deduplication
 * 5. Selector candidate validation
 */

import { validateAndRankSelectors } from './selectorValidator';
import type { ValidatedCandidate } from './selectorValidator';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CUSTOM_FIELDS = 8;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Semantic aliases that map to existing catalog fields.
 * When a proposed custom field matches any of these aliases for a
 * catalog field, it is considered a duplicate and discarded.
 */
const SEMANTIC_ALIASES: Record<string, string[]> = {
  brandSelector: ['manufacturer', 'maker', 'vendor', 'brand name', 'produced by'],
  titleSelector: ['product name', 'name', 'product title', 'item name'],
  imagesSelector: ['product image', 'photo', 'gallery image', 'product photo', 'picture'],
  descriptionSelector: ['product description', 'desc', 'details', 'overview', 'about'],
  weightSelector: ['product weight', 'net weight', 'item weight', 'package weight', 'weight'],
  skuSelector: ['sku', 'item number', 'part number', 'model number', 'product code', 'mpn', 'upc', 'ean', 'gtin'],
  flavorSelector: ['flavour', 'variety', 'variant', 'taste', 'scent'],
};

// ─── Type ───────────────────────────────────────────────────────────────────

export interface RawCustomField {
  proposedKey: string;
  label: string;
  valueType: string;
  multiple: boolean;
  candidates: Array<{ selector: string; evidence: string }>;
}

export interface NormalizedCustomField extends ValidatedCandidate {
  key: string;
  fieldKey: string;
  label: string;
  valueType: string;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Normalize and validate LLM-proposed custom fields.
 *
 * @param html - The sanitized snapshot HTML
 * @param rawCustomFields - Raw custom field proposals from the LLM
 * @param requestedFieldKeys - Keys of fields already in the request catalog
 * @param existingCustomFieldKeys - Keys of custom fields already in the draft
 * @returns Up to 8 validated custom field suggestions
 */
export function normalizeAndValidateCustomFields(
  html: string,
  rawCustomFields: RawCustomField[],
  requestedFieldKeys: string[],
  existingCustomFieldKeys: string[],
): NormalizedCustomField[] {
  const result: NormalizedCustomField[] = [];
  const seenKeys = new Set<string>();
  const requestedKeySet = new Set(requestedFieldKeys);
  const existingKeySet = new Set(existingCustomFieldKeys);

  // Build reverse alias lookup: all alias strings → catalog key
  const aliasToCatalogKey = new Map<string, string>();
  for (const [catalogKey, aliases] of Object.entries(SEMANTIC_ALIASES)) {
    for (const alias of aliases) {
      aliasToCatalogKey.set(alias.toLowerCase(), catalogKey);
    }
  }

  for (const raw of rawCustomFields.slice(0, MAX_CUSTOM_FIELDS + 5)) {
    // ── Step 1: Normalize key ─────────────────────────────────────────
    const normalizedKey = normalizeCustomFieldKey(raw.proposedKey);

    // ── Step 2: Reject reserved keys (check BOTH raw and normalized) ─
    // Normalization can mangle __proto__ to protoSelector and constructor
    // to constructorSelector, so we must check the original too.
    const rawKeyLower = raw.proposedKey?.toLowerCase().trim() ?? '';
    if (RESERVED_KEYS.has(normalizedKey) || RESERVED_KEYS.has(rawKeyLower)) {
      continue;
    }

    // ── Step 3: Reject collisions with catalog fields ──────────────────
    if (requestedKeySet.has(normalizedKey)) {
      continue;
    }

    // ── Step 4: Reject collisions with existing custom fields ──────────
    if (existingKeySet.has(normalizedKey)) {
      continue;
    }

    // ── Step 5: Deduplicate by semantic alias (only for catalog
    //    fields that are actively in the request or existing draft) ────
    const labelLower = raw.label.toLowerCase().trim();
    const keyWithoutSuffix = normalizedKey.replace(/Selector$/i, '').toLowerCase();
    let isDuplicate = false;

    // Check key and stem against ALL known catalog fields
    for (const [catalogKey] of Object.entries(SEMANTIC_ALIASES)) {
      if (normalizedKey === catalogKey) {
        isDuplicate = true;
        break;
      }
      if (catalogKey.replace(/Selector$/i, '').toLowerCase() === keyWithoutSuffix) {
        isDuplicate = true;
        break;
      }
    }

    // Check EXACT alias match against ALL catalog fields
    // (catches "flavour" → flavorSelector by label)
    if (!isDuplicate) {
      for (const [, aliases] of Object.entries(SEMANTIC_ALIASES)) {
        if (aliases.some((alias) => labelLower === alias)) {
          isDuplicate = true;
          break;
        }
      }
    }

    // For requested + existing fields also check includes-based alias matching
    if (!isDuplicate) {
      for (const [catalogKey, aliases] of Object.entries(SEMANTIC_ALIASES)) {
        if (!requestedKeySet.has(catalogKey) && !existingKeySet.has(catalogKey)) continue;
        if (aliases.some((alias) => labelLower.includes(alias) || alias.includes(labelLower))) {
          isDuplicate = true;
          break;
        }
      }
    }

    if (isDuplicate) continue;

    // ── Step 6: Prevent duplicate proposals ────────────────────────────
    if (seenKeys.has(normalizedKey)) {
      continue;
    }
    seenKeys.add(normalizedKey);

    // ── Step 7: Validate the top candidate against HTML ────────────────
    const fieldResults: Record<string, { notFound: boolean; candidates: Array<{ selector: string; evidence: string }> }> = {};

    if (raw.candidates.length > 0) {
      fieldResults[normalizedKey] = {
        notFound: false,
        candidates: raw.candidates.map((c) => ({
          selector: c.selector,
          evidence: c.evidence,
        })),
      };
    } else {
      fieldResults[normalizedKey] = { notFound: true, candidates: [] };
    }

    const validated = validateAndRankSelectors(html, fieldResults, [
      { key: normalizedKey, valueType: raw.valueType, multiple: raw.multiple },
    ]);

    const suggestion = validated[normalizedKey];
    if (!suggestion || suggestion.status !== 'suggested') continue;

    // Support value types
    const supportedTypes = new Set(['text', 'html', 'url', 'image', 'list']);
    const valueType = supportedTypes.has(raw.valueType) ? raw.valueType : 'text';

    result.push({
      key: normalizedKey,
      fieldKey: normalizedKey,
      label: raw.label.slice(0, 256),
      valueType,
      selector: suggestion.selector,
      status: suggestion.status,
      validation: suggestion.validation,
      quality: suggestion.quality,
      warnings: suggestion.warnings,
      explanation: suggestion.explanation,
      preview: suggestion.preview,
    });

    // Cap at MAX_CUSTOM_FIELDS
    if (result.length >= MAX_CUSTOM_FIELDS) {
      break;
    }
  }

  return result;
}

// ─── Key normalization ────────────────────────────────────────────────────────

/**
 * Normalize a proposed custom field key to camelCase + "Selector" suffix.
 *
 * Examples:
 *   "Ingredient List"    → ingredientListSelector
 *   "product_weight"     → productWeightSelector
 *   "Flavor / Variety"   → flavorVarietySelector
 *   "flavorSelector"     → flavorSelector (no double suffix)
 *   "title"              → titleSelector
 *   "__proto__"          → __proto__ (rejected by caller)
 *   "SKU Number"         → sKUNumberSelector (heuristic — acceptable for MVP)
 */
export function normalizeCustomFieldKey(input: string): string {
  // Remove characters outside [A-Za-z0-9_ ], preserving spaces and underscores
  let cleaned = input.replace(/[^a-zA-Z0-9_ ]/g, ' ');

  // Split into words
  const words = cleaned
    .split(/[\s_]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

  if (words.length === 0) return 'customFieldSelector';

  // CamelCase: first word lowercase, rest capitalized
  const camel = words
    .map((word, index) => {
      if (index === 0) {
        return word.charAt(0).toLowerCase() + word.slice(1);
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');

  // Ensure it ends with "Selector"
  if (camel.endsWith('Selector')) {
    return camel;
  }

  return `${camel}Selector`;
}
