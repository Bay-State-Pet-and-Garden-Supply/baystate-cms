/**
 * Discovery research tools (PI-3).
 *
 * search_upc, search_product_name, get_brand_domains, search_brand_sitemap,
 * list_cached_search_results, resolve_product_variants. Search snippets are
 * discovery leads — never authoritative field evidence unless fetched and
 * validated downstream.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/20
 */
import { Type } from 'typebox';
import { discoverSources } from '../../onboarding/source-discovery';
import { findBrandSites, listAllBrandSites } from '../../db/repositories/brand-site-repo';
import { getCachedSerperResults } from '../../db/repositories/serper-cache-repo';
import { getCachedSitemapUrls } from '../../db/repositories/sitemap-cache-repo';
import { fetchAndParseSitemap } from '../../onboarding/sitemap-fetcher';
import { matchSitemapUrls } from '../../onboarding/sitemap-matcher';
import { resolveVariantsForCandidates } from '../../onboarding/variant-url-resolver';
import type { InsertSourceData } from '../../db/repositories/onboarding-source-repo';
import type { PiToolAdapter, PiToolContext, PiToolEvidence, PiToolResult } from './contract';
import { errorResult, evidenceId, noResult, okResult } from './contract';
import { boundedString } from './registry';

function toLeadEvidence(toolName: string, candidates: InsertSourceData[]): PiToolEvidence[] {
  return candidates.slice(0, 20).map((c) => ({
    id: evidenceId(toolName, c.url),
    kind: 'search_lead' as const,
    url: c.url,
    domain: c.domain ?? undefined,
    method: c.sourceMethod ?? 'search',
    snippet: c.title ? c.title.slice(0, 200) : undefined,
  }));
}

const searchUpc: PiToolAdapter = {
  name: 'search_upc',
  version: '1.0.0',
  description:
    'Search the web for a UPC. Returns candidate product-page URLs with their source method and consolidated name. Search results are discovery leads, not evidence.',
  parameters: Type.Object({
    gtin: boundedString(64, 'GTIN/UPC'),
    name: Type.Optional(boundedString(256, 'Register name to disambiguate the search')),
    brandHint: Type.Optional(boundedString(128, 'Brand hint')),
  }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const gtin = String(params.gtin ?? '');
    const name = String(params.name ?? '');
    try {
      const { candidates, consolidatedName, inferredBrand } = await discoverSources(
        gtin,
        name || gtin,
        params.brandHint ? String(params.brandHint) : null,
        {},
      );
      if (candidates.length === 0) return noResult(`No search candidates for UPC ${gtin}`);
      return okResult(
        {
          gtin,
          consolidatedName,
          inferredBrand: inferredBrand ? { brand: inferredBrand.brand, confidence: inferredBrand.confidence } : null,
          candidates: candidates.slice(0, 20).map((c) => ({
            url: c.url,
            domain: c.domain,
            title: c.title,
            sourceMethod: c.sourceMethod,
          })),
        },
        toLeadEvidence('search_upc', candidates),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/API key not configured/i.test(message)) {
        return noResult('Web search is not configured (missing Serper API key); use cached results or sitemap tools instead');
      }
      return errorResult('search_failed', message.slice(0, 500));
    }
  },
};

const searchProductName: PiToolAdapter = {
  name: 'search_product_name',
  version: '1.0.0',
  description:
    'Search the web for a product by name. Returns candidate URLs as discovery leads. Prefer search_upc when a GTIN is known.',
  parameters: Type.Object({
    name: boundedString(256, 'Product name to search'),
    gtin: Type.Optional(boundedString(64, 'Optional GTIN to constrain the search')),
    brandHint: Type.Optional(boundedString(128, 'Brand hint')),
  }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const name = String(params.name ?? '');
    const gtin = params.gtin ? String(params.gtin) : '';
    try {
      const { candidates } = await discoverSources(gtin || name, name, params.brandHint ? String(params.brandHint) : null, {});
      if (candidates.length === 0) return noResult(`No search candidates for "${name.slice(0, 60)}"`);
      return okResult(
        { name, candidates: candidates.slice(0, 20).map((c) => ({ url: c.url, domain: c.domain, title: c.title, sourceMethod: c.sourceMethod })) },
        toLeadEvidence('search_product_name', candidates),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/API key not configured/i.test(message)) return noResult('Web search is not configured (missing Serper API key)');
      return errorResult('search_failed', message.slice(0, 500));
    }
  },
};

const getBrandDomains: PiToolAdapter = {
  name: 'get_brand_domains',
  version: '1.0.0',
  description: 'List official brand domains known to the CMS for a brand (or all brands).',
  parameters: Type.Object({ brand: Type.Optional(boundedString(128, 'Brand name; omit to list all')) }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const brand = params.brand ? String(params.brand) : null;
    const sites = brand ? findBrandSites(brand) : listAllBrandSites();
    if (sites.length === 0) return noResult(brand ? `No brand domains configured for ${brand}` : 'No brand domains configured');
    return okResult(
      {
        brand,
        domains: sites.map((site) => ({ brand: site.brandName, domain: site.domain, sourceStrategy: site.sourceStrategy })),
      },
      sites.map((s) => ({
        id: evidenceId('get_brand_domains', String(s.domain)),
        kind: 'official_evidence' as const,
        domain: s.domain,
        method: 'brand_site_registry',
      })),
    );
  },
};

