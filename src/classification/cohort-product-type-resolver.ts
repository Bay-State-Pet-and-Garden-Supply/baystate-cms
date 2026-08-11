/**
 * Cohort-level Execution Product Type resolver (issue #30 PR4 C3).
 *
 * PURE module: builds per-member frozen evidence, runs the deterministic
 * keyword match, aggregates the family outcome, and validates family
 * invariants — with NO DB reads, NO model calls, and NO persistence. The
 * freeze-time integration (write-once `execution_product_type_id` +
 * `final_membership_hash` in the final CAS transaction) lives in the next
 * commit (C4a); this module is only invoked from there.
 *
 * Inputs are fully frozen (architecture-report §2.1):
 * - per-member `execution-evidence-v1` projections (`spreadsheetIdentity` +
 *   `extraction` + frozen packaging OCR);
 * - each member's immutable runtime snapshot (product type options resolved
 *   via `resolveTargetsFromSnapshot` — a pure snapshot reader; the
 *   DB-backed `resolveEnabledTargets` is never called here).
 *
 * Aggregation (architecture-report §2.2, DECISION-C; no majority forcing):
 * - all confident members agree               -> `coherent`
 * - >=1 confident match, >=1 abstainer, no
 *   contradiction                             -> `coherent_with_abstentions`
 * - >=2 confident DISTINCT ids                -> `conflicted` (id never picked)
 * - no confident match                        -> `abstained`
 * A member result below `confidenceFloor` counts as an abstention.
 */
import { randomUUID } from 'node:crypto';
import { hashCanonicalJson } from '../shared/stable-id';
import type {
  ClassificationEvidence,
  BrandConfig,
} from '../shared/schemas/classification';
import type { PackagingOcrData } from '../shared/schemas/onboarding';
import type {
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionV1,
} from '../shared/schemas/cohorts';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { matchKeywordOptions } from './curation-target-matcher';
import { buildEvidenceTargetPacket } from './evidence-targeting';
import { resolveTargetsFromSnapshot, type ResolvedTargetOption } from './curation-target-resolver';
import { resolveBrand } from './brand-resolution';

const now = () => new Date().toISOString();

/**
 * Deterministic keyword-match confidence floor. Mirrors the per-SKU stage
 * constant (`KEYWORD_MATCH_MIN_CONFIDENCE = 0.7`,
 * `src/classification/curation-target-processor.ts:47`), which is not
 * exported. The cohort floor is an additional caller-supplied tunable
 * (`confidenceFloor`); a member match must clear BOTH the matcher floor here
 * and the caller's `confidenceFloor` to count as confident.
 */
export const KEYWORD_MATCH_MIN_CONFIDENCE = 0.7;

// ─── C3a: per-member frozen evidence ─────────────────────────────────────────

export interface EvidenceFromProjectionOptions {
  /** Run id stamped on the produced records (default '' — pure builder, no run yet). */
  runId?: string;
  /** Product SKU stamped on the produced records (default: the projection's productSku). */
  productSku?: string;
}

export interface DeterministicTypeMatchResult {
  /** The matched product type id, or null when no confident keyword match. */
  productTypeId: string | null;
  /** The keyword-match confidence (0..1), or null when no confident match. */
  confidence: number | null;
  /** 'keyword' when the deterministic matcher produced the match, else null. */
  source: 'keyword' | null;
}

/**
 * Build the per-member evidence records purely from a frozen
 * `execution-evidence-v1` projection member — a projection-only mirror of the
 * frozen-mode evidence stage (`executeFrozenEvidenceExtraction`,
 * `src/classification/stages/evidence-extraction.ts:28-137`) WITHOUT
 * persistence: no `onboarding_items` reads, no model calls, no write-back.
 *
 * Field mapping mirrors the frozen stage exactly:
 * - `spreadsheetIdentity` -> `spreadsheet` source records (name, expected_name,
 *   brand);
 * - normalized `extraction` fields -> `official_product_page` source records
 *   (name, brand, weight, description, bullet_point, search_keywords [low],
 *   custom fields);
 * - frozen packaging OCR -> `visual_product_evidence` records (the frozen
 *   stage's `packagingOcrDataToEvidence` conversion, mirrored here so this
 *   pure module never loads the DB/model-coupled extractor module).
 *
 * The OCR is materialized ONLY when the projection's own input-hash binding
 * still matches (recomputed purely from frozen fields) AND the projection
 * carries a non-null `ocrExecutionDigest` (the execution-authority binding the
 * freeze verified against the member snapshot's plan/rule digest — immutable
 * in the content-addressed projection). The frozen stage additionally
 * re-derives the snapshot digest at stage time; this builder cannot (no
 * snapshot in scope) and trusts the digest frozen at freeze time.
 */
