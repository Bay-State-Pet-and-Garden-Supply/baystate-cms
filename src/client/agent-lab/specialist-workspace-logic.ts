/**
 * Specialist workspace logic — pure helpers for e02s01 (PI-7 specialist stages).
 *
 * Hard rule: never surface raw model / chain-of-thought. All helpers only
 * expose structured artifact fields and allowlisted event payloads (logic.ts).
 * Untrusted artifact strings are escaped before render by callers.
 */

import type { PiEvidenceRow, PiSourceRow } from '../product-intelligence-api';

// ---------------------------------------------------------------------------
// Types (client-side mirrors of server SpecialistWorkflowResult artifacts)
// ---------------------------------------------------------------------------

export interface SpecialistStageInfo {
  id: string;
  label: string;
  status: 'completed' | 'pending' | 'failed' | 'needs_review' | 'skipped';
  artifactType: string | null;
  producedAt: string | null;
}

export interface ProductSeedDisplay {
  sku: string;
  name: string;
  price: string;
}

export interface DiscoveryCandidateDisplay {
  url: string;
  domain: string;
  sourceType: string;
  confidence: number | null;
}

export interface ExtractionProfileDisplay {
  domain: string;
  profileVersion: string;
  method: string;
  selectorPath: string | null;
  sourceUrl: string | null;
  contentHash: string | null;
}

export interface ResolverFactDisplay {
  field: string;
  status: 'resolved' | 'conflict' | 'needs_more_evidence' | 'abstained';
  value: string | null;
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}

export interface ResolverConflictDisplay {
  field: string;
  reason: string;
  sides: Array<{ value: string; evidenceIds: string[] }>;
}

export interface CuratorFactDisplay {
  field: string;
  value: string;
  evidenceIds: string[];
  groundedInResolvedFact: boolean;
  supportedByEvidenceCount: number;
}

export interface VerifierVerdictDisplay {
  verdict: 'pass' | 'fail' | 'human_review';
  summary: string;
  failingFields: string[];
  evidenceIds: string[];
  conflictFields: string[];
}

export interface ProvenanceLink {
  resolvedFactField: string;
  evidenceId: string;
  sourceUrl: string | null;
  method: string | null;
  contentHash: string | null;
}

// ---------------------------------------------------------------------------
// 1. Specialist stage progress
// ---------------------------------------------------------------------------

const STAGE_ORDER: Array<{ id: string; label: string; artifactTypes: string[] }> = [
  { id: 'seed', label: 'ProductSeed', artifactTypes: ['product_seed'] },
  { id: 'discovery', label: 'Discovery', artifactTypes: ['discovery_output'] },
  { id: 'extraction', label: 'Extraction', artifactTypes: ['extraction_evidence_bundle'] },
  { id: 'resolver', label: 'Resolver', artifactTypes: ['resolved_factset'] },
  { id: 'curator', label: 'Curator', artifactTypes: ['curated_product_draft'] },
  { id: 'verifier', label: 'Verifier', artifactTypes: ['verification_report'] },
];

export function getSpecialistStages(artifactIds: string[], statusByArtifactType?: Map<string, string>): SpecialistStageInfo[] {
  const artifactSet = new Set(artifactIds);
  return STAGE_ORDER.map((stage) => {
    const hasArtifact = stage.artifactTypes.some((t) => artifactSet.has(t));
    const mappedStatus = statusByArtifactType?.get(stage.id);
    const status: SpecialistStageInfo['status'] = hasArtifact
      ? mappedStatus === 'failed' ? 'failed' : mappedStatus === 'needs_review' ? 'needs_review' : 'completed'
      : 'pending';
    return {
      id: stage.id,
      label: stage.label,
      status,
      artifactType: stage.artifactTypes[0] ?? null,
      producedAt: null,
    };
  });
}

// ---------------------------------------------------------------------------
// 2. ProductSeed (immutable) display
// ---------------------------------------------------------------------------

export function parseProductSeedDisplay(inputJson: string): ProductSeedDisplay | null {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    const seed = (parsed.productSeed ?? parsed) as Record<string, unknown>;
    if (typeof seed.sku !== 'string' || typeof seed.name !== 'string') return null;
    const sku = String(seed.sku);
    const name = String(seed.name);
    if (!sku.trim() || !name.trim()) return null;
    const price = seed.price != null ? String(seed.price) : '';
    return { sku, name, price };
  } catch {
    return null;
  }
}

export function isProductSeedImmutable(seed: ProductSeedDisplay): boolean {
  return seed.sku.length > 0 && seed.name.length > 0;
}

// ---------------------------------------------------------------------------
// 3. Discovery candidates
// ---------------------------------------------------------------------------

