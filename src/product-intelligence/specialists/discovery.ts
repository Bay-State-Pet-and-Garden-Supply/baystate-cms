/**
 * Provider-neutral Discovery / Identity specialist (PI-#49).
 *
 * Discovery produces ranked identity leads. It never chooses a catalog product,
 * writes onboarding state, or treats a supplier SKU, a name match, or a batch
 * hint as identity authority. Page identity is delegated to the existing
 * PageExtractionContract; this module only ranks the resulting evidence and
 * reports whether more evidence or review is required.
 */
import { z } from 'zod';
import { evidenceId, type PageExtractionContract, type PageExtractionResult } from '../tools/contract';
import {
  captureSpecialistCodeCommit,
  finalizeSpecialistArtifact,
  SpecialistArtifactSchemaRegistry,
  type SpecialistArtifactEnvelope,
} from './artifacts';
import {
  SpecialistResultSchema,
  type SpecialistContext,
  type SpecialistResult,
  type SpecialistCapability,
} from './contracts';
import { ProductSeedSchema, BatchContextSchema, DiscoveredGtinSchema, type ProductSeed, type BatchContext } from '../product-seed';

export const DISCOVERY_SPECIALIST_NAME = 'discovery_identity';
export const DISCOVERY_SPECIALIST_VERSION = '1.0.0';
export const DISCOVERY_INPUT_SCHEMA_VERSION = '1.0.0';
export const DISCOVERY_OUTPUT_SCHEMA_VERSION = '1.0.0';
export const DISCOVERY_INPUT_ARTIFACT_TYPE = 'discovery_input';
export const DISCOVERY_OUTPUT_ARTIFACT_TYPE = 'discovery_result';

const MAX_SOURCES = 40;
const MAX_EVIDENCE_IDS = 32;
const MAX_REASON_CODES = 12;
const MAX_SIGNALS = 20;

export const DiscoverySourceTypeSchema = z.enum([
  'manufacturer',
  'supplier',
  'distributor',
  'retailer',
  'marketplace',
  'search',
  'sitemap',
  'existing_evidence',
  'other',
]);
export type DiscoverySourceType = z.infer<typeof DiscoverySourceTypeSchema>;

/** A search lead with explicit provenance. It is not an authority assertion. */
export const DiscoverySourceCandidateSchema = z.object({
  url: z.string().url().max(2048),
  sourceType: DiscoverySourceTypeSchema.default('search'),
  sourceRef: z.string().trim().min(1).max(256),
  sourceMethod: z.string().trim().min(1).max(128),
  title: z.string().max(512).nullish(),
  snippet: z.string().max(512).nullish(),
  evidenceIds: z.array(z.string().trim().min(1).max(256)).max(MAX_EVIDENCE_IDS).default([]),
}).strict();
export type DiscoverySourceCandidate = z.infer<typeof DiscoverySourceCandidateSchema>;

export const DiscoverySpecialistInputSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  productSeed: ProductSeedSchema,
  /** Optional discovered evidence; it is never required to run discovery. */
  discoveredGtin: DiscoveredGtinSchema.nullish(),
  /** Bounded, non-authoritative row context from #57. */
  batchContext: BatchContextSchema.nullish(),
  /** Existing leads may be replayed without spending a search request. */
  sourceCandidates: z.array(DiscoverySourceCandidateSchema).max(MAX_SOURCES).default([]),
}).strict();
export type DiscoverySpecialistInput = z.infer<typeof DiscoverySpecialistInputSchema>;

export const DiscoveryPageKindSchema = z.enum([
  'exact_pdp',
  'probable_pdp',
  'parent_family_page',
  'wrong_variant',
  'unresolved_lead',
]);
export type DiscoveryPageKind = z.infer<typeof DiscoveryPageKindSchema>;

export const DiscoverySignalKindSchema = z.enum([
  'exact_gtin',
  'gtin_conflict',
  'sku_match',
  'name_alignment',
  'abbreviated_name_alignment',
  'brand_hint_alignment',
  'size_match',
  'size_conflict',
  'parent_family_page',
  'wrong_variant',
  'official_source_tier',
  'search_lead',
  'batch_context_hint',
  'unverified_source',
]);
export type DiscoverySignalKind = z.infer<typeof DiscoverySignalKindSchema>;

