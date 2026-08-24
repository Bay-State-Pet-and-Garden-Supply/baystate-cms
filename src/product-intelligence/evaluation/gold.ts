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
import { PiDifficultyTagSchema } from '../../shared/schemas/agent-training';

// Canonical home: src/shared/schemas/agent-training.ts (ADR-0030 PR 1.3).
export { PiDifficultyTagSchema };
export type { PiDifficultyTag } from '../../shared/schemas/agent-training';

const PiExpectedImageSchema = z
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
