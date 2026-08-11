// fallow-ignore-file unused-export

/**
 * Cohort-centric, type-first Curation (issue #30) — shared contracts.
 *
 * Durable product families: a `curation_cohort` is a versioned candidate
 * family of onboarding items grouped by a deterministic grouping algorithm.
 * Members are linked through `curation_cohort_members`. This file defines the
 * status/scoping vocabulary, row shapes, and API DTOs used across the DB
 * repository, the curation-cohort service, the onboarding worker, the API
 * route, and the Pipeline Board UI.
 */

import { z } from 'zod';

// ─── Cohort Status ─────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a curation cohort (schema v3, issue #31 commit 3 / D7).
 *
 * - `forming`: candidate family created by the grouping algorithm; members are
 *   still being evaluated for extraction completeness.
 * - `waiting`: at least one member's evidence is not yet stable (the derived
 *   "Waiting for N family members to finish Extraction" state).
 * - `ready`: every member's extraction evidence is complete and frozen into an
 *   extraction hash; the cohort is a stable candidate (PR3+ will execute it).
 * - `superseded`: a newer cohort revision replaced this row. Historical rows
 *   are superseded, never mutated in place.
 *
 * The cohort row is a candidate-family record ONLY: execution/lifecycle
 * states (`running`/`completed`/`failed`/`conflicted`) never belong on it —
 * cohort RUN state is owned by the cohort run (PR3+). The v3 migration narrows
 * the DB CHECK to these four values and deterministically maps any legacy
 * execution status to `ready`.
 */
export const CohortStatusEnum = z.enum([
  'forming',
  'waiting',
  'ready',
  'superseded',
]);

export type CohortStatus = z.infer<typeof CohortStatusEnum>;

// ─── Readiness State ───────────────────────────────────────────────────────────

/**
 * Derived extraction-readiness state for a cohort member and its cohort
 * (issue #30 round-2 F5):
 *
 * - `ready`: every extraction-completeness condition is met;
 * - `waiting`: still processing — evidence is not yet complete;
 * - `blocked`: a member failed in Discovery/Extraction/Curation. This is a
 *   deterministic stop (never a wait) and carries a deterministic
 *   `Member failed (SKU: …)` reason.
 */
export const ReadinessStateSchema = z.enum(['ready', 'waiting', 'blocked']);

export type ReadinessState = z.infer<typeof ReadinessStateSchema>;

// ─── Curation Target Scopes ────────────────────────────────────────────────────

/**
 * The semantic scope of a curation target (issue #30, "Curation target scopes").
 *
 * - `family_invariant`: expected to resolve identically across finalized cohort
 *   members (e.g. canonical Brand, Primary Product Type). Disagreement is a
 *   semantic/evidence conflict — never normalized away.
 * - `coordinated_variant`: computed once using the full cohort, but individual
 *   member answers may legitimately differ (e.g. curated title, Category Page
 *   assignment).
 * - `member_local`: computed from the member's own evidence after cohort
 *   context is frozen (e.g. flavor, size, weight, color, life stage).
 */
export const CurationTargetScopeEnum = z.enum([
  'family_invariant',
  'coordinated_variant',
  'member_local',
]);

export type CurationTargetScope = z.infer<typeof CurationTargetScopeEnum>;

// ─── Cohort Run Status ─────────────────────────────────────────────────────────

