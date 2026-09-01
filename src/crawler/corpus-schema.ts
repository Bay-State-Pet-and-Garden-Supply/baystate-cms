import { z } from 'zod';
import { sha256Hex } from '../shared/stable-id.js';

const AcquisitionModeEnum = z.enum([
  'browser_parse',
  'http_fetch',
  'cloud_scraper',
  'open_api',
  'import_file',
]);

const LicenseStatusEnum = z.enum(['open_licensed', 'proprietary', 'unknown']);

const ValidationStateEnum = z.enum(['unvalidated', 'valid', 'rejected']);

const PageKindEnum = z.enum(['product', 'category', 'interstitial', 'blocked', 'unknown']);

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

export { validateGtin } from '../shared/gtin.js';

/**
 * Deterministic payload hash for a Bronze record: canonical JSON of the record
 * with identity/provenance-derived fields removed so identical payloads hash
 * identically regardless of scrape time.
 */
export function computePayloadHash(record: Record<string, unknown>): string {
  const { id: _id, entityId: _entityId, observationId: _observationId, payloadHash: _payloadHash, scrapedAt: _scrapedAt, validationState: _validationState, ...payload } = record;
  return sha256Hex(`payload:${JSON.stringify(payload)}`);
}
