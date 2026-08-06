/**
 * PI-9 extraction-provider benchmark: score extraction strategies on the
 * versioned golden dataset, ALWAYS distinguishing retrieval success from
 * correct product extraction (an HTML 200 with the wrong size/flavor is a
 * failed product-extraction task).
 *
 * Providers implement ExtractionProviderAdapter. Stub fixtures power the
 * deterministic benchmark; the HTTP provider wraps the PageExtractionContract
 * seam (PI-11) and requires the network flag (disabled by default).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { getExamples } from '../../db/repositories/benchmark-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import type { PageExtractionContract } from '../tools/contract';
import { PiGoldLabelsSchema, PiProductInputSchema } from './gold';

export interface ExtractionProviderExtraction {
  identityStatus: string | null;
  variant: string | null;
  facts: Array<{ field: string; value: string; method: string | null; sourcePath: string | null; artifactRef: string | null }>;
  imageUrl: string | null;
}

export interface ExtractionProviderAdapter {
  name: string;
  version: string;
  extract(input: { url: string; gtin: string; name: string }): Promise<{
    retrieval: { ok: boolean; status: number; contentType: string | null };
    extraction: ExtractionProviderExtraction | null;
  }>;
}

export interface StubPageFixture {
  html: string;
  contentType: string;
  identityStatus: string | null;
  variant: string | null;
  facts: Array<{ field: string; value: string; method: string | null; sourcePath: string | null; artifactRef: string | null }>;
  delayMs?: number;
}

/**
 * Deterministic stub provider over a URL → fixture map. Missing URLs are
 * treated as retrieval failures (404) — the blocked-page case.
 */
export class StubExtractionProvider implements ExtractionProviderAdapter {
  readonly name = 'stub';
  readonly version = '1.0.0';
  private fixtures: Map<string, StubPageFixture>;

  constructor(fixtures: Map<string, StubPageFixture>) {
    this.fixtures = fixtures;
  }

  async extract(input: { url: string }): Promise<{
    retrieval: { ok: boolean; status: number; contentType: string | null };
    extraction: ExtractionProviderExtraction | null;
  }> {
    const fixture = this.fixtures.get(input.url);
    if (fixture?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
    }
    if (!fixture) {
      return { retrieval: { ok: false, status: 404, contentType: null }, extraction: null };
    }
    return {
      retrieval: { ok: true, status: 200, contentType: fixture.contentType },
      extraction: {
        identityStatus: fixture.identityStatus,
        variant: fixture.variant,
        facts: fixture.facts,
        imageUrl: fixture.facts.find((f) => f.field === 'image')?.value ?? null,
      },
    };
  }
}

/**
 * HTTP provider wrapping the PageExtractionContract seam. Retrieval status is
 * approximated from the contract result (the contract does not expose raw
 * HTTP status); network access requires the benchmark network flag.
 */
export class HttpExtractionProvider implements ExtractionProviderAdapter {
  readonly name = 'http';
  readonly version = '1.0.0';
  private contract: PageExtractionContract;

  constructor(contract: PageExtractionContract) {
    this.contract = contract;
  }

  async extract(input: { url: string; gtin: string; name: string }): Promise<{
    retrieval: { ok: boolean; status: number; contentType: string | null };
    extraction: ExtractionProviderExtraction | null;
  }> {
    try {
      const result = await this.contract.extract({
        url: input.url,
        expected: { gtin: input.gtin, name: input.name },
        signal: new AbortController().signal,
        timeoutMs: 30_000,
      });
      return {
        retrieval: { ok: true, status: 200, contentType: 'text/html' },
        extraction: {
          identityStatus: result.identityStatus,
          variant: result.variant?.name ?? null,
          facts: result.fields.map((f) => ({
            field: f.field,
            value: String(f.value ?? ''),
            method: f.method ?? null,
            sourcePath: f.sourcePath ?? null,
            artifactRef: result.artifactRef,
          })),
          imageUrl: result.images[0]?.url ?? null,
        },
      };
    } catch {
      return { retrieval: { ok: false, status: 0, contentType: null }, extraction: null };
    }
  }
}

