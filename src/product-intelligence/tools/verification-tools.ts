/**
 * Verification research tools (PI-3).
 *
 * verify_candidate_page, check_exact_gtin_match, compare_identity_signals,
 * check_source_priority. Verification distinguishes exact GTIN evidence from
 * text similarity — an exact GTIN on the page is authoritative; name/brand
 * similarity is corroboration only.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/20
 */
import { Type } from 'typebox';
import { createRequire } from 'node:module';
import { verifyCandidate, type VerificationContext } from '../../onboarding/page-verifier';
import { defaultPolicyGateway } from '../policy';
import type { PiToolAdapter, PiToolContext, PiToolResult } from './contract';
import { errorResult, evidenceId, noResult, okResult, policyDenied } from './contract';
import { boundedString } from './registry';

const lazyRequire = createRequire(import.meta.url);

export const verifyCandidatePage: PiToolAdapter = {
  name: 'verify_candidate_page',
  version: '1.0.0',
  description:
    'Fetch and verify a candidate product page against the expected product: computes a verification score, identity signals (UPC present, SKU, JSON-LD product, official domain, title similarity), and whether the page has strong proof. Returns the decision reason.',
  parameters: Type.Object({
    url: boundedString(512, 'Candidate page URL'),
    gtin: boundedString(64, 'GTIN/UPC'),
    expectedName: boundedString(256, 'Expected product name'),
    brandHint: Type.Optional(boundedString(128, 'Brand hint')),
    officialDomains: Type.Optional(Type.Array(boundedString(256, 'Official domain'), { maxItems: 10 })),
  }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const url = String(params.url ?? '');
    const gateway = ctx.gateway ?? defaultPolicyGateway;
    const netCtx = { runId: ctx.runId, policy: ctx.policy };
    const netCheck = await gateway.checkNetworkRequest(netCtx, url);
    if (!netCheck.allowed) {
      return policyDenied(`network denied: ${netCheck.reasonCode}${netCheck.detail ? ` (${netCheck.detail})` : ''}`);
    }
    const context: VerificationContext = {
      upc: String(params.gtin),
      expectedName: String(params.expectedName),
      brandHint: params.brandHint ? String(params.brandHint) : null,
      officialDomains: params.officialDomains ? (params.officialDomains as string[]) : [],
    };
    const networkFetch = gateway.buildPiNetworkFetch(netCtx, { dataClassification: 'fetched_content' });
    try {
      const result = await verifyCandidate(
        { url, title: null, confidence: 0, sourceMethod: 'agent_candidate' },
        context,
        networkFetch,
        { signal: ctx.signal, timeoutMs: ctx.remainingMs },
      );
      if (!result) return noResult(`Could not fetch or parse ${url.slice(0, 80)}`);
      const gtinEvidence = result.signals.upcInPage ? 'gtin_evidence' : 'search_lead';
      return okResult(
        {
          url,
          verificationScore: result.verificationScore,
          hasStrongProof: result.hasStrongProof,
          decisionReason: result.decisionReason,
          signals: {
            domainOfficial: result.signals.domainOfficial,
            isProductDetailPage: result.signals.isProductDetailPage,
            isListingOrSearchPage: result.signals.isListingOrSearchPage,
            isBlogOrCmsPage: result.signals.isBlogOrCmsPage,
            titleSimilarity: result.signals.titleSimilarity,
            brandInPage: result.signals.brandInPage,
            upcInPage: result.signals.upcInPage,
            skuInPage: result.signals.skuInPage,
            hasJsonLdProduct: result.signals.hasJsonLdProduct,
          },
        },
        [
          {
            id: evidenceId('verify_candidate_page', url),
            kind: gtinEvidence,
            url,
            domain: (() => { try { return new URL(url).hostname; } catch { return undefined; } })(),
            method: 'page_verification',
            snippet: result.decisionReason.slice(0, 300),
          },
        ],
      );
    } catch (error) {
      return errorResult('verification_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

export const checkExactGtinMatch: PiToolAdapter = {
  name: 'check_exact_gtin_match',
  version: '1.0.0',
  description:
    'Deterministic check: does an exact normalized GTIN appear in a list of GTINs extracted from a page? Distinguishes exact GTIN evidence from mere text similarity.',
  parameters: Type.Object({
    requestedGtin: boundedString(64, 'GTIN being researched'),
    extractedGtins: Type.Array(boundedString(64, 'GTIN found on the page'), { maxItems: 20 }),
  }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const requested = String(params.requestedGtin).replace(/\D/g, '');
    const extracted = (params.extractedGtins as string[]).map((g) => g.replace(/\D/g, ''));
    const exact = extracted.includes(requested);
    const normalizedPrefix = requested.length >= 8 ? requested.slice(0, Math.min(8, requested.length)) : null;
    const partial = !exact && normalizedPrefix ? extracted.some((g) => g.startsWith(normalizedPrefix)) : false;
    return okResult(
      {
        exactMatch: exact,
        partialPrefixMatch: partial,
        requestedGtin: requested,
        extractedGtins: extracted,
        conclusion: exact ? 'exact_match' : partial ? 'partial_prefix_match' : 'no_match',
      },
      [{ id: evidenceId('check_exact_gtin_match', requested), kind: 'gtin_evidence', method: 'gtin_exact_comparison' }],
    );
  },
};

export const compareIdentitySignals: PiToolAdapter = {
  name: 'compare_identity_signals',
  version: '1.0.0',
  description:
    'Compare identity signals (name, brand, size, pack count) between the expected product and a page. Returns per-signal agreement. Text similarity is corroboration, never identity proof.',
  parameters: Type.Object({
    expectedName: boundedString(256, 'Expected product name'),
    expectedBrand: Type.Optional(boundedString(128, 'Expected brand')),
    pageTitle: Type.Optional(boundedString(512, 'Page title')),
    pageBrand: Type.Optional(boundedString(128, 'Brand extracted from the page')),
    pageSize: Type.Optional(boundedString(64, 'Size extracted from the page')),
    expectedSize: Type.Optional(boundedString(64, 'Expected size')),
  }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const norm = (value: string | undefined): string => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const expectedName = norm(String(params.expectedName));
    const pageTitle = norm(params.pageTitle ? String(params.pageTitle) : undefined);
    const expectedBrand = norm(params.expectedBrand ? String(params.expectedBrand) : undefined);
    const pageBrand = norm(params.pageBrand ? String(params.pageBrand) : undefined);
    const expectedSize = norm(params.expectedSize ? String(params.expectedSize) : undefined);
    const pageSize = norm(params.pageSize ? String(params.pageSize) : undefined);

    const nameAgreement =
      expectedName.length > 0 && pageTitle.length > 0
        ? pageTitle.includes(expectedName.slice(0, 12)) || expectedName.includes(pageTitle.slice(0, 12))
        : null;
    const brandAgreement =
      expectedBrand.length > 0 && pageBrand.length > 0 ? pageBrand === expectedBrand || pageBrand.includes(expectedBrand) || expectedBrand.includes(pageBrand) : null;
    const sizeAgreement =
      expectedSize.length > 0 && pageSize.length > 0 ? pageSize === expectedSize || pageSize.includes(expectedSize) || expectedSize.includes(pageSize) : null;

    return okResult(
      {
        nameAgreement,
        brandAgreement,
        sizeAgreement,
        conclusion:
          nameAgreement === false || brandAgreement === false
            ? 'conflicting'
            : sizeAgreement === false
              ? 'variant_conflict'
              : nameAgreement === true && (brandAgreement ?? true) && (sizeAgreement ?? true)
                ? 'aligned'
                : 'insufficient',
      },
      [{ id: evidenceId('compare_identity_signals', expectedName), kind: 'variant_evidence', method: 'identity_signal_comparison' }],
    );
  },
};

const KNOWN_RETAILER_DOMAINS = ['chewy.com', 'amazon.com', 'walmart.com', 'target.com', 'tractorsupply.com', 'acehardware.com', 'petco.com', 'petsmart.com', 'agway.com', 'tscstores.com'];

/** Round-8 (review P0): official/manufacturer/supplier authority comes ONLY
 *  from the CMS-managed brand-site registry — never from agent-supplied
 *  sourceKind or officialDomains. The lookup is lazy (createRequire) so this
 *  module stays importable without bun:sqlite (vitest); with no DB the result
 *  fails closed to 'unknown' (the trusted registry is the standing wiring
 *  dependency for manufacturer-tier authority). Round-9: the registry match
 *  carries the brand name + row id so authority can require a brand match.
 */
function trustedOfficialDomain(domain: string): { official: boolean; brandName?: string; brandSiteId?: string; reason: string } {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) {
      return { official: false, reason: 'trusted registry unavailable (no database)' };
    }
    const repo = lazyRequire('../../db/repositories/brand-site-repo') as {
      listAllBrandSites: () => Array<{ domain: string; brandName?: string; id?: string }>;
    };
    const sites = repo.listAllBrandSites();
    const matched = sites.find((site) => {
      const siteDomain = String(site.domain ?? '').replace(/^www\./, '').toLowerCase();
      return siteDomain !== '' && (domain === siteDomain || domain.endsWith(`.${siteDomain}`));
    });
    if (!matched) {
      return { official: false, reason: 'domain is not in the trusted brand-site registry' };
    }
    return {
      official: true,
      brandName: typeof matched.brandName === 'string' && matched.brandName.length > 0 ? matched.brandName : undefined,
      brandSiteId: typeof matched.id === 'string' && matched.id.length > 0 ? matched.id : undefined,
      reason: 'domain is in the CMS-managed brand-site registry',
    };
  } catch {
    return { official: false, reason: 'trusted registry unavailable (lookup failed)' };
  }
}

/** Round-9 (review P0): the run's expected brand hint (from the operator's
 *  brandHint), normalized. Round-10: DISPLAY-ONLY context — brand hints are
 *  untrusted search hints and NEVER establish authority (see loadResolvedBrand).
 *  Lazy + fail-closed so this module stays vitest-importable. */
function loadExpectedBrand(runId: string): string | null {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return null;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      getPiRun: (runId: string) => { inputJson?: string } | undefined;
    };
    const run = repo.getPiRun(runId);
    if (!run?.inputJson) return null;
    const input = JSON.parse(run.inputJson) as { brandHint?: unknown };
    if (typeof input.brandHint !== 'string' || !input.brandHint.trim()) return null;
    return input.brandHint.trim().toLowerCase();
  } catch {
    return null;
  }
}

