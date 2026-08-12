/**
 * Cohort Semantic Validator (issue #30 PR9) — PURE / deterministic module.
 *
 * Validates a finalized cohort against its FROZEN semantic authority using
 * the curation target scope model (ADR 0013 + `src/shared/schemas/cohorts.ts`
 * `CurationTargetScopeEnum`):
 *
 * - `family_invariant` — canonical Brand + Primary Product Type must resolve
 *   identically across finalized members. A disagreement is a HARD cohort
 *   semantic failure (never normalized away): `family_product_type` /
 *   `family_brand` findings.
 * - `coordinated_variant` — curated title + Category Pages are computed once
 *   per cohort revision; individual member answers legitimately differ.
 *   Validation is CONTRACT CORRESPONDENCE ONLY: the member's title/page
 *   output must correspond to the PARENT DURABLE output assigned to that SKU
 *   (`curated_title` / `coordinated_page` rows) — sibling equality is NEVER
 *   checked. Title/page VARIANT differences between siblings always pass.
 * - `member_local` — attribute applicability under the member's effective
 *   Curation Product Type/profile: every non-universal `field_assignment`
 *   target must be profile-applicable; universal attributes are exempt
 *   (type-independent). Cardinality is re-checked defense-in-depth only
 *   (`validateProposalSafety` in `proposal-safety.ts` already throws first).
 *
 * FROZEN-ONLY CONTRACT: every input is passed in from frozen authority (the
 * parent run row, the persisted execution-evidence snapshot, the durable
 * cohort output rows, the member's committed curation data). This module has
 * NO database access — nothing here may read live batch/config/evidence
 * state, and the inputs must never be derived from a live re-grouping.
 *
 * BLOCKED-NOT-DESTROYED: hard findings produce `status: 'blocked'` — the
 * member's curationData + proposals are NEVER destroyed. The review
 * completion gate refuses blocked items (`semantic_validation_blocked`,
 * review-completion-gate.ts), while the curationData carries the findings
 * for the Review UX (PR10).
 */
import { normalizeBrand } from '../onboarding/product-line-grouper';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type CohortSemanticFindingCode =
  | 'family_product_type'
  | 'family_brand'
  | 'coordinated_title'
  | 'coordinated_page'
  | 'member_attribute_applicability'
  | 'member_cardinality';

export interface CohortSemanticFinding {
  code: CohortSemanticFindingCode;
  memberSku: string;
  message: string;
}

export interface CohortSemanticFindings {
  status: 'passed' | 'blocked';
  findings: CohortSemanticFinding[];
}

/** The parent durable `coordinated_page` output payload for one SKU. */
export type DurablePageOutput =
  | { status: 'assigned'; pages: Array<{ pageId: string; pageName: string; confidence: number }> }
  | { status: 'abstained'; reason: string };

// ─── Shared helpers ────────────────────────────────────────────────────────────

function passed(): CohortSemanticFindings {
  return { status: 'passed', findings: [] };
}

function toFindings(findings: CohortSemanticFinding[]): CohortSemanticFindings {
  return findings.length > 0 ? { status: 'blocked', findings } : passed();
}

/** Canonical set comparison (order-insensitive, deterministic). */
function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

// ─── family_invariant + coordinated_variant (per member) ─────────────────────

export interface MemberSemanticsInput {
  memberSku: string;
  /**
   * The frozen parent authority: the cohort Execution Product Type
   * (id + label from the parent run row + frozen snapshot).
   */
  parentExecutionType: { id: string | null; label: string | null };
  /** The member's curated title (curationData.curatedTitle). */
  curatedTitle: string | null;
  /** The member's title source (curationData.titleSource). */
  titleSource: string | null;
  /** The member's suggested Category Pages (curationData.suggestedPages). */
  suggestedPages: string[];
  /** The member's suggested Primary Product Type (curationData.suggestedProductType). */
  suggestedProductType: string | null;
  /**
   * The parent durable `curated_title` output for this SKU, or null. Only
   * multi-item group members have entries (singletons are never coordinated —
   * DECISION-O); a member with a cohort-coordinated titleSource and no
   * durable output is semantically inconsistent.
   */
  durableTitleOutput?: { title: string; source: 'llm_cohort' | 'cohort_fallback' } | null;
  /**
   * The parent durable `coordinated_page` output for this SKU, or null.
   * Pages cover ALL members (DECISION-A), so a missing row (without an
   * expected-empty marker) is a finding — PR8 already fails those members
   * closed, this re-asserts the correspondence.
   */
  durablePageOutput?: DurablePageOutput | null;
  /**
   * True when the parent page op chose EXPECTED-EMPTY (page target disabled
   * or no verified pages — DECISION-C): no output rows by design, members
   * abstain deterministically with zero pages.
   */
  pageOutputExpectedEmpty?: boolean;
}

