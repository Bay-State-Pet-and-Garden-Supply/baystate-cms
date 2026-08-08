/**
 * Image research tools (PI-6).
 *
 * verify_image_candidate runs the deterministic verification pipeline against
 * a candidate URL (gateway-quarantined fetch, decode, hashes, identity
 * comparison, rights resolution, commerce-approval). discover_image_candidates
 * normalizes structured discovery artifacts (JSON-LD, Shopify/WooCommerce
 * variant-image mappings, #29-style network captures) with full provenance —
 * network-free.
 *
 * Adapters never receive image binaries, raw credentials, or catalog write
 * access; every result carries an `image_evidence` id the agent can cite.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/23
 */
import { Type } from 'typebox';
import { createRequire } from 'node:module';
import { defaultPolicyGateway, PolicyDeniedError } from '../policy';
import { parseNetContent, verifyImageCandidate } from '../assets/verification';
import { discoverCandidates } from '../assets/discovery';
import type { DiscoveredImageCandidate, ExtractionMethod, IdentityObservation } from '../assets/schema';
import type { PiToolAdapter, PiToolContext, PiToolResult } from './contract';
import { errorResult, evidenceId, noResult, okResult, policyDenied } from './contract';
import { boundedString } from './registry';
import type { EvidenceResolver, ResolvedEvidenceFact, ReuseGrantRecord } from '../assets/verification';