export function evidenceFromProjection(
  memberProjection: ExecutionEvidenceProjectionMemberV1,
  options: EvidenceFromProjectionOptions = {},
): ClassificationEvidence[] {
  const evidence: ClassificationEvidence[] = [];
  const sku = options.productSku ?? memberProjection.productSku ?? '';
  const runId = options.runId ?? '';
  const sourceUrl = memberProjection.sourceUrl;
  const ext = memberProjection.extraction;
  const identity = memberProjection.spreadsheetIdentity;

  const push = (entry: Omit<ClassificationEvidence, 'id' | 'runId' | 'stageName' | 'productSku' | 'capturedAt'>): void => {
    evidence.push({
      ...entry,
      id: randomUUID(),
      runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      capturedAt: now(),
    } as ClassificationEvidence);
  };

  // ── Spreadsheet identity (frozen spreadsheet hints) ────────────────────
  push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: identity.name.slice(0, 300), value: identity.name, metadata: { provenance: 'spreadsheet_import' } });
  if (identity.expectedName && identity.expectedName !== identity.name) {
    push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'expected_name', snippet: identity.expectedName.slice(0, 300), value: identity.expectedName, metadata: { provenance: 'spreadsheet_import', refinement: 'discovery_consolidation' } });
  }
  if (identity.brandHint) {
    push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'brand', snippet: identity.brandHint.slice(0, 300), value: identity.brandHint, metadata: { provenance: 'spreadsheet_import' } });
  }

  // ── Normalized extraction fields (official product page) ───────────────
  const pageSource: ClassificationEvidence['source'] = 'official_product_page';
  if (ext.title && ext.title.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'name', snippet: ext.title.slice(0, 300), value: ext.title, metadata: { provenance: 'official_product_page' } });
  }
  if (ext.brand && ext.brand.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'brand', snippet: ext.brand.slice(0, 300), value: ext.brand, metadata: { provenance: 'official_product_page' } });
  }
  if (ext.weight && ext.weight.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'weight', snippet: ext.weight.slice(0, 300), value: ext.weight, metadata: { provenance: 'official_product_page' } });
  }
  if (ext.description && ext.description.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'description', snippet: ext.description.slice(0, 500), value: ext.description, metadata: { provenance: 'official_product_page' } });
  }
  for (const bullet of ext.bulletPoints) {
    if (!bullet || !bullet.trim()) continue;
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'bullet_point', snippet: String(bullet).slice(0, 300), value: String(bullet), metadata: { provenance: 'official_product_page' } });
  }
  if (ext.searchKeywords && ext.searchKeywords.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'low', sourceUrl, sourceField: 'search_keywords', snippet: ext.searchKeywords.slice(0, 300), value: ext.searchKeywords, metadata: { provenance: 'product_data' } });
  }
  for (const [key, rawVal] of Object.entries(ext.customFields)) {
    const value = String(rawVal ?? '').trim();
    if (!value) continue;
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: key, snippet: value.slice(0, 300), value, metadata: { provenance: 'product_data' } });
  }

  // ── FROZEN packaging OCR materialization (NO model call) ────────────────
  const frozenOcr = ext.ocr;
  const ocrInputHashMatches =
    frozenOcr.packagingOcrData != null &&
    hashCanonicalJson({
      sourceUrl: memberProjection.sourceUrl,
      extractionSourceUrl: memberProjection.extractionSourceUrl,
      primaryImage: ext.primaryImage,
      additionalImages: ext.additionalImages,
    }) === frozenOcr.ocrInputHash;
  // Execution-authority binding: the freeze verified the stored OCR against
  // the member snapshot's plan/rule digest and persisted the digest into the
  // content-addressed projection. A projection without a digest predates the
  // binding (PR3 hardening) and is never materialized (fail-closed mirror).
  const executionDigestBound = frozenOcr.ocrExecutionDigest != null;
  if (frozenOcr.packagingOcrData && ocrInputHashMatches && executionDigestBound) {
    const modelCallIds = frozenOcr.packagingOcrData.metadata?.modelCallIds;
    evidence.push(...mirrorPackagingOcrDataToEvidence(frozenOcr.packagingOcrData, {
      runId,
      sku,
      model: frozenOcr.outcome?.model ?? 'unknown',
      ...(Array.isArray(modelCallIds) && modelCallIds.length > 0 ? { modelCallIds } : {}),
    }));
  }

  return evidence;
}

