/**
 * PI-9 extraction benchmark tests (issue #26).
 *
 * DB-backed (bun test): the stub provider over the built-in fixture pages —
 * retrieval success is ALWAYS distinguished from correct product extraction
 * (an HTML 200 with the wrong size is a failed extraction task).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';
import { runExtractionBenchmark, STUB_BENCHMARK_PAGES } from '../../product-intelligence/evaluation/extraction-benchmark';
import { StubManagedProvider } from '../../product-intelligence/extraction/managed-fallback';

const workspaceId = 'ws-pi-bench-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

/** Seed a frozen dataset from a subset of STUB_BENCHMARK_PAGES. */
function seedDataset(
  name: string,
  urls: string[],
  extras: Array<{ gtin: string; sku: string; input: Record<string, unknown>; gold: Record<string, unknown> }> = [],
): string {
  const ds = benchmarkRepo.createDataset(workspaceId, name, 'random', 42);
  const pages = STUB_BENCHMARK_PAGES.filter((p) => urls.includes(p.url));
  for (const page of pages) {
    const input = {
      gtin: page.gtin,
      registerName: page.name,
      expectedPageUrl: page.url,
    };
    // Gold facts mirror the fixture facts; identity expectations per case.
    const gold: Record<string, unknown> = {
      identity: {
        exactProduct: page.fixture.identityStatus === 'exact_match',
        wrongVariant: page.fixture.identityStatus === 'wrong_variant',
        parentProductOnly: page.fixture.identityStatus === 'parent_product_only',
        requiredAbstention: false,
      },
      expectedSource: null,
      expectedTitle: page.name,
      requiredFacts: page.fixture.facts.map((f) => ({ field: f.field, value: f.value })),
      expectedEvidence: page.fixture.facts.map((f) => ({ field: f.field, extractionMethod: f.method })),
      expectedImage: null,
      expectedClassification: { productType: null, attributes: [], categoryPages: [] },
      misleadingSources: [],
      difficultyTags: [],
    };
    benchmarkRepo.insertExample(
      ds.id,
      page.gtin,
      page.gtin,
      'test',
      JSON.stringify(input),
      JSON.stringify(gold),
    );
  }
  for (const extra of extras) {
    benchmarkRepo.insertExample(ds.id, extra.gtin, extra.sku, 'test', JSON.stringify(extra.input), JSON.stringify(extra.gold));
  }
  benchmarkRepo.markFamilyReviewComplete(ds.id, 'tester');
  benchmarkRepo.freezeDataset(ds.id, 'tester');
  return ds.id;
}