/** Round-10 (review P0): the product brand resolved from DURABLE exact-GTIN
 *  evidence — verified assets (exact_product_match = 1) whose observed GTIN
 *  equals the run's requested GTIN. The untrusted brandHint never feeds this.
 *  Round-11 (review P1): returns the evidence PROVENANCE that established the
 *  brand (verified asset id + content hash + source page URL) so an authority
 *  record is a durable statement "Brand A observed from evidence E on asset
 *  bytes H whose GTIN X was independently exact". Returns null when the brand
 *  is unresolved OR ambiguous (multiple distinct resolved brands) — both fail
 *  closed, so no authority is minted. */
interface ResolvedBrand {
  brand: string;
  assetId: string;
  contentHash: string;
  sourcePageUrl: string | null;
  /** Round-12 (review P0-3): the QUALIFYING brand evidence binding persisted
   *  on the asset — never reconstructed from observedBrand + image hash. */
  brandEvidenceId: string | null;
  brandEvidenceHash: string | null;
}

/** Round-12 (review P0-3): an asset's brand is authority-qualified ONLY when
 *  the asset retains a qualifying binding: either a durable brand evidence
 *  row id (byte-bound OCR/decoder observation or structured evidence
 *  entity-linked to the exact-GTIN product) or a bytes-bound hash that
 *  equals the verified image bytes (deterministic decoder output). An asset
 *  whose observedBrand came from an unqualified hash-less fact carries no
 *  binding and can never resolve the product brand for authority. */