/**
 * Mirror of the shared `packagingOcrDataToEvidence`
 * (`src/classification/product-evidence-extractor.ts:105-353`). The shared
 * helper lives in a module that imports DB/model layers; this pure module
 * reproduces the EXACT field mapping (fields, reliability thresholds, source
 * fields, metadata, model-call propagation) without importing it.
 */
function mirrorPackagingOcrDataToEvidence(
  ocrData: PackagingOcrData,
  params: { runId: string; sku: string; model: string; modelCallIds?: string[] },
): ClassificationEvidence[] {
  const evidence: ClassificationEvidence[] = [];
  const { runId, sku, model } = params;
  const reliability = (field: string, fallback: string): string => {
    const confidence = ocrData.confidenceByField?.[field];
    if (confidence == null) return fallback;
    if (confidence >= 0.7) return 'high';
    if (confidence >= 0.4) return 'medium';
    return 'low';
  };

  const base = {
    runId,
    stageName: 'evidence_extraction' as const,
    productSku: sku,
    source: 'visual_product_evidence' as const,
    sourceUrl: null as string | null,
    capturedAt: now(),
  };

  const push = (entry: Omit<ClassificationEvidence, 'id' | 'runId' | 'stageName' | 'productSku' | 'capturedAt' | 'source' | 'sourceUrl'>): void => {
    evidence.push({
      ...base,
      ...entry,
      id: randomUUID(),
    } as ClassificationEvidence);
  };

  if (ocrData.productName) {
    push({ attributeId: null, reliability: reliability('productName', 'high') as ClassificationEvidence['reliability'], sourceField: 'name', snippet: ocrData.productName.slice(0, 300), value: ocrData.productName, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.productName ?? null } });
  }
  if (ocrData.brand) {
    push({ attributeId: null, reliability: reliability('brand', 'high') as ClassificationEvidence['reliability'], sourceField: 'brand', snippet: ocrData.brand.slice(0, 300), value: ocrData.brand, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.brand ?? null } });
  }
  if (ocrData.species?.length) {
    for (const val of ocrData.species) {
      push({ attributeId: null, reliability: reliability('species', 'medium') as ClassificationEvidence['reliability'], sourceField: 'species', snippet: val.slice(0, 300), value: val, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.species ?? null } });
    }
  }
  if (ocrData.flavorVariety) {
    push({ attributeId: 'flavor', reliability: reliability('flavorVariety', 'medium') as ClassificationEvidence['reliability'], sourceField: 'flavor', snippet: ocrData.flavorVariety.slice(0, 300), value: ocrData.flavorVariety, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.flavorVariety ?? null } });
  }
  if (ocrData.color) {
    push({ attributeId: 'color', reliability: reliability('color', 'medium') as ClassificationEvidence['reliability'], sourceField: 'color', snippet: ocrData.color.slice(0, 300), value: ocrData.color, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.color ?? null } });
  }
  if (ocrData.material) {
    push({ attributeId: 'material', reliability: reliability('material', 'medium') as ClassificationEvidence['reliability'], sourceField: 'material', snippet: ocrData.material.slice(0, 300), value: ocrData.material, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.material ?? null } });
  }
  if (ocrData.size) {
    push({ attributeId: 'size', reliability: reliability('size', 'medium') as ClassificationEvidence['reliability'], sourceField: 'size', snippet: ocrData.size.slice(0, 300), value: ocrData.size, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.size ?? null } });
  }
  if (ocrData.weight) {
    push({ attributeId: null, reliability: reliability('weight', 'medium') as ClassificationEvidence['reliability'], sourceField: 'weight', snippet: ocrData.weight.slice(0, 300), value: ocrData.weight, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.weight ?? null } });
  }
  if (ocrData.count) {
    push({ attributeId: null, reliability: reliability('count', 'medium') as ClassificationEvidence['reliability'], sourceField: 'count', snippet: ocrData.count.slice(0, 300), value: ocrData.count, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.count ?? null } });
  }
  if (ocrData.lifeStage) {
    push({ attributeId: 'lifeStage', reliability: reliability('lifeStage', 'medium') as ClassificationEvidence['reliability'], sourceField: 'lifeStage', snippet: ocrData.lifeStage.slice(0, 300), value: ocrData.lifeStage, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.lifeStage ?? null } });
  }
  if (ocrData.breedSize) {
    push({ attributeId: 'breedSize', reliability: reliability('breedSize', 'medium') as ClassificationEvidence['reliability'], sourceField: 'breedSize', snippet: ocrData.breedSize.slice(0, 300), value: ocrData.breedSize, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.breedSize ?? null } });
  }
  if (ocrData.productForm) {
    push({ attributeId: 'productForm', reliability: reliability('productForm', 'medium') as ClassificationEvidence['reliability'], sourceField: 'productForm', snippet: ocrData.productForm.slice(0, 300), value: ocrData.productForm, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.productForm ?? null } });
  }
  if (ocrData.healthConcernFunction?.length) {
    for (const val of ocrData.healthConcernFunction) {
      push({ attributeId: 'healthConcern', reliability: reliability('healthConcernFunction', 'medium') as ClassificationEvidence['reliability'], sourceField: 'healthConcern', snippet: val.slice(0, 300), value: val, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.healthConcernFunction ?? null } });
    }
  }
  if (ocrData.dietaryLabels?.length) {
    for (const val of ocrData.dietaryLabels) {
      push({ attributeId: null, reliability: reliability('dietaryLabels', 'medium') as ClassificationEvidence['reliability'], sourceField: 'dietaryLabel', snippet: val.slice(0, 300), value: val, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.dietaryLabels ?? null } });
    }
  }
  if (ocrData.ingredientKeywords?.length) {
    for (const val of ocrData.ingredientKeywords) {
      push({ attributeId: null, reliability: reliability('ingredientKeywords', 'low') as ClassificationEvidence['reliability'], sourceField: 'ingredientKeyword', snippet: val.slice(0, 300), value: val, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.ingredientKeywords ?? null } });
    }
  }
  if (ocrData.visibleTextLines?.length) {
    const lines = ocrData.visibleTextLines.slice(0, 3);
    for (const val of lines) {
      if (!val?.trim()) continue;
      push({ attributeId: null, reliability: reliability('visibleTextLines', 'low') as ClassificationEvidence['reliability'], sourceField: 'visible_text', snippet: val.slice(0, 300), value: val, metadata: { provenance: 'packaging_ocr', model, visibleText: true, confidence: ocrData.confidenceByField?.visibleTextLines ?? null } });
    }
  }
  if (ocrData.ingredients?.length) {
    for (const val of ocrData.ingredients) {
      if (!val?.trim()) continue;
      push({ attributeId: null, reliability: reliability('ingredients', 'medium') as ClassificationEvidence['reliability'], sourceField: 'ingredient', snippet: val.slice(0, 300), value: val, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.ingredients ?? null } });
    }
  }
  if (ocrData.claims?.length) {
    for (const val of ocrData.claims) {
      if (!val?.trim()) continue;
      push({ attributeId: null, reliability: reliability('claims', 'medium') as ClassificationEvidence['reliability'], sourceField: 'claim', snippet: val.slice(0, 300), value: val, metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.claims ?? null } });
    }
  }

  // Propagate the durable model-call IDs that produced this OCR evidence
  // (mirror of the shared helper; issue #17 E).
  if (params.modelCallIds?.length) {
    for (const record of evidence) {
      record.metadata = { ...(record.metadata ?? {}), modelCallIds: params.modelCallIds };
    }
  }

  return evidence;
}

