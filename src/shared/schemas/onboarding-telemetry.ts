// fallow-ignore-file unused-export

/**
 * Epic #46 — onboarding observability schema.
 *
 * Every metric is DERIVED from existing durable state at query time. Each
 * metric carries an honesty marker so consumers can tell exact derivations
 * from documented approximations and from genuinely unavailable values.
 */
import { z } from 'zod';

/** How trustworthy a metric value is. */
export const MetricDerivationEnum = z.enum(['exact', 'approximation', 'not_available']);

export type MetricDerivation = z.infer<typeof MetricDerivationEnum>;

export const MetricBreakdownEntrySchema = z.object({
  key: z.string(),
  value: z.number(),
  /** Share of the parent population (0..1); null when not meaningful. */
  share: z.number().nullable().default(null),
});

export type MetricBreakdownEntry = z.infer<typeof MetricBreakdownEntrySchema>;

export const TelemetryMetricSchema = z.object({
  value: z.number().nullable(),
  unit: z.string().nullable().default(null),
  derivation: MetricDerivationEnum,
  note: z.string().nullable().default(null),
  /** Optional breakdown (e.g. attention volume by reason). */
  breakdown: z.array(MetricBreakdownEntrySchema).default(() => []),
});

export type TelemetryMetric = z.infer<typeof TelemetryMetricSchema>;

export const METRIC_KEYS = [
  'automationCompletionRate',
  'attentionVolume',
  'attentionRateByReason',
  'attentionResolutionTime',
  'productsCompletedFromDistributorOnly',
  'productsRequiringOfficialSite',
  'extractorProfileBlockRate',
  'extractorProfileDomainUnblockCount',
  'familiesWaitingCount',
  'familyWaitDurationHours',
  'cohortCurationSuccessRate',
  'productsReadyForReview',
  'reviewThroughputProductsPerMinute',
  'reviewEditRate',
  'bulkApprovalSuccessRate',
  'exportSuccessRate',
] as const;

export type OnboardingMetricKey = (typeof METRIC_KEYS)[number];

export const OnboardingTelemetrySchema = z.object({
  scope: z.enum(['batch', 'global']),
  batchId: z.string().nullable().default(null),
  generatedAt: z.string(),
  metrics: z.object({
    automationCompletionRate: TelemetryMetricSchema,
    attentionVolume: TelemetryMetricSchema,
    attentionRateByReason: TelemetryMetricSchema,
    attentionResolutionTime: TelemetryMetricSchema,
    productsCompletedFromDistributorOnly: TelemetryMetricSchema,
    productsRequiringOfficialSite: TelemetryMetricSchema,
    extractorProfileBlockRate: TelemetryMetricSchema,
    extractorProfileDomainUnblockCount: TelemetryMetricSchema,
    familiesWaitingCount: TelemetryMetricSchema,
    familyWaitDurationHours: TelemetryMetricSchema,
    cohortCurationSuccessRate: TelemetryMetricSchema,
    productsReadyForReview: TelemetryMetricSchema,
    reviewThroughputProductsPerMinute: TelemetryMetricSchema,
    reviewEditRate: TelemetryMetricSchema,
    bulkApprovalSuccessRate: TelemetryMetricSchema,
    exportSuccessRate: TelemetryMetricSchema,
  }),
});

export type OnboardingTelemetry = z.infer<typeof OnboardingTelemetrySchema>;