export function toDiscoveryCandidateDisplays(candidates: unknown): DiscoveryCandidateDisplay[] {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((c) => ({
      url: typeof c.url === 'string' ? c.url : '',
      domain: typeof c.domain === 'string' ? c.domain : '',
      sourceType: typeof c.sourceType === 'string' ? c.sourceType : 'other',
      confidence: typeof c.confidence === 'number' ? c.confidence : null,
    }))
    .filter((d) => d.url.length > 0);
}

// ---------------------------------------------------------------------------
// 4. Extraction profile / method / path
// ---------------------------------------------------------------------------

export function toExtractionProfileDisplays(
  bundles: unknown,
  sources: PiSourceRow[],
): ExtractionProfileDisplay[] {
  if (!Array.isArray(bundles)) return [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  return bundles
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .map((b) => {
      const profile = b.profileBinding as Record<string, unknown> | undefined;
      const observation = b.observation as Record<string, unknown> | undefined;
      const sourceId = typeof b.sourceId === 'string' ? b.sourceId : null;
      const source = sourceId ? sourceById.get(sourceId) : undefined;
      return {
        domain: typeof profile?.domain === 'string' ? profile.domain : (source?.domain ?? ''),
        profileVersion: typeof profile?.version === 'string' ? profile.version : (typeof b.profileVersion === 'string' ? b.profileVersion : 'unknown'),
        method: typeof b.extractionMethod === 'string' ? b.extractionMethod : (typeof observation?.method === 'string' ? observation.method : 'unknown'),
        selectorPath: typeof b.sourcePath === 'string' ? b.sourcePath : (typeof observation?.sourcePath === 'string' ? observation.sourcePath : null),
        sourceUrl: typeof b.sourceUrl === 'string' ? b.sourceUrl : (source?.url ?? null),
        contentHash: typeof b.contentHash === 'string' ? b.contentHash : (source?.contentHash ?? null),
      };
    });
}

// ---------------------------------------------------------------------------
// 5. Resolver facts + conflicts (never leak raw logs)
// ---------------------------------------------------------------------------

export function toResolverFactDisplays(resolvedFactSet: unknown): ResolverFactDisplay[] {
  if (!resolvedFactSet || typeof resolvedFactSet !== 'object') return [];
  const set = resolvedFactSet as Record<string, unknown>;
  const facts = Array.isArray(set.facts) ? set.facts : [];
  return facts
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null && typeof f.field === 'string')
    .map((f) => ({
      field: String(f.field),
      status: (['resolved', 'conflict', 'needs_more_evidence', 'abstained'] as unknown as string[]).includes(String(f.status))
        ? (String(f.status) as ResolverFactDisplay['status'])
        : 'needs_more_evidence',
      value: f.value != null ? String(f.value) : null,
      confidence: typeof f.confidence === 'number' ? f.confidence : 0,
      supportingEvidenceIds: Array.isArray((f.supportingEvidence as Array<Record<string, unknown>>) ?? [])
        ? ((f.supportingEvidence as Array<Record<string, unknown>>).map((e) => String(e.id ?? e.evidenceId ?? '')).filter(Boolean))
        : Array.isArray(f.evidenceIds) ? (f.evidenceIds as string[]) : [],
      contradictingEvidenceIds: Array.isArray(f.contradictingEvidence)
        ? ((f.contradictingEvidence as Array<Record<string, unknown>>).map((e) => String(e.id ?? e.evidenceId ?? '')).filter(Boolean))
        : [],
    }));
}

export function toResolverConflictDisplays(resolvedFactSet: unknown): ResolverConflictDisplay[] {
  if (!resolvedFactSet || typeof resolvedFactSet !== 'object') return [];
  const set = resolvedFactSet as Record<string, unknown>;
  const conflicts = Array.isArray(set.conflicts) ? set.conflicts : Array.isArray(set.factConflicts) ? set.factConflicts : [];
  return conflicts
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null && typeof c.field === 'string')
    .map((c) => ({
      field: String(c.field),
      reason: typeof c.reason === 'string' ? c.reason : '',
      sides: Array.isArray(c.sides)
        ? (c.sides as Array<Record<string, unknown>>).map((s) => ({
            value: typeof s.value === 'string' ? s.value : String(s.value ?? ''),
            evidenceIds: Array.isArray(s.evidenceIds) ? (s.evidenceIds as string[]) : [],
          }))
        : [],
    }));
}

export function getUnresolvedFields(factDisplays: ResolverFactDisplay[]): string[] {
  return factDisplays
    .filter((f) => f.status === 'needs_more_evidence' || f.status === 'abstained')
    .map((f) => f.field);
}

// ---------------------------------------------------------------------------
// 6. Curator facts with provenance links
// ---------------------------------------------------------------------------