const searchBrandSitemap: PiToolAdapter = {
  name: 'search_brand_sitemap',
  version: '1.0.0',
  description:
    'Fetch a brand domain sitemap and match it against a UPC and product name. Returns UPC-exact hits and ranked candidates. Sitemap hits are stronger leads than web search.',
  parameters: Type.Object({
    domain: boundedString(256, 'Brand domain'),
    gtin: boundedString(64, 'GTIN/UPC'),
    name: Type.Optional(boundedString(256, 'Product name for matching')),
    productUrlPattern: Type.Optional(boundedString(256, 'Product URL pattern filter')),
  }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const domain = String(params.domain ?? '');
    const gtin = String(params.gtin ?? '');
    const name = String(params.name ?? '');
    try {
      const sitemap = await fetchAndParseSitemap(domain, params.productUrlPattern ? String(params.productUrlPattern) : null);
      if (sitemap.urls.length === 0) return noResult(`No sitemap URLs found for ${domain}`);
      const matches = await matchSitemapUrls(sitemap.urls, name || gtin, null, gtin, domain);
      if (matches.length === 0) return noResult(`Sitemap for ${domain} has no matches for ${gtin}`);
      return okResult(
        { domain, sourceUrl: sitemap.sourceUrl, matches: matches.slice(0, 11) },
        matches.slice(0, 11).map((m) => ({
          id: evidenceId('search_brand_sitemap', m.url),
          kind: (m.matchType === 'upc_exact' ? 'gtin_evidence' : 'search_lead') as 'gtin_evidence' | 'search_lead',
          url: m.url,
          domain,
          method: `sitemap_${m.matchType}`,
        })),
      );
    } catch (error) {
      return errorResult('sitemap_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

const listCachedSearchResults: PiToolAdapter = {
  name: 'list_cached_search_results',
  version: '1.0.0',
  description:
    'List cached search and sitemap results for a query or domain (no network). Useful when web search is unavailable.',
  parameters: Type.Object({
    query: Type.Optional(boundedString(256, 'Search query that was cached')),
    domain: Type.Optional(boundedString(256, 'Domain whose sitemap cache to list')),
  }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const query = params.query ? String(params.query) : null;
    const domain = params.domain ? String(params.domain) : null;
    if (!query && !domain) return noResult('Provide query or domain');
    const results: unknown[] = [];
    const evidence: PiToolEvidence[] = [];
    if (query) {
      const cached = getCachedSerperResults(query);
      if (cached && cached.length > 0) {
        for (const r of cached.slice(0, 20)) {
          results.push({ source: 'serper_cache', title: r.title, url: r.link });
          evidence.push({ id: evidenceId('list_cached_search_results', r.link), kind: 'search_lead', url: r.link, method: 'serper_cache' });
        }
      }
    }
    if (domain) {
      const urls = getCachedSitemapUrls(domain);
      if (urls && urls.length > 0) {
        for (const url of urls.slice(0, 50)) {
          results.push({ source: 'sitemap_cache', url });
          evidence.push({ id: evidenceId('list_cached_search_results', url), kind: 'search_lead', url, method: 'sitemap_cache' });
        }
      }
    }
    if (results.length === 0) return noResult('No cached results for the given query/domain');
    return okResult({ results: results.slice(0, 50) }, evidence);
  },
};

const resolveProductVariants: PiToolAdapter = {
  name: 'resolve_product_variants',
  version: '1.0.0',
  description:
    'Resolve whether candidate URLs point at the exact variant of a product. Returns per-candidate variant status (exact/probable/parent/wrong/unknown).',
  parameters: Type.Object({
    gtin: boundedString(64, 'GTIN/UPC'),
    rawName: boundedString(256, 'Register name'),
    expectedName: Type.Optional(boundedString(256, 'Consolidated expected name')),
    brandHint: Type.Optional(boundedString(128, 'Brand hint')),
    candidateUrls: Type.Array(boundedString(512, 'Candidate URL'), { maxItems: 6 }),
  }),
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const candidates: InsertSourceData[] = (params.candidateUrls as string[]).map((url, index) => ({
      id: `adapter-${index}`,
      url,
      domain: (() => { try { return new URL(url).hostname; } catch { return null; } })(),
      title: null,
      confidence: 0,
      sourceMethod: 'agent_candidate',
    }));
    try {
      const resolved = await resolveVariantsForCandidates({
        candidates,
        upc: String(params.gtin),
        rawName: String(params.rawName),
        expectedName: params.expectedName ? String(params.expectedName) : String(params.rawName),
        brandHint: params.brandHint ? String(params.brandHint) : null,
        brandDomains: [],
      });
      return okResult(
        {
          resolved: resolved.map((c) => {
            const meta = (() => { try { return JSON.parse(c.metadataJson ?? '{}'); } catch { return {}; } })() as { variantResolution?: Record<string, unknown> };
            return {
              url: c.url,
              title: c.title ?? null,
              sourceMethod: c.sourceMethod ?? null,
              variantResolution: meta.variantResolution ?? null,
            };
          }),
        },
        resolved.map((c) => ({
          id: evidenceId('resolve_product_variants', c.url),
          kind: 'variant_evidence' as const,
          url: c.url,
          method: 'variant_html_resolution',
        })),
      );
    } catch (error) {
      return errorResult('variant_resolution_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

export const discoveryTools: PiToolAdapter[] = [
  searchUpc,
  searchProductName,
  getBrandDomains,
  searchBrandSitemap,
  listCachedSearchResults,
  resolveProductVariants,
];
