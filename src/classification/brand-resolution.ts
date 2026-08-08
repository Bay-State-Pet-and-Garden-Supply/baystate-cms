/**
 * Deterministic brand resolver for the curation pipeline.
 *
 * Resolves free-text brand strings to canonical brand IDs using:
 * 1. Exact canonical name match (case-insensitive)
 * 2. Alias match (case-insensitive)
 * 3. Longest-prefix match against the start of the input brand string
 *
 * This is purely deterministic — no LLM calls.
 */
import { matchExistingBrand } from '../shared/brand-matcher';
import type { BrandConfig } from '../shared/schemas/classification';

export interface BrandResolution {
  /** Canonical brand ID */
  brandId: string;
  /** Canonical brand display name */
  brandName: string;
  /** Confidence: 1.0 for exact/alias, 0.8 for prefix match */
  confidence: number;
  /** How the match was made */
  matchedBy: 'exact' | 'alias' | 'prefix';
}

/**
 * Resolve a free-text brand string to a canonical brand using deterministic matching.
 *
 * @param inputBrand - Free-text brand string (e.g. from spreadsheet, web scrape, OCR)
 * @param brands - Array of configured canonical brands with aliases
 * @returns Resolved brand info, or null if no match
 */
export function resolveBrand(inputBrand: string, brands: BrandConfig[]): BrandResolution | null {
  if (!inputBrand || inputBrand.trim().length === 0) return null;
  if (brands.length === 0) return null;

  const cleanInput = inputBrand.trim();

  // 1. Exact canonical name match (case-insensitive)
  for (const brand of brands) {
    if (brand.name.toLowerCase() === cleanInput.toLowerCase()) {
      return {
        brandId: brand.id,
        brandName: brand.name,
        confidence: 1.0,
        matchedBy: 'exact',
      };
    }
  }

  // 2. Alias match (case-insensitive)
  for (const brand of brands) {
    for (const alias of brand.aliases) {
      if (alias.toLowerCase() === cleanInput.toLowerCase()) {
        return {
          brandId: brand.id,
          brandName: brand.name,
          confidence: 1.0,
          matchedBy: 'alias',
        };
      }
    }
  }

  // 3. Longest-prefix match against canonical names and aliases
  const candidateList: { brand: BrandConfig; candidateName: string }[] = [];
  for (const brand of brands) {
    candidateList.push({ brand, candidateName: brand.name });
    for (const alias of brand.aliases) {
      candidateList.push({ brand, candidateName: alias });
    }
  }

  const matchedCandidateName = matchExistingBrand(
    cleanInput,
    candidateList.map((c) => c.candidateName),
  );

  if (matchedCandidateName) {
    const entry = candidateList.find(
      (c) => c.candidateName.trim().toLowerCase() === matchedCandidateName.trim().toLowerCase(),
    );
    if (entry) {
      return {
        brandId: entry.brand.id,
        brandName: entry.brand.name,
        confidence: 0.8,
        matchedBy: 'prefix',
      };
    }
  }

  return null;
}
