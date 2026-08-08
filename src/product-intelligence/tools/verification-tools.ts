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
 *  Returns null when the brand is unresolved OR ambiguous (multiple distinct
 *  resolved brands) — both fail closed, so no authority is minted. */
function loadResolvedBrand(runId: string): string | null {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return null;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      getPiRun: (runId: string) => { inputJson?: string } | undefined;
      listResolvedProductBrands: (runId: string, requestedGtin?: string | null) => string[];
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

/** Round-9 (review P0): establish a durable manufacturer authority for a source
 *  row when the registry brand matches the expected product brand. Lazy + fail
 *  closed (no DB / no source row → no record). The source row's tier is upgraded
 *  so existing resolvers observe the authority — the first-writer bug is closed.
 */
function establishManufacturerAuthority(runId: string, url: string, brandName: string, brandSiteId?: string): void {
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
    });
  } catch {
    // Fail closed: authority establishment is best-effort; absence of a record
    // leaves the source neutral (never a minted tier).
  }
}

export const checkSourcePriority: PiToolAdapter = {
  name: 'check_source_priority',
  version: '1.0.0',
  description:
    'Rank a source by authority: only domains in the CMS-managed brand-site registry are official; known retailer domains are retailer corroboration; everything else is unknown. Agent-supplied sourceKind/officialDomains and the run brandHint are NEVER authoritative (round-10: manufacturer authority is established only when the registry brand matches the product brand resolved from durable exact-GTIN-verified evidence; an unresolved brand leaves the source neutral).',
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
      registry.brandName.trim().toLowerCase() === resolvedBrand;

    let tier: string;
    let reason: string;
    if (registry.official) {
      tier = 'official';
      if (brandMatch) {
        reason = `registry brand '${registry.brandName}' matches the durable exact-GTIN-resolved product brand`;
        establishManufacturerAuthority(ctx.runId, url, registry.brandName as string, registry.brandSiteId);
      } else if (resolvedBrand !== null) {
        reason = `registry official but brand '${registry.brandName ?? '?'}' does not match the durable resolved product brand '${resolvedBrand}' (no authority established)`;
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
        // Round-9: authoritative when a durable authority record was established
        // (brand-matched manufacturer). Never true for agent-asserted claims.
        authorityEstablished: brandMatch,
        authorityType: brandMatch ? 'manufacturer' : undefined,
        authorityBrand: brandMatch ? registry.brandName : undefined,
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
