/**
 * Versioned production quality telemetry (issue #17 work item F).
 *
 * The report schema and metric-definition are versioned so formula changes
 * are auditable and historical reports stay interpretable. All metric values
 * are nullable: empty/insufficient metrics are `null` with explicit
 * denominators and warnings — a misleading zero is never emitted.
 *
 * Read-only contract: producing a report never mutates proposals, decisions,
 * runs, model calls, or any other row. Reviewer agreement is a REVIEW signal,
 * never labeled Gold/true precision. Superseded decisions are never
 * double-counted, and prediction confidence is never replaced with revised
 * confidence.
 */
import { z } from 'zod';
import { StrictIsoDateTimeStringSchema } from './classification';

/** Bumped when the report envelope shape changes. */
export const QUALITY_REPORT_SCHEMA_VERSION = 1;
/** Bumped when any metric formula changes. */
export const QUALITY_METRIC_DEFINITION_VERSION = 1;
/** Hard cap on the requested report window. */
export const QUALITY_REPORT_MAX_RANGE_DAYS = 90;

const QualityWindowSchema = z
  .object({
    start: StrictIsoDateTimeStringSchema,
    end: StrictIsoDateTimeStringSchema,
  })
  .strict();

const QualitySampleCountsSchema = z
  .object({
    runs: z.number().int().nonnegative(),
    completedRuns: z.number().int().nonnegative(),
    eligibleRuns: z.number().int().nonnegative(),
    proposals: z.number().int().nonnegative(),
    liveDecisions: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
  })
  .strict();

const QualityCalibrationBinSchema = z
  .object({
    bin: z.number().int().min(0),
    count: z.number().int().nonnegative(),
    accuracy: z.number().min(0).max(1),
    avgConfidence: z.number().min(0).max(1),
  })
  .strict();