/**
 * Lifecycle status of a parent cohort run (`classification_cohort_runs`, issue
 * #30 PR3 M1; cohort schema v5).
 *
 * - `freezing`: the run was atomically CLAIMED (lease held). Frozen authority
 *   hashes are still being captured; `freezing → running` happens only after
 *   the final freeze CAS transaction commits.
 * - `running`: execution started (`started_at` set); per-member child runs are
 *   being executed against the frozen cohort context.
 * - `completed`: every member completed; the cohort-level semantic work
 *   committed.
 * - `completed_with_abstentions`: every member completed but at least one
 *   stage abstained (no proposal emitted) without failing the run.
 * - `completed_with_member_failures`: members individually failed but the
 *   cohort-level semantic work still committed.
 * - `failed`: the run failed and must be retried to make progress.
 * - `cancelled`: the run was cancelled before completion (e.g. a freezing run
 *   that can never finalize).
 * - `superseded`: a newer run/cohort revision replaced this row. Settable from
 *   ANY state including terminal ones; no transition out of it. Superseded
 *   runs keep their frozen values — they are history, never mutated into a
 *   new truth.
 *
 * The DB enforces at most one CURRENT (non-superseded) run per cohort via the
 * unique partial index `idx_classification_cohort_runs_current`, and the
 * hash-required CHECK (`status = 'freezing' OR (candidate_membership_hash IS
 * NOT NULL AND evidence_snapshot_hash IS NOT NULL)`) forces the two mandatory
 * evidence hashes before a run may leave `freezing`.
 */
export const ClassificationCohortRunStatusEnum = z.enum([
  'freezing',
  'running',
  'completed',
  'completed_with_abstentions',
  'completed_with_member_failures',
  'failed',
  'cancelled',
  'superseded',
]);

export type ClassificationCohortRunStatus = z.infer<typeof ClassificationCohortRunStatusEnum>;

/**
 * Row shape of a parent cohort run (`classification_cohort_runs`), camelCase.
 * Mirrors the DB columns 1:1 (snake_case rows map via the repo's
 * `mapCohortRunRow`). See the SQL file header for the immutable/mutable field
 * contract.
 */
export const CohortRunSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cohortId: z.string(),
  /** Frozen cohort.membership_hash at claim (H1 — member identity only). */
  candidateMembershipHash: z.string(),
  /** PR4 (write-once after family coherence); NULL until then. */
  finalMembershipHash: z.string().nullable(),
  /** H2 canonical hash over the frozen member evidence; NULL while freezing. */
  evidenceSnapshotHash: z.string().nullable(),
  /** H3 config authority (nullable mirror). */
  configSnapshotId: z.string().nullable(),
  configSnapshotHash: z.string().nullable(),
  /** H4 Page catalog identity (nullable mirror). */
  pageImportId: z.string().nullable(),
  pageImportHash: z.string().nullable(),
  /** H5 unbound model-execution digest (nullable mirror). */
  modelPolicyDigest: z.string().nullable(),
  /** PR4 placeholder. */
  executionProductTypeId: z.string().nullable(),
  /** PR4 placeholder. */
  productTypeConfidence: z.number().nullable(),
  status: ClassificationCohortRunStatusEnum,
  /** Worker id that owns the claim lease. */
  claimedBy: z.string().nullable(),
  claimedAt: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  /** Execution start; set on `freezing → running` (NULL until then). */
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  supersededAt: z.string().nullable(),
  createdAt: z.string(),
});

export type CohortRun = z.infer<typeof CohortRunSchema>;

// ─── Grouping Version ──────────────────────────────────────────────────────────

/**
 * Version of the deterministic candidate-grouping algorithm. Grouping rules may
 * evolve; the version is persisted on every cohort so historical cohorts are
 * never silently reinterpreted (issue #30, "Candidate grouping, not
 * authoritative grouping").
 */
export const GROUPING_VERSION = 'product-family-v1';

// ─── Cohort Row Shape ──────────────────────────────────────────────────────────

export const CurationCohortSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  batchId: z.string(),
  /** Deterministic brand + normalized name-stem key (candidate grouping v1). */
  groupKey: z.string(),
  groupLabel: z.string(),
  groupingVersion: z.string(),
  /** Order-insensitive canonical hash over member IDENTITY (sorted onboarding item ids). */
  membershipHash: z.string(),
  status: CohortStatusEnum,
  blockedReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Schema v4 (issue #31 cleanup F3): startedAt/completedAt were REMOVED —
  // execution timestamps belong solely to `classification_cohort_runs`, never
  // to the candidate cohort row.
  supersededAt: z.string().nullable(),
});

