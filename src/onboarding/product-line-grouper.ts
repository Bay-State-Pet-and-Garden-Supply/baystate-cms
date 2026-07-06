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
const BRAND_JUNK = /[®™©℠℗\[\]{}()'"]/g;

/** Size/weight/count patterns to remove from name stem */
const SIZE_PATTERNS = /\b(\d+(?:\.\d+)?\s*(?:lb|lbs|oz|kg|g|ml|l|gal|count|ct|pk|pack|pound|ounce)s?\.?)\b/gi;

/** Size adjectives to remove from name stem */
const SIZE_ADJECTIVES = /\b(small|medium|large|x[\s-]?large|giant|jumbo|mini|teeny|petite|standard|trial|value|economy|bulk|multi[\s-]?pack|variety[\s-]?pack|assorted|sm|lg|xl|x[\s-]?l|md|xs|xxl|xx[\s-]?large|pk|ct|oz|lb|kg|ml|gal|count)\b/gi;

/** Flavor/variant words to remove from name stem */
const FLAVOR_WORDS = /\b(chicken|beef|salmon|lamb|turkey|duck|fish|tuna|shrimp|pork|venison|rabbit|bison|whitefish|ocean\s*fish|mixed|variety|assortment|medley|combo|blend|recipe|formula|adult|puppy|kitten|senior|all[\s-]?life[\s-]?stage)\b/gi;

/** Common suffixes to strip from name stem */
const NAME_SUFFIXES = /\b(for\s+(dogs|cats|pets?|adults?|seniors?|puppies?|kittens?))\b/gi;

const SIZE_VARIANT_KEYWORDS = /\d+\s*(lb|lbs|oz|kg|g|ml|l|gal|count|ct|pk|pack|pound|ounce)/i;
const FLAVOR_VARIANT_KEYWORDS = /\b(chicken|beef|salmon|lamb|turkey|duck|fish|tuna|flavor|variety)\b/i;

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
 */
export function extractNameStem(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(SIZE_PATTERNS, '')
    .replace(SIZE_ADJECTIVES, '')
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

  const itemBrand = normalizeBrand(item.brandHint);
  const itemStem = extractNameStem(item.name || '');

  if (!itemStem) return null;

  // Find siblings: same brand + same name stem, different SKU or name
  const siblings = batchItems.filter(sibling => {
    if (sibling.id === item.id) return false;
    if (!sibling.name) return false;

    const siblingBrand = normalizeBrand(sibling.brandHint);
    const siblingStem = extractNameStem(sibling.name);

    // Must share same brand (or both have no brand)
    if (itemBrand && siblingBrand && itemBrand !== siblingBrand) return false;
    if (!itemBrand && siblingBrand) return false;
    if (itemBrand && !siblingBrand) return false;

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