export const DiscoverySignalSchema = z.object({
  kind: DiscoverySignalKindSchema,
  /** Structured, bounded signal value; never free-form model rationale. */
  value: z.string().trim().min(1).max(256),
  /** Ranking weight only, not confidence or an approval score. */
  weight: z.number().finite().min(-1).max(1),
  evidenceIds: z.array(z.string().trim().min(1).max(256)).max(MAX_EVIDENCE_IDS).default([]),
}).strict();
export type DiscoverySignal = z.infer<typeof DiscoverySignalSchema>;

export const DiscoveryIdentifierSchema = z.object({
  kind: z.enum(['gtin', 'sku']),
  value: z.string().trim().min(1).max(64),
  method: z.string().trim().min(1).max(128),
  /** Exact path in the page/artifact where this identifier was observed. */
  sourcePath: z.string().trim().min(1).max(1024),
  /** Artifact containing this identifier observation, never a candidate URL. */
  sourceArtifactId: z.string().trim().min(1).max(256),
  /** Evidence ids bind the identifier to its own source extraction. */
  evidenceIds: z.array(z.string().trim().min(1).max(256)).min(1).max(MAX_EVIDENCE_IDS),
}).strict();
export type DiscoveryIdentifier = z.infer<typeof DiscoveryIdentifierSchema>;

export const DiscoveryCandidateSchema = z.object({
  /** Null for unresolved/unverified candidates; only rankable candidates are ranked. */
  rank: z.number().int().positive().nullable(),
  score: z.number().finite().min(0).max(1),
  /** Score is for ordering; it is not model confidence or authority. */
  scoreMeaning: z.literal('ranking_only'),
  source: DiscoverySourceCandidateSchema,
  finalUrl: z.string().url().max(2048).nullish(),
  pageKind: DiscoveryPageKindSchema,
  extractionStatus: z.enum(['verified', 'unverified', 'no_result', 'error']),
  extracted: z.object({
    productName: z.string().max(512).nullish(),
    brand: z.string().max(256).nullish(),
    sku: z.string().max(256).nullish(),
    size: z.string().max(128).nullish(),
    gtins: z.array(z.string().max(32)).max(20),
    identifiers: z.array(DiscoveryIdentifierSchema).max(20),
    identityStatus: z.string().max(64).nullish(),
  }).strict(),
  signals: z.array(DiscoverySignalSchema).max(MAX_SIGNALS),
  rationaleCodes: z.array(z.string().trim().min(1).max(128)).max(MAX_REASON_CODES),
  evidenceIds: z.array(z.string().trim().min(1).max(256)).max(MAX_EVIDENCE_IDS),
}).strict();
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;

export const DiscoveryDispositionSchema = z.enum(['ranked', 'needs_targeted_evidence', 'human_review']);
export type DiscoveryDisposition = z.infer<typeof DiscoveryDispositionSchema>;

export const DiscoveryNextEvidenceSchema = z.enum([
  'exact_gtin',
  'selected_variant',
  'brand_confirmation',
  'size_or_pack_confirmation',
  'additional_source',
  'human_review',
]);
export type DiscoveryNextEvidence = z.infer<typeof DiscoveryNextEvidenceSchema>;

export const DiscoveryBudgetSchema = z.object({
  searchRequestsUsed: z.number().int().nonnegative(),
  verificationRequestsUsed: z.number().int().nonnegative(),
  searchRequestsAllowed: z.number().int().nonnegative(),
  verificationRequestsAllowed: z.number().int().nonnegative(),
  exhausted: z.boolean(),
}).strict();

export const DiscoverySpecialistOutputSchema = z.object({
  schemaVersion: z.literal(1),
  productSeed: ProductSeedSchema,
  discoveredGtin: DiscoveredGtinSchema.nullish(),
  candidates: z.array(DiscoveryCandidateSchema).max(MAX_SOURCES),
  disposition: DiscoveryDispositionSchema,
  nextEvidence: z.array(DiscoveryNextEvidenceSchema).max(4),
  /** Explicitly records that this is a proposal/evidence artifact only. */
  authority: z.literal('none'),
  budget: DiscoveryBudgetSchema,
}).strict();
export type DiscoverySpecialistOutput = z.infer<typeof DiscoverySpecialistOutputSchema>;

