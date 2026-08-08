/**
 * Search-stage benchmark (issue #29 companion): scores product-page
 * SEARCH strategies — the stage that turns (gtin, registerName, brandHint)
 * into candidate product-page URLs, BEFORE extraction runs.
 *
 * The extraction benchmark scores the page-reading stage against
 * expectedPageUrl; this benchmark scores the page-FINDING stage against the
 * same gold labels: page-found rate, rank@1, precision@k, misleading-source
 * rejection (gold.misleadingSources must never rank above the truth), and
 * blocked-official recovery (blocked_official-tagged products still need a
 * correct page from somewhere).
 *
 * Strategies implement SearchStrategyAdapter. Deterministic stubs model the
 * real discovery strategies (web search / brand sitemap / structured product
 * database / cached results); real vendors plug in programmatically. Search
 * results are discovery leads, never evidence.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { getExamples } from '../../db/repositories/benchmark-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { PiGoldLabelsSchema, PiProductInputSchema } from './gold';

export interface SearchResult {
  url: string;
  source: string;
  rank: number;
  title: string | null;
}

export interface SearchStrategyAdapter {
  name: string;
  version: string;
  search(input: { gtin: string; name: string; brandHint: string | null }): Promise<{
    results: SearchResult[];
    latencyMs: number;
    costUsd: number;
  }>;
}

/**
 * Perfect web-search stub: an upper bound — every known GTIN resolves to the
 * golden page at rank 1. Models an ideal Serper-style lookup.
 */
export class PerfectWebSearchStub implements SearchStrategyAdapter {
  readonly name = 'web_search_perfect';
  readonly version = '1.0.0';
  private pages: Map<string, string>;

  constructor(pages: Map<string, string>) {
    this.pages = pages;
  }

  async search(input: { gtin: string; name: string; brandHint: string | null }): Promise<{
    results: SearchResult[];
    latencyMs: number;
    costUsd: number;
  }> {
    const url = this.pages.get(input.gtin);
    return {
      results: url
        ? [{ url, source: 'web_search', rank: 1, title: input.name }]
        : [],
      latencyMs: 250,
      costUsd: 0.001,
    };
  }
}

/**
 * Brand-sitemap stub: knows the official domain only for brands in its map.
 * Models search_brand_sitemap — high precision, but only when the domain is
 * known/crawlable (blocked_official products are missed entirely).
 */
export class SitemapSearchStub implements SearchStrategyAdapter {
  readonly name = 'sitemap';
  readonly version = '1.0.0';
  private domainPages: Map<string, Map<string, string>>;

  constructor(domainPages: Map<string, Map<string, string>>) {
    this.domainPages = domainPages;
  }

  async search(input: { gtin: string; name: string; brandHint: string | null }): Promise<{
    results: SearchResult[];
    latencyMs: number;
    costUsd: number;
  }> {
    const domain = input.brandHint;
    const pages = (domain ? this.domainPages.get(domain.toLowerCase()) : undefined) ?? new Map<string, string>();
    const url = pages.get(input.gtin);
    return {
      results: url ? [{ url, source: 'brand_sitemap', rank: 1, title: input.name }] : [],
      latencyMs: 800,
      costUsd: 0.0,
    };
  }
}

/**
 * Structured-product-database stub (Open Food Facts-style GTIN lookup).
 * High precision; covers only products present in the database.
 */
export class DatabaseSearchStub implements SearchStrategyAdapter {
  readonly name = 'structured_database';
  readonly version = '1.0.0';
  private pages: Map<string, string>;

  constructor(pages: Map<string, string>) {
    this.pages = pages;
  }

  async search(input: { gtin: string; name: string; brandHint: string | null }): Promise<{
    results: SearchResult[];
    latencyMs: number;
    costUsd: number;
  }> {
    const url = this.pages.get(input.gtin);
    return {
      results: url ? [{ url, source: 'structured_database', rank: 1, title: input.name }] : [],
      latencyMs: 120,
      costUsd: 0.0,
    };
  }
}