const COORDINATED_TITLE_SOURCES = new Set(['llm_cohort', 'cohort_fallback']);

/**
 * Per-member family_invariant + coordinated_variant checks. NEVER compares
 * siblings to each other: every check is the member's own output against the
 * parent authority / the parent durable output assigned to that SKU.
 */
export function validateMemberSemantics(
  input: MemberSemanticsInput,
): CohortSemanticFindings {
  const findings: CohortSemanticFinding[] = [];
  const { memberSku } = input;

  // ── family_invariant: Primary Product Type vs the parent authority ───────
  // The cohort Execution Product Type is the family authority; a member whose
  // suggested type disagrees is a hard semantic failure. A member with NO
  // suggested type abstains on the family invariant (the pipeline's type
  // stage may legitimately abstain when the member's extraction evidence is
  // inconclusive — the freeze resolver sees the spreadsheet name, the member
  // pipeline only the extraction evidence) — an abstention is never a
  // conflict. When the parent has no execution type (abstained/conflicted
  // run), there is no family authority to enforce against.
  if (
    input.parentExecutionType.id !== null &&
    input.parentExecutionType.id.length > 0 &&
    input.suggestedProductType !== null &&
    input.suggestedProductType.length > 0
  ) {
    if (input.suggestedProductType !== input.parentExecutionType.id) {
      const label = input.parentExecutionType.label
        ? ` (${input.parentExecutionType.label})`
        : '';
      findings.push({
        code: 'family_product_type',
        memberSku,
        message:
          `Primary Product Type "${input.suggestedProductType}" does not match the ` +
          `family invariant (cohort Execution Product Type "${input.parentExecutionType.id}"${label}).`,
      });
    }
  }

  // ── coordinated_variant: title correspondence to the durable output ──────
  if (input.durableTitleOutput) {
    const sourceOk = input.titleSource !== null && COORDINATED_TITLE_SOURCES.has(input.titleSource);
    if (input.curatedTitle !== input.durableTitleOutput.title || !sourceOk) {
      findings.push({
        code: 'coordinated_title',
        memberSku,
        message:
          `Curated title "${input.curatedTitle ?? '(none)'}" (source=${input.titleSource ?? 'none'}) ` +
          `does not correspond to the parent durable coordinated title ` +
          `"${input.durableTitleOutput.title}" (source=${input.durableTitleOutput.source}) for this SKU.`,
      });
    }
  } else if (input.titleSource !== null && COORDINATED_TITLE_SOURCES.has(input.titleSource)) {
    // A title that CLAIMS cohort coordination must have a durable parent
    // output — a coordinated title without one is a semantic inconsistency
    // (singleton/per-item titles carry non-cohort sources and pass here).
    findings.push({
      code: 'coordinated_title',
      memberSku,
      message:
        `Curated title claims cohort coordination (titleSource="${input.titleSource}") but no ` +
        'durable parent curated_title output exists for this SKU.',
    });
  }

  // ── coordinated_variant: page correspondence to the durable output ───────
  if (input.durablePageOutput) {
    if (input.durablePageOutput.status === 'assigned') {
      const storedPageNames = input.durablePageOutput.pages.map(page => page.pageName);
      if (!sameStringSet(input.suggestedPages, storedPageNames)) {
        findings.push({
          code: 'coordinated_page',
          memberSku,
          message:
            `Suggested pages [${input.suggestedPages.join(', ')}] do not exactly match the parent ` +
            `durable coordinated_page assignment [${storedPageNames.join(', ')}] for this SKU.`,
        });
      }
    } else {
      // Abstained durable row ⇒ the member must carry zero pages.
      if (input.suggestedPages.length > 0) {
        findings.push({
          code: 'coordinated_page',
          memberSku,
          message:
            `Parent coordinated_page output abstained, but the member carries suggested pages ` +
            `[${input.suggestedPages.join(', ')}].`,
        });
      }
    }
  } else if (!input.pageOutputExpectedEmpty) {
    // Missing durable page row without the expected-empty marker — PR8 fails
    // the member closed; the validator re-asserts the correspondence.
    findings.push({
      code: 'coordinated_page',
      memberSku,
      message:
        'No parent coordinated_page output exists for this SKU (missing durable row); ' +
        'the member carries no valid page authority.',
    });
  }

  return toFindings(findings);
}

