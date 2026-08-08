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
import type { DiscoveredImageCandidate, ExtractionMethod, IdentityObservation, ProductAssetEvidence } from '../assets/schema';
import type { PiToolAdapter, PiToolContext, PiToolResult } from './contract';
import { errorResult, evidenceId, noResult, okResult, policyDenied } from './contract';
import { boundedString } from './registry';
import type { EvidenceResolver, ResolvedEvidenceFact, ReuseGrantRecord, SourceTypeProvenance, VerifiedAgainstSnapshot } from '../assets/verification';

export const verifyImageCandidateTool: PiToolAdapter = {
  name: 'verify_image_candidate',
  version: '2.0.0',
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
    sourcePageUrl: Type.Optional(boundedString(512, 'Source page URL (display only — round-7: provenance comes from the server-created candidate record)')),
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
    candidateId: boundedString(128, 'Durable server-created image-candidate id (from discover_image_candidates) — the provenance that determines source tier'),
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

    // Round-4 (review P0): the comparison target is the server-derived run
    // identity (from the run input), never the agent's expected* params.
    // Agent-supplied expected*/declaredSourceType strings are NOT threaded
    // into verification at all — a conflicting hint cannot shift the
    // comparison target or select a reuse grant.
    const runIdentity = loadRunIdentity(ctx.runId);

    // Round-7 (review P0): provenance authority comes ONLY from the
    // server-created candidate record. The agent-selected sourcePageUrl and
    // agent-selected evidence rows can never select the source tier. When the
    // candidate record (or its discovering source) is unresolved, verification
    // fails closed: tier 'unknown', rights restricted.
    const candidateId = params.candidateId ? String(params.candidateId) : null;
    if (!candidateId) {
      return errorResult(
        'image_verification_failed',
        'candidateId is required: verification provenance must come from a server-created discover_image_candidates record',
      );
    }
    const candidate = loadAssetStore()?.getPiImageCandidate?.(candidateId);
    const discoveringSource =
      candidate?.discoveringSourceId
        ? loadSourceRows(ctx.runId).find((source) => source.id === candidate.discoveringSourceId)
        : undefined;
    if (!candidate) {
      return errorResult('image_verification_failed', `candidateId ${candidateId} does not resolve to a durable discovery record`);
    }
    if (!discoveringSource) {
      return errorResult('image_verification_failed', `candidate ${candidateId} has no durable discovering source (provenance unresolved — fail closed)`);
    }
    // The candidate record is a server-created relationship for ONE image:
    // verifying a different URL against it would let the agent repoint the
    // provenance at another asset.
    if (candidate.imageUrl !== url) {
      return errorResult('image_verification_failed', `candidate ${candidateId} was created for a different image (${candidate.imageUrl}); refusing to verify ${url}`);
    }

    try {
      // Round-8 (review P1): discovery provenance (sourcePath/sourceArtifactId/
      // extractionMethod) comes from the SERVER-CREATED candidate row — never
      // from agent parameters. The agent's sourcePath/sourceArtifactId/
      // extractionMethod params are non-authoritative hints that are dropped;
      // the verification pipeline method is recorded separately on the record
      // (verificationMethod = 'image_verification_pipeline') while the asset's
      // extractionMethod stays the candidate's discovery method.
      const record = await verifyImageCandidate(
        {
          url,
          // Round-7: provenance is server-derived from the candidate record —
          // the discovering source's URL, never the agent's sourcePageUrl.
          sourcePageUrl: discoveringSource.url ?? null,
          sourcePath: candidate.sourcePath ?? null,
          sourceArtifactId: candidate.sourceArtifactId ?? undefined,
          extractionMethod: (candidate.extractionMethod as ExtractionMethod | undefined) ?? undefined,
          candidateId,
          runIdentity,
          evidenceIds: Array.isArray(params.evidenceIds) ? (params.evidenceIds as unknown[]).map((id) => String(id)) : undefined,
          // Round-6: server-resolved asset-to-GTIN linkage for THIS image
          // (same run + URL, previously verified exact). Never agent-supplied.
          assetGtinLinkages: loadAssetGtinLinkages(ctx.runId, url),
          observed,
        },
        {
          runId: ctx.runId,
          policy: ctx.policy,
          gateway,
          signal: ctx.signal,
          evidenceResolver,
          // Round-4: source kind derives from the durable source row for the
          // URL (provenance), never the agent's declaredSourceType.
          sourceTypeResolver: loadSourceTypeResolver(ctx.runId),
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
      // Round-3 (review finding 5): persist the server-verified record as a
      // durable asset row so the terminal bundle can cite it (verifiedAssetIds)
      // and the server can re-derive identity/rights/quality/commerce-approval
      // from durable fields. Lazy (bun-only): with no DB (vitest) the record
      // returns without a persisted id (fail closed — nothing to cite).
      const verifiedAssetId = persistVerifiedAsset(ctx.runId, record);
      return okResult({ ...record, verifiedAssetId }, [
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
  version: '2.0.0',
  description:
    'Discover product image candidates from a SERVER-RETAINED page artifact (run extract_product_page first, which returns artifactId). ' +
    'Loads the artifact bytes server-side (the agent never supplies page content), parses JSON-LD image values, Shopify/WooCommerce embedded variant-image mappings, or a network-capture JSON array, ' +
    'and creates durable candidate records attested to the artifact. Network-free.',
  parameters: Type.Object({
    artifactId: boundedString(256, 'Durable page artifact id (from extract_product_page)'),
    sourceType: Type.Optional(
      Type.Union([
        Type.Literal('json_ld'),
        Type.Literal('shopify'),
        Type.Literal('woocommerce'),
        Type.Literal('network_capture'),
      ]),
    ),
  }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const artifactId = String(params.artifactId ?? '');
    const sourceType = params.sourceType ? String(params.sourceType) : undefined;
    // Round-9 (P1-1/P1-5): the candidate -> discovering-page relationship must
    // originate from a SERVER-RETAINED artifact. No agent-supplied content or
    // pageUrl can influence provenance — the artifact record (bytes + hash +
    // url) is the attestation. Fabricated content never reaches this path.
    const artifact = loadArtifactById(artifactId);
    if (!artifact) {
      return noResult(`artifact not found for id ${artifactId.slice(0, 24)} (run extract_product_page first)`);
    }
    const pageUrl = artifact.url;
    const content = artifact.content;
    const parserType = sourceType ?? inferArtifactSourceType(content);
    try {
      const candidates: DiscoveredImageCandidate[] = discoverCandidates(parserType as DiscoveredImageCandidate['extractionMethod'], content, pageUrl, artifact.createdAt);
      if (candidates.length === 0) {
        return noResult(`No image candidates found in the ${parserType} artifact`, [
          { id: evidenceId('discover_image_candidates', `${parserType}:${pageUrl}`), kind: 'image_evidence', url: pageUrl, method: `image_discovery:${parserType}` },
        ]);
      }
      let enriched: Array<DiscoveredImageCandidate & { candidateId?: string; artifactId?: string }> = candidates;
      try {
        const store = loadAssetStore();
        if (store) {
          const sources = loadSourceRows(ctx.runId);
          let pageSource = sources.find((source) => source.url === pageUrl);
          if (!pageSource) {
            const created = store.insertPiSource({
              runId: ctx.runId,
              url: pageUrl,
              domain: domainOfUrl(pageUrl),
              sourceType: 'other',
            }) as LazySourceRow;
            pageSource = { id: created.id, url: pageUrl, sourceType: 'other' };
            sources.push(pageSource);
          }
          enriched = candidates.map((candidate) => ({
            ...candidate,
            candidateId: store.insertPiImageCandidate({
              runId: ctx.runId,
              imageUrl: candidate.url,
              discoveringSourceId: pageSource?.id ?? null,
              sourceArtifactId: candidate.sourceArtifactId ?? null,
              sourcePath: candidate.sourcePath ?? null,
              extractionMethod: candidate.extractionMethod ?? null,
              variantReference: candidate.variantReference ?? null,
              entityId: candidate.entityId ?? null,
              attestationArtifactId: artifact.id,
              attestedContentHash: artifact.contentHash,
            }).id,
            artifactId: artifact.id,
          }));
        }
      } catch (error) {
        // No DB (vitest) or persistence failure: candidates return without
        // durable ids — verification of an unpersisted candidate fails
        // closed on the missing candidateId.
        console.warn('[discover_image_candidates] could not persist candidate provenance:', error instanceof Error ? error.message : String(error));
      }
      return okResult(
        { candidates: enriched, count: enriched.length, artifactId },
        [
          {
            id: evidenceId('discover_image_candidates', `${parserType}:${pageUrl}`),
            kind: 'image_evidence',
            url: pageUrl,
            method: `image_discovery:${parserType}`,
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
  sourceType?: string | null;
}

/** Round-7: durable server-created image-candidate record. */
interface LazyCandidateRow {
  id: string;
  runId: string;
  imageUrl: string;
  discoveringSourceId: string | null;
  sourceArtifactId: string | null;
  sourcePath: string | null;
  extractionMethod: string | null;
  variantReference: string | null;
  entityId: string | null;
  createdAt: string;
}

const lazyRequire = createRequire(import.meta.url);

let _evidenceRepo:
  | {
      listPiEvidence: (runId: string) => LazyEvidenceRow[];
      listPiSources: (runId: string) => LazySourceRow[];
      listPiEvidenceByToolEvidenceId: (runId: string, toolEvidenceIds: string[]) => LazyEvidenceRow[];
      getPiPageArtifact: (id: string) => { id: string; url: string; contentHash: string; content: string; createdAt: string | null } | undefined;
    }
  | undefined;

function loadEvidenceRepo(): {
  listPiEvidence: (runId: string) => LazyEvidenceRow[];
  listPiSources: (runId: string) => LazySourceRow[];
  listPiEvidenceByToolEvidenceId: (runId: string, toolEvidenceIds: string[]) => LazyEvidenceRow[];
  getPiPageArtifact: (id: string) => { id: string; url: string; contentHash: string; content: string; createdAt: string | null } | undefined;
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
          getPiPageArtifact: () => undefined,
        };
        return _evidenceRepo;
      }
    } catch {
      _evidenceRepo = {
        listPiEvidence: () => [],
        listPiSources: () => [],
        listPiEvidenceByToolEvidenceId: () => [],
        getPiPageArtifact: () => undefined,
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

// ---------------------------------------------------------------------------
// Round-3 (review finding 5): durable persistence of server-verified records.
// The terminal bundle cites these asset row ids; the validator and the
// persistence layer re-derive authority from the rows (never from agent
// claims). Lazy require — real runs execute under bun; with no DB (vitest)
// persistence is skipped and verifiedAssetId is null (nothing to cite).
// ---------------------------------------------------------------------------
interface LazySourceRow {
  id: string;
  url: string;
}

let _assetStore:
  | {
      insertPiSource: (input: Record<string, unknown>) => LazySourceRow;
      listPiSources: (runId: string) => LazySourceRow[];
      insertPiAsset: (input: Record<string, unknown>) => { id: string };
      listPiAssetsByRun: (runId: string) => Array<{
        id: string;
        sourceUrl: string;
        exactProductMatch: number | boolean;
        verifiedAgainstJson: string | null;
        originalContentHash: string | null;
      }>;
      // Round-7: server-created image-candidate records.
      insertPiImageCandidate: (input: Record<string, unknown>) => LazyCandidateRow;
      getPiImageCandidate: (id: string) => LazyCandidateRow | undefined;
      listPiImageCandidatesByRun: (runId: string) => LazyCandidateRow[];
    }
  | null
  | undefined;

function loadAssetStore(): NonNullable<typeof _assetStore> | null {
  if (_assetStore !== undefined) return _assetStore ?? null;
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) {
      _assetStore = null;
      return null;
    }
  } catch {
    _assetStore = null;
    return null;
  }
  try {
    _assetStore = lazyRequire('../../db/repositories/product-intelligence-repo') as NonNullable<typeof _assetStore>;
    return _assetStore;
  } catch {
    _assetStore = null;
    return null;
  }
}

function domainOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/** Round-4 (review P0): the server-derived identity snapshot to verify an
 *  image against, from the run's immutable input (gtin + registerName).
 *  Lazy (bun-only); with no DB it returns null — verification then compares
 *  nothing (dimensions absent are never taken from the agent). */
/** Round-6: server-authoritative asset-to-GTIN linkage for THIS image.
 *  Only a durable asset row from the SAME run, for the SAME URL, that was
 *  previously verified exact and bound to a GTIN snapshot qualifies — this
 *  is the alternative to hash-bound OCR/decoder evidence for establishing
 *  the image's observed GTIN. The agent cannot supply this; it is derived
 *  from durable server state only. */
/** Round-8 (review P0): the model-supplied discovery artifact is only
 *  authoritative when it is ATTESTED to a server-retained page fetch. The
 *  server retains page-bytes hashes in durable evidence metadata (extraction
 *  field entries carry metadata.contentHash = sha256 of the fetched page);
 *  fabricated content can never match a hash the server actually recorded.
 *  No DB / no matching row -> fail closed (never persist a candidate). */
/** Round-9 (P1-1/P1-5): load a retained page artifact by id (the attestation
 *  for artifact-driven discovery). Lazy + fail-closed — no DB (vitest) or
 *  unknown id returns null, and discovery returns noResult. */
function loadArtifactById(artifactId: string): { id: string; url: string; contentHash: string; content: string; createdAt: string } | null {
  if (!artifactId) return null;
  try {
    const repo = loadEvidenceRepo();
    if (!repo) return null;
    const artifact = repo.getPiPageArtifact?.(artifactId);
    if (!artifact) return null;
    return {
      id: artifact.id,
      url: artifact.url,
      contentHash: artifact.contentHash,
      content: artifact.content,
      createdAt: artifact.createdAt ?? '',
    };
  } catch {
    return null;
  }
}

/** Round-9 (P1-1): infer the parser type from the retained artifact's content
 *  shape when the caller does not supply a sourceType hint. A hint is never
 *  provenance — it only selects which parser walks the server-retained bytes. */
function inferArtifactSourceType(content: string): string {
  const trimmed = content.trimStart();
  if (/ld\+json|"@type"\s*:/.test(content)) return 'json_ld';
  if (/Shopify\.ProductVariants|"variants"\s*:.*"handle"|shopify/i.test(content)) return 'shopify';
  if (/"variations"|woocommerce/i.test(content)) return 'woocommerce';
  if (trimmed.startsWith('[') || /"url"\s*:.*"method"|networkResponse/i.test(content)) return 'network_capture';
  return 'json_ld';
}

function loadAssetGtinLinkages(runId: string, url: string): Array<{ gtin: string; assetId?: string; originalContentHash: string | null }> {
  const store = loadAssetStore();
  if (!store) return [];
  try {
    const rows = store.listPiAssetsByRun(runId);
    const out: Array<{ gtin: string; assetId?: string; originalContentHash: string | null }> = [];
    for (const row of rows) {
      if (row.sourceUrl !== url) continue;
      if (!row.exactProductMatch) continue;
      if (!row.verifiedAgainstJson) continue;
      try {
        const snapshot = JSON.parse(row.verifiedAgainstJson) as { gtin?: unknown };
        const gtin = snapshot.gtin !== undefined && snapshot.gtin !== null ? String(snapshot.gtin).replace(/\D/g, '') : null;
        if (gtin && gtin.length >= 8) out.push({ gtin, assetId: row.id, originalContentHash: row.originalContentHash ?? null });
      } catch {
        // malformed snapshot rows never contribute a linkage
      }
    }
    return out;
  } catch {
    return [];
  }
}

function loadRunIdentity(runId: string): VerifiedAgainstSnapshot | null {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return null;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      getPiRun: (runId: string) => { inputJson: string } | undefined;
    };
    const run = repo.getPiRun(runId);
    if (!run) return null;
    const input = JSON.parse(run.inputJson) as { gtin?: unknown; registerName?: unknown };
    const gtin = input.gtin !== undefined && input.gtin !== null ? String(input.gtin).replace(/\D/g, '') : null;
    const name = input.registerName !== undefined && input.registerName !== null ? String(input.registerName) : null;
    if (!gtin && !name) return null;
    return { runId, gtin: gtin && gtin.length >= 8 ? gtin : null, name };
  } catch {
    return null;
  }
}

/** Round-4/5 (review P0/P1): resolve the durable source-kind for an asset
 *  URL through its durable provenance chain. Authority order (round-8):
 *   (a) the SERVER-CREATED candidate record's discovering source — when a
 *       candidateId is present it is authoritative and NEVER outranked by an
 *       image-URL source row (no sticky-tier override); an existing candidate
 *       whose discovering source is untiered fails closed ('unknown');
 *   (b) only when NO candidate provenance exists: the exact image/CDN URL
 *       source row.
 * Agent-declared source types never select a reuse grant — this resolver is
 * the only source of sourceType. */
function loadSourceTypeResolver(runId: string): (url: string, provenance: SourceTypeProvenance) => string | null {
  return (url: string, provenance: SourceTypeProvenance) => {
    const sourceList = loadSourceRows(runId);
    if (sourceList.length === 0) return null;
    // (a) Round-7/8: the SERVER-CREATED candidate record's discovering source
    // is the authority when a candidateId exists. The sourcePageUrl and
    // evidence rows the caller supplies are display/observation inputs only.
    if (provenance.candidateId) {
      const store = loadAssetStore();
      const candidate = store?.getPiImageCandidate?.(provenance.candidateId);
      if (!candidate?.discoveringSourceId) {
        // Candidate exists but its provenance is unresolved — fail closed.
        return null;
      }
      return (
        sourceList.find((source) => source.id === candidate.discoveringSourceId)?.sourceType ??
        null
      );
    }
    // (b) No candidate provenance: exact image/CDN URL source row.
    return sourceList.find((source) => source.url === url)?.sourceType ?? null;
  };
}

/** Per-run cached source rows (lazy, vitest-safe fail closed). */
const _sourceRowsCache = new Map<string, Array<{ id: string; url: string; sourceType: string | null }> | null>();
function loadSourceRows(runId: string): Array<{ id: string; url: string; sourceType: string | null }> {
  if (_sourceRowsCache.has(runId)) return _sourceRowsCache.get(runId) ?? [];
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) {
      _sourceRowsCache.set(runId, []);
      return [];
    }
  } catch {
    _sourceRowsCache.set(runId, []);
    return [];
  }
  try {
    const store = loadAssetStore();
    const rows = (store?.listPiSources(runId) ?? []).map((source) => ({
      id: source.id,
      url: source.url,
      sourceType: source.sourceType ?? null,
    }));
    _sourceRowsCache.set(runId, rows);
  } catch {
    _sourceRowsCache.set(runId, []);
  }
  return _sourceRowsCache.get(runId) ?? [];
}

/** Persist the server-verified record as a durable asset row; returns the
 *  row id (the id the terminal bundle cites in verifiedAssetIds) or null
 *  when no DB is available. Only usable records are persisted (invalid
 *  images are never primary material and carry no id to cite).
 *  Round-8 (review P1): the image-URL source row below is AUDIT ONLY — the
 *  resolved sourceType/rights relationship comes from the candidate's
 *  discovering source (record.sourceType is candidate-derived after the
 *  resolver reorder), never from whatever tier this audit row happens to
 *  carry; the tier-resolver ignores it whenever a candidate exists. */
function persistVerifiedAsset(runId: string, record: ProductAssetEvidence): string | null {
  const store = loadAssetStore();
  if (!store) return null;
  try {
    const existing = store.listPiSources(runId).find((source) => source.url === record.sourceUrl);
    const source =
      existing ??
      (store.insertPiSource({
        runId,
        url: record.sourceUrl,
        domain: domainOfUrl(record.sourceUrl),
        sourceType: record.sourceType,
        gtinMatchStatus: record.exactProductMatch ? 'exact' : 'unknown',
        variantMatchStatus: record.exactVariantMatch === true ? 'exact' : record.exactVariantMatch === false ? 'conflicting' : 'unknown',
        retrievedAt: record.retrievedAt ?? null,
        licenseRef: record.rightsEvidenceRef ?? null,
        termsRef: record.rightsBasis ?? null,
      }) as LazySourceRow);
    const asset = store.insertPiAsset({
      runId,
      sourceId: source.id,
      sourceUrl: record.sourceUrl,
      sourcePageUrl: record.sourcePageUrl ?? null,
      sourceType: record.sourceType,
      sourcePath: record.sourcePath ?? null,
      sourceArtifactId: record.sourceArtifactId ?? null,
      extractionMethod: record.extractionMethod ?? 'manual',
      retrievedAt: record.retrievedAt ?? new Date().toISOString(),
      originalContentHash: record.originalContentHash,
      perceptualHash: record.perceptualHash ?? null,
      variantReference: record.variantReference ?? null,
      rightsStatus: record.rightsStatus,
      rightsBasis: record.rightsBasis ?? null,
      rightsEvidenceRef: record.rightsEvidenceRef ?? null,
      observedBrand: record.observedBrand ?? null,
      observedProductName: record.observedProductName ?? null,
      observedVariant: record.observedVariant ?? null,
      observedNetContent: record.observedNetContent ?? null,
      observedPackCount: record.observedPackCount ?? null,
      observedGtin: record.observedGtin ?? null,
      exactProductMatch: record.exactProductMatch,
      exactVariantMatch: record.exactVariantMatch ?? null,
      qualityStatus: record.qualityStatus,
      commerceApproved: record.commerceApproved,
      conflicts: record.conflicts ?? [],
      payload: record,
      // Round-4: bind the durable asset to the run's immutable identity.
      verifiedAgainstJson: record.verifiedAgainst ? JSON.stringify(record.verifiedAgainst) : null,
      verifiedAgainstHash: record.verifiedAgainstHash ?? null,
      declaredSourceType: record.declaredSourceType ?? record.sourceType ?? null,
    }) as { id: string };
    return asset.id;
  } catch {
    // Persistence is best-effort at the tool boundary; a failure here must
    // never surface as a verification error (the record is still returned).
    return null;
  }
}

export { parseNetContent };