function hasQualifiedBrandBinding(resolved: {
  brandEvidenceId?: string | null;
  brandEvidenceHash?: string | null;
  contentHash: string;
}): boolean {
  if (typeof resolved.brandEvidenceId === 'string' && resolved.brandEvidenceId.length > 0) return true;
  return (
    typeof resolved.brandEvidenceHash === 'string' &&
    resolved.brandEvidenceHash.length > 0 &&
    resolved.brandEvidenceHash === resolved.contentHash
  );
}

/** Round-12 (review P0-3): exact-GTIN assets whose brand is QUALIFIED (see
 *  hasQualifiedBrandBinding) — the only durable basis for resolving the
 *  canonical product brand. Lazy + fail closed. */
function listQualifiedResolvedBrands(
  repo: {
    listResolvedProductBrands: (runId: string, requestedGtin?: string | null) => Array<ResolvedBrand>;
  },
  runId: string,
  requestedGtin: string,
): ResolvedBrand[] {
  return repo.listResolvedProductBrands(runId, requestedGtin).filter(hasQualifiedBrandBinding);
}

function loadResolvedBrand(runId: string): ResolvedBrand | null {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return null;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      getPiRun: (runId: string) => { inputJson?: string } | undefined;
      listResolvedProductBrands: (runId: string, requestedGtin?: string | null) => Array<ResolvedBrand>;
    };
    const run = repo.getPiRun(runId);
    if (!run?.inputJson) return null;
    const input = JSON.parse(run.inputJson) as { gtin?: unknown };
    if (typeof input.gtin !== 'string' || !input.gtin.trim()) return null;
    const brands = listQualifiedResolvedBrands(repo, runId, input.gtin.trim());
    if (brands.length !== 1) return null;
    return brands[0];
  } catch {
    return null;
  }
}

/** Round-12 (review P0-2): a source page is an AUTHORITATIVE manufacturer
 *  source for a brand ONLY when its domain is in the trusted brand-site
 *  registry AND the registry entry's brand equals the resolved product
 *  brand. Product evidence resolves WHICH brand the product is; only the
 *  trusted registry resolves WHO owns the source. Shared by
 *  check_source_priority and the deterministic authority refresh so both
 *  paths agree. */