// ─── C3a: deterministic per-member match ─────────────────────────────────────

interface ScoredTypeMatch {
  match: DeterministicTypeMatchResult;
  /** The bounded evidence packet the keyword match was scored against. */
  packet: ReturnType<typeof buildEvidenceTargetPacket>;
}

/**
 * Shared scoring core: mirrors the per-SKU `processTargetInternal` keyword
 * path (`curation-target-processor.ts:585-610`) — a bounded general-text
 * evidence packet, `matchKeywordOptions` token-overlap scoring, and the
 * `KEYWORD_MATCH_MIN_CONFIDENCE` gate. No LLM fallback in this module (the
 * LLM ranker is run-bound and belongs to the freeze integration, C4a).
 */
function scoreTypeMatch(evidence: ClassificationEvidence[], options: ResolvedTargetOption[]): ScoredTypeMatch {
  const packet = buildEvidenceTargetPacket(evidence, {
    attributeId: null,
    sourceField: null,
    selectionMode: 'single',
  });
  const text = packet.promptText;
  if (options.length === 0 || !text || text.length < 3) {
    return { match: { productTypeId: null, confidence: null, source: null }, packet };
  }
  const keywordMatches = matchKeywordOptions({ options, text, selectionMode: 'single' });
  if (keywordMatches.length > 0 && keywordMatches[0].confidence >= KEYWORD_MATCH_MIN_CONFIDENCE) {
    const top = keywordMatches[0];
    return { match: { productTypeId: top.value, confidence: top.confidence, source: 'keyword' }, packet };
  }
  return { match: { productTypeId: null, confidence: null, source: null }, packet };
}

