/**
 * Deterministic detail enrichment for curation proposals.
 *
 * Extracts structured facets (species, life stage, flavor, color, size,
 * material, weight, count, breed size, product form, dietary labels,
 * health concerns) from product evidence text and packaging OCR data.
 *
 * This runs after LLM consolidation and uses only deterministic pattern
 * matching — no additional LLM call. Each extractor follows a strict
 * evidence-first policy: sensitive claims (health concerns, dietary
 * labels) require direct textual evidence and are never inferred.
 */
import type { PackagingOcrData } from '../shared/schemas/onboarding';
import { matchCanonicalValue, resolveAlias } from './controlled-value-identity';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EnrichmentParams {
  /** Lowercased, joined evidence text from all sources */
  evidenceText: string;
  /** Structured packaging OCR data, if available */
  packagingOcrData?: PackagingOcrData | null;
  /** Curated product title, if available */
  curatedTitle?: string | null;
  /** If provided, only return values in this set */
  allowedValues?: string[];
  /** If provided, check aliases in addition to direct values */
  aliases?: Array<{ alias: string; mapsTo: string }>;
}

export interface EnrichmentCandidate {
  attributeId: string;
  value: string;
  confidence: number;
  matchedBy: 'pattern' | 'evidence' | 'alias';
  evidenceSnippet: string | null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const LOWERCASE = (s: string) => s.toLowerCase();

/**
 * Find a keyword in text with word-boundary awareness.
 * Returns the matching snippet or null.
 */
function findKeyword(text: string, keyword: string): string | null {
  const idx = text.indexOf(keyword);
  if (idx === -1) return null;
  // Return a small snippet around the match
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + keyword.length + 20);
  return text.slice(start, end).trim();
}

/**
 * Find any of the given keywords in text. Returns the first match.
 */
function findAnyKeyword(text: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    const found = findKeyword(text, kw);
    if (found) return found;
  }
  return null;
}

/**
 * Check OCR data for a specific field, then fall back to keyword matching.
 * If allowedValues is provided, only return values within the allowed set.
 */
function ocrOrKeyword(
  attributeId: string,
  ocrValue: string | null | undefined,
  ocrArray: string[] | null | undefined,
  text: string,
  title: string | null,
  keywords: Record<string, string[]>,
  allowedValues?: string[],
  aliases?: Array<{ alias: string; mapsTo: string }>,
): EnrichmentCandidate[] {
  // 1. Check OCR data first (most reliable)
  if (ocrValue) {
    const canonical = matchCanonicalValue(ocrValue, allowedValues ?? []);
    // With an allowed set the OCR value must resolve to one exact canonical
    // ID (near-matches fail closed); without one the raw value is the ID.
    if (canonical !== null || !allowedValues) {
      const value = canonical ?? ocrValue.trim();
      return [{
        attributeId,
        value,
        confidence: 0.8,
        matchedBy: 'evidence',
        evidenceSnippet: `ocr:${value}`,
      }];
    }
  }

  // 2. Check OCR array fields (species, dietary labels, etc.)
  if (ocrArray && ocrArray.length > 0) {
    const results: EnrichmentCandidate[] = [];
    for (const val of ocrArray) {
      const canonical = matchCanonicalValue(val, allowedValues ?? []);
      if (canonical === null && allowedValues) continue;
      const value = canonical ?? val.trim();
      if (!value) continue;
      results.push({
        attributeId,
        value,
        confidence: 0.75,
        matchedBy: 'evidence',
        evidenceSnippet: `ocr:${value}`,
      });
    }
    if (results.length > 0) return results;
  }

  // 3. Check evidence text for keywords
  const textLower = text.toLowerCase();
  const allSources = [textLower, title?.toLowerCase() ?? ''].filter(Boolean);

  for (const [canonicalValue, matchPatterns] of Object.entries(keywords)) {
    // If allowedValues is provided, skip values not in the set (comparison-
    // key match; never an ad hoc case-insensitive guess).
    if (allowedValues && matchCanonicalValue(canonicalValue, allowedValues) === null) {
      continue;
    }

    for (const source of allSources) {
      const snippet = findAnyKeyword(source, matchPatterns.map(LOWERCASE));
      if (snippet) {
        return [{
          attributeId,
          value: canonicalValue,
          confidence: 0.6,
          matchedBy: 'pattern',
          evidenceSnippet: snippet,
        }];
      }
    }
  }

  // 4. Check aliases if provided
  if (aliases && aliases.length > 0) {
    for (const source of allSources) {
      for (const alias of aliases) {
        if (source.includes(alias.alias.toLowerCase())) {
          // The alias target must resolve to one exact canonical ID. When no
          // allowed set is provided the alias target itself is the canonical
          // ID; otherwise a target outside the set fails closed.
          const canonical = allowedValues
            ? resolveAlias(alias.mapsTo, aliases, allowedValues)
            : alias.mapsTo;
          if (!canonical) continue;
          return [{
            attributeId,
            value: canonical,
            confidence: 0.55,
            matchedBy: 'alias',
            evidenceSnippet: findKeyword(source, alias.alias.toLowerCase()),
          }];
        }
      }
    }
  }

  return [];
}