export const verifyImageCandidateTool: PiToolAdapter = {
  name: 'verify_image_candidate',
  version: '1.0.0',
  description:
    'Verify a candidate product image against the expected product: quarantine-fetch through the policy gateway, decode and reject corrupt content, record content + perceptual hashes, compare observed packaging evidence (GTIN, name, net content, pack count, flavor, formula, variant), resolve rights from the declared source and basis, and compute the deterministic commerce-approved flag. Never returns image binaries. Pass observed fields from extract_packaging_evidence when available.',
  parameters: Type.Object({
    url: boundedString(512, 'Image URL'),
    gtin: Type.Optional(boundedString(64, 'Expected GTIN/UPC')),
    expectedName: Type.Optional(boundedString(256, 'Expected product name')),
    variant: Type.Optional(boundedString(256, 'Expected variant')),
    netContentValue: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    netContentUnit: Type.Optional(boundedString(16, 'Net content unit')),
    packCount: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
    flavor: Type.Optional(boundedString(128, 'Expected flavor')),
    formula: Type.Optional(boundedString(128, 'Expected formula')),
    sourcePageUrl: Type.Optional(boundedString(512, 'Source page URL')),
    sourcePath: Type.Optional(boundedString(1024, 'Source path in the source')),
    sourceArtifactId: Type.Optional(boundedString(256, 'Source artifact id')),
    extractionMethod: Type.Optional(
      Type.Union([
        Type.Literal('json_ld'),
        Type.Literal('platform_api'),
        Type.Literal('network_response'),
        Type.Literal('profile_selector'),
        Type.Literal('media_api'),
        Type.Literal('manual'),
      ]),
    ),
    declaredSourceType: Type.Optional(
      boundedString(128, 'Declared source kind: supplier | manufacturer | retailer | licensed_dataset | manual_photography | network_discovered | generated'),
    ),
    rightsBasis: Type.Optional(boundedString(512, 'Declared rights basis (e.g. supplier_authorized_asset)')),
    rightsEvidenceRef: Type.Optional(boundedString(512, 'Evidence reference backing the rights basis')),
    evidenceIds: Type.Optional(Type.Array(boundedString(128, 'Durable evidence-row id backing this verification'))),
    observedProductName: Type.Optional(boundedString(512, 'Observed product name (agent assertion — recorded, not authoritative)')),
    observedBrand: Type.Optional(boundedString(256, 'Observed brand (OCR/structured)')),
    observedVariant: Type.Optional(boundedString(256, 'Observed variant (OCR/structured)')),
    observedNetContentValue: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    observedNetContentUnit: Type.Optional(boundedString(16, 'Observed net content unit')),
    observedPackCount: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
    observedGtin: Type.Optional(boundedString(64, 'Observed GTIN (agent assertion — recorded, not authoritative)')),
  }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const url = String(params.url ?? '');
    const gateway = ctx.gateway ?? defaultPolicyGateway;

    // Server-resolved durable evidence (lazy import keeps this module
    // importable in vitest — no bun:sqlite at module scope).
    const evidenceResolver: EvidenceResolver = (evidenceIds) => resolveEvidenceFacts(ctx.runId, evidenceIds);

    const observed: IdentityObservation = {
      brand: params.observedBrand ? String(params.observedBrand) : null,
      productName: params.observedProductName ? String(params.observedProductName) : null,
      variant: params.observedVariant ? String(params.observedVariant) : null,
      netContent:
        params.observedNetContentValue !== undefined && params.observedNetContentUnit
          ? { value: Number(params.observedNetContentValue), unit: String(params.observedNetContentUnit) }
          : null,
      packCount: params.observedPackCount !== undefined ? Number(params.observedPackCount) : null,
      gtin: params.observedGtin ? String(params.observedGtin) : null,
    };

    try {
      const record = await verifyImageCandidate(
        {
          url,
          sourcePageUrl: params.sourcePageUrl ? String(params.sourcePageUrl) : null,
          sourcePath: params.sourcePath ? String(params.sourcePath) : null,
          sourceArtifactId: params.sourceArtifactId ? String(params.sourceArtifactId) : undefined,
          extractionMethod: params.extractionMethod as ExtractionMethod | undefined,
          expectedGtin: params.gtin ? String(params.gtin) : null,
          expectedName: params.expectedName ? String(params.expectedName) : null,
          expectedVariant: params.variant ? String(params.variant) : null,
          expectedNetContent:
            params.netContentValue !== undefined && params.netContentUnit
              ? { value: Number(params.netContentValue), unit: String(params.netContentUnit) }
              : null,
          expectedPackCount: params.packCount !== undefined ? Number(params.packCount) : null,
          expectedFlavor: params.flavor ? String(params.flavor) : null,
          expectedFormula: params.formula ? String(params.formula) : null,
          declaredSourceType: params.declaredSourceType ? String(params.declaredSourceType) : null,
          declaredRightsBasis: params.rightsBasis ? String(params.rightsBasis) : null,
          declaredRightsEvidenceRef: params.rightsEvidenceRef ? String(params.rightsEvidenceRef) : null,
          evidenceIds: Array.isArray(params.evidenceIds) ? (params.evidenceIds as unknown[]).map((id) => String(id)) : undefined,
          observed,
        },
        {
          runId: ctx.runId,
          policy: ctx.policy,
          gateway,
          signal: ctx.signal,
          evidenceResolver,
          // P0-6: rights resolve ONLY from the workspace's durable reuse
          // grants (server-authoritative). The declared source tier + basis
          // strings prove origin only, never reuse permission — absent a
          // grant, reuse is denied (fail closed).
          reuseGrantResolver: loadReuseGrantResolver(ctx.workspaceId),
        },
      );
      const evidenceContentHash = record.originalContentHash || undefined;
      if (record.qualityStatus === 'invalid') {
        return noResult(record.conflicts[0] ?? 'image could not be verified', [
          { id: evidenceId('verify_image_candidate', url), kind: 'image_evidence', url, method: 'image_verification_pipeline', contentHash: evidenceContentHash },
        ]);
      }
      return okResult(record, [
        {
          id: evidenceId('verify_image_candidate', url),
          kind: 'image_evidence',
          url,
          method: 'image_verification_pipeline',
          contentHash: evidenceContentHash,
          retrievedAt: record.retrievedAt,
        },
      ]);
    } catch (error) {
      if (error instanceof PolicyDeniedError) {
        return policyDenied(`network denied: ${error.decision.reasonCode}${error.decision.detail ? ` (${error.decision.detail})` : ''}`);
      }
      return errorResult('image_verification_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

export const discoverImageCandidatesTool: PiToolAdapter = {
  name: 'discover_image_candidates',
  version: '1.0.0',
  description:
    'Discover product image candidates from a structured artifact: JSON-LD image values, Shopify or WooCommerce embedded variant-image mappings, or a #29-style network-capture JSON array. Returns normalized candidates with source page, exact source path, artifact id, extraction method, and variant mapping. Network-free.',
  parameters: Type.Object({
    pageUrl: boundedString(512, 'Page URL the artifact came from'),
    content: boundedString(200_000, 'Artifact content: page HTML or embedded state JSON'),
    sourceType: Type.Union([
      Type.Literal('json_ld'),
      Type.Literal('shopify'),
      Type.Literal('woocommerce'),
      Type.Literal('network_capture'),
    ]),
    retrievedAt: Type.Optional(Type.String({ format: 'date-time' })),
  }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const pageUrl = String(params.pageUrl ?? '');
    const content = String(params.content ?? '');
    const sourceType = String(params.sourceType ?? '') as 'json_ld' | 'shopify' | 'woocommerce' | 'network_capture';
    const retrievedAt = params.retrievedAt ? String(params.retrievedAt) : undefined;
    try {
      const candidates: DiscoveredImageCandidate[] = discoverCandidates(sourceType, content, pageUrl, retrievedAt);
      if (candidates.length === 0) {
        return noResult(`No image candidates found in the ${sourceType} artifact`, [
          { id: evidenceId('discover_image_candidates', `${sourceType}:${pageUrl}`), kind: 'image_evidence', url: pageUrl, method: `image_discovery:${sourceType}` },
        ]);
      }
      return okResult(
        { candidates, count: candidates.length },
        [
          {
            id: evidenceId('discover_image_candidates', `${sourceType}:${pageUrl}`),
            kind: 'image_evidence',
            url: pageUrl,
            method: `image_discovery:${sourceType}`,
          },
        ],
      );
    } catch (error) {
      return errorResult('image_discovery_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

/**
 * Resolve durable evidence rows into the facts the verification pipeline
 * consumes. Lazy require (createRequire) keeps this module importable in
 * vitest (no bun:sqlite in the module graph) — see pi-executor for the
 * same pattern. Real runs always execute under bun.
 */
interface LazyEvidenceRow {
  id: string;
  sourceId: string;
  targetField: string;
  valueJson: string;
  extractionMethod: string | null;
  snippet: string | null;
  metadataJson: string | null;
}
interface LazySourceRow {
  id: string;
  url: string;
  domain: string;
}

const lazyRequire = createRequire(import.meta.url);

let _evidenceRepo:
  | {
      listPiEvidence: (runId: string) => LazyEvidenceRow[];
      listPiSources: (runId: string) => LazySourceRow[];
      listPiEvidenceByToolEvidenceId: (runId: string, toolEvidenceIds: string[]) => LazyEvidenceRow[];
    }
  | undefined;

function loadEvidenceRepo(): {
  listPiEvidence: (runId: string) => LazyEvidenceRow[];
  listPiSources: (runId: string) => LazySourceRow[];
  listPiEvidenceByToolEvidenceId: (runId: string, toolEvidenceIds: string[]) => LazyEvidenceRow[];
} {
  if (!_evidenceRepo) {
    try {
      const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
      if (!conn.isDbInitialized?.()) {
        // No DB (e.g. vitest): return an empty resolver — no evidence rows
        // can resolve, so identity comparison cannot approve. Fail closed.
        _evidenceRepo = {
          listPiEvidence: () => [],
          listPiSources: () => [],
          listPiEvidenceByToolEvidenceId: () => [],
        };
        return _evidenceRepo;
      }
    } catch {
      _evidenceRepo = {
        listPiEvidence: () => [],
        listPiSources: () => [],
        listPiEvidenceByToolEvidenceId: () => [],
      };
      return _evidenceRepo;
    }
    _evidenceRepo = lazyRequire('../../db/repositories/product-intelligence-repo') as NonNullable<typeof _evidenceRepo>;
  }
  return _evidenceRepo;
}

/**
 * Resolve durable evidence rows for the agent-visible evidence ids. The
 * registry relays deterministic tool evidence ids (evidenceId() /
 * fieldEvidenceId() — e.g. 'extract_product_page:abc123:gtin:def456') to the
 * model; when persisted, the DB row gets its own UUID with the deterministic
 * id stored in metadata.toolEvidenceId. Resolve BOTH namespaces so the real
 * agent path works end to end: first the row UUID, then the canonical
 * agent-facing metadata.toolEvidenceId namespace.
 */
function resolveEvidenceFacts(runId: string, evidenceIds: string[]): ResolvedEvidenceFact[] {
  if (!evidenceIds.length) return [];
  const repo = loadEvidenceRepo();
  const byRowId = repo.listPiEvidence(runId).filter((row) => evidenceIds.includes(row.id));
  const seen = new Set(byRowId.map((row) => row.id));
  const byToolEvidenceId = repo
    .listPiEvidenceByToolEvidenceId(runId, evidenceIds)
    .filter((row) => !seen.has(row.id));
  const rows = [
    ...byRowId.map((row) => ({ row, matchedNamespace: 'row_id' as const })),
    ...byToolEvidenceId.map((row) => ({ row, matchedNamespace: 'tool_evidence_id' as const })),
  ];
  if (rows.length === 0) return [];
  const sources = new Map(repo.listPiSources(runId).map((source) => [source.id, source]));
  return rows.map(({ row, matchedNamespace }) => {
    let value: unknown;
    try {
      value = JSON.parse(row.valueJson);
    } catch {
      value = null;
    }
    let contentHash: string | null;
    try {
      const metadata = row.metadataJson ? (JSON.parse(row.metadataJson) as { contentHash?: unknown }) : null;
      contentHash = metadata && typeof metadata.contentHash === 'string' ? metadata.contentHash : null;
    } catch {
      contentHash = null;
    }
    const source = sources.get(row.sourceId);
    return {
      id: row.id,
      targetField: row.targetField,
      value,
      extractionMethod: row.extractionMethod,
      snippet: row.snippet,
      sourceUrl: source?.url ?? null,
      sourceDomain: source?.domain ?? null,
      contentHash,
      matchedNamespace,
    };
  });
}

/**
 * P0-6: durable server-authoritative reuse grants. Lazy-load the workspace
 * grant resolver; with no DB (vitest) or no grants, reuse is denied.
 */
function loadReuseGrantResolver(workspaceId: string): (sourceTier: string, domain: string) => ReuseGrantRecord | null {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) {
      return () => null;
    }
  } catch {
    return () => null;
  }
  try {
    const repo = lazyRequire('../../db/repositories/pi-reuse-policy-repo') as {
      buildReuseGrantResolver: (workspaceId: string) => (sourceTier: string, domain: string) => ReuseGrantRecord | null;
    };
    return repo.buildReuseGrantResolver(workspaceId);
  } catch {
    return () => null;
  }
}

export const imageTools: PiToolAdapter[] = [verifyImageCandidateTool, discoverImageCandidatesTool];

export { parseNetContent };