export const DISCOVERY_INPUT_ARTIFACT_SCHEMA = {
  name: DISCOVERY_INPUT_ARTIFACT_TYPE,
  version: DISCOVERY_INPUT_SCHEMA_VERSION,
  schema: DiscoverySpecialistInputSchema,
  description: 'ProductSeed-based, provider-neutral discovery input with bounded batch hints',
} as const;

export const DISCOVERY_OUTPUT_ARTIFACT_SCHEMA = {
  name: DISCOVERY_OUTPUT_ARTIFACT_TYPE,
  version: DISCOVERY_OUTPUT_SCHEMA_VERSION,
  schema: DiscoverySpecialistOutputSchema,
  description: 'Ranked product identity candidates and structured evidence requests',
} as const;

export const DISCOVERY_SPECIALIST_CAPABILITY: SpecialistCapability = {
  name: DISCOVERY_SPECIALIST_NAME,
  version: DISCOVERY_SPECIALIST_VERSION,
  kind: 'identity',
  summary: 'Discovers and ranks product identity candidates without forcing a match.',
  input: { schemaName: DISCOVERY_INPUT_ARTIFACT_TYPE, schemaVersion: DISCOVERY_INPUT_SCHEMA_VERSION },
  output: { schemaName: DISCOVERY_OUTPUT_ARTIFACT_TYPE, schemaVersion: DISCOVERY_OUTPUT_SCHEMA_VERSION },
};
/** Compatibility alias for callers that use a specialist-specific name. */
export const discoverySpecialistCapability = DISCOVERY_SPECIALIST_CAPABILITY;

export function registerDiscoverySpecialistSchemas(registry: SpecialistArtifactSchemaRegistry): SpecialistArtifactSchemaRegistry {
  return registry.register(DISCOVERY_INPUT_ARTIFACT_SCHEMA).register(DISCOVERY_OUTPUT_ARTIFACT_SCHEMA);
}

export interface DiscoverySearchRequest {
  productSeed: ProductSeed;
  discoveredGtin: string | null;
  batchContext: BatchContext | null;
}

export interface DiscoverySearchResult {
  candidates: DiscoverySourceCandidate[];
}

export interface DiscoverySpecialistDependencies {
  /** Search is optional when replaying bounded sourceCandidates. */
  search?: (request: DiscoverySearchRequest, context: SpecialistContext) => Promise<DiscoverySearchResult>;
  /** Existing provider-neutral extraction seam. */
  extraction?: PageExtractionContract;
}

export interface DiscoverySpecialistOptions {
  /** Hard cap on search-provider calls (currently one per invocation). */
  maxSearchRequests?: number;
  /** Hard cap on page verification/extraction calls. */
  maxVerificationRequests?: number;
  maxCandidates?: number;
  /** Deterministic build identity for artifact provenance; env/git is the fallback. */
  codeCommit?: string | null;
}

export interface DiscoveryRun {
  output: DiscoverySpecialistOutput;
  artifact: SpecialistArtifactEnvelope;
  result: SpecialistResult;
}

const DEFAULT_MAX_SEARCH_REQUESTS = 1;
const DEFAULT_MAX_VERIFICATION_REQUESTS = 8;
const DEFAULT_MAX_CANDIDATES = 20;

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(value: string): string[] {
  return [...new Set(normalize(value).split(/\s+/u).filter((token) => token.length > 1))];
}

function tokenOverlap(expected: string, actual: string): { score: number; abbreviated: boolean } {
  const left = tokens(expected);
  const right = tokens(actual);
  if (!left.length || !right.length) return { score: 0, abbreviated: false };
  const rightSet = new Set(right);
  const exact = left.filter((token) => rightSet.has(token));
  const prefix = left.filter((token) => token.length >= 3 && right.some((other) => other.startsWith(token) || token.startsWith(other)));
  const intersection = new Set([...exact, ...prefix]).size;
  // Supplier abbreviations commonly use initials ("WS" for "Wild Salmon").
  // Treat that as an alignment only when the short token maps to a contiguous
  // run of extracted words; generic short-token overlap remains untrusted.
  const abbreviated = left.some((token) => {
    if (token.length < 2 || token.length > 4) return false;
    for (let start = 0; start < right.length; start += 1) {
      for (let length = 2; length <= Math.min(3, right.length - start); length += 1) {
        if (right.slice(start, start + length).map((word) => word[0]).join('') === token) return true;
      }
    }
    return false;
  });
  const score = intersection / new Set([...left, ...right]).size;
  return { score: Math.min(1, score + (abbreviated ? 0.18 : 0)), abbreviated };
}

