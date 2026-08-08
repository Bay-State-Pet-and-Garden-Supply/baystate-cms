import { type ScrapedProductEvidence, ScrapedProductEvidenceSchema } from '../corpus-schema.js';
import { computeEntityId } from '../url-policy.js';

export interface OpenPetFoodFactsProductResponse {
  status: number;
  status_verbose: string;
  product?: {
    product_name?: string;
    generic_name?: string;
    brands?: string;
    code?: string;
    categories_tags?: string[];
    categories_hierarchy?: string[];
    ingredients_text?: string;
    ingredients_text_en?: string;
    serving_size?: string;
    quantity?: string;
    image_url?: string;
    image_front_url?: string;
    targeted_species?: string;
    labels_tags?: string[];
    nutriments?: Record<string, unknown>;
  };
}

/**
 * Fetches product metadata from Open Pet Food Facts API using GTIN/UPC barcode.
 * Open Pet Food Facts is licensed under ODbL and free to use ($0 cost).
 */
export async function fetchOpenPetFoodFactsByGtin(
  gtin: string,
  fetchFn: typeof fetch = fetch
): Promise<ScrapedProductEvidence | null> {
  const cleanGtin = gtin.trim().replace(/[^0-9]/g, '');
  if (!cleanGtin) return null;

  const variants = Array.from(
    new Set([cleanGtin, cleanGtin.replace(/^0+/, ''), cleanGtin.padStart(13, '0'), cleanGtin.padStart(12, '0')])
  ).filter(Boolean);

  for (const variant of variants) {
    const url = `https://world.openpetfoodfacts.org/api/v0/product/${variant}.json`;
    try {
      const res = await fetchFn(url, {
        headers: {
          'User-Agent': 'BaystateCMS-Importer/1.0 (https://baystatecms.local; support@baystate.local)',
        },
      });

      if (!res.ok) continue;

      const data = (await res.json()) as OpenPetFoodFactsProductResponse;
      if (data.status !== 1 || !data.product) {
        continue;
      }

      const p = data.product;
      const title = (p.product_name || p.generic_name || '').trim();
      if (!title) continue;

      const brand = p.brands ? p.brands.split(',')[0].trim() : undefined;

      const rawBreadcrumb = (p.categories_hierarchy || p.categories_tags || [])
        .map((cat) => cat.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ').trim())
        .filter(Boolean);

      const specifications: Record<string, string> = {};
      if (p.ingredients_text || p.ingredients_text_en) {
        specifications['Ingredients'] = (p.ingredients_text || p.ingredients_text_en || '').trim();
      }
      if (p.quantity) {
        specifications['Package Weight / Size'] = p.quantity.trim();
      }
      if (p.serving_size) {
        specifications['Serving Size'] = p.serving_size.trim();
      }
      if (p.targeted_species) {
        specifications['Target Species'] = p.targeted_species.trim();
      }
      if (p.labels_tags && p.labels_tags.length > 0) {
        specifications['Claims & Labels'] = p.labels_tags
          .map((l) => l.replace(/^[a-z]{2}:/, '').replace(/-/g, ' '))
          .join(', ');
      }

      const images: string[] = [];
      if (p.image_url) images.push(p.image_url);
      if (p.image_front_url && !images.includes(p.image_front_url)) images.push(p.image_front_url);

      const evidence: ScrapedProductEvidence = {
        id: `openpetfoodfacts-${cleanGtin}`,
        entityId: computeEntityId(`https://world.openpetfoodfacts.org/product/${variant}`),
        retailer: 'openpetfoodfacts.org',
        sourceUrl: `https://world.openpetfoodfacts.org/product/${variant}`,
        scrapedAt: new Date().toISOString(),
        title,
        brand,
        upc: cleanGtin,
        gtin: cleanGtin,
        rawBreadcrumb,
        specifications,
        description: specifications['Ingredients'] ? `Ingredients: ${specifications['Ingredients']}` : undefined,
        images,
        acquisitionMode: 'open_api',
        parserVersion: '2.0',
        licenseStatus: 'open_licensed',
        validationState: 'unvalidated',
        qualityFlags: [],
        pageKind: 'unknown',
      };

      return ScrapedProductEvidenceSchema.parse(evidence);
    } catch {
      // Continue to next variant
    }
  }

  return null;
}

/**
 * Imports a batch of GTIN barcodes from Open Pet Food Facts API with rate-limiting delay.
 */
export async function importOpenPetFoodFactsBatch(
  gtins: string[],
  delayMs = 200,
  fetchFn: typeof fetch = fetch
): Promise<ScrapedProductEvidence[]> {
  const results: ScrapedProductEvidence[] = [];

  for (const gtin of gtins) {
    const evidence = await fetchOpenPetFoodFactsByGtin(gtin, fetchFn);
    if (evidence) {
      results.push(evidence);
    }
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return results;
}