/**
 * Misleading-web-search stub: an adversarial baseline that ranks the gold
 * misleading source (when one exists) above the truth. The benchmark must
 * measure that no real strategy behaves like this.
 */
export class MisleadingSearchStub implements SearchStrategyAdapter {
  readonly name = 'web_search_misleading';
  readonly version = '1.0.0';
  private pages: Map<string, string>;
  private misleadingDomains: Map<string, string>;

  constructor(pages: Map<string, string>, misleadingDomains: Map<string, string>) {
    this.pages = pages;
    this.misleadingDomains = misleadingDomains;
  }

  async search(input: { gtin: string; name: string; brandHint: string | null }): Promise<{
    results: SearchResult[];
    latencyMs: number;
    costUsd: number;
  }> {
    const correct = this.pages.get(input.gtin);
    const misleading = this.misleadingDomains.get(input.gtin);
    const results: SearchResult[] = [];
    if (misleading) results.push({ url: misleading, source: 'web_search', rank: 1, title: `Misleading result for ${input.name}` });
    if (correct) results.push({ url: correct, source: 'web_search', rank: results.length + 1, title: input.name });
    return { results, latencyMs: 250, costUsd: 0.001 };
  }
}

export interface SearchBenchmarkOptions {
  datasetId: string;
  strategies: Array<SearchStrategyAdapter | { name: string; version?: string }>;
}

export interface SearchBenchmarkRow {
  strategy: string;
  strategyVersion: string;
  products: number;
  pageFound: number;
  pageFoundRate: number | null;
  rankAt1: number | null;
  precisionAt5: number | null;
  misleadingRejectionRate: number | null;
  blockedOfficialRecoveryRate: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  costPerSearch: number;
  costPerFoundPage: number | null;
}

export interface SearchBenchmarkReport {
  rows: SearchBenchmarkRow[];
  /** Strategies that clear pageFoundRate >= 0.8 AND precisionAt5 >= 0.5. */
  recommendation: { recommended: string[]; rationale: string } | null;
}

