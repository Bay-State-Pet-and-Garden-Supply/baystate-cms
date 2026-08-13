/**
 * Canonical cohort title input hash (issue #30, PR6 C2) — the "T-hash".
 *
 * PURE module: `computeCohortTitleInputHash` derives a canonical SHA-256 from
 * FROZEN TITLE AUTHORITY ONLY (architecture-report §3, DECISION-P/Q). It is
 * the per-row `input_hash` of the durable `classification_cohort_outputs`
 * table and the reuse key of the parent `ensureCohortTitlesCoordinated` op:
 * outputs for a run are reusable iff every multi-item group member has a row
 * AND every row's input hash matches the freshly computed T-hash. The hash is
 * recomputed on every `processCohort` entry (cheap, pure); a mismatch means
 * the frozen title authority changed (impossible in the normal flow — the
 * projection + run authorities are immutable once frozen — but possible if
 * prompt/format/rule constants changed between deployments). A mismatch
 * against a committed output set is WRITE-ONCE drift: the parent op FAILS
 * CLOSED with `CohortTitleAuthorityDriftError` — the set is never
 * re-coordinated or replaced, and the run terminates deterministically with
 * no further coordination and no further writes. REPLAY CONTRACT: at most
 * one ACTIVE coordination call at a time; a crash between transport success
 * and the output-set commit may cause ANOTHER independently audited
 * invocation (no retry cap — each pre-commit crash repeats this); only a
 * successful commit makes later entries call-free (replay-safe after
 * commit).
 *
 * HASH ONLY FROZEN TITLE AUTHORITY — explicit exclusions (DECISION-P):
 * - NO live `onboarding_items` rows, stage/status, `curation_data_json`, or
 *   `updated_at` — the members array is built strictly from
 *   `projection.members` (the persisted `execution-evidence-v1` payload).
 * - NO cache-key shape (`buildCacheKey`, cohort-name-coordinator): the old
 *   string fingerprint + `modelIdentity {provider, model, policyDigest}`
 *   combined with FORMAT_RULES is replaced by this structured canonical JSON.
 * - NO non-title projection fields: `description`, `bulletPoints`,
 *   `searchKeywords`, `customFields`, `fieldProvenance`,
 *   `primaryImage`/`additionalImages`.
 * - NO `evidenceHash` (H2 member evidence identity — it changes on OCR
 *   *re-runs* even when the title text is identical), NO `ocrInputHash` /
 *   `ocrExecutionDigest` (OCR *provenance*, not title text).
 * - NO H3 config / H4 Page catalog (titles do not depend on them).
 * - Only the title H5 slice: the frozen `cohort_title_consolidation` plan
 *   entry (provider/model/promptTemplateVersion/ruleVersion) + `FORMAT_RULES`
 *   digest. An unrelated route change (e.g. `attribute_ranking`) changes H5
 *   but NOT the T-hash ⇒ outputs are reused.
 *
 * PR13 (issue #30, DECISION-C): the hashed model-execution authority is
 * genuinely OPERATION-SPECIFIC — exactly `{operation,
 * 'cohort_title_consolidation', promptTemplateVersion, ruleVersion, provider,
 * model}` from the frozen plan entry (registry consts when absent), mirroring
 * the P-hash's operation-specific contract. The broad H5 `policyDigest` is
 * deliberately NOT hashed: it is routing state that changes with ANY model
 * route change, not a title authority — dropping it means an unrelated
 * non-title route change never re-coordinates titles. PRE-RELEASE COMPOSITION
 * CHANGE: sets committed under the OLD composition (policy digest hashed)
 * drift under this hash — documented in ADR 0013 PR13; there is no
 * production data to migrate.
 *
 * The per-member slice is `titleAuthorityFromProjectionMember`: productSku,
 * spreadsheet identity (name/expectedName/brandHint), web title/brand, and
 * the packaging-OCR title signals (`packagingOcrData.productName ??
 * packagingTitle`, `weight`, `flavorVariety` — DECISION-Q: weight/flavor are
 * title-format-relevant signals the FORMAT_RULES mandate). The slice is
 * PROMPT-NORMALIZED (the same truncation the coordinated prompt renders:
 * 200 chars for brand signals, 500 for the rest) so the hashed authority
 * equals the prompted authority by construction — a suffix-only mutation
 * beyond the cutoffs changes neither the prompt NOR the hash.
 */