/**
 * Deterministically match one member's evidence to the resolved product type
 * options (keyword/token overlap only; the LLM ranker fallback is run-bound
 * and lives in the freeze integration). Returns the matched id + confidence
 * when the top keyword match clears `KEYWORD_MATCH_MIN_CONFIDENCE`, else a
 * null result (abstention candidate — the caller's `confidenceFloor` may still
 * downgrade a confident match to an abstention).
 */
export function matchMemberDeterministically(
  memberEvidence: ClassificationEvidence[],
  options: ResolvedTargetOption[],
): DeterministicTypeMatchResult {
  return scoreTypeMatch(memberEvidence, options).match;
}

// ─── C3b: aggregation ────────────────────────────────────────────────────────

export interface CohortMemberInput {
  /** Frozen per-member execution-evidence projection (`execution-evidence-v1`). */
  projection: ExecutionEvidenceProjectionMemberV1;
  /** The member's immutable runtime snapshot (carries productTypes/curationTargets). */
  memberSnapshot: RuntimeClassificationSnapshot;
}

/**
 * A run-bound LLM ranker result for ONE member (PR4 C4a freeze integration,
 * DECISION-A: the model call is attached to the member child run via
 * `buildModelCallContext(memberSnapshot, childRunId, 'product_type_ranking', 1)`
 * — provenance identical to the member SKU stage). The LLM is a FALLBACK: it
 * is applied only when the deterministic keyword match is absent or below the
 * caller's confidence floor, and a failing/unavailable LLM path abstains
 * (fail-closed — no silent type from a failed model path).
 */
export interface MemberLlmRankResult {
  /** The LLM-chosen product type id (one of the member's resolved options). */
  productTypeId: string;
  /** The LLM ranker confidence (0..1). */
  confidence: number;
}

export interface ResolveCohortProductTypeInput {
  /** One entry per finalized cohort member, any order. */
  members: CohortMemberInput[];
  /**
   * Confidence floor (0..1) — a member result below it counts as an
   * abstention (architecture-report §2.2; env-tunable in C5). The matcher's
   * own `KEYWORD_MATCH_MIN_CONFIDENCE` gate still applies per member.
   */
  confidenceFloor: number;
  /**
   * Optional per-member LLM ranker results (PR4 C4a freeze integration): the
   * freeze runs the run-bound `product_type_ranking` fallback for members
   * whose deterministic keyword match is absent or below the floor, then
   * passes the results here. Aligned with `members` (same length + order;
   * null entry = no LLM result for that member). The aggregation applies an
   * LLM result ONLY when the member's deterministic match is absent or below
   * the floor — a confident keyword match always wins (deterministic-first,
   * exactly like the per-SKU `processTargetInternal`). Pure input: the caller
   * already made the run-bound model call; this module never invokes a model.
   */
  memberLlmResults?: Array<MemberLlmRankResult | null>;
}

/**
 * Per-member resolution result. `productTypeId`/`confidence`/`source` carry
 * the RAW deterministic match (null when the keyword matcher produced no
 * confident match); `isAbstention` is the floor-normalized view used by the
 * aggregation — a raw match below `confidenceFloor` counts as an abstention
 * while its values stay visible for diagnostics.
 */