function registryBrandMatches(pageUrl: string, brand: string): { matches: boolean; brandName?: string; brandSiteId?: string } {
  let domain: string;
  try {
    domain = new URL(pageUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return { matches: false };
  }
  const registry = trustedOfficialDomain(domain);
  if (!registry.official || typeof registry.brandName !== 'string' || !registry.brandName.trim()) {
    return { matches: false };
  }
  const match = registry.brandName.trim().toLowerCase() === String(brand).trim().toLowerCase();
  return { matches: match, brandName: registry.brandName, brandSiteId: registry.brandSiteId };
}

/** Round-11 (review P1): DETERMINISTIC server-side authority establishment —
 *  a direct consequence of verified product evidence, never an agent
 *  orchestration trick. After an exact-GTIN asset exists with a trustworthy
 *  brand, the server evaluates every known source authority and upserts
 *  evidence-provenanced pi_source_authorities records (and upgrades the
 *  source rows so resolvers observe the tier). Callers (e.g. image
 *  verification after persisting an exact asset) invoke this best-effort;
 *  the rights decision of a SUBSEQUENT verification reads fresh source rows.
 *  A source page resolving to multiple distinct brands is skipped
 *  (ambiguous — fail closed). Lazy + fail closed (no DB -> no-op). */
export function refreshResolvedAuthoritiesForRun(runId: string): void {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      getPiRun: (runId: string) => { inputJson?: string } | undefined;
      listResolvedProductBrands: (runId: string, requestedGtin?: string | null) => Array<ResolvedBrand>;
      listPiEvidence: (runId: string) => Array<{
        id: string;
        sourceId: string;
        targetField: string;
        valueJson: string;
        metadataJson: string | null;
      }>;
      listPiSources: (runId: string) => Array<{ id: string; url: string; sourceType?: string | null }>;
      listPiImageCandidatesByRun: (runId: string) => Array<{ imageUrl: string; discoveringSourceId: string | null }>;
      listSourceAuthoritiesByRun: (runId: string) => Array<{ sourceId: string; authorityType: string }>;
      insertPiSource: (input: { runId: string; url: string; domain: string; sourceType: string }) => { id: string };
      upsertSourceAuthority: (input: {
        sourceId: string;
        authorityType: string;
        authorityRef?: string | null;
        brandName?: string | null;
        establishedBy: string;
        brandEvidenceId?: string | null;
        brandEvidenceHash?: string | null;
        brandEvidenceKind?: string | null;
      }) => unknown;
      revokeSourceAuthority: (sourceId: string, authorityType: string) => void;
    };
    const run = repo.getPiRun(runId);
    if (!run?.inputJson) return;
    const input = JSON.parse(run.inputJson) as { gtin?: unknown };
    if (typeof input.gtin !== 'string' || !input.gtin.trim()) return;
    const runGtinDigits = input.gtin.trim().replace(/\D/g, '');

    // Round-12 (review P1-2): RECONCILER. Compute the DESIRED manufacturer
    // authority per page source from the current durable evidence, then
    // establish, replace, or revoke so the stored authority always matches
    // what the current evidence + trusted registry actually support.
    // desiredByPageUrl: pageUrl -> { brand, evidenceId, evidenceHash, evidenceKind, source }
    interface DesiredAuthority {
      brand: string;
      evidenceId: string | null;
      evidenceHash: string | null;
      evidenceKind: string;
      sourceId: string;
      phase: 'evidence' | 'asset';
      anchorRef: string;
    }
    const desiredByPageUrl = new Map<string, DesiredAuthority>();
    // Round-12 (review P1-2): a page source whose CURRENT evidence resolves
    // to multiple distinct brands is AMBIGUOUS — ambiguity anywhere (evidence
    // phase, asset phase, or across both) EXCLUDES the source from desired
    // authority and REVOKES any stale record.
    const ambiguousPageUrls = new Set<string>();

    const evidenceBrandsByPageUrl = new Map<
      string,
      Array<{ brand: string; evidenceId: string; hash: string; sourceId: string }>
    >();

    // ---- EVIDENCE phase (pre-verification; real OCR shape) --------------
    // extract_packaging_evidence emits targetField 'upc' (image_ocr,
    // contentHash = image bytes) and its brand facts belong to the IMAGE URL
    // source. A hash-bound exact GTIN + a brand observation bound to the
    // SAME bytes on the same source resolve the product brand BEFORE any
    // exact asset exists — so the FIRST verification observes the tier.
    // Round-12 (review P1-1): accept 'upc' as the GTIN target field and
    // resolve the PAGE source through the candidate record
    // (imageUrl -> discoveringSourceId) when the evidence source is an image.
    try {
      const evidence = repo.listPiEvidence(runId);
      const gtinHashes = new Map<string, { sourceId: string; hash: string }>();
      for (const row of evidence) {
        const field = (row.targetField ?? '').toLowerCase();
        if (field !== 'gtin' && field !== 'upc') continue;
        if (!row.metadataJson) continue;
        let value: unknown;
        try {
          value = JSON.parse(row.valueJson);
        } catch {
          continue;
        }
        const normalized = String(value ?? '').replace(/\D/g, '');
        if (normalized !== runGtinDigits) continue;
        let hash: string | null = null;
        try {
          const meta = JSON.parse(row.metadataJson) as { contentHash?: unknown };
          if (typeof meta.contentHash === 'string' && meta.contentHash.length === 64) hash = meta.contentHash;
        } catch {
          /* malformed metadata is not evidence */
        }
        if (!hash) continue;
        gtinHashes.set(hash, { sourceId: row.sourceId, hash });
      }
      if (gtinHashes.size > 0) {
        // Brand observations bound to the same image bytes + same source.
        const brandBySourceHash = new Map<string, { sourceId: string; hash: string; brand: string; evidenceId: string }>();
        for (const row of evidence) {
          if ((row.targetField ?? '').toLowerCase() !== 'brand' || !row.metadataJson) continue;
          let hash: string | null = null;
          try {
            const meta = JSON.parse(row.metadataJson) as { contentHash?: unknown };
            if (typeof meta.contentHash === 'string') hash = meta.contentHash;
          } catch {
            continue;
          }
          if (!hash || !gtinHashes.has(hash)) continue;
          let value: unknown;
          try {
            value = JSON.parse(row.valueJson);
          } catch {
            continue;
          }
          if (typeof value !== 'string' || !value.trim()) continue;
          const key = `${row.sourceId}:${hash}`;
          const norm = value.trim().toLowerCase();
          const existing = brandBySourceHash.get(key);
          if (!existing) {
            brandBySourceHash.set(key, { sourceId: row.sourceId, hash, brand: norm, evidenceId: row.id });
          } else if (existing.brand !== norm) {
            // Conflicting brand observations on the same bytes -> ambiguous.
            brandBySourceHash.set(key, { ...existing, brand: '__ambiguous__' });
          }
        }
        const sources = repo.listPiSources(runId);
        const candidates = repo.listPiImageCandidatesByRun(runId);
        // Resolve the PAGE source for an evidence source: OCR evidence rows
        // belong to the IMAGE URL source; the authority attaches to the
        // candidate's DISCOVERING page source. Evidence seeded directly on a
        // page source resolves to itself.
        const pageSourceOf = (sourceId: string): { id: string; url: string } | undefined => {
          const evidenceSource = sources.find((candidate) => candidate.id === sourceId);
          if (!evidenceSource) return undefined;
          const candidate = candidates.find((c) => c.imageUrl === evidenceSource.url);
          if (candidate?.discoveringSourceId) {
            const page = sources.find((source) => source.id === candidate.discoveringSourceId);
            if (page) return page;
          }
          return { id: evidenceSource.id, url: evidenceSource.url };
        };
        for (const entry of brandBySourceHash.values()) {
          const pageSource = pageSourceOf(entry.sourceId);
          if (!pageSource) continue;
          if (entry.brand === '__ambiguous__') {
            ambiguousPageUrls.add(pageSource.url);
            continue;
          }
          const list = evidenceBrandsByPageUrl.get(pageSource.url) ?? [];
          list.push({ brand: entry.brand, evidenceId: entry.evidenceId, hash: entry.hash, sourceId: pageSource.id });
          evidenceBrandsByPageUrl.set(pageSource.url, list);
        }
        // Round-13 (review P0-2): Aggregate evidence brands per page URL.
        // If a page source resolves to multiple distinct evidence brands,
        // mark it ambiguous before making any decision.
        for (const [pageUrl, entries] of evidenceBrandsByPageUrl) {
          const distinctBrands = new Set(entries.map((e) => e.brand));
          if (distinctBrands.size > 1) {
            ambiguousPageUrls.add(pageUrl);
          }
        }
      }
    } catch {
      // Fail closed: evidence-based authority is best-effort.
    }

    // ---- ASSET phase (stronger provenance — wins over evidence) ---------
    // Exact verified assets with a QUALIFIED brand binding. Round-12
    // (review P0-3): the asset must retain the qualifying brand evidence
    // binding; observedBrand alone is never enough. The binding hash is the
    // brand evidence's hash (the exact bytes for OCR/decoder), never a
    // reconstruction from observedBrand + originalContentHash.
    const assetBrandsByPageUrl = new Map<string, Array<ResolvedBrand>>();
    try {
      const brands = listQualifiedResolvedBrands(repo, runId, input.gtin.trim());
      for (const resolved of brands) {
        if (!resolved.sourcePageUrl) continue;
        const list = assetBrandsByPageUrl.get(resolved.sourcePageUrl) ?? [];
        list.push(resolved);
        assetBrandsByPageUrl.set(resolved.sourcePageUrl, list);
      }
      for (const [pageUrl, resolvedList] of assetBrandsByPageUrl) {
        const distinctBrands = new Set(resolvedList.map((r) => r.brand));
        if (distinctBrands.size > 1) {
          ambiguousPageUrls.add(pageUrl);
        }
      }
    } catch {
      // Fail closed: asset-based authority is best-effort.
    }

    // ---- DECISION PHASE (aggregate before decide) ------------------------
    const candidatePageUrls = new Set([...evidenceBrandsByPageUrl.keys(), ...assetBrandsByPageUrl.keys()]);

    // Round 14 (review P0-1): RUN-WIDE BRAND AMBIGUITY.
    // Compute the run-wide set of qualified candidate brands across all pages
    // (both evidence and asset phases). If the run contains multiple distinct
    // qualified product brands (e.g. branda.example has Brand A while brandb.example
    // has Brand B for GTIN X), the product brand is globally unresolved. No
    // manufacturer authority may be granted to ANY page in the run (fail closed).
    const runWideBrands = new Set<string>();
    for (const entries of evidenceBrandsByPageUrl.values()) {
      for (const entry of entries) {
        runWideBrands.add(entry.brand.toLowerCase());
      }
    }
    for (const resolvedList of assetBrandsByPageUrl.values()) {
      for (const resolved of resolvedList) {
        runWideBrands.add(resolved.brand.toLowerCase());
      }
    }
    if (runWideBrands.size > 1) {
      for (const pageUrl of candidatePageUrls) {
        ambiguousPageUrls.add(pageUrl);
      }
    }

    for (const pageUrl of candidatePageUrls) {
      if (ambiguousPageUrls.has(pageUrl)) {
        continue; // ambiguity within a phase or run-wide -> fail closed
      }
      const assetList = assetBrandsByPageUrl.get(pageUrl);
      const evList = evidenceBrandsByPageUrl.get(pageUrl);

      if (assetList && assetList.length > 0) {
        const assetBrand = assetList[0].brand;
        if (evList && evList.length > 0) {
          const evBrand = evList[0].brand;
          if (evBrand !== assetBrand) {
            ambiguousPageUrls.add(pageUrl); // ambiguity across phases
            continue;
          }
        }
        const resolved = assetList[0];
        let source = repo.listPiSources(runId).find((candidate) => candidate.url === pageUrl);
        if (!source) {
          try {
            const created = repo.insertPiSource({
              runId,
              url: pageUrl,
              domain: new URL(pageUrl).hostname.replace(/^www\./, '').toLowerCase(),
              sourceType: 'other',
            });
            source = { id: created.id, url: pageUrl };
          } catch {
            continue;
          }
        }
        const evidenceKind = resolved.brandEvidenceId ? 'evidence' : 'decoder';
        desiredByPageUrl.set(pageUrl, {
          brand: resolved.brand,
          evidenceId: resolved.brandEvidenceId,
          evidenceHash: resolved.brandEvidenceHash,
          evidenceKind,
          sourceId: source.id,
          phase: 'asset',
          anchorRef: `verified_asset:${resolved.assetId}`,
        });
      } else if (evList && evList.length > 0) {
        const ev = evList[0];
        desiredByPageUrl.set(pageUrl, {
          brand: ev.brand,
          evidenceId: ev.evidenceId,
          evidenceHash: ev.hash,
          evidenceKind: 'evidence',
          sourceId: ev.sourceId,
          phase: 'evidence',
          anchorRef: `evidence:${ev.evidenceId}`,
        });
      }
    }

    // ---- Registry gate + reconcile --------------------------------------
    // A source page is manufacturer-authoritative ONLY when the trusted
    // brand-site registry entry for its domain matches the resolved product
    // brand (review P0-2). Product evidence resolves the brand; the registry
    // resolves who owns the source. No match -> no authority -> REVOKE any
    // stale record.
    for (const [pageUrl, desired] of desiredByPageUrl) {
      if (ambiguousPageUrls.has(pageUrl)) {
        // Current evidence is ambiguous about WHICH brand this source is —
        // no authority until it resolves (fail closed, stale record revoked).
        repo.revokeSourceAuthority(desired.sourceId, 'manufacturer');
        continue;
      }
      const registry = registryBrandMatches(pageUrl, desired.brand);
      if (!registry.matches) {
        // Current evidence resolves a brand, but this page is not a trusted
        // official source for that brand (retailer page, wrong brand, or no
        // registry row) -> never an authority.
        repo.revokeSourceAuthority(desired.sourceId, 'manufacturer');
        continue;
      }
      repo.upsertSourceAuthority({
        sourceId: desired.sourceId,
        authorityType: 'manufacturer',
        authorityRef: desired.anchorRef,
        brandName: desired.brand,
        establishedBy:
          desired.phase === 'asset'
            ? desired.evidenceKind === 'decoder'
              ? 'verified_asset_decoder_brand'
              : 'verified_asset_evidence'
            : 'verified_evidence',
        brandEvidenceId: desired.evidenceId,
        brandEvidenceHash: desired.evidenceHash,
        brandEvidenceKind: desired.evidenceKind,
      });
    }

    // ---- Revocation sweep (review P1-2) ----------------------------------
    // Any existing manufacturer authority whose source no longer has a
    // DESIRED entry (evidence deleted, assets removed, or the source became
    // ambiguous) is revoked and the source tier downgraded.
    for (const authority of repo.listSourceAuthoritiesByRun(runId)) {
      if (authority.authorityType !== 'manufacturer') continue;
      const source = repo.listPiSources(runId).find((candidate) => candidate.id === authority.sourceId);
      if (!source || !desiredByPageUrl.has(source.url) || ambiguousPageUrls.has(source.url)) {
        repo.revokeSourceAuthority(authority.sourceId, 'manufacturer');
      }
    }
  } catch {
    // Fail closed: authority establishment is best-effort; absence of a record
    // leaves the source neutral (never a minted tier).
  }
}

