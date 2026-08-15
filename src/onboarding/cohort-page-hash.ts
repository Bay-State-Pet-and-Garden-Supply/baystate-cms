/**
 * Canonical cohort Page input hash (issue #30, PR7 C2) — the "P-hash".
 *
 * PURE module (mirroring `cohort-title-hash.ts`): `computeCohortPageInputHash`
 * derives a canonical SHA-256 from FROZEN PAGE AUTHORITY ONLY
 * (architecture-report §3, DECISION-B). It is the per-row `input_hash` of the
 * durable `classification_cohort_outputs` rows for output_kind
 * 'coordinated_page' and the reuse key of the parent
 * `ensureCohortPagesCoordinated` op: outputs for a run are reusable iff EVERY
 * member (groups AND singletons — the P-set, DECISION-A) has a row AND every
 * row's input hash matches the freshly computed P-hash. The hash is
 * recomputed on every `processCohort` entry (cheap, pure); a mismatch against
 * a committed output set is WRITE-ONCE drift: the parent op FAILS CLOSED with
 * `CohortPageAuthorityDriftError` — the set is never re-coordinated or
 * replaced, and the run terminates deterministically.
 *
 * REPLAY CONTRACT (mirrors titles): at most one ACTIVE Page coordination call
 * at a time; a crash between transport success and the output-set commit may
 * cause ANOTHER independently audited invocation (no retry cap — each
 * pre-commit crash repeats this); only a successful commit makes later
 * entries call-free (replay-safe after commit).
 *
 * PROMPT-AUTHORITY CONSTRUCTION RULE (PR6 hardening C/D applied to pages):
 * ONE normalized authority object is BOTH hashed and rendered. The per-member
 * slice (`pageAuthorityFromProjectionMember`) applies the SAME truncation
 * constants the v2 prompt renders (`PAGE_AUTHORITY_TRUNCATION` +
 * `normalizePageAuthorityString`) — so a suffix-only mutation beyond a cutoff
 * changes NEITHER the P-hash NOR the rendered authority slice. The slice is
 * derived from the frozen projection member exactly the way the frozen
 * `ProductLineItemSnapshot` (page-coordination input) is built: `name` from
 * the spreadsheet identity, `brand` from the spreadsheet brandHint (never the
 * web-extracted brand), and species/flavor/lifeStage/productForm/healthConcern
 * from the packaging-OCR data.
 *
 * OPERATION-SPECIFIC MODEL AUTHORITY (DECISION-B + PR7 review R2 F2c): the
 * P-hash covers the `{provider, model}` from the FROZEN model-execution-plan
 * entry for `cohort_page_assignment_parent` (never live
 * `getLlmConfigForTask` — see the FROZEN-PLAN MODEL AUTHORITY note below) —
 * NOT the broad `policyDigest` P2 the T-hash carries (the Page projection is
 * genuinely operation-specific from day one). Unconfigured (no plan entry /
 * no policy route) resolves to null and is hashed as null.
 *
 * HASH ONLY FROZEN PAGE AUTHORITY — explicit exclusions (mirroring titles):
 * - NO live `onboarding_items` rows, stage/status, `curation_data_json`, or
 *   `updated_at` — members come strictly from `projection.members`.
 * - NO cache-key shape (`stableKey` in cohort-page-coordinator): the old
 *   string fingerprint + `modelIdentity {provider, model, policyDigest}` is
 *   replaced by this structured canonical JSON.
 * - NO non-page projection fields: `bulletPoints`, `searchKeywords`,
 *   `customFields`, `fieldProvenance`, `piEvidence`, `evidenceHash`,
 *   `ocrInputHash` / `ocrExecutionDigest` (OCR provenance), images.
 * - Milestone E EXCEPTION: the narrow source-kind/provenance binding slice
 *   (`sourceProvenance` — see cohort-title-hash.ts) DOES participate in the
 *   P-hash as input identity. It is intentionally NOT rendered into the page
 *   prompt (the rendered context stays product-line semantics); the
 *   hashed-authority == prompted-authority rule therefore applies to the
 *   rendered page fields only, with the source binding as a strict
 *   identity gate on top. V1 members normalize to official_page.
 * - NO `modelPolicyDigest` (titles' P2); the page model authority is the
 *   operation-specific `{provider, model}` slice only.
 *
 * FROZEN-PLAN MODEL AUTHORITY (PR7 review R2, F2c — P1-C): the P-hash model
 * authority + rule version NEVER come from live credentials. They are derived
 * from the ordinal-0 member runtime snapshot's FROZEN model-execution-plan
 * entry for the parent operation `cohort_page_assignment_parent` — so a
 * mid-flight credential lookup failure or a live policy change can never flip
 * the hash and needlessly supersede a committed decision. `buildCohortPageAuthorityBundle`
 * resolves the `modelExecutionAuthority` ({provider, model, promptTemplateVersion,
 * ruleVersion} — ALL four from the SAME frozen plan entry) when a snapshot is
 * supplied; the parent op always supplies the frozen ordinal-0 snapshot. Both
 * semantic versions participate in the P-hash, so a prompt-template bump
 * changes the hash even when rules/provider/model are unchanged — the hash
 * hardcodes no page version of its own.
 */