// ─── member_local: profile applicability + cardinality (defense-in-depth) ─────

export interface MemberLocalProposal {
  targetId: string | null;
  /** The proposal's proposed value (used for canonical-value de-dup). */
  proposedValue?: unknown;
  /** Effective reviewer-corrected value (canonical when present). */
  revisedValue?: unknown;
  hasRevisedValue?: boolean;
}

export interface MemberLocalAttributesInput {
  memberSku: string;
  /** field_assignment proposals ONLY (the caller filters). */
  proposals: MemberLocalProposal[];
  /** The member's effective Curation Product Type id (null = none). */
  effectiveTypeId: string | null;
  /** The frozen snapshot attribute config. */
  attributeConfig: Array<{ id: string; isUniversal?: boolean }>;
  /** Universal attribute ids (type-independent applicability — exempt). */
  universalAttributeIds: Set<string> | string[];
  /**
   * The effective type's profile attribute ids resolved from the FROZEN
   * snapshot (null only when there is no effective type). An effective type
   * with a legitimately EMPTY profile passes an EMPTY set — every
   * non-universal target is then not_applicable.
   */
  profileAttributeIds?: Set<string> | null;
  /**
   * Profile-declared cardinality per attribute id (frozen). Unknown
   * attributes default to 'single' per the profile schema; universal
   * attributes outside the profile are never assumed single.
   */
  cardinalityByAttributeId?: Map<string, 'single' | 'multiple'>;
}

/**
 * member_local re-validation: every non-universal `field_assignment` target
 * must be profile-applicable under the member's effective type; universal
 * attributes are exempt; cardinality is re-checked defense-in-depth (the
 * pipeline's `validateProposalSafety` already throws first — this only
 * records a finding if a proposal set somehow passed with a breach).
 * Cross-sibling member_local equality is NEVER required.
 */
export function validateMemberLocalAttributes(
  input: MemberLocalAttributesInput,
): CohortSemanticFindings {
  const findings: CohortSemanticFinding[] = [];
  const { memberSku } = input;
  const universal = new Set<string>(input.universalAttributeIds);
  const profile = input.profileAttributeIds ?? null;
  const cardinality = input.cardinalityByAttributeId ?? new Map<string, 'single' | 'multiple'>();
  const effectiveTypeId =
    input.effectiveTypeId !== null && input.effectiveTypeId.length > 0
      ? input.effectiveTypeId
      : null;

  const attributeFor = (id: string) => input.attributeConfig.find(candidate => candidate.id === id);
  const isUniversal = (id: string) =>
    universal.has(id) || attributeFor(id)?.isUniversal === true;

  // Cardinality re-check inputs: DISTINCT canonical values per target id. A
  // re-executed member (crash between pipeline completion and the atomic
  // commit) legitimately accumulates IDENTICAL proposals from earlier
  // attempts on the same child run — those are an audit artifact, never a
  // semantic breach. Two DIFFERENT values for a single-cardinality attribute
  // are the breach this defense-in-depth check is here to catch.
  const canonicalValueOf = (proposal: MemberLocalProposal): unknown =>
    proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
  const distinctValuesByTarget = new Map<string, Set<string>>();
  for (const proposal of input.proposals) {
    if (!proposal.targetId) continue;
    const valueKey = JSON.stringify(canonicalValueOf(proposal));
    if (!distinctValuesByTarget.has(proposal.targetId)) {
      distinctValuesByTarget.set(proposal.targetId, new Set());
    }
    distinctValuesByTarget.get(proposal.targetId)!.add(valueKey);
  }

  for (const proposal of input.proposals) {
    if (!proposal.targetId) {
      findings.push({
        code: 'member_attribute_applicability',
        memberSku,
        message: 'A field_assignment proposal carries no target attribute id; applicability cannot be established.',
      });
      continue;
    }
    if (isUniversal(proposal.targetId)) continue;

    if (effectiveTypeId === null) {
      findings.push({
        code: 'member_attribute_applicability',
        memberSku,
        message:
          `Field assignment targets "${proposal.targetId}" but no effective Curation Product Type exists; ` +
          'the non-universal attribute cannot be applicable.',
      });
      continue;
    }

    if (profile === null || !profile.has(proposal.targetId)) {
      // Fail closed: a non-universal proposal outside the effective type's
      // profile (or with an unresolvable profile) is inapplicable.
      findings.push({
        code: 'member_attribute_applicability',
        memberSku,
        message:
          `Field assignment targets "${proposal.targetId}" which is not profile-applicable under ` +
          `the effective Curation Product Type "${effectiveTypeId}".`,
      });
    }
  }

  // Cardinality re-check (defense-in-depth): more than one DISTINCT value
  // for a single-cardinality attribute is a breach the pipeline should
  // already have thrown on.
  for (const [targetId, values] of distinctValuesByTarget) {
    if (values.size <= 1) continue;
    const declared = cardinality.get(targetId);
    let effectiveCardinality: 'single' | 'multiple';
    if (declared) {
      effectiveCardinality = declared;
    } else if (isUniversal(targetId)) {
      // Universal attribute with no profile entry: never assume single.
      effectiveCardinality = 'multiple';
    } else {
      // Profile attribute default per the schema.
      effectiveCardinality = 'single';
    }
    if (effectiveCardinality === 'single') {
      findings.push({
        code: 'member_cardinality',
        memberSku,
        message:
          `Attribute "${targetId}" received ${values.size} distinct field_assignment value(s) but is single-cardinality.`,
      });
    }
  }

  return toFindings(findings);
}