/** Round-9 (review P0): establish a durable manufacturer authority for a source
 *  row when the registry brand matches the expected product brand. Round-11
 *  (review P1): the record is EVIDENCE-PROVENANCED — the verified asset id +
 *  content hash that resolved the brand are retained on the authority row.
 *  Lazy + fail closed (no DB / no source row → no record). The source row's
 *  tier is upgraded so existing resolvers observe the authority — the
 *  first-writer bug is closed.
 */
/** Round-12 (review P0-3): the qualified brand binding — the durable
 *  evidence row id + hash that actually established the brand (never a
 *  reconstruction from observedBrand + image hash). */
interface BrandBinding {
  evidenceId: string | null;
  evidenceHash: string | null;
  evidenceKind: string;
}
function establishManufacturerAuthority(
  runId: string,
  url: string,
  brandName: string,
  brandSiteId?: string,
  binding?: BrandBinding | null,
): void {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      listPiSources: (runId: string) => Array<{ id: string; url: string }>;
      insertPiSource: (input: { runId: string; url: string; domain: string; sourceType: string }) => { id: string };
      upsertSourceAuthority: (input: {
        sourceId: string;
        authorityType: string;
        authorityRef?: string | null;
        brandName?: string | null;
        establishedBy: string;
        brandEvidenceId?: string | null;
        brandEvidenceHash?: string | null;
        brandEvidenceKind?: string | null;
      }) => unknown;
    };
    // The authority-establishing call is itself a source-establishing path:
    // when no source row exists for the URL yet, create a NEUTRAL one first
    // (never a minted tier) so the authority record has a durable anchor.
    let source = repo.listPiSources(runId).find((candidate) => candidate.url === url);
    if (!source) {
      try {
        const created = repo.insertPiSource({
          runId,
          url,
          domain: new URL(url).hostname.replace(/^www\./, '').toLowerCase(),
          sourceType: 'other',
        });
        source = { id: created.id, url };
      } catch {
        return; // fail closed: no durable anchor, no authority
      }
    }
    repo.upsertSourceAuthority({
      sourceId: source.id,
      authorityType: 'manufacturer',
      authorityRef: brandSiteId ? `brand_site:${brandSiteId}` : null,
      brandName,
      establishedBy: 'check_source_priority:resolved_brand',
      brandEvidenceId: binding?.evidenceId ?? null,
      brandEvidenceHash: binding?.evidenceHash ?? null,
      brandEvidenceKind: binding?.evidenceKind ?? null,
    });
  } catch {
    // Fail closed: authority establishment is best-effort; absence of a record
    // leaves the source neutral (never a minted tier).
  }
}