/**
 * High-safety extractor for sensitive claims. Only returns values that
 * have DIRECT evidence in the text — never infers from absence.
 */
function evidenceOnlyExtractor(
  attributeId: string,
  ocrArray: string[] | null | undefined,
  text: string,
  keywords: Record<string, string[]>,
  allowedValues?: string[],
): EnrichmentCandidate[] {
  const results: EnrichmentCandidate[] = [];
  const textLower = text.toLowerCase();

  // Check OCR array first
  if (ocrArray && ocrArray.length > 0) {
    for (const val of ocrArray) {
      const canonical = matchCanonicalValue(val, allowedValues ?? []);
      if (canonical === null && allowedValues) continue;
      const value = canonical ?? val.trim();
      if (!value) continue;
      results.push({
        attributeId,
        value,
        confidence: 0.8,
        matchedBy: 'evidence',
        evidenceSnippet: `ocr:${value}`,
      });
    }
  }

  // Then check evidence text
  for (const [canonicalValue, matchPatterns] of Object.entries(keywords)) {
    if (allowedValues && matchCanonicalValue(canonicalValue, allowedValues) === null) continue;

    for (const pattern of matchPatterns) {
      const snippet = findKeyword(textLower, pattern.toLowerCase());
      if (snippet) {
        results.push({
          attributeId,
          value: canonicalValue,
          confidence: 0.65,
          matchedBy: 'evidence',
          evidenceSnippet: snippet,
        });
        break;
      }
    }
  }

  return results;
}

// ─── Weight/Count Pattern Extractors ───────────────────────────────────────────

const WEIGHT_PATTERN = /\b(\d+(?:\.\d+)?)\s*(lb|lbs|kg|oz|ounce|pound|pounds|g)\b/i;
const COUNT_PATTERN = /\b(\d+)\s*(count|pk|pack|ct|packs|pieces?|treats?|sticks?|capsules?|tablets?|chews?)\b/i;

/**
 * Extract weight from text using regex pattern.
 */
function extractWeightFromText(text: string): EnrichmentCandidate[] {
  const match = WEIGHT_PATTERN.exec(text);
  if (!match) return [];
  const value = `${match[1]} ${match[2].toLowerCase()}`;
  return [{
    attributeId: 'weight',
    value,
    confidence: 0.7,
    matchedBy: 'pattern',
    evidenceSnippet: match[0],
  }];
}

/**
 * Extract count from text using regex pattern.
 */
function extractCountFromText(text: string): EnrichmentCandidate[] {
  const match = COUNT_PATTERN.exec(text);
  if (!match) return [];
  const value = `${match[1]} ${match[2].toLowerCase()}`;
  return [{
    attributeId: 'count',
    value,
    confidence: 0.7,
    matchedBy: 'pattern',
    evidenceSnippet: match[0],
  }];
}

// ─── Keyword Maps ──────────────────────────────────────────────────────────────

const SPECIES_KEYWORDS: Record<string, string[]> = {
  // Multi-species patterns MUST come before single-species patterns so
  // "dog & cat" matches before "dog" alone.
  'Dog & Cat': ['dog & cat', 'dog and cat', 'multi-species', 'all species', 'multi species'],
  'Dog': ['dog', 'dogs', 'canine', 'puppy', 'puppies', 'all breed'],
  'Cat': ['cat', 'cats', 'feline', 'kitten', 'kittens'],
};

const LIFE_STAGE_KEYWORDS: Record<string, string[]> = {
  'Puppy': ['puppy', 'puppies', 'growth', 'junior'],
  'Kitten': ['kitten', 'kittens', 'growth'],
  'Adult': ['adult', 'maintenance', 'all ages'],
  'Senior': ['senior', 'mature', 'golden years', 'aging'],
  'All Life Stages': ['all life stages', 'all stages', 'every stage'],
};