describe('PI-9 extraction benchmark', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('distinguishes retrieval success from correct product extraction', async () => {
    const urls = STUB_BENCHMARK_PAGES.map((p) => p.url);
    // Blocked page: present in the dataset but NOT in the stub fixture map —
    // the stub treats unknown URLs as 404 (retrieval failure).
    const ds = seedDataset('full', urls.filter((u) => !u.endsWith('blocked')));
    // Add a blocked example whose URL is not in the fixture map.
    const ds2 = benchmarkRepo.createDataset(workspaceId, 'full-with-blocked', 'random', 43);
    // Re-seed with a blocked URL added to the map keys (missing from fixtures).
    const blockedUrl = 'https://blocked.example/p/x';
    for (const page of STUB_BENCHMARK_PAGES) {
      const input = { gtin: page.gtin, registerName: page.name, expectedPageUrl: page.url };
      const gold = {
        identity: { exactProduct: page.fixture.identityStatus === 'exact_match', wrongVariant: page.fixture.identityStatus === 'wrong_variant', parentProductOnly: page.fixture.identityStatus === 'parent_product_only', requiredAbstention: false },
        expectedSource: null, expectedTitle: page.name,
        requiredFacts: page.fixture.facts.map((f) => ({ field: f.field, value: f.value })),
        expectedEvidence: [], expectedImage: null,
        expectedClassification: { productType: null, attributes: [], categoryPages: [] },
        misleadingSources: [], difficultyTags: [],
      };
      benchmarkRepo.insertExample(ds2.id, page.gtin, page.gtin, 'test', JSON.stringify(input), JSON.stringify(gold));
    }
    benchmarkRepo.insertExample(ds2.id, '000000000001', '000000000001', 'test', JSON.stringify({ gtin: '000000000001', registerName: 'Blocked', expectedPageUrl: blockedUrl }), JSON.stringify({ identity: { exactProduct: true, wrongVariant: false, parentProductOnly: false, requiredAbstention: false }, expectedSource: null, expectedTitle: 'Blocked', requiredFacts: [], expectedEvidence: [], expectedImage: null, expectedClassification: { productType: null, attributes: [], categoryPages: [] }, misleadingSources: [], difficultyTags: [] }));
    benchmarkRepo.markFamilyReviewComplete(ds2.id, 'tester');
    benchmarkRepo.freezeDataset(ds2.id, 'tester');
    void ds;

    const report = await runExtractionBenchmark({ datasetId: ds2.id, providers: ['stub'], network: false });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.provider).toBe('stub');
    expect(row.pages).toBe(6);
    // Retrieval: 5 of 6 (blocked page 404s).
    expect(row.retrievalSuccess).toBe(5);
    expect(row.retrievalRate).toBeCloseTo(5 / 6, 5);
    // Extraction: only the exact-match pages with ALL required facts (2 of 6:
    // json_ld exact + xhr-only exact). The wrong-size page retrieved fine but
    // FAILED extraction.
    expect(row.extractionSuccess).toBe(2);
    expect(row.extractionRate).toBeCloseTo(2 / 6, 5);
    expect(row.extractionRate).toBeLessThan(row.retrievalRate);
    // Wrong-variant detection: the stub correctly returned 'wrong_variant' for
    // the wrong-size page -> wrongVariantRate 0.
    expect(row.wrongVariantRate).toBe(0);
    // Parent-only detection correct for the family page.
    expect(row.parentOnlyDetectionAccuracy).toBe(1);
    // Exact-product accuracy over exact-product gold pages.
    expect(row.exactProductAccuracy).toBeCloseTo(2 / 3, 5);
    // Traceability: facts carry method/sourcePath for stub fixtures.
    expect(row.traceability.withMethod).toBeGreaterThan(0);
    expect(row.traceability.coverage).not.toBeNull();
    // Replay available for the deterministic stub.
    expect(row.replayAvailable).toBe(true);
    expect(row.medianLatencyMs).not.toBeNull();
    expect(row.failureRate).toBeCloseTo(1 / 6, 5);
  });

  it('recommends providers passing quality + cost thresholds', async () => {
    // Only the two exact-match pages -> stub extractionRate 1.0.
    const urls = STUB_BENCHMARK_PAGES.filter((p) => p.fixture.identityStatus === 'exact_match').map((p) => p.url);
    const dsId = seedDataset('good', urls);
    const report = await runExtractionBenchmark({ datasetId: dsId, providers: ['stub'], network: false });
    expect(report.recommendation).not.toBeNull();
    expect(report.recommendation!.recommended).toContain('stub');
  });

  it('does not recommend a provider below the extraction threshold', async () => {
    const urls = STUB_BENCHMARK_PAGES.filter((p) => p.fixture.identityStatus === 'wrong_variant' || p.fixture.identityStatus === 'parent_product_only').map((p) => p.url);
    const dsId = seedDataset('bad', urls);
    const report = await runExtractionBenchmark({ datasetId: dsId, providers: ['stub'], network: false });
    expect(report.rows[0].extractionRate).toBe(0);
    expect(report.recommendation).toBeNull();
  });

  it('keeps network providers disabled by default', async () => {
    const dsId = seedDataset('net', STUB_BENCHMARK_PAGES.map((p) => p.url).slice(0, 2));
    const report = await runExtractionBenchmark({ datasetId: dsId, providers: ['http'], network: false });
    expect(report.rows[0].provider).toBe('http');
    expect(report.rows[0].pages).toBe(0);
    expect(report.rows[0].extractionRate).toBe(0);
  });
  it('scores a managed-browser provider through the full benchmark pipeline', async () => {
    // Deterministic stub managed provider serving JSON-LD pages that mirror
    // the exact-match fixture — layer-7 seam scored end-to-end.
    const htmlFor = (url: string): string => {
      if (url.includes('exact-jsonld')) {
        return '<script type="application/ld+json">{"@type":"Product","name":"Stella & Chewy Chicken Broth 16 oz","sku":"SC-16","brand":"Stella & Chewy","size":"16 oz","gtin":"085000079585"}</script>';
      }
      if (url.includes('xhr-only')) {
        return '<script type="application/ld+json">{"@type":"Product","name":"Stella & Chewy Chicken Broth 16 oz","size":"16 oz","gtin":"085000079585","image":"https://cdn.example.com/v16.jpg"}</script>';
      }
      return '';
    };
    const pages = new Map<string, string>();
    for (const p of STUB_BENCHMARK_PAGES) pages.set(p.url, htmlFor(p.url));
    const provider = new StubManagedProvider(pages);

    const urls = STUB_BENCHMARK_PAGES.filter((p) => p.fixture.identityStatus === 'exact_match').map((p) => p.url);
    const dsId = seedDataset('managed-good', urls);
    const report = await runExtractionBenchmark({ datasetId: dsId, providers: ['managed'], managed: { providers: [provider] } });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].provider).toBe('managed:stub_managed');
    expect(report.rows[0].retrievalRate).toBe(1);
    expect(report.rows[0].extractionRate).toBe(1);
    expect(report.rows[0].exactProductAccuracy).toBe(1);
    expect(report.rows[0].fieldRecall).toBe(1);
    expect(report.rows[0].traceability.coverage).toBe(1);
    expect(report.recommendation?.recommended).toContain('managed:stub_managed');
  });

  it('distinguishes retrieval success from extraction success for managed providers', async () => {
    // Page retrieved (200) but has no JSON-LD -> extraction must fail.
    const pages = new Map([['https://managed.example.com/p/empty', '<html><body>no data</body></html>']]);
    // Seed an example whose expectedPageUrl is served but empty (inserted
    // before freeze — frozen datasets are immutable).
    const dsId = seedDataset('managed-retrieval-only', [], [
      {
        gtin: '085000079585',
        sku: '085000079585',
        input: { gtin: '085000079585', registerName: 'STELLA CHKN BROTH 16OZ', expectedPageUrl: 'https://managed.example.com/p/empty' },
        gold: {
          identity: { exactProduct: true, wrongVariant: false, parentProductOnly: false, requiredAbstention: false },
          expectedSource: null, expectedTitle: 'X', requiredFacts: [{ field: 'title', value: 'X' }],
          expectedEvidence: [], expectedImage: null,
          expectedClassification: { productType: null, attributes: [], categoryPages: [] },
          misleadingSources: [], difficultyTags: [],
        },
      },
    ]);
    const report = await runExtractionBenchmark({
      datasetId: dsId,
      providers: ['managed'],
      managed: { providers: [new StubManagedProvider(pages)] },
    });
    expect(report.rows[0].retrievalRate).toBe(1);
    expect(report.rows[0].extractionRate).toBe(0);
  });

  it('flags conflicting GTINs instead of claiming exact matches for managed providers', async () => {
    const wrongGtinHtml = '<script type="application/ld+json">{"@type":"Product","name":"Wrong Product","gtin":"999999999999"}</script>';
    const provider = new StubManagedProvider(new Map([['https://managed.example.com/p/wrong', wrongGtinHtml]]));
    const dsId = seedDataset('managed-conflict', [], [
      {
        gtin: '085000079585',
        sku: '085000079585',
        input: { gtin: '085000079585', registerName: 'STELLA CHKN BROTH 16OZ', expectedPageUrl: 'https://managed.example.com/p/wrong' },
        gold: {
          identity: { exactProduct: true, wrongVariant: false, parentProductOnly: false, requiredAbstention: false },
          expectedSource: null, expectedTitle: 'Wrong Product', requiredFacts: [{ field: 'title', value: 'Wrong Product' }],
          expectedEvidence: [], expectedImage: null,
          expectedClassification: { productType: null, attributes: [], categoryPages: [] },
          misleadingSources: [], difficultyTags: [],
        },
      },
    ]);
    const report = await runExtractionBenchmark({
      datasetId: dsId,
      providers: ['managed'],
      managed: { providers: [provider] },
    });
    // Retrieved and parsed, but the GTIN conflicts — never an exact match.
    expect(report.rows[0].retrievalRate).toBe(1);
    expect(report.rows[0].exactProductAccuracy).toBe(0);
    expect(report.rows[0].extractionRate).toBe(0);
  });

  it('records a skip row when a managed provider is requested but not registered', async () => {
    const dsId = seedDataset('managed-unregistered', STUB_BENCHMARK_PAGES.map((p) => p.url).slice(0, 1));
    const report = await runExtractionBenchmark({ datasetId: dsId, providers: ['managed'], managed: { providers: [] } });
    expect(report.rows[0].provider).toBe('managed:n/a');
    expect(report.rows[0].pages).toBe(0);
    expect(report.rows[0].failureRate).toBe(1);
  });
});