/** Round-11 (review P1): does a DURABLE manufacturer authority exist for this
 *  source URL already (established deterministically from verified product
 *  evidence, or via a registry-brand match)? check_source_priority's
 *  authorityEstablished reports this durable record — not only the
 *  registry-match it just evaluated — so an evidence-derived authority (no
 *  registry row needed) is truthfully surfaced. Lazy + fail closed (no DB ->
 *  false). */
/** Round-11 (review P1): does a DURABLE manufacturer authority exist for
 *  THIS source URL already (established deterministically from verified
 *  product evidence, or via a registry-brand match)? Round-12 (review P1-3):
 *  the check is SOURCE-SCOPED — a manufacturer authority on an unrelated
 *  source in the same run must never report authorityEstablished for this
 *  URL. Lazy + fail closed (no DB -> false). */
function hasDurableManufacturerAuthority(runId: string, url: string): boolean {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return false;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      listPiSources: (runId: string) => Array<{ id: string; url: string }>;
      getSourceAuthorities: (sourceId: string) => Array<{ authorityType: string }>;
    };
    const source = repo.listPiSources(runId).find((candidate) => candidate.url === url);
    if (!source) return false;
    return repo.getSourceAuthorities(source.id).some((authority) => authority.authorityType === 'manufacturer');
  } catch {
    return false;
  }
}