const QualityCalibrationSchema = z
  .object({
    /** Expected calibration error over reviewer-agreement labels, or null when no labeled examples exist. */
    ece: z.number().min(0).nullable(),
    bins: z.array(QualityCalibrationBinSchema),
    sampleCount: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();

const QualityLatencySchema = z
  .object({
    runMedianMs: z.number().nonnegative().nullable(),
    runP95Ms: z.number().nonnegative().nullable(),
    runSampleCount: z.number().int().nonnegative(),
    modelCallMedianMs: z.number().nonnegative().nullable(),
    modelCallP95Ms: z.number().nonnegative().nullable(),
    modelCallSampleCount: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();

const QualityCostSchema = z
  .object({
    totalKnownUsd: z.number().nonnegative().nullable(),
    meanKnownUsd: z.number().nonnegative().nullable(),
    knownCostCalls: z.number().int().nonnegative(),
    totalCalls: z.number().int().nonnegative(),
    /** Fraction of calls with a known cost (local_zero or a reviewed rate). */
    knownCostFraction: z.number().min(0).max(1).nullable(),
    /** Fraction of calls with both prompt and completion token counts recorded. */
    tokenCoverageFraction: z.number().min(0).max(1).nullable(),
    warnings: z.array(z.string()),
  })
  .strict();

const QualityReviewAgreementSchema = z
  .object({
    /** accepted-unchanged / (accepted-unchanged + accepted-corrected + rejected); deferred excluded. */
    precision: z.number().min(0).max(1).nullable(),
    acceptedUnchanged: z.number().int().nonnegative(),
    acceptedCorrected: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();

const QualityCoverageSchema = z
  .object({
    /**
     * Runs with at least one decision-eligible (non-abstention) proposal /
     * eligible completed runs. A proposal is decision-eligible when produced
     * for review (pending included) — a run awaiting review is never a silent
     * miss. A run with no decision-eligible proposal is uncovered, surfaced
     * with a warning. Null (with a warning) when no eligible run has produced
     * a decision-eligible proposal — never a misleading zero.
     */
    value: z.number().min(0).max(1).nullable(),
    eligibleRuns: z.number().int().nonnegative(),
    decisionEligibleRuns: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();

const QualityAbstentionSchema = z
  .object({
    /**
     * Reviewable abstentions / ALL proposals in the group. (The plan wording
     * says "over eligible runs"; the all-proposals denominator is the
     * implemented, documented deviation — it is defensible because abstentions
     * are proposals, and the schema fields make the denominator explicit.)
     */
    rate: z.number().min(0).max(1).nullable(),
    reviewableAbstentions: z.number().int().nonnegative(),
    proposals: z.number().int().nonnegative(),
    resolvedAbstentions: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();

const QualityCorrectionsSchema = z
  .object({
    /** Live accepted decisions with a revised value/target / live accepted decisions. */
    rate: z.number().min(0).max(1).nullable(),
    correctedAccepted: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    /** Revisions per 100 adjudicated proposals (any live decision). */
    revisionsPer100: z.number().nonnegative().nullable(),
    adjudicatedProposals: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();

const QualityGroundingSchema = z
  .object({
    /** Proposals with >= 1 supporting evidence / non-abstention proposals. */
    supportingCitationCoverage: z.number().min(0).max(1).nullable(),
    /** Proposals with >= 1 contradicting evidence / non-abstention proposals. */
    contradictionRate: z.number().min(0).max(1).nullable(),
    /** Accepted corrections with >= 1 evidence citation / accepted corrections. */
    correctionCitationCoverage: z.number().min(0).max(1).nullable(),
    proposalsWithSupporting: z.number().int().nonnegative(),
    proposalsWithContradicting: z.number().int().nonnegative(),
    nonAbstentionProposals: z.number().int().nonnegative(),
    correctionsWithCitations: z.number().int().nonnegative(),
    acceptedCorrections: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();

const QualityModelRouteSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    count: z.number().int().nonnegative(),
  })
  .strict();

/**
 * One version group: every run in the group shares the same config/runtime
 * snapshot hash, model-plan digest, rule-versions digest, source kind, AND
 * executed model route identity (provider/model pairs from the run's actual
 * model calls), so differing config/prompt/rule/model identities are never
 * combined.
 */
const QualityVersionGroupSchema = z
  .object({
    configSnapshotHash: z.string().nullable(),
    modelPlanDigest: z.string().nullable(),
    ruleVersionsDigest: z.string().nullable(),
    sourceKind: z.string().nullable(),
    proposalTypes: z.record(z.string(), z.number().int().nonnegative()),
    modelRoutes: z.array(QualityModelRouteSchema),
    reviewAgreement: QualityReviewAgreementSchema,
    coverage: QualityCoverageSchema,
    abstention: QualityAbstentionSchema,
    corrections: QualityCorrectionsSchema,
    calibration: QualityCalibrationSchema,
    grounding: QualityGroundingSchema,
    latency: QualityLatencySchema,
    cost: QualityCostSchema,
    warnings: z.array(z.string()),
  })
  .strict();

export const QualityReportSchema = z
  .object({
    schemaVersion: z.literal(QUALITY_REPORT_SCHEMA_VERSION),
    metricDefinitionVersion: z.literal(QUALITY_METRIC_DEFINITION_VERSION),
    workspaceId: z.string(),
    window: QualityWindowSchema,
    sourceWatermark: z.string().nullable(),
    generatedAt: StrictIsoDateTimeStringSchema,
    sampleCounts: QualitySampleCountsSchema,
    groups: z.array(QualityVersionGroupSchema),
    warnings: z.array(z.string()),
  })
  .strict();

export type QualityWindow = z.infer<typeof QualityWindowSchema>;
export type QualitySampleCounts = z.infer<typeof QualitySampleCountsSchema>;
export type QualityCalibration = z.infer<typeof QualityCalibrationSchema>;
export type QualityLatency = z.infer<typeof QualityLatencySchema>;
export type QualityCost = z.infer<typeof QualityCostSchema>;
export type QualityReviewAgreement = z.infer<typeof QualityReviewAgreementSchema>;
export type QualityCoverage = z.infer<typeof QualityCoverageSchema>;
export type QualityAbstention = z.infer<typeof QualityAbstentionSchema>;
export type QualityCorrections = z.infer<typeof QualityCorrectionsSchema>;
export type QualityGrounding = z.infer<typeof QualityGroundingSchema>;
export type QualityModelRoute = z.infer<typeof QualityModelRouteSchema>;
export type QualityVersionGroup = z.infer<typeof QualityVersionGroupSchema>;
export type QualityReport = z.infer<typeof QualityReportSchema>;
