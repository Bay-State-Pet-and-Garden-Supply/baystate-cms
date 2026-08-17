/**
 * Provider-neutral ProductSeed and batch context contracts (PI-#50).
 *
 * A ProductSeed is the immutable operator/catalog input for a v2 run. It is
 * intentionally not an identity assertion: UPC/GTIN and MPN values are
 * discovered evidence and must never be inferred from a supplier SKU.
 */
import { z } from 'zod';
import type { ProductResearchInput } from './contracts';

const SeedPriceSchema = z.union([
  z.number().finite().nonnegative(),
  z.string().trim().min(1).max(64),
]);

export const ProductSeedSchema = z.object({
  /** Store-facing SKU; numeric-looking values remain SKUs, not GTINs. */
  sku: z.string().trim().min(1).max(256),
  /** Original name as supplied by the operator/import. */
  name: z.string().trim().min(1).max(512),
  /** Original price. Its evidentiary weight depends on source semantics. */
  price: SeedPriceSchema,
}).strict();
export type ProductSeed = z.infer<typeof ProductSeedSchema>;

/**
 * Batch context is a versioned, bounded hint. `authoritative` is deliberately
 * fixed false: sibling rows and batch labels can guide search but can never
 * alter a product's seed identity or produce a classification decision.
 */
export const BatchContextSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  authoritative: z.literal(false).default(false),
  batchId: z.string().trim().min(1).max(128).nullish(),
  batchName: z.string().max(256).nullish(),
  itemIndex: z.number().int().nonnegative().nullish(),
  siblingSkus: z.array(z.string().trim().min(1).max(256)).max(1000).default([]),
  hints: z.record(z.string(), z.string().max(512)).default({}),
}).strict();
export type BatchContext = z.infer<typeof BatchContextSchema>;

/** Optional #43 raw/normalized identity attached as evidence, not seed input. */
export const ExistingIdentityAttachmentSchema = z.object({
  raw: z.unknown().nullish(),
  normalized: z.unknown().nullish(),
  sourceRef: z.string().max(256).nullish(),
}).strict();
export type ExistingIdentityAttachment = z.infer<typeof ExistingIdentityAttachmentSchema>;

/** The v2 wire input. GTIN/UPC is intentionally absent. */
export const ProductResearchV2InputSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  productSeed: ProductSeedSchema,
  batchContext: BatchContextSchema.nullish(),
  existingIdentity: ExistingIdentityAttachmentSchema.nullish(),
}).strict();
export type ProductResearchV2Input = z.infer<typeof ProductResearchV2InputSchema>;

/** Direct seed form accepted by the API for a minimal launch payload. */
export const ProductSeedLaunchSchema = ProductSeedSchema.extend({
  batchContext: BatchContextSchema.nullish(),
  existingIdentity: ExistingIdentityAttachmentSchema.nullish(),
}).strict();
export type ProductSeedLaunch = z.infer<typeof ProductSeedLaunchSchema>;

export function seedPriceToString(price: ProductSeed['price']): string {
  return typeof price === 'number' ? String(price) : price;
}

/**
 * Compatibility adapter for executors that still consume the historical
 * GTIN-first input shape.
 *
 * ProductSeed does not require a GTIN, so a seed cannot always be represented
 * as ProductResearchInput. Callers must provide a discovered, normalized GTIN
 * before this adapter returns the historical shape; the SKU is never copied
 * into it. A missing or invalid discovered GTIN fails closed with null.
 */
export function productSeedToLegacyInput(
  seed: ProductSeed,
  discoveredGtin?: string | null,
): ProductResearchInput | null {
  if (discoveredGtin == null || !/^\d{8,14}$/.test(discoveredGtin)) return null;

  return {
    gtin: discoveredGtin,
    registerName: seed.name,
    price: seedPriceToString(seed.price),
  };
}

export type SeedEvidenceStrength = 'weak' | 'contextual';

/** A price is weak evidence unless the source's pricing semantics are known. */
export function priceEvidenceStrength(sourceSemantics?: string | null): SeedEvidenceStrength {
  return sourceSemantics?.trim() ? 'contextual' : 'weak';
}

/** Supplier SKU is always an SKU; it is never implicitly an MPN or GTIN. */
export function identifierRoleForSeedSku(_sku: string): 'sku' {
  return 'sku';
}

/** Payload schema metadata for the #48 typed specialist-artifact substrate. */
export const PRODUCT_SEED_ARTIFACT_TYPE = 'product_seed' as const;
export const PRODUCT_SEED_ARTIFACT_SCHEMA_VERSION = '1.0.0' as const;