export interface PerMemberProductTypeResult {
  onboardingItemId: string;
  productSku: string | null;
  productTypeId: string | null;
  confidence: number | null;
  /** 'keyword' when the deterministic matcher produced the match, 'llm' when
   *  the freeze-time run-bound ranker did, else null. */
  source: 'keyword' | 'llm' | null;
  /** True when the member contributes no confident match (no match, or confidence < floor). */
  isAbstention: boolean;
  /**
   * Evidence ids that drove the member's confident match (the bounded packet
   * the keyword score was computed over). Empty for abstentions — the pure
   * keyword matcher has no contradiction signal, so member-level
   * `contradictingEvidenceIds` is always [].
   */
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}

/** Non-abstention refinement used by the aggregation (id + confidence non-null). */
export type ConfidentMemberProductTypeResult = PerMemberProductTypeResult & {
  productTypeId: string;
  confidence: number;
  source: 'keyword' | 'llm';
};

/** Member support for the resolved type: confident members vs total members. */
export interface CohortTypeMemberSupport {
  confidentCount: number;
  memberCount: number;
}

interface CohortProductTypeResolutionBase {
  /** The cohort-level outcome (architecture-report §2.4). */
  outcome: 'coherent' | 'coherent_with_abstentions' | 'conflicted' | 'abstained';
  /** The resolved Product Type id — ONLY set for coherent outcomes (never majority-forced). */
  productTypeId: string | null;
  /** min(confident member confidences) — only set for coherent outcomes. */
  confidence: number | null;
  memberSupport: CohortTypeMemberSupport;
  /** Evidence ids supporting the resolved type (union over confident members). */
  supportingEvidenceIds: string[];
  /**
   * Evidence ids contradicting the resolved type: always [] for coherent
   * outcomes; for `conflicted`, the union of every confident member's
   * supporting ids (each side's evidence contradicts the other's — never
   * resolved by source order or majority).
   */
  contradictingEvidenceIds: string[];
  /** Per-member raw results, in input order. */
  perMember: PerMemberProductTypeResult[];
  /** The floor the aggregation applied. */
  confidenceFloor: number;
}

export type CohortProductTypeResolution =
  | (CohortProductTypeResolutionBase & { outcome: 'coherent'; productTypeId: string; confidence: number })
  | (CohortProductTypeResolutionBase & { outcome: 'coherent_with_abstentions'; productTypeId: string; confidence: number })
  | (CohortProductTypeResolutionBase & { outcome: 'conflicted'; productTypeId: null; confidence: null })
  | (CohortProductTypeResolutionBase & { outcome: 'abstained'; productTypeId: null; confidence: null });

/**
 * Resolve the cohort-level Execution Product Type from frozen member evidence.
 * Pure aggregation with NO majority forcing:
 *
 * - every confident member agrees on one id            -> `coherent`
 * - >=1 confident match, >=1 abstainer, no contradiction -> `coherent_with_abstentions`
 *   (DECISION-C: an abstainer carries no counter-evidence)
 * - >=2 confident DISTINCT ids                         -> `conflicted` (id stays null)
 * - no confident match                                 -> `abstained` (incl. empty input)
 *
 * Product type options resolve per member from its frozen runtime snapshot
 * (`resolveTargetsFromSnapshot`); members with no enabled product-type target
 * or no options abstain. An empty members array resolves to `abstained`.
 */
export function resolveCohortProductType(input: ResolveCohortProductTypeInput): CohortProductTypeResolution {
  const { members, confidenceFloor, memberLlmResults } = input;
  const perMember = members.map((member, index) =>
    resolveMemberResult(member, confidenceFloor, memberLlmResults?.[index] ?? null),
  );
  const memberCount = perMember.length;

  const confident = perMember.filter(
    (member): member is ConfidentMemberProductTypeResult => !member.isAbstention,
  );
  const memberSupport: CohortTypeMemberSupport = { confidentCount: confident.length, memberCount };

  if (confident.length === 0) {
    return {
      outcome: 'abstained',
      productTypeId: null,
      confidence: null,
      memberSupport,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      perMember,
      confidenceFloor,
    };
  }

  const distinctIds = [...new Set(confident.map(member => member.productTypeId))];
  if (distinctIds.length >= 2) {
    // Family-invariant disagreement = evidence conflict (ADR: never normalized).
    return {
      outcome: 'conflicted',
      productTypeId: null,
      confidence: null,
      memberSupport,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: confident.flatMap(member => member.supportingEvidenceIds),
      perMember,
      confidenceFloor,
    };
  }

  const productTypeId = distinctIds[0];
  const confidence = Math.min(...confident.map(member => member.confidence));
  const outcome = memberCount > confident.length ? 'coherent_with_abstentions' : 'coherent';

  return {
    outcome,
    productTypeId,
    confidence,
    memberSupport,
    supportingEvidenceIds: confident.flatMap(member => member.supportingEvidenceIds),
    contradictingEvidenceIds: [],
    perMember,
    confidenceFloor,
  };
}