import { hashCanonicalJson } from '../shared/stable-id';
import { getModelExecutionPlanEntry, type RuntimeClassificationSnapshot } from '../classification/runtime-snapshot';
import type { ProductLineItemSnapshot } from '../classification/types';
import {
  type ExecutionTypeTitleAuthority,
  type SourceProvenanceSlice,
  sourceProvenanceFromMember,
} from './cohort-title-hash';
import type {
  CohortRun,
  ExecutionEvidenceProjection,
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
} from '../shared/schemas/cohorts';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Prompt-normalized truncation limits for Page authority strings — the SAME
 * cutoffs the v2 coordinated Page prompt renders (name/webTitle 500, brand
 * 200, description 1500). `pageAuthorityFromProjectionMember` and the
 * prompt's per-member rendering share these, so the hashed authority equals
 * the prompted authority by construction.
 */
export const PAGE_AUTHORITY_TRUNCATION = {
  name: 500,
  webTitle: 500,
  brand: 200,
  description: 1500,
} as const;

/** Truncate a Page authority string to `maxChars` (null-safe). */
export function normalizePageAuthorityString(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The frozen page-relevant slice of one projection member. Every field here
 * participates in the P-hash; everything else on the member is excluded by
 * design (see the module JSDoc).
 */
export interface CohortPageAuthorityMember {
  /** `productSku ?? ''` — the onboarding key the output rows are keyed by. */
  sku: string;
  /** `spreadsheetIdentity.name` (truncated at 500). */
  name: string;
  /** `extraction.title` (truncated at 500); null when absent. */
  webTitle: string | null;
  /** `spreadsheetIdentity.brandHint` (truncated at 200) — never the web-extracted brand. */
  brand: string | null;
  /** `extraction.description` (truncated at 1500); '' when absent. */
  description: string;
  /** OCR species, sorted for determinism. */
  species: string[];
  /** OCR flavor (packagingOcrData.flavorVariety); null when absent. */
  flavor: string | null;
  /** OCR life stage; null when absent. */
  lifeStage: string | null;
  /** OCR product form; null when absent. */
  productForm: string | null;
  /** OCR health-concern functions, sorted for determinism. */
  healthConcern: string[];
  /**
   * Milestone E: source-kind/provenance binding (see
   * `sourceProvenanceFromMember` in cohort-title-hash.ts). Distributor-record
   * members are a different page input identity than official-page members;
   * generation/attempt/hash drift changes the P-hash so stale evidence is
   * never reused for page assignment. V1 members normalize to official_page.
   */
  sourceProvenance: SourceProvenanceSlice;
}

/** The frozen operation-specific Page model authority (DECISION-B). */
export interface CohortPageModelAuthority {
  provider: string;
  model: string;
}

/**
 * The frozen operation-specific Page model-EXECUTION authority (PR7 review
 * round 3, P1): provider/model AND both independent semantic versions
 * (promptTemplateVersion + ruleVersion) from the SAME frozen
 * `cohort_page_assignment_parent` model-execution-plan entry. The registry
 * treats the two versions as independently bumpable (prompt text vs
 * deterministic post-processing), so BOTH participate in the P-hash — a
 * prompt-template bump that changes the Page decision must change the hash
 * even when rules/provider/model are unchanged.
 */
export interface CohortPageModelExecutionAuthority {
  provider: string;
  model: string;
  promptTemplateVersion: string;
  ruleVersion: string;
}

/** The frozen page-catalog + selection slice the P-hash covers (H4 Page
 *  catalog is deliberately NOT in the hash — only the exact list the prompt
 *  renders, sorted by id). */
export interface CohortPagePlanAuthority {
  /** Frozen page list: `{id, name, parentName}` — the prompt renders the same list. */
  pages: Array<{ id: string; name: string; parentName: string | null }>;
  /** Frozen per-target selection mode. */
  selectionMode: 'single' | 'multiple';
  /** Frozen per-target max pages. */
  maxPages: number;
}

/**
 * ONE canonical cohort-Page authority bundle (PR7 review R1, B2): the SINGLE
 * normalized object set that BOTH the P-hash and the parent v2 prompt consume.
 * Built once per `ensureCohortPagesCoordinated` entry from the frozen inputs,
 * then passed to `computeCohortPageInputHash` AND to the parent prompt path
 * (`coordinateCohortPagesCore`'s `executionTypeContext` option + the
 * bundle-derived products/pages/selection) — so hashed authority == prompted
 * authority BY CONSTRUCTION: no duplicated truncation literals, no order
 * dependence (members sorted by sku, pages by id, species/healthConcern
 * arrays sorted).
 */
export interface CohortPageAuthorityBundle {
  /** Canonical P-set membership + per-member normalized authority slices,
   *  sorted by sku; species/healthConcern arrays sorted. */
  members: CohortPageAuthorityMember[];
  /** Frozen page list sorted by id. */
  pages: Array<{ id: string; name: string; parentName: string | null }>;
  /** Frozen per-target selection. */
  selection: { selectionMode: 'single' | 'multiple'; maxPages: number };
  /** The frozen Execution Product Type authority (id+label+confidence+outcome). */
  executionTypeAuthority: ExecutionTypeTitleAuthority;
  /** The frozen operation-specific Page model-EXECUTION authority (from the
   *  frozen model-execution-plan entry — provider, model, prompt-template
   *  version, rule version); null when unconfigured / no plan entry. */
  modelExecutionAuthority: CohortPageModelExecutionAuthority | null;
}

export interface CohortPageAuthorityBundleParams {
  /** The cohort run (execution Product Type resolution). */
  run: CohortRun;
  /** Frozen per-member Page authority (the persisted execution-evidence-v1 payload). */
  projection: ExecutionEvidenceProjection;
  /** Frozen product-line sibling context (contract symmetry — the canonical
   *  members are normalized from the projection via
   *  `pageAuthorityFromProjectionMember`; the bundle output is the ONE
   *  authority both the P-hash and the parent prompt consume). */
  frozenLineContext?: { productLineItems: ProductLineItemSnapshot[] } | null;
  /** Frozen verified page catalog (contract symmetry — the canonical page
   *  list is `pagePlan.pages`, sorted by id). */
  pageCatalog?: Array<{ id: string; name: string; parentName: string | null }> | null;
  /** Frozen page list + selection mode/maxPages (per-target config, frozen). */
  pagePlan: CohortPagePlanAuthority;
  /**
   * Frozen Execution Product Type authority (the SAME
   * `ExecutionTypeTitleAuthority` object the v2 prompt's Execution Type
   * context renders — `titleExecutionTypeAuthorityFromRun`). Absent → the
   * run-fallback authority is built (abstained/conflicted).
   */
  executionTypeAuthority?: ExecutionTypeTitleAuthority | null;
  /**
   * PR7 review R2 (F2c): the frozen ordinal-0 member runtime snapshot the
   * parent op passes in. The `modelExecutionAuthority` (provider, model,
   * prompt-template version, rule version) is derived from the frozen
   * model-execution-plan entry for `cohort_page_assignment_parent` — NEVER
   * live credentials. Absent for direct/test construction.
   */
  snapshot?: RuntimeClassificationSnapshot | null;
  /**
   * Explicit frozen operation-specific Page model-EXECUTION authority
   * (DECISION-B); null when unconfigured — still hashed as null. Overrides
   * the snapshot-derived authority (tests/direct construction). In production
   * this ALWAYS comes from the frozen plan entry (provider + model + BOTH
   * semantic versions).
   */
  modelExecutionAuthority?: CohortPageModelExecutionAuthority | null;
}

/**
 * Build the single canonical authority bundle (PR7 review R1, B2). Both the
 * P-hash and the parent v2 prompt consume this exact bundle: members are
 * normalized via `pageAuthorityFromProjectionMember` and sorted by sku, pages
 * are sorted by id, species/healthConcern arrays are sorted — so any
 * reordering of the raw inputs changes NEITHER the hash NOR the rendered
 * prompt.
 *
 * PR7 review R2 (F2c / P1-C): when `snapshot` is supplied, the bundle's
 * `modelExecutionAuthority` comes from the frozen model-execution-plan entry
 * for `cohort_page_assignment_parent` (provider + model + promptTemplateVersion
 * + ruleVersion — ALL four from the same entry) — the P-hash therefore never
 * touches live credential/config resolution, and a prompt-template bump that
 * can change the Page decision changes the P-hash even when rules and
 * provider/model are unchanged.
 */
export function buildCohortPageAuthorityBundle(
  params: CohortPageAuthorityBundleParams,
): CohortPageAuthorityBundle {
  const { run, projection, pagePlan, executionTypeAuthority, snapshot } = params;
  // FROZEN-PLAN authority: the plan entry's provider/model + BOTH semantic
  // versions are the authority of the P-hash (never live credentials). A
  // missing entry (legacy schema-v1 snapshot, pre-change registry-v1 plan)
  // resolves to null — production always reaches the entry (the parent op
  // fails closed otherwise).
  const planEntry = snapshot
    ? getModelExecutionPlanEntry(snapshot, 'cohort_page_assignment_parent')
    : null;
  const modelExecutionAuthority =
    params.modelExecutionAuthority ??
    (planEntry
      ? {
          provider: planEntry.provider,
          model: planEntry.model,
          promptTemplateVersion: planEntry.promptTemplateVersion,
          ruleVersion: planEntry.ruleVersion,
        }
      : null);
  const members = [...projection.members]
    .map(pageAuthorityFromProjectionMember)
    .sort((a, b) => a.sku.localeCompare(b.sku));
  const pages = [...pagePlan.pages].sort((a, b) => a.id.localeCompare(b.id));
  return {
    members,
    pages,
    selection: { selectionMode: pagePlan.selectionMode, maxPages: pagePlan.maxPages },
    executionTypeAuthority: executionTypeAuthority ?? {
      id: run.executionProductTypeId,
      label: null,
      confidence: run.productTypeConfidence,
      outcome: run.productTypeOutcome,
    },
    modelExecutionAuthority,
  };
}

/**
 * Bridge the canonical bundle member back to the `ProductLineItemSnapshot`
 * shape the coordinated Page prompt renders (PR7 review R1, B2). The parent
 * path builds its core params FROM the bundle members (normalized, sorted)
 * instead of re-deriving from the raw frozen line context, so the rendered
 * prompt text is fully determined by the hashed objects.
 */
export function pageAuthorityMemberToSnapshot(
  member: CohortPageAuthorityMember,
): ProductLineItemSnapshot {
  return {
    sku: member.sku,
    name: member.name,
    webTitle: member.webTitle,
    brand: member.brand,
    description: member.description,
    species: [...member.species],
    flavor: member.flavor,
    lifeStage: member.lifeStage,
    productForm: member.productForm,
    healthConcern: [...member.healthConcern],
  };
}

// ─── Pure builders ────────────────────────────────────────────────────────────

/**
 * The member's frozen page-relevant slice (the exact slice the v2 prompt
 * renders). Species + health-concern arrays are sorted so the hashed
 * authority is independent of OCR array order.
 */
export function pageAuthorityFromProjectionMember(
  member: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2,
): CohortPageAuthorityMember {
  const ocr = member.extraction.ocr.packagingOcrData;
  const trunc = PAGE_AUTHORITY_TRUNCATION;
  return {
    sku: member.productSku ?? '',
    name: normalizePageAuthorityString(member.spreadsheetIdentity.name, trunc.name) ?? '',
    webTitle: normalizePageAuthorityString(member.extraction.title, trunc.webTitle),
    brand: normalizePageAuthorityString(member.spreadsheetIdentity.brandHint, trunc.brand),
    description: normalizePageAuthorityString(member.extraction.description, trunc.description) ?? '',
    species: [...(ocr?.species ?? [])].sort(),
    flavor: ocr?.flavorVariety ?? null,
    lifeStage: ocr?.lifeStage ?? null,
    productForm: ocr?.productForm ?? null,
    healthConcern: [...(ocr?.healthConcernFunction ?? [])].sort(),
    // Milestone E: source-kind/provenance binding participates in the P-hash.
    sourceProvenance: sourceProvenanceFromMember(member),
  };
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Compute the canonical cohort Page input hash (P-hash) over the frozen Page
 * authority bundle (PR7 review R1, B2): the sorted P-set member SKUs, the
 * per-member normalized authority slices, the execution Product Type
 * authority, the sorted frozen page list + selection mode/maxPages, the
 * prompt/rule version (the frozen plan entry's ruleVersion — F2c), and the
 * frozen operation-specific model authority.
 *
 * Consumes ONLY the canonical `CohortPageAuthorityBundle` — the SAME bundle
 * the parent v2 prompt renders — so hashed authority == prompted authority
 * by construction. Deterministic and pure — no DB access, no live item reads,
 * no live credential resolution. The model-EXECUTION authority (provider,
 * model, promptTemplateVersion, ruleVersion — ALL four from the frozen plan
 * entry) participates as ONE object, so a prompt-template bump changes the
 * P-hash even when rules/provider/model are unchanged (PR7 review round 3,
 * P1).
 */
export function computeCohortPageInputHash(bundle: CohortPageAuthorityBundle): string {
  return hashCanonicalJson({
    version: 1,
    kind: 'coordinated_page',
    membership: bundle.members.map(member => member.sku),
    members: bundle.members,
    executionProductType: bundle.executionTypeAuthority,
    pages: bundle.pages,
    selection: bundle.selection,
    modelExecutionAuthority: bundle.modelExecutionAuthority ?? null,
  });
}