/**
 * Built-in deterministic benchmark pages (one per representative case). The
 * 'blocked' page is intentionally absent from this list — the test seeds its
 * fixture map without it so retrieval fails with 404.
 */
export const STUB_BENCHMARK_PAGES: Array<{ url: string; gtin: string; name: string; fixture: StubPageFixture }> = [
  {
    url: 'https://brand.example.com/p/exact-jsonld',
    gtin: '085000079585',
    name: 'STELLA CHKN BROTH 16OZ',
    fixture: {
      html: '<script type="application/ld+json">{"image":"https://cdn.example.com/v16.jpg"}</script>',
      contentType: 'text/html',
      identityStatus: 'exact_match',
      variant: '16 oz',
      facts: [
        { field: 'title', value: 'Stella & Chewy Chicken Broth 16 oz', method: 'json_ld', sourcePath: 'json_ld.name', artifactRef: 'art-1' },
        { field: 'size', value: '16 oz', method: 'json_ld', sourcePath: 'json_ld.size', artifactRef: 'art-1' },
        { field: 'brand', value: 'Stella & Chewy', method: 'json_ld', sourcePath: 'json_ld.brand', artifactRef: 'art-1' },
      ],
    },
  },
  {
    url: 'https://retailer.example.com/p/wrong-size',
    gtin: '085000079585',
    name: 'STELLA CHKN BROTH 8OZ',
    fixture: {
      html: '<div class="product">Stella & Chewy Broth 8 oz</div>',
      contentType: 'text/html',
      identityStatus: 'wrong_variant',
      variant: '8 oz',
      facts: [{ field: 'size', value: '8 oz', method: 'profile_selector', sourcePath: 'div.product', artifactRef: null }],
    },
  },
  {
    url: 'https://brand.example.com/family/broth',
    gtin: '085000079585',
    name: 'STELLA CHKN BROTH',
    fixture: {
      html: '<div class="family">Stella & Chewy Broths — all sizes</div>',
      contentType: 'text/html',
      identityStatus: 'parent_product_only',
      variant: null,
      facts: [{ field: 'title', value: 'Stella & Chewy Broth Family', method: 'profile_selector', sourcePath: 'div.family', artifactRef: null }],
    },
  },
  {
    url: 'https://brand.example.com/p/xhr-only',
    gtin: '085000079585',
    name: 'STELLA CHKN BROTH 16OZ',
    fixture: {
      html: '<div id="app"></div>',
      contentType: 'text/html',
      identityStatus: 'exact_match',
      variant: '16 oz',
      facts: [
        { field: 'title', value: 'Stella & Chewy Chicken Broth 16 oz', method: 'network_response', sourcePath: 'xhr:/products/123.json', artifactRef: 'art-4' },
        { field: 'size', value: '16 oz', method: 'network_response', sourcePath: 'xhr:/products/123.json', artifactRef: 'art-4' },
      ],
    },
  },
  {
    url: 'https://brand.example.com/p/incomplete',
    gtin: '085000079585',
    name: 'STELLA CHKN BROTH 16OZ',
    fixture: {
      html: '<div class="product">Stella & Chewy Broth</div>',
      contentType: 'text/html',
      identityStatus: 'probable_match',
      variant: null,
      facts: [{ field: 'title', value: 'Stella & Chewy Broth', method: 'profile_selector', sourcePath: 'div.product', artifactRef: null }],
    },
  },
];

export interface ExtractionBenchmarkOptions {
  datasetId: string;
  providers: Array<'stub' | 'http'>;
  /** Network-enabled providers (http) stay disabled by default. */
  network?: boolean;
}

export interface ExtractionBenchmarkRow {
  provider: string;
  providerVersion: string;
  pages: number;
  retrievalSuccess: number;
  retrievalRate: number;
  extractionSuccess: number;
  extractionRate: number;
  exactProductAccuracy: number | null;
  wrongVariantRate: number | null;
  parentOnlyDetectionAccuracy: number | null;
  fieldPrecision: number | null;
  fieldRecall: number | null;
  traceability: { withMethod: number; withSourcePath: number; withArtifactRef: number; coverage: number | null };
  replayAvailable: boolean;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  costPerPage: number;
  costPerCorrectProduct: number | null;
  failureRate: number;
  blockedPageRecoveryRate: number | null;
}