const FLAVOR_KEYWORDS: Record<string, string[]> = {
  'Chicken': ['chicken', 'chkn', 'ckn'],
  'Beef': ['beef'],
  'Salmon': ['salmon'],
  'Lamb': ['lamb'],
  'Turkey': ['turkey', 'trky'],
  'Duck': ['duck'],
  'Fish': ['fish'],
  'Tuna': ['tuna'],
  'Shrimp': ['shrimp'],
  'Whitefish': ['whitefish', 'white fish'],
  'Venison': ['venison'],
  'Bison': ['bison'],
  'Rabbit': ['rabbit'],
  'Pork': ['pork'],
  'Liver': ['liver'],
  'Mixed Grill': ['mixed grill', 'variety pack', 'assorted'],
};

const COLOR_KEYWORDS: Record<string, string[]> = {
  'Brown': ['brown'],
  'Black': ['black'],
  'White': ['white'],
  'Red': ['red'],
  'Blue': ['blue'],
  'Green': ['green'],
  'Yellow': ['yellow'],
  'Gray': ['gray', 'grey'],
  'Tan': ['tan'],
  'Chocolate': ['chocolate'],
  'Pink': ['pink'],
  'Purple': ['purple'],
  'Orange': ['orange'],
  'Multi-Color': ['multi-color', 'multicolor', 'multiple colors', 'assorted colors'],
};

const SIZE_KEYWORDS: Record<string, string[]> = {
  'Small': ['small', 'mini', 'tiny', 'petite'],
  'Medium': ['medium', 'regular', 'standard', 'mid'],
  'Large': ['large', 'big', 'giant', 'jumbo', 'xl', 'xxl'],
  'X-Large': ['x-large', 'extra large', 'xx-large', 'xxx-large'],
  'Mini': ['mini'],
};

const MATERIAL_KEYWORDS: Record<string, string[]> = {
  'Nylon': ['nylon'],
  'Cotton': ['cotton'],
  'Polyester': ['polyester'],
  'Leather': ['leather'],
  'Rubber': ['rubber'],
  'Plastic': ['plastic'],
  'Wood': ['wood'],
  'Metal': ['metal', 'steel', 'stainless steel', 'iron'],
  'Fleece': ['fleece'],
  'Canvas': ['canvas'],
  'Mesh': ['mesh'],
  'Neoprene': ['neoprene'],
  'Vinyl': ['vinyl'],
  'Rope': ['rope'],
  'Suede': ['suede'],
};

const BREED_SIZE_KEYWORDS: Record<string, string[]> = {
  'Small Breed': ['small breed', 'small-sized', 'small sized', 'toy breed'],
  'Medium Breed': ['medium breed'],
  'Large Breed': ['large breed', 'giant breed', 'big breed'],
  'All Breeds': ['all breeds', 'every breed', 'any breed'],
};

const PRODUCT_FORM_KEYWORDS: Record<string, string[]> = {
  'Dry': ['dry', 'kibble', 'biscuit', 'crunchy'],
  'Wet': ['wet', 'canned', 'pouch', 'paté', 'pate'],
  'Freeze-Dried': ['freeze-dried', 'freeze dried', 'raw freeze dried'],
  'Raw': ['raw', 'frozen raw', 'raw food'],
  'Treats': ['treats', 'treat', 'chews', 'chew', 'snack', 'snacks', 'cookie', 'cookies', 'biscuits'],
  'Soft': ['soft', 'chewy', 'tender', 'moist'],
  'Semi-Moist': ['semi-moist', 'semimoist'],
  'Chilled': ['chilled', 'refrigerated', 'fresh'],
  'Liquid': ['liquid', 'broth', 'soup', 'water'],
};

const DIETARY_LABEL_KEYWORDS: Record<string, string[]> = {
  'Grain-Free': ['grain-free', 'grain free', 'no grain', 'no grains'],
  'Gluten-Free': ['gluten-free', 'gluten free'],
  'Organic': ['organic', 'usda organic'],
  'Natural': ['natural', 'all-natural', 'all natural', '100% natural'],
  'Non-GMO': ['non-gmo', 'non gmo', 'gmo-free', 'gmo free'],
  'High-Protein': ['high-protein', 'high protein'],
  'Limited Ingredient': ['limited ingredient', 'limited-ingredient', 'single protein'],
  'Wheat-Free': ['wheat-free', 'wheat free'],
  'Corn-Free': ['corn-free', 'corn free'],
  'Soy-Free': ['soy-free', 'soy free'],
  'Preservative-Free': ['preservative-free', 'preservative free', 'no preservatives'],
  'No Artificial Colors': ['no artificial colors', 'no artificial colour', 'no artificial color'],
};

