/**
 * Catalog Product Source Adapter
 *
 * Maps a Product object from the Git workspace into the normalized
 * evidence input structure used by the shared evidence extractor.
 * Also computes a deterministic product hash for drift detection.
 */
import { hashCanonicalJson } from '../shared/stable-id';
import type { Product } from '../shared/types';
import type { NormalizedEvidenceInput } from './product-evidence-extractor';
import type { PageRow } from '../db/repositories/page-repo';
import { parseProductOnPages } from '../shopsite/product-page-assignments';

export interface CatalogProductSource {
  productHash: string;
  normalizedInput: NormalizedEvidenceInput;
  existingPages: Array<{ pageId: string; pageName: string }>;
}

/**
 * Build a normalized evidence input from a Product object.
 *
 * Maps:
 * - title: product.core.name
 * - description: product.core.description
 * - brand: product.customFields['ProductField16'] (or first found brand-like field)
 * - weight: product.core.weight
 * - customFields: product.customFields
 * - primaryImage: product.core.media.primary
 * - additionalImages: product.core.media.additional
 * - searchKeywords: product.core.seo?.searchKeywords
 *
 * Page context comes ONLY from the product's own preserved ProductOnPages
 * observations — never from the store-wide page index. Name-only rows are
 * review context, not verified identities.
 */
export function buildCatalogProductEvidenceInput(
  product: Product,
  workspacePath: string,
  _pages?: PageRow[],
): CatalogProductSource {
  // Compute a deterministic hash of classification-relevant fields
  const productHash = computeProductHash(product);

  // Resolve the product's OWN page observations (name-only review context).
  const ownPageNames = parseProductOnPages(product.shopsite?.preserved);
  const existingPages = ownPageNames.map(pageName => ({ pageId: pageName, pageName }));
  const existingPageNames = existingPages.map(p => p.pageName);

  // Brand: check common custom field locations
  const brand = product.customFields?.['ProductField16']
    ?? product.customFields?.Brand
    ?? product.customFields?.brand
    ?? null;

  // Build bullet points from description (split on newlines/sentences if long)
  const bulletPoints: string[] = [];
  if (product.core.description) {
    // Use first 500 chars as a single bullet from description
    bulletPoints.push(product.core.description.slice(0, 500));
  }

  const normalizedInput: NormalizedEvidenceInput = {
    title: product.core.name ?? null,
    description: product.core.description ?? null,
    brand,
    weight: product.core.weight ?? null,
    bulletPoints,
    searchKeywords: product.core.seo?.searchKeywords ?? null,
    customFields: product.customFields ?? {},
    primaryImage: product.core.media?.primary ?? null,
    additionalImages: product.core.media?.additional ?? [],
    sourceUrl: null, // No source URL for catalog products
    existingPageNames,
    workspacePath,
  };

  return { productHash, normalizedInput, existingPages };
}

/**
 * Compute a deterministic canonical hash of every product field relevant to
 * classification, INCLUDING search keywords and the product's own Page names.
 * This is used for drift detection at apply time; the same function runs on
 * both sides of the comparison.
 */
export function computeProductHash(product: Product): string {
  return hashCanonicalJson({
    name: product.core.name,
    description: product.core.description,
    weight: product.core.weight,
    customFields: product.customFields,
    primaryImage: product.core.media?.primary,
    additionalImages: product.core.media?.additional,
    searchKeywords: product.core.seo?.searchKeywords,
    productPageNames: parseProductOnPages(product.shopsite?.preserved),
  });
}