function resolveMemberResult(
  member: CohortMemberInput,
  confidenceFloor: number,
  llmResult?: MemberLlmRankResult | null,
): PerMemberProductTypeResult {
  const evidence = evidenceFromProjection(member.projection);
  const options = resolveProductTypeOptions(member.memberSnapshot);
  const { match, packet } = scoreTypeMatch(evidence, options);
  // LLM ranker fallback (PR4 C4a freeze integration, DECISION-A): applied ONLY
  // when the deterministic keyword match is absent or below the caller's
  // confidence floor — a confident deterministic match always wins, exactly
  // like the per-SKU stage (`processTargetInternal`: deterministic first, LLM
  // fallback). The LLM result's own confidence still passes through the floor
  // gate below (a sub-floor LLM match counts as an abstention).
  const belowFloor = match.productTypeId === null || match.confidence === null || match.confidence < confidenceFloor;
  // PR4 review fix (BLOCKER): `llmRankOptions` returns option LABELS, but the
  // persisted execution Product Type id must be the option's canonical VALUE
  // (pt.id). Map the LLM label back through the member's frozen options; no
  // exact match ⇒ the member abstains (fail closed — never an id guessed from
  // a display label). The freeze integration already canonicalizes, so an
  // already-canonical id passes through unchanged.
  const effective = belowFloor && llmResult
    ? mapLlmRankResultToMemberOption(llmResult, options)
    : match;
  // A null effective result (unmappable LLM label) is an abstention; a
  // below-floor match/LLM confidence also counts as an abstention (the raw
  // values stay visible for diagnostics).
  const isAbstention = effective === null
    || effective.productTypeId === null
    || effective.confidence === null
    || effective.confidence < confidenceFloor;

  return {
    onboardingItemId: member.projection.onboardingItemId,
    productSku: member.projection.productSku,
    productTypeId: effective?.productTypeId ?? null,
    confidence: effective?.confidence ?? null,
    source: effective?.source ?? null,
    isAbstention,
    supportingEvidenceIds: isAbstention ? [] : packet.evidenceIds,
    contradictingEvidenceIds: [],
  };
}

/**
 * Map a run-bound LLM ranker result back to the member's frozen Product Type
 * option VALUE (pt.id). `llmRankOptions` prompts and normalizes exclusively
 * against `option.label` (`curation-target-ranker.ts`); the stored
 * `execution_product_type_id` must be the canonical `option.value`. An exact
 * value match passes through (the freeze integration already canonicalizes);
 * an exact label match maps to its value. No exact match → null: the member
 * abstains (fail closed — a label outside the frozen options is never turned
 * into an id).
 */
function mapLlmRankResultToMemberOption(
  llmResult: MemberLlmRankResult,
  options: ResolvedTargetOption[],
): { productTypeId: string; confidence: number; source: 'llm' } | null {
  const byValue = options.find(option => option.value === llmResult.productTypeId);
  if (byValue) {
    return { productTypeId: byValue.value, confidence: llmResult.confidence, source: 'llm' as const };
  }
  const byLabel = options.find(option => option.label === llmResult.productTypeId);
  if (byLabel) {
    return { productTypeId: byLabel.value, confidence: llmResult.confidence, source: 'llm' as const };
  }
  return null;
}

/**
 * Resolve the member's product type options purely from its frozen runtime
 * snapshot (mirrors `primaryProductTypeStage`: the FIRST enabled product type
 * curation target, `curation-target-processor`/`primary-product-type.ts`).
 * Returns [] when no product type target is enabled or it has no options.
 */
function resolveProductTypeOptions(snapshot: RuntimeClassificationSnapshot): ResolvedTargetOption[] {
  const resolved = resolveTargetsFromSnapshot(snapshot);
  if (resolved.productTypes.length === 0) return [];
  return resolved.productTypes[0].options;
}

// ─── C3b: family invariant validator ─────────────────────────────────────────