import { hashCanonicalJson } from '../shared/stable-id';
import { FORMAT_RULES } from './title-prompt-template';
import { PROMPT_TEMPLATE_VERSIONS, RULE_VERSIONS } from '../classification/model-operation-registry';
import type { ModelExecutionPlanEntry } from '../classification/model-operation-registry';
import type {
  CohortRun,
  ExecutionEvidenceProjectionV1,
  ExecutionEvidenceProjectionMemberV1,
} from '../shared/schemas/cohorts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CohortTitleInputHashParams {
  /** The cohort run (final_membership_hash + execution Product Type). */
  run: CohortRun;
  /** Frozen per-member title authority (the persisted execution-evidence-v1 payload). */
  projection: ExecutionEvidenceProjectionV1;
  /** Frozen `cohort_title_consolidation` plan entry (H5 title slice); absent → registry consts. */
  titlePlanEntry?: ModelExecutionPlanEntry;
  /**
   * Frozen Execution Product Type authority (PR6 hardening C, issue #30
   * P1-3): the SAME `ExecutionTypeTitleAuthority` object the coordinated
   * prompt renders — id + label + confidence + outcome. A label change
   * changes the T-hash (the prompt would change, so re-coordination is
   * correct). Absent → a null authority is hashed (abstained/conflicted).
   */
  executionTypeAuthority?: ExecutionTypeTitleAuthority | null;
}

/**
 * ONE canonical Execution Product Type title authority (PR6 hardening C,
 * issue #30 P1-3): `{id, label, confidence, outcome}`. Both the T-hash and the
 * coordinated prompt consume THIS authority — the prompt renders `id` and
 * `label`, the hash covers all four fields, so hashed authority == prompted
 * authority by construction.
 */
export interface ExecutionTypeTitleAuthority {
  /** The frozen Execution Product Type id (null when abstained/conflicted). */
  id: string | null;
  /** The frozen product-type option's label for `id` (null when no matching option). */
  label: string | null;
  /** The frozen resolution confidence (0..1; null when unresolved). */
  confidence: number | null;
  /** The frozen resolution outcome marker (coherent | … | abstained; null when unresolved). */
  outcome: string | null;
}

/** The frozen member-snapshot slice the label lookup needs (structural — keeps
 *  the hash module decoupled from the full runtime snapshot). */
export type ExecutionTypeLabelSource = {
  productTypes: ReadonlyArray<{ id: string; name: string }>;
} | null;

/**
 * Build the canonical Execution Product Type title authority from the frozen
 * run row and (optionally) the ordinal-0 member's frozen runtime snapshot
 * (the label is the product-type option's name matched by id; null when the
 * run has no type id or the snapshot has no matching option).
 */
export function titleExecutionTypeAuthorityFromRun(
  run: CohortRun,
  memberSnapshot?: ExecutionTypeLabelSource | null,
): ExecutionTypeTitleAuthority {
  const id = run.executionProductTypeId;
  return {
    id,
    label:
      id && memberSnapshot
        ? (memberSnapshot.productTypes.find(pt => pt.id === id)?.name ?? null)
        : null,
    confidence: run.productTypeConfidence,
    outcome: run.productTypeOutcome,
  };
}

/**
 * The frozen title-relevant slice of one projection member. Every field here
 * participates in the T-hash; everything else on the member is excluded by
 * design (see the module JSDoc).
 */
export interface CohortTitleAuthorityMember {
  productSku: string | null;
  spreadsheetName: string;
  expectedName: string | null;
  brandHint: string | null;
  webTitle: string | null;
  webBrand: string | null;
  /** `ocr.packagingOcrData?.productName ?? packagingTitle` — the OCR packaging title. */
  packagingOcrTitle: string | null;
  /** Title-format-relevant OCR weight (DECISION-Q); null when OCR is absent. */
  ocrWeight: string | null;
  /** Title-format-relevant OCR flavor (DECISION-Q); null when OCR is absent. */
  ocrFlavor: string | null;
}

// ─── Pure builder ─────────────────────────────────────────────────────────────

/**
 * The member's frozen title-relevant slice (DECISION-Q). Reused by the parent
 * op and by tests. Deliberately narrow: excludes every non-title projection
 * field (description, images, provenance, evidence/OCR authority hashes).
 */