const RECOMMEND_THRESHOLDS = {
  pageFoundRate: 0.8,
  precisionAt5: 0.5,
  /** A strategy that ranks noise above the truth is never recommended. */
  misleadingRejectionRate: 0.5,
  /** No recommendation below this many measured products (degenerate runs). */
  minProducts: 3,
} as const;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function runSearchBenchmark(opts: SearchBenchmarkOptions): Promise<SearchBenchmarkReport> {
  const ws = findWorkspace();
  if (!ws) throw new Error('No active workspace');

  const examples = getExamples(opts.datasetId, 'test');
  const rows: SearchBenchmarkRow[] = [];

  for (const entry of opts.strategies) {
    const adapter = 'search' in entry ? entry : null;
    if (!adapter) {
      // Requested but no implementation registered — honest skip row.
      rows.push({
        strategy: entry.name,
        strategyVersion: entry.version ?? 'n/a',
        products: 0,
        pageFound: 0,
        pageFoundRate: null,
        rankAt1: null,
        precisionAt5: null,
        misleadingRejectionRate: null,
        blockedOfficialRecoveryRate: null,
        medianLatencyMs: null,
        p95LatencyMs: null,
        costPerSearch: 0,
        costPerFoundPage: null,
      });
      continue;
    }

    let products = 0;
    let pageFound = 0;
    const rankAt1Correct: Array<boolean> = [];
    const precisionsAt5: Array<number> = [];
    const misleadingRejected: Array<boolean> = [];
    const blockedRecovered: Array<boolean> = [];
    const latencies: number[] = [];
    let costTotal = 0;
    let costFound = 0;

    for (const example of examples) {
      const input = PiProductInputSchema.safeParse(JSON.parse(example.input_snapshot_json));
      const gold = PiGoldLabelsSchema.safeParse(JSON.parse(example.gold_labels_json));
      if (!input.success || !gold.success || !input.data.expectedPageUrl) continue;
      const expectedUrl = input.data.expectedPageUrl;
      const misleadingDomains = new Set(gold.data.misleadingSources.map((m) => m.domain.toLowerCase()));

      products += 1;
      const outcome = await adapter.search({
        gtin: input.data.gtin,
        name: input.data.registerName,
        brandHint: input.data.brandHint ?? null,
      });
      latencies.push(outcome.latencyMs);
      costTotal += outcome.costUsd;

      const top20 = outcome.results.slice(0, 20);
      const foundIndex = top20.findIndex((r) => r.url === expectedUrl);
      if (foundIndex >= 0) {
        pageFound += 1;
        costFound += outcome.costUsd;
        rankAt1Correct.push(foundIndex === 0);
      }
      precisionsAt5.push(
        top20
          .slice(0, 5)
          .filter((r) => r.url === expectedUrl).length / Math.min(5, top20.length || 1),
      );
      // Misleading-source rejection: no misleading domain may appear ABOVE
      // the correct page (a misleading result at any rank is a red flag;
      // ranking it above the truth is the failure this benchmark measures).
      // Rejection rate is measured only over products that HAVE known
      // misleading sources — vacuous passes would inflate the rate.
      if (misleadingDomains.size > 0) {
        const correctRank = foundIndex;
        const misleadingRank = top20.findIndex((r) => misleadingDomains.has(domainOf(r.url).toLowerCase()));
        if (correctRank < 0) {
          misleadingRejected.push(false); // page not found at all
        } else {
          misleadingRejected.push(misleadingRank < 0 || misleadingRank > correctRank);
        }
      }
      if (gold.data.difficultyTags.includes('blocked_official')) {
        blockedRecovered.push(foundIndex >= 0);
      }
    }

    const mean = (values: Array<boolean>): number | null => {
      if (values.length === 0) return null;
      return values.filter(Boolean).length / values.length;
    };

    rows.push({
      strategy: adapter.name,
      strategyVersion: adapter.version,
      products,
      pageFound,
      pageFoundRate: products > 0 ? pageFound / products : null,
      rankAt1: mean(rankAt1Correct),
      precisionAt5: precisionsAt5.length > 0 ? precisionsAt5.reduce((a, b) => a + b, 0) / precisionsAt5.length : null,
      misleadingRejectionRate: mean(misleadingRejected),
      blockedOfficialRecoveryRate: mean(blockedRecovered),
      medianLatencyMs: median(latencies),
      p95LatencyMs: p95(latencies),
      costPerSearch: costTotal / Math.max(1, products),
      costPerFoundPage: pageFound > 0 ? costFound / pageFound : null,
    });
  }

  const recommended = rows
    .filter((row) => row.products >= RECOMMEND_THRESHOLDS.minProducts)
    .filter((row) => row.pageFoundRate !== null && row.pageFoundRate >= RECOMMEND_THRESHOLDS.pageFoundRate)
    .filter((row) => row.precisionAt5 !== null && row.precisionAt5 >= RECOMMEND_THRESHOLDS.precisionAt5)
    // Non-vacuous misleading-source rejection: a strategy whose results rank
    // noise above the truth (rate < 0.5 over products that HAVE misleading
    // sources) must never be recommended, regardless of raw find-rate.
    .filter((row) => row.misleadingRejectionRate === null || row.misleadingRejectionRate >= RECOMMEND_THRESHOLDS.misleadingRejectionRate)
    .map((row) => row.strategy);

  return {
    rows,
    recommendation:
      recommended.length > 0
        ? {
            recommended,
            rationale: `pageFoundRate >= ${RECOMMEND_THRESHOLDS.pageFoundRate}, precision@5 >= ${RECOMMEND_THRESHOLDS.precisionAt5}, misleading-source rejection >= ${RECOMMEND_THRESHOLDS.misleadingRejectionRate}, and n >= ${RECOMMEND_THRESHOLDS.minProducts} measured products (never model confidence)`,
          }
        : null,
  };
}
