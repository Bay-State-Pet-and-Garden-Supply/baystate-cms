/**
 * Product-line group determiner for internal Curation substage.
 *
 * Groups items from the same batch by normalized brand + name stem so that
 * sibling products (e.g. same brand + product with different sizes/flavors)
 * can be consolidated together for more consistent naming.
 *
 * This is DETERMINISTIC only — no LLM calls. Grouping is internal context,
 * not a reviewable proposal.
 */
import type { OnboardingItem } from '../shared/schemas/onboarding';
import {
  splitAttachedSizeTokens,
  expandAbbreviations,
} from './product-line-token-normalizer';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductGroup {
  groupId: string;
  groupLabel: string;
  normalizedBrand: string;
  normalizedName: string;
  siblingNames: string[];
  siblingWebTitles: string[];
  siblingOcrTitles: string[];
  siblingSkus: string[];
  sizeVariantCount: number;
  flavorVariantCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Suffixes to strip from brand names during normalization */
const BRAND_SUFFIXES = /\b(inc|llc|ltd|limited|co|company|brands|group|corporation|corp)\b\.?$/i;

/** Trademark / registered / superscript chars to strip */
const BRAND_JUNK = /[®™©℠℗[\]{}()'"]/g;

/** Size/weight/count patterns to remove from name stem */
const SIZE_PATTERNS = /\b(\d+(?:\.\d+)?\s*(?:lb|lbs|oz|kg|g|ml|l|gal|count|ct|pk|pack|pound|ounce)s?\.?)\b/gi;

/** Size adjectives to remove from name stem */
const SIZE_ADJECTIVES = /\b(small|medium|large|x[\s-]?large|giant|jumbo|mini|teeny|petite|standard|trial|value|economy|bulk|multi[\s-]?pack|variety[\s-]?pack|assorted|sm|lg|xl|x[\s-]?l|md|xs|xxl|xx[\s-]?large|pk|ct|oz|lb|kg|ml|gal|count)\b/gi;

/**
 * Attached size/count/color suffixes that trail a word without a space.
 * Must be pre-normalised before the stem is computed so siblings with
 * different attached variant tokens produce the same stem.
 * Examples: SM5CT (Small 5 Count), MD2CT (Medium 2 Count), 2.64OZ (2.64 oz),
 * FLYBALLYELLOW (flyball + yellow), FLYBALLLAVENDER (flyball + lavender).
 *
 * The ATTACHED_SIZE_COUNT pattern handles forms like SM5CT, MD2CT wherever
 * they appear (not just end-of-string) since they can occur mid-name.
 */
const ATTACHED_SIZE_COUNT = /(?:sm|md|lg|xl|xs)(?:\d+)(?:pk|ct|oz|lb|g|kg|ml|gal)/gi;
const ATTACHED_COLOR = /(yellow|lavender|orange|green|blue|red|pink|purple|black|white|brown|tan)$/i;

/** Standalone word-boundary color tokens to strip from name stem */
const STANDALONE_COLORS = /\b(yellow|lavender|orange|green|blue|red|pink|purple|black|white|brown|tan)\b/gi;

/** Flavor/variant words to remove from name stem */
const FLAVOR_WORDS = /\b(chicken|chkn|ckn|beef|salmon|slmn|lamb|turkey|trky|duck|fish|tuna|shrimp|pork|venison|rabbit|bison|whitefish|ocean\s*fish|mixed|variety|assortment|medley|combo|blend|recipe|formula|adult|puppy|kitten|senior|all[\s-]?life[\s-]?stage)\b/gi;

/** Common suffixes to strip from name stem */
const NAME_SUFFIXES = /\b(for\s+(dogs|cats|pets?|adults?|seniors?|puppies?|kittens?))\b/gi;

const SIZE_VARIANT_KEYWORDS = /\d+\s*(lb|lbs|oz|kg|g|ml|l|gal|count|ct|pk|pack|pound|ounce)/i;
const FLAVOR_VARIANT_KEYWORDS = /\b(chicken|beef|salmon|lamb|turkey|duck|fish|tuna|flavor|variety)\b/i;

// ─── Brand detection (epic #46 review round, Package A) ───────────────────────

/**
 * Fallback known brands used when `brandHint` is empty: the brand is often
 * visibly embedded in the all-caps distributor name ("BETTER BONE HARD VNSN
 * SM") but the spreadsheet brand column is empty for some rows. Prefix
 * matching is anchored to the NAME START and compares compact (space-
 * stripped) forms, so "BetterBone" and "Better Bone" are the same brand.
 */
export const DEFAULT_KNOWN_BRANDS: string[] = [
  'Better Bone',
  'Fromm',
  'Wellness',
  'Inaba',
  'Churu',
  'Three Dog Bakery',
  'Old Mother Hubbard',
  'Instinct',
  "Butcher's",
  'Butchers',
  'Little Giant',
  'PetArmor',
  'Tiki',
  'Purina',
  'Blue Buffalo',
  'Dr. Marty',
  'Acme',
];

/**
 * Compact brand comparison key: lowercase, junk/suffix-stripped, no spaces.
 * "BetterBone" and "Better Bone" both collapse to "betterbone".
 */
export function compactBrandKey(brand: string | null | undefined): string {
  return normalizeBrand(brand).replace(/\s+/g, '');
}

/**
 * Detect a known brand at the START of a product name (case-insensitive,
 * compact comparison, longest match wins). Returns the matched known-brand
 * spelling or null when no known brand prefixes the name. Never invents
 * arbitrary first words as brands.
 */
export function brandFromNamePrefix(name: string | null | undefined, knownBrands: string[]): string | null {
  if (!name) return null;
  const strippedName = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  let best: string | null = null;
  for (const known of knownBrands) {
    const key = known.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key || key.length < 4) continue;
    if (strippedName.startsWith(key) && (best === null || key.length > best.length)) {
      best = known;
    }
  }
  return best;
}

/**
 * Effective brand for grouping: the explicit brandHint when present,
 * otherwise a known-brand name-prefix match, otherwise '' (no-brand).
 */
export function effectiveBrandFor(
  item: Pick<OnboardingItem, 'brandHint' | 'name'>,
  knownBrands: string[],
): string {
  if (item.brandHint) return item.brandHint;
  return brandFromNamePrefix(item.name, knownBrands) ?? '';
}

/**
 * Unique known-brand candidates for a batch: explicit brandHints first
 * (within-batch propagation — if ANY sibling carries the brand, its compact
 * form is used to recognize brand-embedded names), then the built-in list.
 */
export function knownBrandsForBatch(batchItems: OnboardingItem[]): string[] {
  const fromBatch = batchItems.map(i => i.brandHint).filter((b): b is string => Boolean(b));
  return [...new Set([...fromBatch, ...DEFAULT_KNOWN_BRANDS])];
}

// ─── Normalization Helpers ─────────────────────────────────────────────────────

/**
 * Normalize a brand name for comparison: lowercase, strip junk, strip common suffixes.
 */
export function normalizeBrand(brand: string | null | undefined): string {
  if (!brand) return '';
  return brand
    .toLowerCase()
    .replace(BRAND_JUNK, '')
    .replace(BRAND_SUFFIXES, '')
    .trim();
}

/**
 * Extract the canonical name stem from a product name by stripping
 * sizes, flavors, suffixes, and normalizing whitespace.
 *
 * Order (epic #46 Package A): attached size tokens are split on the RAW
 * name first (case-aware — distributor names are ALL-CAPS), then lowercase,
 * then the existing size/count/color patterns, then abbreviation expansion
 * so abbreviated flavors (vnsn → venison) hit `FLAVOR_WORDS`.
 */
export function extractNameStem(name: string | null | undefined): string {
  if (!name) return '';
  return splitAttachedSizeTokens(name)
    .toLowerCase()
    // Pre-strip attached size/count suffixes (e.g. SM5CT, MD2CT, LG, XL) and
    // trailing color tokens so siblings with different variants share a stem.
    .replace(ATTACHED_SIZE_COUNT, '')
    .replace(ATTACHED_COLOR, '')
    .replace(STANDALONE_COLORS, '')
    .replace(SIZE_PATTERNS, '')
    .replace(SIZE_ADJECTIVES, '')
    .replace(/[a-z]+/g, expandAbbreviations)
    .replace(FLAVOR_WORDS, '')
    .replace(NAME_SUFFIXES, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

/**
 * Determine the product line group for a given item within its batch.
 *
 * Scans all items in the same batch, normalizes brand and name stem,
 * and groups items that share the same brand + name stem combination.
 *
 * @param item - The current onboarding item being curated
 * @param batchItems - All onboarding items in the same batch
 * @returns ProductGroup if siblings found, null if product stands alone
 */
export function determineProductGroup(
  item: OnboardingItem,
  batchItems: OnboardingItem[],
): ProductGroup | null {
  if (!item.name && !item.brandHint) return null;

  const knownBrands = knownBrandsForBatch(batchItems);
  // Epic #46 Package A: brandHint OR name-embedded known-brand prefix; the
  // comparison uses the COMPACT key so "BetterBone" and "Better Bone" are
  // the same family.
  const itemBrand = compactBrandKey(effectiveBrandFor(item, knownBrands));
  const itemStem = extractNameStem(item.name || '');

  if (!itemStem) return null;

  // Find siblings: same brand + same name stem, different SKU or name
  const siblings = batchItems.filter(sibling => {
    if (sibling.id === item.id) return false;
    if (!sibling.name) return false;

    const siblingBrand = compactBrandKey(effectiveBrandFor(sibling, knownBrands));
    const siblingStem = extractNameStem(sibling.name);

    // Must share same brand (or both have no brand)
    if (itemBrand !== siblingBrand) return false;

    // Must share same name stem
    if (!siblingStem || siblingStem !== itemStem) return false;

    return true;
  });

  if (siblings.length === 0) return null;

  // Build group metadata
  const allSiblings = [item, ...siblings];
  const groupLabel = siblings[0]?.name || item.name || 'Unknown Product Line';
  const siblingNames = allSiblings.map(s => s.name).filter(Boolean) as string[];
  const siblingWebTitles = allSiblings
    .map(s => s.extractionData?.title)
    .filter(Boolean) as string[];
  const siblingOcrTitles = allSiblings
    .map(s => s.extractionData?.packagingOcrData?.productName)
    .filter((t): t is string => t != null && t.length > 0);
  const siblingSkus = allSiblings.map(s => s.upc).filter(Boolean) as string[];

  // Count variant types heuristically
  const names = allSiblings.map(s => (s.name || '').toLowerCase());
  const sizeVariants = names.filter(n => SIZE_VARIANT_KEYWORDS.test(n)).length;
  const flavorVariants = names.filter(n => FLAVOR_VARIANT_KEYWORDS.test(n)).length;

  const groupId = `group-${itemBrand || 'no-brand'}-${itemStem.slice(0, 40).replace(/\s+/g, '-')}`;

  return {
    groupId,
    groupLabel: groupLabel.slice(0, 100),
    normalizedBrand: itemBrand,
    normalizedName: itemStem,
    siblingNames,
    siblingWebTitles,
    siblingOcrTitles,
    siblingSkus,
    sizeVariantCount: sizeVariants,
    flavorVariantCount: flavorVariants,
  };
}