/**
 * Prompt-normalized truncation limits for title authority strings — the SAME
 * cutoffs the coordinated prompt renders (brand signals 200 chars, all other
 * title signals 500). `titleAuthorityFromProjectionMember` and the
 * coordinator's signals-ON mapping share these, so the hashed authority
 * equals the prompted authority by construction.
 */
export const TITLE_AUTHORITY_TRUNCATION = {
  brandMaxChars: 200,
  signalMaxChars: 500,
} as const;

/** Truncate a title-authority string to `maxChars` (null-safe). */
export function normalizeTitleAuthorityString(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

export function titleAuthorityFromProjectionMember(
  member: ExecutionEvidenceProjectionMemberV1,
): CohortTitleAuthorityMember {
  const ocr = member.extraction.ocr.packagingOcrData;
  const brandMax = TITLE_AUTHORITY_TRUNCATION.brandMaxChars;
  const signalMax = TITLE_AUTHORITY_TRUNCATION.signalMaxChars;
  return {
    productSku: member.productSku,
    spreadsheetName: normalizeTitleAuthorityString(member.spreadsheetIdentity.name, signalMax) ?? '',
    expectedName: normalizeTitleAuthorityString(member.spreadsheetIdentity.expectedName, signalMax),
    brandHint: normalizeTitleAuthorityString(member.spreadsheetIdentity.brandHint, brandMax),
    webTitle: normalizeTitleAuthorityString(member.extraction.title, signalMax),
    webBrand: normalizeTitleAuthorityString(member.extraction.brand, brandMax),
    packagingOcrTitle: normalizeTitleAuthorityString(ocr?.productName ?? member.extraction.packagingTitle, signalMax),
    ocrWeight: normalizeTitleAuthorityString(ocr?.weight ?? null, signalMax),
    ocrFlavor: normalizeTitleAuthorityString(ocr?.flavorVariety ?? null, signalMax),
  };
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Compute the canonical title input hash (T-hash) over the frozen title
 * authority: sorted-by-`onboardingItemId` member slices, the final
 * membership hash, the execution Product Type resolution, the FORMAT_RULES
 * digest, and the operation-specific model-execution authority for
 * `cohort_title_consolidation` (the frozen plan entry's provider/model/
 * versions — NO broad policy digest, PR13 DECISION-C — falling back to the
 * registry consts).
 *
 * Deterministic and pure — no DB access, no live item reads. Members are
 * sorted by onboardingItemId, so the hash is independent of input member
 * order.
 */
export function computeCohortTitleInputHash(params: CohortTitleInputHashParams): string {
  return computeCohortTitleInputHashForFormatRules(params, FORMAT_RULES);
}

/**
 * Parameterized internal: identical to `computeCohortTitleInputHash` but the
 * format-rules text is injectable, so tests can prove the FORMAT_RULES digest
 * participates without mutating the module constant.
 */
// fallow-ignore-next-line unused-export — used by tests
export function computeCohortTitleInputHashForFormatRules(
  params: CohortTitleInputHashParams,
  formatRules: string,
): string {
  const { run, projection, titlePlanEntry, executionTypeAuthority } = params;
  const members = [...projection.members]
    .sort((a, b) => a.onboardingItemId.localeCompare(b.onboardingItemId))
    .map(titleAuthorityFromProjectionMember);
  return hashCanonicalJson({
    version: 1,
    kind: 'curated_title',
    membership: run.finalMembershipHash,
    members,
    executionProductType: executionTypeAuthority ?? {
      id: run.executionProductTypeId,
      label: null,
      confidence: run.productTypeConfidence,
      outcome: run.productTypeOutcome,
    },
    titleFormatRulesDigest: hashCanonicalJson(formatRules),
    modelExecutionAuthority: {
      operation: 'cohort_title_consolidation',
      promptTemplateVersion:
        titlePlanEntry?.promptTemplateVersion ?? PROMPT_TEMPLATE_VERSIONS.cohort_title_consolidation,
      ruleVersion: titlePlanEntry?.ruleVersion ?? RULE_VERSIONS.cohort_title_consolidation,
      provider: titlePlanEntry?.provider ?? null,
      model: titlePlanEntry?.model ?? null,
    },
  });
}
