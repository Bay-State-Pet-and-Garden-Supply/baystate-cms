import { z } from 'zod';
import { sha256Hex } from '../shared/stable-id.js';

export const AcquisitionModeEnum = z.enum([
  'browser_parse',
  'http_fetch',
  'cloud_scraper',
  'open_api',
  'import_file',
]);

export const LicenseStatusEnum = z.enum(['open_licensed', 'proprietary', 'unknown']);

export const ValidationStateEnum = z.enum(['unvalidated', 'valid', 'rejected']);

export const PageKindEnum = z.enum(['product', 'category', 'interstitial', 'blocked', 'unknown']);

export const ScrapedProductEvidenceSchema = z.object({
  /** Stable identifier for the scraped item (legacy prefix-derived IDs are replaced by SHA-256 entity IDs). */
  id: z.string().optional(),
  /** Source-scoped SHA-256 entity identity derived from the canonical source URL. */
  entityId: z.string().optional(),
  /** Source-scoped SHA-256 observation identity (entity + payload). */
  observationId: z.string().optional(),
  /** Source e-commerce domain (e.g. 'chewy.com', 'tractorsupply.com') */
  retailer: z.string(),
  /** Full URL of the product page (canonicalized by the URL policy). */
  sourceUrl: z.string().url(),
  /** Original pre-canonicalization URL when it differs from sourceUrl. */
  rawUrl: z.string().url().optional(),
  /** ISO timestamp when the product was scraped. */
  scrapedAt: z.string(),
  /** Product title as displayed on the target site. */
  title: z.string(),
  /** Brand name extracted from product page or metadata. */
  brand: z.string().optional(),
  /** Standard product codes when available. */
  upc: z.string().optional(),
  gtin: z.string().optional(),
  mpn: z.string().optional(),
  modelNumber: z.string().optional(),
  /** Raw category breadcrumb path from target site (e.g. ["Dog", "Food", "Dry Food"]) */
  rawBreadcrumb: z.array(z.string()).default([]),
  /** Key-value dictionary of product specifications (e.g. { "Species": "Dog", "Form": "Kibble" }) */
  specifications: z.record(z.string(), z.string()).default({}),
  /** Main product description text / copy */
  description: z.string().optional(),
  /** List of product image URLs */
  images: z.array(z.string().url()).default([]),
  /** Price string if extracted (for reference) */
  price: z.string().optional(),
  /** Availability status if extracted */
  inStock: z.boolean().optional(),

  // ─── Milestone 8 provenance/quality contract ───────────────────────────
  /** How the observation was acquired. */
  acquisitionMode: AcquisitionModeEnum.default('import_file'),
  /** Parser/schema version that produced this record. */
  parserVersion: z.string().default('1.0'),
  /** SHA-256 of the canonical payload (excludes identity fields). */
  payloadHash: z.string().optional(),
  /** License status of the source data. */
  licenseStatus: LicenseStatusEnum.default('unknown'),
  /** Validation state of this record in the offline pipeline. */
  validationState: ValidationStateEnum.default('unvalidated'),
  /** Quality flags (e.g. 'missing_gtin', 'low_confidence'). */
  qualityFlags: z.array(z.string()).default([]),
  /** Classified page kind. */
  pageKind: PageKindEnum.default('unknown'),
});

export type ScrapedProductEvidence = z.input<typeof ScrapedProductEvidenceSchema>;

export const SiteCrawlConfigSchema = z.object({
  domain: z.string(),
  startUrls: z.array(z.string().url()),
  maxItems: z.number().optional().default(100),
  maxConcurrency: z.number().optional().default(2),
  requestDelayMs: z.number().optional().default(1000),
  useBrowser: z.boolean().optional().default(false),
});

export type SiteCrawlConfig = z.infer<typeof SiteCrawlConfigSchema>;

/**
 * GTIN/UPC/EAN checksum validation (mod-10).
 * Accepts 8-14 digit codes; verifies the check digit for 12/13/14-digit codes
 * and 8-digit EAN-8 codes.
 */
export function validateGtin(code: string): boolean {
  const digits = code.replace(/[^0-9]/g, '');
  if (digits.length !== 8 && digits.length !== 12 && digits.length !== 13 && digits.length !== 14) {
    return false;
  }
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  // Right-to-left, alternate weights 3 and 1, starting with 3 for the
  // rightmost body digit.
  let weight = 3;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  const computed = (10 - (sum % 10)) % 10;
  return computed === check;
}

/**
 * Deterministic payload hash for a Bronze record: canonical JSON of the record
 * with identity/provenance-derived fields removed so identical payloads hash
 * identically regardless of scrape time.
 */
export function computePayloadHash(record: Record<string, unknown>): string {
  const { id: _id, entityId: _entityId, observationId: _observationId, payloadHash: _payloadHash, scrapedAt: _scrapedAt, validationState: _validationState, ...payload } = record;
  return sha256Hex(`payload:${JSON.stringify(payload)}`);
}