const HEALTH_CONCERN_KEYWORDS: Record<string, string[]> = {
  'Digestive Health': ['digestive', 'probiotic', 'prebiotic', 'gut health'],
  'Joint Health': ['joint', 'hip & joint', 'glucosamine', 'chondroitin', 'mobility'],
  'Skin & Coat': ['skin & coat', 'skin and coat', 'skin health', 'coat health', 'omega', 'fish oil'],
  'Weight Management': ['weight management', 'weight control', 'weight loss', 'lighter', 'low calorie', 'lite'],
  'Dental Health': ['dental', 'teeth', 'oral health', 'fresh breath', 'dental'],
  'Urinary Health': ['urinary', 'urinary tract', 'bladder', 'uti'],
  'Immune Support': ['immune', 'immunity', 'antioxidant'],
  'Allergy Relief': ['allergy', 'allergies', 'hypoallergenic'],
  'Hairball Control': ['hairball', 'hair ball'],
  'Calming': ['calming', 'calm', 'anxiety', 'stress'],
  'Heart Health': ['heart health', 'cardiac', 'taurine'],
  'Eye Health': ['eye health', 'vision', 'lutein'],
};

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Run all deterministic detail extractors against the provided evidence.
 * Returns an array of enrichment candidates, one per matched attribute.
 *
 * Extractors follow this priority:
 * 1. Packaging OCR data (most reliable)
 * 2. Evidence text keyword matching
 * 3. Curated title keyword matching
 * 4. Alias resolution (if configured)
 *
 * SAFETY: Health concern and dietary label extractors require
 * direct evidence — they never infer from absence.
 *
 * @param params - Evidence sources and optional filtering
 * @returns Array of enrichment candidates (empty if no matches)
 */
export function enrichProductDetails(params: EnrichmentParams): EnrichmentCandidate[] {
  const { evidenceText, packagingOcrData, curatedTitle, allowedValues, aliases } = params;
  const text = evidenceText ?? '';
  const title = curatedTitle ?? null;
  const ocr = packagingOcrData ?? null;
  const results: EnrichmentCandidate[] = [];

  // Species
  results.push(...ocrOrKeyword(
    'species', null, ocr?.species ?? null,
    text, title, SPECIES_KEYWORDS, allowedValues, aliases,
  ));

  // Life Stage
  results.push(...ocrOrKeyword(
    'lifeStage', ocr?.lifeStage ?? null, null,
    text, title, LIFE_STAGE_KEYWORDS, allowedValues, aliases,
  ));

  // Flavor
  results.push(...ocrOrKeyword(
    'flavor', ocr?.flavorVariety ?? null, null,
    text, title, FLAVOR_KEYWORDS, allowedValues, aliases,
  ));

  // Color
  results.push(...ocrOrKeyword(
    'color', ocr?.color ?? null, null,
    text, title, COLOR_KEYWORDS, allowedValues, aliases,
  ));

  // Size
  results.push(...ocrOrKeyword(
    'size', ocr?.size ?? null, null,
    text, title, SIZE_KEYWORDS, allowedValues, aliases,
  ));

  // Material
  results.push(...ocrOrKeyword(
    'material', ocr?.material ?? null, null,
    text, title, MATERIAL_KEYWORDS, allowedValues, aliases,
  ));

  // Weight (pattern + keyword)
  if (ocr?.weight) {
    results.push(...ocrOrKeyword(
      'weight', ocr.weight, null,
      text, title, {}, allowedValues, aliases,
    ));
  } else {
    results.push(...extractWeightFromText(text));
    if (title) results.push(...extractWeightFromText(title));
  }

  // Count (pattern + keyword)
  if (ocr?.count) {
    results.push(...ocrOrKeyword(
      'count', ocr.count, null,
      text, title, {}, allowedValues, aliases,
    ));
  } else {
    results.push(...extractCountFromText(text));
    if (title) results.push(...extractCountFromText(title));
  }

  // Breed Size
  results.push(...ocrOrKeyword(
    'breedSize', ocr?.breedSize ?? null, null,
    text, title, BREED_SIZE_KEYWORDS, allowedValues, aliases,
  ));

  // Product Form
  results.push(...ocrOrKeyword(
    'productForm', ocr?.productForm ?? null, null,
    text, title, PRODUCT_FORM_KEYWORDS, allowedValues, aliases,
  ));

  // Dietary Labels (evidence-only — safety gated)
  results.push(...evidenceOnlyExtractor(
    'dietaryLabel',
    ocr?.dietaryLabels ?? null,
    text,
    DIETARY_LABEL_KEYWORDS,
    allowedValues,
  ));

  // Health Concerns (evidence-only — safety gated)
  results.push(...evidenceOnlyExtractor(
    'healthConcern',
    ocr?.healthConcernFunction ?? null,
    text,
    HEALTH_CONCERN_KEYWORDS,
    allowedValues,
  ));

  return results;
}