function extractSize(value: string): string | null {
  const match = normalize(value).match(/\b\d+(?:\.\d+)?\s?(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l|ct|count|pk|pack|case)\b/u);
  return match?.[0] ?? null;
}

function sourceBase(sourceType: DiscoverySourceType): number {
  switch (sourceType) {
    case 'manufacturer': return 0.38;
    case 'supplier': return 0.34;
    case 'distributor': return 0.32;
    case 'sitemap': return 0.30;
    case 'retailer': return 0.20;
    case 'marketplace': return 0.12;
    case 'existing_evidence': return 0.24;
    default: return 0.10;
  }
}

function dedupeSources(sources: DiscoverySourceCandidate[]): DiscoverySourceCandidate[] {
  const byUrl = new Map<string, DiscoverySourceCandidate>();
  for (const source of sources) {
    const key = source.url.replace(/#.*$/u, '');
    const existing = byUrl.get(key);
    if (!existing) byUrl.set(key, source);
    else byUrl.set(key, {
      ...existing,
      evidenceIds: [...new Set([...existing.evidenceIds, ...source.evidenceIds])].slice(0, MAX_EVIDENCE_IDS),
      sourceType: existing.sourceType === 'search' ? source.sourceType : existing.sourceType,
    });
  }
  return [...byUrl.values()].slice(0, MAX_SOURCES);
}

function classifyPage(result: PageExtractionResult | null, expectedSku: string): DiscoveryPageKind {
  if (!result) return 'unresolved_lead';
  if (result.identityStatus === 'wrong_variant' || result.identityStatus === 'conflicting_identity') return 'wrong_variant';
  if (result.identityStatus === 'parent_product_only') return 'parent_family_page';
  if (result.identityStatus === 'exact_match') return 'exact_pdp';
  // A deterministic SKU match is useful when the seed has only a supplier SKU,
  // but it cannot override an extraction conflict or a parent-page decision.
  if (expectedSku.trim() && result.sku && normalize(result.sku) === normalize(expectedSku) && result.identityStatus === 'probable_match') return 'probable_pdp';
  if (result.identityStatus === 'probable_match') return 'probable_pdp';
  return 'unresolved_lead';
}

/** Only verified, resolved page identities receive a positive rank. */
function isRankableCandidate(candidate: Pick<DiscoveryCandidate, 'pageKind' | 'extractionStatus'>): boolean {
  return candidate.extractionStatus === 'verified' && (candidate.pageKind === 'exact_pdp' || candidate.pageKind === 'probable_pdp');
}

function nextEvidenceFor(candidates: DiscoveryCandidate[]): DiscoveryNextEvidence[] {
  const next: DiscoveryNextEvidence[] = [];
  if (candidates.some((c) => c.pageKind === 'exact_pdp' || c.signals.some((s) => s.kind === 'exact_gtin'))) next.push('selected_variant');
  if (candidates.some((c) => c.pageKind === 'parent_family_page' || c.pageKind === 'wrong_variant')) next.push('size_or_pack_confirmation', 'selected_variant');
  if (candidates.some((c) => c.signals.some((s) => s.kind === 'gtin_conflict'))) next.push('exact_gtin');
  if (candidates.length > 1) next.push('brand_confirmation');
  if (!next.length) next.push('additional_source');
  return [...new Set(next)].slice(0, 4);
}

export class DiscoverySpecialist {
  readonly capability = DISCOVERY_SPECIALIST_CAPABILITY;
  private readonly dependencies: DiscoverySpecialistDependencies;
  private readonly options: Required<DiscoverySpecialistOptions>;

  constructor(dependencies: DiscoverySpecialistDependencies = {}, options: DiscoverySpecialistOptions = {}) {
    this.dependencies = dependencies;
    this.options = {
      maxSearchRequests: Math.max(0, Math.min(4, options.maxSearchRequests ?? DEFAULT_MAX_SEARCH_REQUESTS)),
      maxVerificationRequests: Math.max(0, Math.min(50, options.maxVerificationRequests ?? DEFAULT_MAX_VERIFICATION_REQUESTS)),
      maxCandidates: Math.max(1, Math.min(MAX_SOURCES, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES)),
      codeCommit: options.codeCommit ?? null,
    };
  }

  /** Execute through the #48 specialist boundary, returning only the bounded result. */
  async execute(rawInput: unknown, context: SpecialistContext): Promise<SpecialistResult> {
    const run = await this.discover(rawInput, context);
    return 'result' in run ? run.result : run;
  }

  async discover(rawInput: unknown, context: SpecialistContext): Promise<DiscoveryRun | SpecialistResult> {
    const parsed = DiscoverySpecialistInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { specialist: DISCOVERY_SPECIALIST_NAME, outcome: 'failed', failure: { code: 'invalid_input', message: parsed.error.message }, durationMs: 0 };
    }
    const startedAt = Date.now();
    const input = parsed.data;
    const policyAllowed = Math.max(0, context.runtimeAllowance?.remainingToolCalls ?? context.policy.maxToolCalls);
    const searchCost = 0.005;
    const costAllowed = typeof context.runtimeAllowance?.remainingCostUsd === 'number'
      ? Math.floor(context.runtimeAllowance.remainingCostUsd / searchCost)
      : (typeof context.policy.maxCostUsd === 'number' ? Math.floor(context.policy.maxCostUsd / searchCost) : Number.POSITIVE_INFINITY);
    const searchAllowed = Math.min(this.options.maxSearchRequests, policyAllowed, Math.max(0, costAllowed));
    let searchRequestsUsed = 0;
    let verificationRequestsUsed = 0;
    let sources = [...input.sourceCandidates];

    if (sources.length === 0 && this.dependencies.search && searchAllowed > 0) {
      if (context.signal?.aborted) {
        return {
          specialist: DISCOVERY_SPECIALIST_NAME,
          outcome: 'failed',
          failure: { code: 'cancelled', message: 'discovery cancelled' },
          durationMs: Date.now() - startedAt,
          usage: {
            toolCalls: searchRequestsUsed,
            modelCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: Number((searchRequestsUsed * 0.005).toFixed(4)),
          },
        };
      }
      searchRequestsUsed += 1;
      try {
        const searched = await this.dependencies.search({ productSeed: input.productSeed, discoveredGtin: input.discoveredGtin ?? null, batchContext: input.batchContext ?? null }, context);
        sources = searched.candidates;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (sources.length === 0) {
          return {
            specialist: DISCOVERY_SPECIALIST_NAME,
            outcome: 'abstained',
            abstention: {
              reason: `search unavailable: ${message.slice(0, 300)}`,
              actionableNextStep: 'Provide a cached source candidate or enable an approved search capability.',
              targets: [input.productSeed.sku],
            },
            durationMs: Date.now() - startedAt,
            usage: {
              toolCalls: searchRequestsUsed,
              modelCalls: 0,
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostUsd: Number((searchRequestsUsed * 0.005).toFixed(4)),
            },
          };
        }
      }
    }

    // Search calls and extraction calls share the immutable per-run tool-call
    // ceiling. Do not reserve a search slot when replaying supplied leads.
    const verificationAllowed = Math.min(this.options.maxVerificationRequests, Math.max(0, policyAllowed - searchRequestsUsed));
    const uniqueSources = dedupeSources(sources).slice(0, this.options.maxCandidates);
    if (uniqueSources.length === 0) {
      return {
        specialist: DISCOVERY_SPECIALIST_NAME,
        outcome: 'abstained',
        abstention: {
          reason: 'no source candidates were discovered',
          actionableNextStep: 'Request a targeted name, brand, or GTIN search, then retry discovery.',
          targets: [input.productSeed.sku],
        },
        durationMs: Date.now() - startedAt,
        usage: {
          toolCalls: searchRequestsUsed,
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: Number((searchRequestsUsed * 0.005).toFixed(4)),
        },
      };
    }

    const candidates: DiscoveryCandidate[] = [];
    for (const source of uniqueSources) {
      if (context.signal?.aborted) {
        return {
          specialist: DISCOVERY_SPECIALIST_NAME,
          outcome: 'failed',
          failure: { code: 'cancelled', message: 'discovery cancelled' },
          durationMs: Date.now() - startedAt,
          usage: {
            toolCalls: searchRequestsUsed + verificationRequestsUsed,
            modelCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: Number((searchRequestsUsed * 0.005).toFixed(4)),
          },
        };
      }
      let page: PageExtractionResult | null = null;
      let extractionStatus: DiscoveryCandidate['extractionStatus'] = 'unverified';
      if (this.dependencies.extraction && verificationRequestsUsed < verificationAllowed) {
        verificationRequestsUsed += 1;
        try {
          page = await this.dependencies.extraction.extract({
            url: source.url,
            expected: { gtin: input.discoveredGtin ?? undefined, name: input.productSeed.name },
            signal: context.signal ?? new AbortController().signal,
            timeoutMs: Math.max(1, context.deadlineAt ? Math.max(1, context.deadlineAt - Date.now()) : context.policy.deadlineMs),
          });
          extractionStatus = page.fields.length || page.gtins.length || page.productName ? 'verified' : 'no_result';
        } catch {
          extractionStatus = 'error';
        }
      }

      const pageKind = classifyPage(page, input.productSeed.sku);
      const signalList: DiscoverySignal[] = [];
      let score = sourceBase(source.sourceType);
      const evidenceIds = [...new Set([...source.evidenceIds, evidenceId('discovery_identity', source.url)])].slice(0, MAX_EVIDENCE_IDS);
      const add = (kind: DiscoverySignalKind, value: string, weight: number, ids = evidenceIds): void => {
        signalList.push({ kind, value: value.slice(0, 256), weight, evidenceIds: ids.slice(0, MAX_EVIDENCE_IDS) });
        score += weight;
      };
      const extractedName = page?.productName ?? page?.fields.find((field) => field.field === 'product_name')?.value ?? null;
      const nameMatch = tokenOverlap(input.productSeed.name, extractedName ?? source.title ?? '');
      if (nameMatch.score >= 0.25) add(nameMatch.abbreviated ? 'abbreviated_name_alignment' : 'name_alignment', `${Math.round(nameMatch.score * 100)}% token alignment`, Math.min(0.20, nameMatch.score * 0.20));
      const extractedSku = page?.sku ?? page?.fields.find((field) => field.field === 'sku')?.value ?? null;
      const extractedGtins = page?.gtins.map((gtin) => gtin.value.replace(/\D/gu, '')) ?? [];
      /**
       * Identifier scoring is fail-closed: page-level candidate evidence and
       * artifactRef are not enough to establish where an identifier came from.
       * Every scored identifier must carry its own method, path, artifact, and
       * durable evidence ids.
       */
      const identifierEvidence = (entry: {
        method?: string;
        sourcePath?: string;
        sourceArtifactId?: string | null;
        evidenceIds?: string[];
      }): Pick<DiscoveryIdentifier, 'sourcePath' | 'sourceArtifactId' | 'evidenceIds'> | null => {
        const method = entry.method?.trim();
        const sourcePath = entry.sourcePath?.trim();
        const sourceArtifactId = entry.sourceArtifactId?.trim();
        const ownEvidenceIds = entry.evidenceIds?.map((id) => id.trim()).filter(Boolean) ?? [];
        if (!method || !sourcePath || !sourceArtifactId || ownEvidenceIds.length === 0) return null;
        return { sourcePath, sourceArtifactId, evidenceIds: [...new Set(ownEvidenceIds)].slice(0, MAX_EVIDENCE_IDS) };
      };
      const trustedGtins = (page?.gtins ?? []).flatMap((gtin) => {
        const provenance = identifierEvidence(gtin);
        return provenance ? [gtin.value.replace(/\D/gu, '')] : [];
      });
      const skuField = extractedSku
        ? page?.fields.find((field) => field.field === 'sku' && field.value === extractedSku)
        : undefined;
      const skuEvidence = page?.skuEvidence && extractedSku && normalize(page.skuEvidence.value) === normalize(extractedSku)
        ? page.skuEvidence
        : skuField;
      const trustedSku = extractedSku && identifierEvidence(skuEvidence ?? {}) ? extractedSku : null;
      if (trustedSku && normalize(trustedSku) === normalize(input.productSeed.sku)) add('sku_match', 'extracted SKU equals ProductSeed SKU', 0.18);
      const identifiers: DiscoveryIdentifier[] = [
        ...(page?.gtins ?? []).flatMap((gtin) => {
          const provenance = identifierEvidence(gtin);
          return provenance ? [{ kind: 'gtin' as const, value: gtin.value.replace(/\D/gu, ''), method: gtin.method, ...provenance }] : [];
        }),
        ...(extractedSku ? (() => {
          const provenance = identifierEvidence(skuEvidence ?? {});
          return provenance ? [{ kind: 'sku' as const, value: extractedSku, method: skuEvidence?.method ?? 'page_extraction', ...provenance }] : [];
        })() : []),
      ].slice(0, 20);
      if (input.discoveredGtin && trustedGtins.includes(input.discoveredGtin.replace(/\D/gu, ''))) add('exact_gtin', 'discovered GTIN occurs in extracted page evidence', 0.42);
      if (page && extractedGtins.length > 1 && input.discoveredGtin && !extractedGtins.includes(input.discoveredGtin)) add('gtin_conflict', 'page exposes GTINs but not the requested GTIN', -0.35);
      const expectedSize = extractSize(input.productSeed.name);
      const pageSize = page?.size ?? page?.fields.find((field) => field.field === 'size')?.value ?? null;
      if (expectedSize && pageSize) {
        if (normalize(expectedSize) === normalize(pageSize) || normalize(pageSize).includes(normalize(expectedSize))) add('size_match', pageSize, 0.12);
        else add('size_conflict', `expected ${expectedSize}; page ${pageSize}`, -0.30);
      }
      if (source.sourceType === 'manufacturer' || source.sourceType === 'supplier' || source.sourceType === 'distributor') add('official_source_tier', source.sourceType, 0.08);
      if (input.batchContext?.hints && Object.keys(input.batchContext.hints).length > 0) add('batch_context_hint', 'bounded batch hint used as search context only', 0.01);
      if (pageKind === 'parent_family_page') add('parent_family_page', 'page represents a family or variant selector', -0.10);
      if (pageKind === 'wrong_variant') add('wrong_variant', 'page identity conflicts with the seed variant', -0.50);
      if (extractionStatus !== 'verified') add('unverified_source', extractionStatus, -0.04);
      if (!signalList.some((signal) => signal.kind === 'name_alignment' || signal.kind === 'abbreviated_name_alignment' || signal.kind === 'sku_match' || signal.kind === 'exact_gtin')) add('search_lead', source.sourceMethod, 0);
      if (page?.identityStatus === 'conflicting_identity') add('gtin_conflict', 'extractor reported conflicting identity', -0.30);

      const scoreBounded = Math.max(0, Math.min(1, score));
      candidates.push({
        rank: 0,
        score: scoreBounded,
        scoreMeaning: 'ranking_only',
        source,
        finalUrl: page?.finalUrl ?? null,
        pageKind,
        extractionStatus,
        extracted: {
          productName: extractedName,
          brand: page?.brand ?? null,
          sku: extractedSku,
          size: pageSize,
          gtins: extractedGtins,
          identifiers,
          identityStatus: page?.identityStatus ?? null,
        },
        signals: signalList.slice(0, MAX_SIGNALS),
        rationaleCodes: [...new Set(signalList.map((signal) => signal.kind))].slice(0, MAX_REASON_CODES),
        evidenceIds,
      });
    }

    // Keep rankable candidates first, then sort each partition deterministically.
    // Non-rankable leads remain visible for follow-up but never receive a
    // positive rank value.
    candidates.sort((left, right) => {
      const rankability = Number(isRankableCandidate(right)) - Number(isRankableCandidate(left));
      return rankability || right.score - left.score || left.source.url.localeCompare(right.source.url);
    });
    let nextRank = 1;
    candidates.forEach((candidate) => {
      candidate.rank = isRankableCandidate(candidate) ? nextRank++ : null;
    });
    const top = candidates[0];
    const distinctBrands = new Set(candidates.map((candidate) => normalize(candidate.extracted.brand ?? '')).filter(Boolean));
    const ambiguous = candidates.length > 1 && (Math.abs(top.score - candidates[1].score) <= 0.08 || distinctBrands.size > 1);
    // A ranked result must contain only verified, resolved page identities. A
    // lead that could not be extracted (including budget-exhausted work) is
    // still useful for targeted follow-up, but can never be presented as a
    // resolved ranking.
    const unresolvedEvidence = candidates.some((candidate) =>
      candidate.pageKind === 'unresolved_lead' || candidate.extractionStatus !== 'verified');
    const disposition: DiscoveryDisposition = distinctBrands.size > 1
      ? 'human_review'
      : ambiguous || unresolvedEvidence || top.pageKind === 'wrong_variant' || top.pageKind === 'parent_family_page'
        ? 'needs_targeted_evidence'
        : 'ranked';
    const budget: z.infer<typeof DiscoveryBudgetSchema> = {
      searchRequestsUsed,
      verificationRequestsUsed,
      searchRequestsAllowed: searchAllowed,
      verificationRequestsAllowed: verificationAllowed,
      exhausted: searchRequestsUsed >= searchAllowed || verificationRequestsUsed >= verificationAllowed,
    };
    const output: DiscoverySpecialistOutput = {
      schemaVersion: 1,
      productSeed: input.productSeed,
      discoveredGtin: input.discoveredGtin ?? null,
      candidates,
      disposition,
      nextEvidence: disposition === 'ranked' ? [] : (distinctBrands.size > 1 ? ['human_review'] : nextEvidenceFor(candidates)),
      authority: 'none',
      budget,
    };
    const durationMs = Date.now() - startedAt;
    const totalToolCalls = searchRequestsUsed + verificationRequestsUsed;
    const artifact = finalizeSpecialistArtifact({
      artifactType: DISCOVERY_OUTPUT_ARTIFACT_TYPE,
      payload: output,
      payloadSchema: DiscoverySpecialistOutputSchema,
      lineage: {
        runId: context.runId,
        workflowRef: input.batchContext?.batchId ?? null,
        inputArtifactIds: input.batchContext?.contextHash ? [input.batchContext.contextHash] : [],
      },
      provenance: {
        specialist: DISCOVERY_SPECIALIST_NAME,
        specialistVersion: DISCOVERY_SPECIALIST_VERSION,
        policyConfigId: context.policy.configId,
        codeCommit: this.options.codeCommit ?? captureSpecialistCodeCommit(),
        durationMs,
      },
    });
    const result: SpecialistResult = {
      specialist: DISCOVERY_SPECIALIST_NAME,
      outcome: 'succeeded',
      output: artifact,
      durationMs,
      usage: {
        toolCalls: totalToolCalls,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: Number((searchRequestsUsed * 0.005).toFixed(4)),
      },
    };
    return { output, artifact, result: SpecialistResultSchema.parse(result) };
  }
}

/** Orchestrator-facing convenience function; it does not route or dispatch. */
export async function runDiscoverySpecialist(
  input: unknown,
  context: SpecialistContext,
  dependencies: DiscoverySpecialistDependencies = {},
  options: DiscoverySpecialistOptions = {},
): Promise<DiscoveryRun | SpecialistResult> {
  return new DiscoverySpecialist(dependencies, options).discover(input, context);
}

/** Historical-friendly aliases for consumers discovering the #49 API. */
export const DiscoveryIdentitySpecialist = DiscoverySpecialist;
export const DiscoverySpecialistInput = DiscoverySpecialistInputSchema;
export const DiscoverySpecialistOutput = DiscoverySpecialistOutputSchema;
export const DiscoveryInputSchema = DiscoverySpecialistInputSchema;
export const DiscoveryOutputSchema = DiscoverySpecialistOutputSchema;
export const DiscoveryResultSchema = DiscoverySpecialistOutputSchema;
