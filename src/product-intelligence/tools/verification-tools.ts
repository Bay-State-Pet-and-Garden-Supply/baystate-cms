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
import { verifyCandidate, type VerificationContext } from '../../onboarding/page-verifier';
import type { PiToolAdapter, PiToolContext, PiToolResult } from './contract';
import { errorResult, evidenceId, noResult, okResult } from './contract';
import { boundedString } from './registry';

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
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const url = String(params.url ?? '');
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

export const checkSourcePriority: PiToolAdapter = {
  name: 'check_source_priority',
  version: '1.0.0',
  description:
    'Rank a source by authority: official manufacturer domains and supplier/distributor sources outrank retailer corroboration; unknown domains are lowest. Returns the priority tier and reasoning.',
  parameters: Type.Object({
    url: boundedString(512, 'Source URL'),
    officialDomains: Type.Optional(Type.Array(boundedString(256, 'Official domain'), { maxItems: 10 })),
    sourceKind: Type.Optional(Type.Union([Type.Literal('catalog'), Type.Literal('supplier'), Type.Literal('registry'), Type.Literal('retailer'), Type.Literal('manufacturer'), Type.Literal('other')])),
  }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const url = String(params.url ?? '');
    let domain = '';
    try {
      domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return noResult(`Invalid URL: ${url.slice(0, 80)}`);
    }
    const official = (params.officialDomains as string[] | undefined) ?? [];
    const officialNorm = official.map((d) => d.replace(/^www\./, '').toLowerCase());
    const isOfficial = officialNorm.some((d) => domain === d || domain.endsWith(`.${d}`));
    const kind = params.sourceKind ? String(params.sourceKind) : 'other';
    const isRetailer = KNOWN_RETAILER_DOMAINS.includes(domain) || kind === 'retailer';

    let tier: string;
    let reason: string;
    if (isOfficial || kind === 'manufacturer') {
      tier = 'official';
      reason = 'official manufacturer domain or source kind';
    } else if (kind === 'supplier' || kind === 'distributor') {
      tier = 'supplier';
      reason = 'supplier/distributor source kind';
    } else if (kind === 'registry' || kind === 'catalog') {
      tier = 'registry';
      reason = 'structured registry/catalog source kind';
    } else if (isRetailer) {
      tier = 'retailer';
      reason = 'known retailer corroboration';
    } else {
      tier = 'unknown';
      reason = 'domain is not official and source kind is unknown';
    }
    return okResult(
      { url, domain, tier, reason, isOfficial, isRetailer },
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