// ─── family_invariant: mutual Brand coherence (post-loop) ────────────────────

export interface CohortBrandMemberInput {
  sku: string;
  /**
   * FROZEN brand evidence for the member (normalizeBrand is applied; empty
   * values are ignored). The canonical brand is the deterministic majority
   * over ALL members' normalized evidence — never a live batch read.
   */
  frozenBrandEvidence: Array<string | null | undefined>;
}

/**
 * Cohort-level mutual Brand coherence. The canonical brand is the
 * deterministic majority over normalizeBrand of the FROZEN member brand
 * evidence; a tie (or an empty evidence set) blocks with the tie listed, and
 * every member whose evidence conflicts with the canonical brand is blocked.
 * A singleton cohort follows the same architecture: its evidence IS the
 * canonical brand, so only an internal evidence conflict blocks it.
 */
export function validateCohortBrandCoherence(
  members: CohortBrandMemberInput[],
): CohortSemanticFindings {
  const findings: CohortSemanticFinding[] = [];

  // Deterministic majority over normalizeBrand of frozen evidence.
  const normalizedByMember = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const member of members) {
    const brands = new Set<string>();
    for (const evidence of member.frozenBrandEvidence) {
      const normalized = normalizeBrand(evidence);
      if (!normalized) continue;
      brands.add(normalized);
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    normalizedByMember.set(member.sku, brands);
  }

  const distinctBrands = [...counts.keys()];
  if (distinctBrands.length === 0) return passed();

  // Stable ordering so the tie list is deterministic.
  const sortedByCount = [...distinctBrands].sort((a, b) => {
    const diff = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  const topCount = counts.get(sortedByCount[0]) ?? 0;
  const tiedBrands = sortedByCount.filter(brand => (counts.get(brand) ?? 0) === topCount);
  const isTie = tiedBrands.length > 1;

  if (isTie) {
    // The canonical brand is unresolved: every member whose evidence
    // participates in the tie is blocked (the finding lists the tie).
    const tiedSet = new Set(tiedBrands);
    for (const member of members) {
      const memberBrands = normalizedByMember.get(member.sku) ?? new Set<string>();
      if ([...memberBrands].some(brand => tiedSet.has(brand))) {
        findings.push({
          code: 'family_brand',
          memberSku: member.sku,
          message:
            `Brand evidence ties across the cohort (tied canonical brands: ${tiedBrands.join(', ')}); ` +
            'the family Brand invariant is unresolved.',
        });
      }
    }
  } else {
    const canonicalBrand = sortedByCount[0];
    for (const member of members) {
      const memberBrands = normalizedByMember.get(member.sku) ?? new Set<string>();
      const conflicting = [...memberBrands].filter(brand => brand !== canonicalBrand);
      for (const conflict of conflicting) {
        findings.push({
          code: 'family_brand',
          memberSku: member.sku,
          message:
            `Member brand "${conflict}" conflicts with the canonical cohort Brand "${canonicalBrand}".`,
        });
      }
    }
  }

  return toFindings(findings);
}