export function toCuratorFactDisplays(curatedDraft: unknown, resolvedFactSet: unknown): CuratorFactDisplay[] {
  if (!curatedDraft || typeof curatedDraft !== 'object') return [];
  const draft = curatedDraft as Record<string, unknown>;
  const facts = Array.isArray(draft.commerceFacts) ? draft.commerceFacts : Array.isArray(draft.facts) ? draft.facts : [];
  const resolverFacts = new Set(toResolverFactDisplays(resolvedFactSet).map((f) => f.field));
  return facts
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null && typeof f.field === 'string')
    .map((f) => {
      const field = String(f.field);
      const evidenceIds = Array.isArray(f.evidenceIds) ? (f.evidenceIds as string[]) : [];
      return {
        field,
        value: f.value != null ? String(f.value) : '',
        evidenceIds,
        groundedInResolvedFact: resolverFacts.has(field),
        supportedByEvidenceCount: evidenceIds.length,
      };
    });
}

export function getProvenanceLinks(
  curatorFacts: CuratorFactDisplay[],
  evidence: PiEvidenceRow[],
  sources: PiSourceRow[],
): ProvenanceLink[] {
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const links: ProvenanceLink[] = [];
  for (const fact of curatorFacts) {
    for (const eid of fact.evidenceIds) {
      const ev = evidenceById.get(eid);
      const source = ev ? sourceById.get(ev.sourceId) : undefined;
      let contentHash: string | null = null;
      try {
        const meta = ev?.metadataJson ? JSON.parse(ev.metadataJson) as Record<string, unknown> : null;
        contentHash = typeof meta?.contentHash === 'string' ? meta.contentHash : null;
      } catch { /* ignore */ }
      links.push({
        resolvedFactField: fact.field,
        evidenceId: eid,
        sourceUrl: source?.url ?? ev?.snippet ?? null,
        method: ev?.extractionMethod ?? null,
        contentHash,
      });
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// 7. Verifier verdict
// ---------------------------------------------------------------------------

export function toVerifierVerdictDisplay(report: unknown): VerifierVerdictDisplay | null {
  if (!report || typeof report !== 'object') return null;
  const r = report as Record<string, unknown>;
  const verdict = typeof r.verdict === 'string' ? r.verdict : typeof r.status === 'string' ? r.status : null;
  if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'human_review') return null;
  const mapped: VerifierVerdictDisplay['verdict'] = verdict === 'fail' ? 'fail' : verdict === 'human_review' ? 'human_review' : 'pass';
  return {
    verdict: mapped,
    summary: typeof r.summary === 'string' ? r.summary : typeof r.reason === 'string' ? r.reason : '',
    failingFields: Array.isArray(r.failingFields) ? (r.failingFields as string[]) : Array.isArray(r.failedFields) ? (r.failedFields as string[]) : [],
    evidenceIds: Array.isArray(r.evidenceIds) ? (r.evidenceIds as string[]) : [],
    conflictFields: Array.isArray(r.conflictFields) ? (r.conflictFields as string[]) : [],
  };
}

// ---------------------------------------------------------------------------
// 8. Escaping + allowlist enforcement (never leak raw logs)
// ---------------------------------------------------------------------------

export function escapeArtifactString(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isUnsupportedClaim(value: string | null, evidenceCount: number, commerceApproved?: boolean): boolean {
  if (value == null || value.trim() === '') return true;
  if (evidenceCount === 0) return true;
  if (commerceApproved === false) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 9. Policy snapshot (read-only, server owns policy)
// ---------------------------------------------------------------------------

export interface PolicySnapshotDisplay {
  configId: string;
  allowedTools: string[];
  researchTools: string[];
  allowedSourceDomains: string[];
  modelRoute: { provider: string; model: string; thinkingLevel: string } | null;
  maxToolCalls: number | null;
  maxCostUsd: number | null;
  deadlineMs: number | null;
  isReadOnly: true;
}

export function toPolicySnapshotDisplay(policyJson: string): PolicySnapshotDisplay | null {
  try {
    const p = JSON.parse(policyJson) as Record<string, unknown>;
    const modelRoute = p.modelRoute as Record<string, unknown> | null;
    return {
      configId: typeof p.configId === 'string' ? p.configId : '',
      allowedTools: Array.isArray(p.allowedTools) ? (p.allowedTools as string[]) : [],
      researchTools: Array.isArray(p.researchTools) ? (p.researchTools as string[]) : [],
      allowedSourceDomains: Array.isArray(p.allowedSourceDomains) ? (p.allowedSourceDomains as string[]) : [],
      modelRoute: modelRoute && typeof modelRoute.provider === 'string' && typeof modelRoute.model === 'string'
        ? { provider: String(modelRoute.provider), model: String(modelRoute.model), thinkingLevel: String(modelRoute.thinkingLevel ?? 'medium') }
        : null,
      maxToolCalls: typeof p.maxToolCalls === 'number' ? p.maxToolCalls : null,
      maxCostUsd: typeof p.maxCostUsd === 'number' ? p.maxCostUsd : null,
      deadlineMs: typeof p.deadlineMs === 'number' ? p.deadlineMs : null,
      isReadOnly: true as const,
    };
  } catch {
    return null;
  }
}