export interface ExtractionBenchmarkReport {
  datasetId: string;
  datasetHash: string;
  rows: ExtractionBenchmarkRow[];
  recommendation: { recommended: string[]; rationale: string } | null;
  generatedAt: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[index];
}

function factMatches(predicted: string, gold: string): boolean {
  const a = predicted.toLowerCase().trim();
  const b = gold.toLowerCase().trim();
  return a === b || (a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a)));
}

export async function runExtractionBenchmark(opts: ExtractionBenchmarkOptions): Promise<ExtractionBenchmarkReport> {
  const ws = findWorkspace();
  if (!ws) throw new Error('No active workspace');

  const examples = getExamples(opts.datasetId, 'test');
  const rows: ExtractionBenchmarkRow[] = [];

  for (const providerName of opts.providers) {
    let provider: ExtractionProviderAdapter | null = null;
    if (providerName === 'stub') {
      const fixtures = new Map<string, StubPageFixture>();
      for (const page of STUB_BENCHMARK_PAGES) fixtures.set(page.url, page.fixture);
      provider = new StubExtractionProvider(fixtures);
    } else if (providerName === 'http') {
      if (!opts.network) {
        // Network stays disabled by default; the row records the skip honestly.
        rows.push({
          provider: 'http', providerVersion: '1.0.0', pages: 0, retrievalSuccess: 0, retrievalRate: 0,
          extractionSuccess: 0, extractionRate: 0, exactProductAccuracy: null, wrongVariantRate: null,
          parentOnlyDetectionAccuracy: null, fieldPrecision: null, fieldRecall: null,
          traceability: { withMethod: 0, withSourcePath: 0, withArtifactRef: 0, coverage: null },
          replayAvailable: false, medianLatencyMs: null, p95LatencyMs: null,
          costPerPage: 0.001, costPerCorrectProduct: null, failureRate: 1, blockedPageRecoveryRate: null,
        });
        continue;
      }
      const { HttpPageExtractionAdapter } = await import('../tools/extraction-tools');
      provider = new HttpExtractionProvider(new HttpPageExtractionAdapter());
    }

    let pages = 0;
    let retrievalSuccess = 0;
    let extractionSuccess = 0;
    const exactProductCorrect: Array<boolean> = [];
    const wrongVariantCorrect: Array<boolean> = [];
    const parentOnlyCorrect: Array<boolean> = [];
    const fieldPrecisions: Array<number> = [];
    const fieldRecalls: Array<number> = [];
    let traceMethod = 0;
    let tracePath = 0;
    let traceArtifact = 0;
    let traceCompared = 0;
    const latencies: number[] = [];

    for (const example of examples) {
      const input = PiProductInputSchema.safeParse(JSON.parse(example.input_snapshot_json));
      const gold = PiGoldLabelsSchema.safeParse(JSON.parse(example.gold_labels_json));
      if (!input.success || !gold.success || !input.data.expectedPageUrl) continue;
      const goldData = gold.data;

      const startedAt = Date.now();
      const outcome = await provider!.extract({
        url: input.data.expectedPageUrl,
        gtin: input.data.gtin,
        name: input.data.registerName,
      });
      latencies.push(Date.now() - startedAt);
      pages += 1;

      if (outcome.retrieval.ok) retrievalSuccess += 1;

      // Retrieval is NOT extraction success.
      const hasAllRequiredFacts = goldData.requiredFacts.every((fact) =>
        outcome.extraction?.facts.some((f) => f.field === fact.field && factMatches(f.value, fact.value)),
      );
      const extractionOk =
        outcome.retrieval.ok &&
        outcome.extraction != null &&
        outcome.extraction.identityStatus === 'exact_match' &&
        hasAllRequiredFacts;
      if (extractionOk) extractionSuccess += 1;

      if (goldData.identity.exactProduct) {
        exactProductCorrect.push(outcome.extraction?.identityStatus === 'exact_match');
      }
      if (goldData.identity.wrongVariant) {
        wrongVariantCorrect.push(outcome.extraction?.identityStatus === 'wrong_variant');
      }
      if (goldData.identity.parentProductOnly) {
        parentOnlyCorrect.push(outcome.extraction?.identityStatus === 'parent_product_only');
      }

      // Field precision/recall over gold requiredFacts.
      if (outcome.extraction) {
        const matchedGold = goldData.requiredFacts.filter((fact) =>
          outcome.extraction!.facts.some((f) => f.field === fact.field && factMatches(f.value, fact.value)),
        );
        if (goldData.requiredFacts.length > 0) fieldRecalls.push(matchedGold.length / goldData.requiredFacts.length);
        if (outcome.extraction.facts.length > 0) {
          const predictedMatched = outcome.extraction.facts.filter((f) =>
            goldData.requiredFacts.some((fact) => fact.field === f.field && factMatches(f.value, fact.value)),
          ).length;
          fieldPrecisions.push(predictedMatched / outcome.extraction.facts.length);
        }
        // Traceability over the extraction's facts.
        traceCompared += outcome.extraction.facts.length;
        traceMethod += outcome.extraction.facts.filter((f) => f.method != null).length;
        tracePath += outcome.extraction.facts.filter((f) => f.sourcePath != null).length;
        traceArtifact += outcome.extraction.facts.filter((f) => f.artifactRef != null).length;
      }
    }

    const rate = (n: number): number | null => (pages > 0 ? n / pages : null);
    const mean = (values: Array<boolean | null>): number | null => {
      const nonNull = values.filter((v): v is boolean => v != null);
      if (nonNull.length === 0) return null;
      return nonNull.filter(Boolean).length / nonNull.length;
    };
    const wrongVariantMean = mean(wrongVariantCorrect);
    const exactProductMean = mean(exactProductCorrect);
    const parentMean = mean(parentOnlyCorrect);

    rows.push({
      provider: providerName,
      providerVersion: provider?.version ?? 'n/a',
      pages,
      retrievalSuccess,
      retrievalRate: rate(retrievalSuccess) ?? 0,
      extractionSuccess,
      extractionRate: rate(extractionSuccess) ?? 0,
      exactProductAccuracy: exactProductMean,
      wrongVariantRate: wrongVariantMean == null ? null : 1 - wrongVariantMean,
      parentOnlyDetectionAccuracy: parentMean,
      fieldPrecision: fieldPrecisions.length > 0 ? fieldPrecisions.reduce((a, b) => a + b, 0) / fieldPrecisions.length : null,
      fieldRecall: fieldRecalls.length > 0 ? fieldRecalls.reduce((a, b) => a + b, 0) / fieldRecalls.length : null,
      traceability: {
        withMethod: traceMethod,
        withSourcePath: tracePath,
        withArtifactRef: traceArtifact,
        coverage: traceCompared > 0 ? traceMethod / traceCompared : null,
      },
      replayAvailable: providerName === 'stub',
      medianLatencyMs: median(latencies),
      p95LatencyMs: p95(latencies),
      costPerPage: providerName === 'stub' ? 0 : 0.001,
      costPerCorrectProduct:
        extractionSuccess > 0 ? ((providerName === 'stub' ? 0 : 0.001) * pages) / extractionSuccess : null,
      failureRate: rate(retrievalSuccess) == null ? 1 : 1 - (rate(retrievalSuccess) ?? 0),
      blockedPageRecoveryRate: null,
    });
  }

  const passing = rows.filter(
    (r) => r.pages > 0 && r.extractionRate >= 0.8 && r.costPerCorrectProduct != null && r.costPerCorrectProduct <= 0.01,
  );
  const sorted = [...passing].sort((a, b) => b.extractionRate - a.extractionRate || a.costPerPage - b.costPerPage);
  const recommendation =
    sorted.length > 0
      ? {
          recommended: sorted.map((r) => r.provider),
          rationale:
            'providers with extractionRate >= 0.8 and costPerCorrectProduct <= $0.01, sorted by extraction rate then cost',
        }
      : null;

  return {
    datasetId: opts.datasetId,
    datasetHash: '',
    rows,
    recommendation,
    generatedAt: new Date().toISOString(),
  };
}