export type CurationCohort = z.infer<typeof CurationCohortSchema>;

// ─── Cohort Member Row Shape ───────────────────────────────────────────────────

export const CurationCohortMemberSchema = z.object({
  cohortId: z.string(),
  onboardingItemId: z.string(),
  productSku: z.string().nullable(),
  normalizedBrand: z.string(),
  normalizedNameStem: z.string(),
  /**
   * Why this item belongs to the cohort, e.g.
   * `{"kind":"deterministic_grouping","groupingVersion":"product-family-v1"}`.
   */
  membershipReasonJson: z.record(z.string(), z.unknown()).nullable(),
  /** Canonical hash of extraction/sourcing evidence; NULL until complete. */
  extractionHash: z.string().nullable(),
  ordinal: z.number().int(),
  createdAt: z.string(),
});

export type CurationCohortMember = z.infer<typeof CurationCohortMemberSchema>;

// ─── API DTOs ──────────────────────────────────────────────────────────────────

/**
 * A sibling member that a cohort (or member) is waiting on.
 */
export const CohortWaitingOnItemSchema = z.object({
  itemId: z.string(),
  upc: z.string(),
  name: z.string(),
});

export type CohortWaitingOnItem = z.infer<typeof CohortWaitingOnItemSchema>;

/**
 * A cohort member with derived extraction-readiness state, for the API/UI.
 */
export const CohortMemberReadinessSchema = z.object({
  onboardingItemId: z.string(),
  productSku: z.string().nullable(),
  normalizedBrand: z.string(),
  normalizedNameStem: z.string(),
  extractionHash: z.string().nullable(),
  ordinal: z.number().int(),
  /** Lightweight item identity for display. */
  item: z.object({
    id: z.string(),
    upc: z.string(),
    name: z.string(),
  }),
  ready: z.boolean(),
  state: ReadinessStateSchema,
  blockedReason: z.string().nullable(),
  /** Sibling members this member is waiting on (excludes self). */
  waitingOn: z.array(CohortWaitingOnItemSchema).default(() => []),
});

export type CohortMemberReadiness = z.infer<typeof CohortMemberReadinessSchema>;

/**
 * Full cohort view returned by `GET /api/onboarding/batches/:id/cohorts`.
 * `status` is the cohort's persisted status, refreshed by the service.
 */
export const CurationCohortViewSchema = z.object({
  cohort: CurationCohortSchema,
  members: z.array(CohortMemberReadinessSchema),
  status: CohortStatusEnum,
  /** Derived readiness state: `blocked` when any member failed. */
  state: ReadinessStateSchema,
  blockedReason: z.string().nullable(),
  memberCount: z.number().int(),
  readyCount: z.number().int(),
  waitingOn: z.array(CohortWaitingOnItemSchema).default(() => []),
});

export type CurationCohortView = z.infer<typeof CurationCohortViewSchema>;

export const CohortListResponseSchema = z.object({
  cohorts: z.array(CurationCohortViewSchema),
});

export type CohortListResponse = z.infer<typeof CohortListResponseSchema>;

/**
 * Derived per-item family state for the Pipeline Board family indicator.
 */
export const DerivedCohortStateForItemSchema = z.object({
  cohortId: z.string().nullable(),
  groupKey: z.string().nullable(),
  groupLabel: z.string().nullable(),
  status: CohortStatusEnum.nullable(),
  /** Derived readiness state; null when the item has no active cohort. */
  state: ReadinessStateSchema.nullable(),
  blockedReason: z.string().nullable(),
  waitingOn: z.array(CohortWaitingOnItemSchema).default(() => []),
  memberCount: z.number().int(),
  readyCount: z.number().int(),
});

export type DerivedCohortStateForItem = z.infer<typeof DerivedCohortStateForItemSchema>;