export const checkSourcePriority: PiToolAdapter = {
  name: 'check_source_priority',
  version: '1.0.0',
  description:
    'Rank a source by authority: only domains in the CMS-managed brand-site registry are official; known retailer domains are retailer corroboration; everything else is unknown. Agent-supplied sourceKind/officialDomains and the run brandHint are NEVER authoritative (round-10/11: manufacturer authority is established only from the product brand resolved from durable exact-GTIN-verified evidence — an unresolved brand leaves the source neutral; evidence-provenanced authority records retain the verified asset id + content hash; authority is also established deterministically after image verification as a server consequence).',
  parameters: Type.Object({
    url: boundedString(512, 'Source URL'),
    officialDomains: Type.Optional(Type.Array(boundedString(256, 'Official domain'), { maxItems: 10 })),
    sourceKind: Type.Optional(Type.Union([Type.Literal('catalog'), Type.Literal('supplier'), Type.Literal('registry'), Type.Literal('retailer'), Type.Literal('manufacturer'), Type.Literal('other')])),
  }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const url = String(params.url ?? '');
    let domain: string;
    try {
      domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return noResult(`Invalid URL: ${url.slice(0, 80)}`);
    }
    // Round-8: agent-asserted source kind and official domains are recorded as
    // advisory hints only — they never determine the tier or the evidence kind.
    const agentKind = params.sourceKind ? String(params.sourceKind) : 'other';
    const isRetailer = KNOWN_RETAILER_DOMAINS.includes(domain);
    const registry = trustedOfficialDomain(domain);

    // Round-9: registry-official is DISPLAY-only. Round-10 (review P0):
    // manufacturer AUTHORITY requires the registry brand to match the product
    // brand resolved from DURABLE exact-GTIN evidence — an official domain for
    // Brand A researching Brand B (or hint-only Brand A with no evidence) never
    // becomes manufacturer authority. Round-12 (review P0-3): the resolved
    // brand is itself QUALIFIED — exact assets must retain the qualifying
    // brand evidence binding (never observedBrand alone). brandHint is
    // untrusted and may only color the display reason.
    const resolvedBrand = loadResolvedBrand(ctx.runId);
    const brandHint = loadExpectedBrand(ctx.runId); // display-only context
    const registryBrand = registryBrandMatches(url, resolvedBrand?.brand ?? '');
    const brandMatch = resolvedBrand !== null && registryBrand.matches;
    // Round-11 (review P1): a durable authority may already exist (established
    // deterministically from verified product evidence without any registry
    // row) — it is reported truthfully regardless of this call's brand match.
    const durableAuthority = hasDurableManufacturerAuthority(ctx.runId, url);

    let tier: string;
    let reason: string;
    if (registry.official) {
      tier = 'official';
      if (brandMatch) {
        reason = `registry brand '${registryBrand.brandName}' matches the durable exact-GTIN-resolved product brand`;
        establishManufacturerAuthority(ctx.runId, url, resolvedBrand!.brand, registryBrand.brandSiteId, {
          evidenceId: resolvedBrand!.brandEvidenceId,
          evidenceHash: resolvedBrand!.brandEvidenceHash,
          evidenceKind: resolvedBrand!.brandEvidenceId ? 'evidence' : 'decoder',
        });
      } else if (resolvedBrand !== null) {
        reason = `registry official but brand '${registry.brandName ?? '?'}' does not match the durable resolved product brand '${resolvedBrand.brand}' (no authority established)`;
      } else if (brandHint !== null && typeof registry.brandName === 'string' && registry.brandName.trim().toLowerCase() === brandHint) {
        reason = `registry official; brandHint '${brandHint}' matches the registry brand but brand hints are untrusted and the product brand is unresolved from durable exact-GTIN evidence (no authority established)`;
      } else {
        reason = 'registry official but the product brand is unresolved from durable exact-GTIN evidence (no authority established)';
      }
    } else if (isRetailer) {
      tier = 'retailer';
      reason = 'known retailer corroboration';
    } else {
      tier = 'unknown';
      reason = `${registry.reason}; agent-declared kind '${agentKind}' is not authoritative`;
    }
    return okResult(
      {
        url,
        domain,
        tier,
        reason,
        isOfficial: registry.official,
        isRetailer,
        agentKind,
        // Round-9/11: authoritative when a durable authority record exists —
        // either the registry-brand match established right here, or an
        // evidence-derived authority already on record. Never true for
        // agent-asserted claims.
        authorityEstablished: brandMatch || durableAuthority,
        authorityType: brandMatch || durableAuthority ? 'manufacturer' : undefined,
        authorityBrand: brandMatch ? registryBrand.brandName : durableAuthority ? resolvedBrand?.brand : undefined,
      },
      [{ id: evidenceId('check_source_priority', url), kind: tier === 'official' ? 'official_evidence' : 'search_lead', url, domain, method: 'source_priority_rank' }],
    );
  },
};

export const verificationTools: PiToolAdapter[] = [
  verifyCandidatePage,
  checkExactGtinMatch,
  compareIdentitySignals,
  checkSourcePriority,
];
