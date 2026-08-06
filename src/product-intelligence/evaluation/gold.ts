/**
 * PI-9 golden-set schemas (issue #26).
 *
 * The PI evaluation dataset reuses the #14 benchmark tables
 * (benchmark_datasets / benchmark_examples): gold labels live in
 * `gold_labels_json` as a PiGoldLabels record, and the product input lives
 * in `input_snapshot_json` as a PiProductInput record. Pure zod module —
 * no imports beyond zod.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { z } from 'zod';

export const PiDifficultyTagSchema = z.enum([
  'upc_normalization',
  'json_ld_static',
  'shopify_variant',
  'woocommerce_variant',
  'multi_variant',
  'product_family',
  'xhr_only',
  'interaction_required',
  'packaging_redesign',
  'wrong_size_retailer',
  'discontinued',
  'ambiguous_brand',
  'blocked_official',
  'distributor_conflict',
  'image_rights_uncertainty',
  'abstention_correct',
]);

export const PiExpectedImageSchema = z
  .object({
    identityMatch: z.enum(['exact', 'variant', 'wrong', 'unknown']),
    rightsStatus: z.enum(['approved', 'restricted', 'unknown']),
  })
  .nullish();

export const PiGoldLabelsSchema = z.object({
  identity: z.object({
    exactProduct: z.boolean(),
    exactVariant: z.boolean().nullish(),
    parentProductOnly: z.boolean().default(false),
    wrongVariant: z.boolean().default(false),
    requiredAbstention: z.boolean().default(false),
  }),
  expectedSource: z
    .object({
      domain: z.string().min(1),
      kind: z.enum(['official', 'supplier', 'retailer', 'registry', 'other']),
    })
    .nullish(),
  expectedTitle: z.string().nullish(),
  requiredFacts: z
    .array(z.object({ field: z.string().min(1), value: z.string() }))
    .default([]),
  expectedEvidence: z
    .array(
      z.object({
        field: z.string().min(1),
        sourcePath: z.string().nullish(),
        extractionMethod: z.string().nullish(),
      }),
    )
    .default([]),
  expectedImage: PiExpectedImageSchema,
  expectedClassification: z
    .object({
      productType: z.string().nullish(),
      attributes: z
        .array(z.object({ attributeId: z.string(), value: z.string() }))
        .default([]),
      categoryPages: z.array(z.string()).default([]),
    })
    .default({ productType: null, attributes: [], categoryPages: [] }),
  misleadingSources: z
    .array(z.object({ domain: z.string(), reason: z.string() }))
    .default([]),
  difficultyTags: z.array(PiDifficultyTagSchema).default([]),
});

export const PiProductInputSchema = z.object({
  gtin: z.string(),
  registerName: z.string(),
  brandHint: z.string().nullish(),
  departmentHint: z.string().nullish(),
  price: z.string().nullish(),
  quantity: z.number().int().positive().nullish(),
  expectedPageUrl: z.string().url().nullish(),
});

export type PiGoldLabels = z.infer<typeof PiGoldLabelsSchema>;
export type PiProductInput = z.infer<typeof PiProductInputSchema>;
export type PiDifficultyTag = z.infer<typeof PiDifficultyTagSchema>;

export const DIFFICULTY_TAG_LABELS: Record<PiDifficultyTag, string> = {
  upc_normalization: 'UPC padding / normalization variants',
  json_ld_static: 'Static page with complete JSON-LD',
  shopify_variant: 'Shopify variant page',
  woocommerce_variant: 'WooCommerce variant page',
  multi_variant: 'Multi-variant ecommerce page',
  product_family: 'Product-family page without exact variant',
  xhr_only: 'Data only in XHR/fetch/GraphQL responses',
  interaction_required: 'Interaction required to reveal variant',
  packaging_redesign: 'Packaging redesign',
  wrong_size_retailer: 'Wrong-size retailer page',
  discontinued: 'Discontinued product',
  ambiguous_brand: 'Ambiguous brand',
  blocked_official: 'Missing or blocked official page',
  distributor_conflict: 'Conflicting distributor data',
  image_rights_uncertainty: 'Image-rights uncertainty',
  abstention_correct: 'Abstention is correct',
};
