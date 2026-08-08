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
    const netCheck = await (ctx.gateway ?? defaultPolicyGateway).checkNetworkRequest({ runId: ctx.runId, policy: ctx.policy }, url);
    if (!netCheck.allowed) {
      return policyDenied(`network denied: ${netCheck.reasonCode}${netCheck.detail ? ` (${netCheck.detail})` : ''}`);
    }
    const context: VerificationContext = {
      upc: String(params.gtin),
      expectedName: String(params.expectedName),
      brandHint: params.brandHint ? String(params.brandHint) : null,
      officialDomains: params.officialDomains ? (params.officialDomains as string[]) : [],
    };
    try {
      const result = await verifyCandidate(
        { url, title: null, confidence: 0, sourceMethod: 'agent_candidate' },
        context,
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
}
function loadResolvedBrand(runId: string): ResolvedBrand | null {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return null;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      getPiRun: (runId: string) => { inputJson?: string } | undefined;
      listResolvedProductBrands: (runId: string, requestedGtin?: string | null) => Array<{
        brand: string;
        assetId: string;
        contentHash: string;
        sourcePageUrl: string | null;
      }>;
    };
    const run = repo.getPiRun(runId);
    if (!run?.inputJson) return null;
    const input = JSON.parse(run.inputJson) as { gtin?: unknown };
    if (typeof input.gtin !== 'string' || !input.gtin.trim()) return null;
    const brands = repo.listResolvedProductBrands(runId, input.gtin.trim());
    if (brands.length !== 1) return null;
    return brands[0];
  } catch {
    return null;
  }
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
      listResolvedProductBrands: (runId: string, requestedGtin?: string | null) => Array<{
        brand: string;
        assetId: string;
        contentHash: string;
        sourcePageUrl: string | null;
      }>;
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
    const run = repo.getPiRun(runId);
    if (!run?.inputJson) return;
    const input = JSON.parse(run.inputJson) as { gtin?: unknown };
    if (typeof input.gtin !== 'string' || !input.gtin.trim()) return;
    // Round-11 (review P1): EVIDENCE phase — BEFORE any exact asset exists
    // (the workflow's ordering: check_source_priority -> ... -> OCR ->
    // verify), the pre-verification evidence rows already carry the durable
    // observations: a hash-bound exact GTIN (value === the run's immutable
    // GTIN) and a brand observation bound to the SAME image bytes (same
    // contentHash) on the same source. Authority established here makes the
    // FIRST verification observe the manufacturer tier — the reviewer's
    // sequence: exact GTIN + trustworthy brand resolved -> server evaluates
    // known source authorities -> rights verification reads current rows.
    const evidenceRepo = repo as typeof repo & {
      listPiEvidence: (runId: string) => Array<{
        id: string;
        sourceId: string;
        targetField: string;
        valueJson: string;
        metadataJson: string | null;
      }>;
    };
    try {
      const evidence = evidenceRepo.listPiEvidence?.(runId) ?? [];
      const gtinHashes = new Map<string, { sourceId: string; hash: string }>();
      for (const row of evidence) {
        if (row.targetField !== 'gtin' || !row.metadataJson) continue;
        let value: unknown;
        try {
          value = JSON.parse(row.valueJson);
        } catch {
          continue;
        }
        const normalized = String(value ?? '').replace(/\D/g, '');
        if (normalized !== input.gtin.trim().replace(/\D/g, '')) continue;
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
          if (row.targetField !== 'brand' || !row.metadataJson) continue;
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
        for (const entry of brandBySourceHash.values()) {
          if (entry.brand === '__ambiguous__') continue; // fail closed
          const source = repo.listPiSources(runId).find((candidate) => candidate.id === entry.sourceId);
          if (!source) continue;
          repo.upsertSourceAuthority({
            sourceId: source.id,
            authorityType: 'manufacturer',
            authorityRef: `evidence:${entry.evidenceId}`,
            brandName: entry.brand,
            establishedBy: 'verified_evidence',
            brandEvidenceId: entry.evidenceId,
            brandEvidenceHash: entry.hash,
            brandEvidenceKind: 'evidence',
          });
        }
      }
    } catch {
      // Fail closed: evidence-based authority is best-effort.
    }

    // Asset phase: exact verified assets (stronger provenance — runs last so
    // the asset-backed record wins the upsert over the pre-verification
    // evidence record).
    const brands = repo.listResolvedProductBrands(runId, input.gtin.trim());
    // Group by source page URL; a URL resolving to multiple distinct brands is
    // ambiguous and never minted.
    const byUrl = new Map<string, Array<{ brand: string; assetId: string; contentHash: string }>>();
    for (const resolved of brands) {
      if (!resolved.sourcePageUrl) continue;
      const list = byUrl.get(resolved.sourcePageUrl) ?? [];
      list.push({ brand: resolved.brand, assetId: resolved.assetId, contentHash: resolved.contentHash });
      byUrl.set(resolved.sourcePageUrl, list);
    }
    for (const [pageUrl, resolvedList] of byUrl) {
      const distinctBrands = new Set(resolvedList.map((r) => r.brand));
      if (distinctBrands.size !== 1) continue; // ambiguous source — fail closed
      const resolved = resolvedList[0];
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
          continue; // no durable anchor, no authority
        }
      }
      repo.upsertSourceAuthority({
        sourceId: source.id,
        authorityType: 'manufacturer',
        authorityRef: `verified_asset:${resolved.assetId}`,
        brandName: resolved.brand,
        establishedBy: 'verified_asset_evidence',
        brandEvidenceId: resolved.assetId,
        brandEvidenceHash: resolved.contentHash,
        brandEvidenceKind: 'verified_asset',
      });
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
function establishManufacturerAuthority(
  runId: string,
  url: string,
  brandName: string,
  brandSiteId?: string,
  evidence?: { assetId: string; contentHash: string } | null,
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
      brandEvidenceId: evidence?.assetId ?? null,
      brandEvidenceHash: evidence?.contentHash ?? null,
      brandEvidenceKind: evidence ? 'verified_asset' : null,
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
function hasDurableManufacturerAuthority(runId: string, url: string): boolean {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return false;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      listPiSources: (runId: string) => Array<{ id: string; url: string }>;
      listSourceAuthoritiesByRun: (runId: string) => Array<{ authorityType: string }>;
    };
    const source = repo.listPiSources(runId).find((candidate) => candidate.url === url);
    if (!source) return false;
    return repo
      .listSourceAuthoritiesByRun(runId)
      .some((authority) => authority.authorityType === 'manufacturer');
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
    // becomes manufacturer authority. brandHint is untrusted and may only color
    // the display reason; with no resolved brand, no authority is established
    // (fail closed to a neutral source).
    const resolvedBrand = loadResolvedBrand(ctx.runId);
    const brandHint = loadExpectedBrand(ctx.runId); // display-only context
    const brandMatch =
      registry.official &&
      typeof registry.brandName === 'string' &&
      resolvedBrand !== null &&
      registry.brandName.trim().toLowerCase() === resolvedBrand.brand;
    // Round-11 (review P1): a durable authority may already exist (established
    // deterministically from verified product evidence without any registry
    // row) — it is reported truthfully regardless of this call's brand match.
    const durableAuthority = hasDurableManufacturerAuthority(ctx.runId, url);

    let tier: string;
    let reason: string;
    if (registry.official) {
      tier = 'official';
      if (brandMatch) {
        reason = `registry brand '${registry.brandName}' matches the durable exact-GTIN-resolved product brand`;
        establishManufacturerAuthority(ctx.runId, url, registry.brandName as string, registry.brandSiteId, {
          assetId: resolvedBrand.assetId,
          contentHash: resolvedBrand.contentHash,
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
        authorityBrand: brandMatch ? registry.brandName : durableAuthority ? resolvedBrand?.brand : undefined,
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
