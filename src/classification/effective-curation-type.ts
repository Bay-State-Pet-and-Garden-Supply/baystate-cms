/**
 * Effective Curation Product Type Resolver (issue #30 PR5).
 *
 * The two Curation stages that gate attribute applicability
 * (`attribute_applicability` / `product_attribute_proposals`) read ONE pure
 * helper here instead of the reviewed-only `getReviewedPrimaryProductTypeId`
 * directly. Priority is:
 *
 *   1. `reviewed` — the member's own reviewed (accepted) Primary Product Type,
 *      resolved by the UNCHANGED `getReviewedPrimaryProductTypeId`, which
 *      honors an in-run accepted proposal first and then provenance-compatible
 *      reviewed facts carried in the frozen runtime snapshot.
 *   2. `execution` — the cohort Execution Product Type written once at freeze
 *      (PR4, `StageContext.cohortExecutionType`), used ONLY when no reviewed
 *      type exists.
 *   3. `none` — neither a reviewed type nor an execution type.
 *
 * Provenance rule: a reviewed type is provenance-compatible BY CONSTRUCTION of
 * the runtime snapshot — `collectCompatibleReviewedFacts` drops every carried
 * fact whose config/source provenance drifted, so the stages need no further
 * checks. This module never re-reads live classification config, never queries
 * pending per-SKU proposals, and never consults `curation_data_json`
 * suggestions — the execution path is a pure function of the frozen snapshot's
 * facts and the frozen `cohortExecutionType`.
 *
 * Reviewed-override precedence: when both a reviewed type and an execution
 * type exist (and even when they differ), the reviewed type wins. Review and
 * Promotion authority stay on the member's own reviewed proposals; the
 * Execution Type only fills the gap for first-pass Curation applicability.
 */
import type { StageContext, StageInput } from './types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { getProductTypeIdFromValue } from './assignment-projection';
import { getReviewedPrimaryProductTypeId } from './proposal-selection';

/** Where the effective Curation Product Type came from. */
export type EffectiveTypeSource = 'reviewed' | 'execution' | 'none';

export interface EffectiveCurationType {
  /** The Product Type id that gates attribute applicability, or null. */
  effectiveTypeId: string | null;
  /** Provenance of the effective type: reviewed fact, execution type, or none. */
  source: EffectiveTypeSource;
}

/**
 * Pure resolution: reviewed first, then the cohort execution type, else none.
 * Empty-string ids are treated as absent (fail closed, never a lookup key).
 */
export function resolveEffectiveCurationType(
  reviewedTypeId: string | null,
  executionTypeId: string | null,
): EffectiveCurationType {
  if (reviewedTypeId !== null && reviewedTypeId.length > 0) {
    return { effectiveTypeId: reviewedTypeId, source: 'reviewed' };
  }
  if (executionTypeId !== null && executionTypeId.length > 0) {
    return { effectiveTypeId: executionTypeId, source: 'execution' };
  }
  return { effectiveTypeId: null, source: 'none' };
}

/**
 * The one reviewed Primary Product Type id from a frozen snapshot's
 * provenance-compatible reviewed facts, or null. Reimplements the reviewed-fact
 * loop of `getReviewedPrimaryProductTypeId` as a standalone additive helper
 * (snapshot-only; the in-run accepted branch is irrelevant mid-pipeline
 * because `runPipeline` seeds `acceptedProposals: []`). The first
 * `primary_product_type` fact wins; the id is extracted via
 * `getProductTypeIdFromValue` (accepts `{ productTypeId }` and string shapes).
 */
export function getReviewedTypeFromSnapshot(
  snapshot: RuntimeClassificationSnapshot | undefined,
): string | null {
  if (!snapshot?.reviewedFacts?.length) return null;
  for (const fact of snapshot.reviewedFacts) {
    if (fact.proposalType !== 'primary_product_type') continue;
    const id = getProductTypeIdFromValue(fact.value);
    if (id && id.length > 0) return id;
  }
  return null;
}

/**
 * Effective Curation Product Type for a stage: the reviewed type
 * (`getReviewedPrimaryProductTypeId`, unchanged) with the frozen cohort
 * Execution Product Type as fallback. Reviewed facts are provenance-compatible
 * by snapshot construction, so no live-config re-validation happens here.
 */
export function getEffectiveCurationProductType(
  input: StageInput,
  context: StageContext,
): EffectiveCurationType {
  return resolveEffectiveCurationType(
    getReviewedPrimaryProductTypeId(input, context.snapshot),
    context.cohortExecutionType?.id ?? null,
  );
}

/**
 * Snapshot-only variant for the cohort executor (no `StageInput` in scope).
 * Resolves the reviewed type purely from `snapshot.reviewedFacts`, so it
 * agrees with `getEffectiveCurationProductType` by construction and the
 * executor's dependency stamping matches what the stages actually used.
 */
export function getEffectiveCurationTypeForSnapshot(
  snapshot: RuntimeClassificationSnapshot | undefined,
  executionTypeId: string | null,
): EffectiveCurationType {
  return resolveEffectiveCurationType(getReviewedTypeFromSnapshot(snapshot), executionTypeId);
}