export interface FamilyInvariantFinding {
  /** The family invariant target (ADR: Brand + Primary Product Type). */
  invariant: 'product_type' | 'brand';
  /**
   * 'error' = family-invariant violation (Product Type conflict); 'warning' =
   * visible finding only — PR4 never fails the cohort on Brand (Brand
   * coherence is not yet a resolver product; the finding is the PR9 seed).
   */
  severity: 'error' | 'warning';
  /** Machine-readable finding kind. */
  kind: 'disagreement';
  /** Human-readable summary. */
  message: string;
  /** Onboarding item ids of the members contributing to the finding. */
  memberIds: string[];
  /** The disagreeing values (product type ids / canonical brand identities). */
  values: string[];
}

/**
 * Post-hoc PURE family-invariant validator (architecture-report §4): asserts
 * (a) every member's execution type contribution agrees (or is a recorded
 * abstention) and (b) canonical Brand agreement across members via the shared
 * brand canonicalization (`resolveBrand`). Returns findings; NEVER mutates the
 * run/projection. Run in tests and shadow mode (C5); PR4 does not fail the
 * cohort on Brand.
 *
 * @param projection - The frozen `execution-evidence-v1` projection (member
 *   brand inputs come from `extraction.brand ?? spreadsheetIdentity.brandHint`,
 *   mirroring the frozen evidence stage).
 * @param memberResults - The `resolveCohortProductType` per-member results.
 * @param brands - The configured canonical brands (frozen in the member
 *   snapshots). Empty when none are configured: brand resolution yields no
 *   canonical ids and members are compared by their raw normalized brand
 *   strings, so a family mismatch stays visible.
 */
export function validateCohortFamilyInvariants(
  projection: ExecutionEvidenceProjectionV1,
  memberResults: PerMemberProductTypeResult[],
  brands: BrandConfig[] = [],
): FamilyInvariantFinding[] {
  const findings: FamilyInvariantFinding[] = [];

  // (a) Product Type agreement finding — distinct confident ids = violation.
  const confident = memberResults.filter(
    (member): member is ConfidentMemberProductTypeResult => !member.isAbstention,
  );
  const distinctTypeIds = [...new Set(confident.map(member => member.productTypeId))];
  if (distinctTypeIds.length >= 2) {
    findings.push({
      invariant: 'product_type',
      severity: 'error',
      kind: 'disagreement',
      message: `Product Type family invariant violated: members resolved ${distinctTypeIds.length} distinct Product Types (${distinctTypeIds.join(', ')}).`,
      memberIds: confident.map(member => member.onboardingItemId),
      values: distinctTypeIds,
    });
  }

  // (b) Canonical Brand disagreement finding (shared brand canonicalization).
  const identityByMember = new Map<string, string>();
  for (const member of projection.members) {
    const brandInput = member.extraction.brand ?? member.spreadsheetIdentity.brandHint ?? null;
    const identity = canonicalBrandIdentity(brandInput, brands);
    if (identity === null) continue;
    identityByMember.set(member.onboardingItemId, identity);
  }
  const membersByIdentity = new Map<string, string[]>();
  for (const [memberId, identity] of identityByMember) {
    const ids = membersByIdentity.get(identity) ?? [];
    ids.push(memberId);
    membersByIdentity.set(identity, ids);
  }
  if (membersByIdentity.size >= 2) {
    const values = [...membersByIdentity.keys()].sort((a, b) => a.localeCompare(b));
    findings.push({
      invariant: 'brand',
      severity: 'warning',
      kind: 'disagreement',
      message: `Brand family invariant violated: members resolve to ${membersByIdentity.size} distinct canonical brands (${values.join(', ')}).`,
      memberIds: [...identityByMember.keys()],
      values,
    });
  }

  return findings;
}

/**
 * Canonical brand identity for one member: the shared `resolveBrand` result's
 * brandId when a configured canonical brand matches; otherwise a deterministic
 * raw identity (`unresolved:<normalized>`), so a family mismatch is visible
 * even before canonical brands are configured. Members with no brand input at
 * all contribute no identity (never a finding on their own).
 */
function canonicalBrandIdentity(brandInput: string | null, brands: BrandConfig[]): string | null {
  if (!brandInput || brandInput.trim().length === 0) return null;
  const resolved = resolveBrand(brandInput, brands);
  if (resolved) return resolved.brandId;
  return `unresolved:${brandInput.trim().toLowerCase()}`;
}
