/**
 * PI-9 search-stage benchmark tests (issue #26 companion): scores product
 * page SEARCH strategies — page-found rate, rank@1, precision@5,
 * misleading-source rejection, blocked-official recovery — against frozen
 * golden datasets. Deterministic stubs only; no network.
 *
 * DB-backed (bun test).
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
import {
  runSearchBenchmark,
  PerfectWebSearchStub,
  SitemapSearchStub,
  DatabaseSearchStub,
  MisleadingSearchStub,
} from '../../product-intelligence/evaluation/search-benchmark';

const workspaceId = 'ws-pi-search-bench-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

interface ProductCase {
  gtin: string;
  name: string;
  pageUrl: string;
  brandHint?: string | null;
  misleadingDomains?: string[];
  blockedOfficial?: boolean;
}

const CASES: ProductCase[] = [
  { gtin: '085000079585', name: 'STELLA CHKN BROTH 16OZ', pageUrl: 'https://brand.example.com/p/stella-broth-16oz', brandHint: 'brand.example.com' },
  { gtin: '040000512693', name: 'FISH FLAKES 2OZ', pageUrl: 'https://retailer.example.com/p/fish-flakes', brandHint: 'retailer.example.com', misleadingDomains: ['wrongsize.example.com'] },
  { gtin: '030000004444', name: 'DISCONTINUED TREAT', pageUrl: 'https://archive.example.com/p/old-treat', brandHint: 'archive.example.com', blockedOfficial: true },
];

/** Seed a frozen dataset with the given cases. */
function seedDataset(name: string, cases: ProductCase[]): string {
  const ds = benchmarkRepo.createDataset(workspaceId, name, 'random', 42);
  for (const product of cases) {
    const input = {
      gtin: product.gtin,
      registerName: product.name,
      brandHint: product.brandHint ?? null,
      expectedPageUrl: product.pageUrl,
    };
    const gold: Record<string, unknown> = {
      identity: { exactProduct: true, wrongVariant: false, parentProductOnly: false, requiredAbstention: false },
      expectedSource: null,
      expectedTitle: product.name,
      requiredFacts: [{ field: 'title', value: product.name }],
      expectedEvidence: [],
      expectedImage: null,
      expectedClassification: { productType: null, attributes: [], categoryPages: [] },
      misleadingSources: (product.misleadingDomains ?? []).map((domain) => ({ domain, reason: 'test' })),
      difficultyTags: product.blockedOfficial ? ['blocked_official'] : [],
    };
    benchmarkRepo.insertExample(ds.id, product.gtin, product.gtin, 'test', JSON.stringify(input), JSON.stringify(gold));
  }
  benchmarkRepo.markFamilyReviewComplete(ds.id, 'tester');
  benchmarkRepo.freezeDataset(ds.id, 'tester');
  return ds.id;
}

describe('PI-9 search-stage benchmark', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-search-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('scores the perfect web-search stub as the upper bound', async () => {
    const dsId = seedDataset('search-good', CASES);
    const pages = new Map(CASES.map((c) => [c.gtin, c.pageUrl]));
    const report = await runSearchBenchmark({
      datasetId: dsId,
      strategies: [new PerfectWebSearchStub(pages)],
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].products).toBe(3);
    expect(report.rows[0].pageFoundRate).toBe(1);
    expect(report.rows[0].rankAt1).toBe(1);
    expect(report.rows[0].precisionAt5).toBe(1);
    expect(report.rows[0].misleadingRejectionRate).toBe(1);
    expect(report.rows[0].blockedOfficialRecoveryRate).toBe(1);
    expect(report.recommendation?.recommended).toContain('web_search_perfect');
  });

  it('the sitemap stub cannot recover blocked official domains', async () => {
    const dsId = seedDataset('search-sitemap', CASES);
    // Sitemap knows both reachable domains but NOT the blocked official one.
    const byDomain = new Map<string, Map<string, string>>();
    for (const c of CASES) {
      if (c.blockedOfficial) continue;
      const domain = new URL(c.pageUrl).hostname.toLowerCase();
      const inner = byDomain.get(domain) ?? new Map();
      inner.set(c.gtin, c.pageUrl);
      byDomain.set(domain, inner);
    }
    const report = await runSearchBenchmark({
      datasetId: dsId,
      strategies: [new SitemapSearchStub(byDomain)],
    });
    expect(report.rows[0].pageFoundRate).toBe(2 / 3);
    expect(report.rows[0].blockedOfficialRecoveryRate).toBe(0);
    expect(report.recommendation).toBeNull();
  });

  it('a misleading strategy is rejected: noise above the truth fails the search task', async () => {
    const dsId = seedDataset('search-misleading', CASES);
    const pages = new Map(CASES.map((c) => [c.gtin, c.pageUrl]));
    const misleading = new Map<string, string>();
    for (const c of CASES) {
      if (c.misleadingDomains?.length) misleading.set(c.gtin, `https://${c.misleadingDomains[0]}/misleading`);
    }
    const report = await runSearchBenchmark({
      datasetId: dsId,
      strategies: [new MisleadingSearchStub(pages, misleading)],
    });
    expect(report.rows[0].pageFoundRate).toBe(1); // the correct page IS in the results
    expect(report.rows[0].rankAt1).toBe(0); // but never first
    expect(report.rows[0].misleadingRejectionRate).toBe(0); // noise ranked above truth
    expect(report.recommendation).toBeNull(); // and it is never recommended
  });

  it('the database stub only covers GTINs present in the database', async () => {
    const dsId = seedDataset('search-db', CASES);
    const partial = new Map([[CASES[0].gtin, CASES[0].pageUrl]]);
    const report = await runSearchBenchmark({
      datasetId: dsId,
      strategies: [new DatabaseSearchStub(partial)],
    });
    expect(report.rows[0].pageFoundRate).toBe(1 / 3);
    expect(report.rows[0].costPerFoundPage).not.toBeNull();
    expect(report.recommendation).toBeNull();
  });

  it('records an honest skip row for unregistered strategies', async () => {
    const dsId = seedDataset('search-skip', CASES);
    const report = await runSearchBenchmark({
      datasetId: dsId,
      strategies: [{ name: 'firecrawl', version: 'v2' }],
    });
    expect(report.rows[0].strategy).toBe('firecrawl');
    expect(report.rows[0].products).toBe(0);
    expect(report.rows[0].pageFoundRate).toBeNull();
  });

  it('latency and cost are measured per strategy', async () => {
    const dsId = seedDataset('search-metrics', CASES);
    const pages = new Map(CASES.map((c) => [c.gtin, c.pageUrl]));
    const report = await runSearchBenchmark({
      datasetId: dsId,
      strategies: [new PerfectWebSearchStub(pages), new DatabaseSearchStub(pages)],
    });
    const web = report.rows[0];
    const db = report.rows[1];
    expect(web.medianLatencyMs).toBe(250);
    expect(web.costPerSearch).toBe(0.001);
    expect(db.medianLatencyMs).toBe(120);
    expect(db.costPerSearch).toBe(0);
    expect(db.costPerFoundPage).toBe(0);
  });
  it('refuses to recommend on degenerate runs below the minimum sample', async () => {
    const dsId = seedDataset('search-degenerate', [CASES[0]]);
    const pages = new Map([[CASES[0].gtin, CASES[0].pageUrl]]);
    const report = await runSearchBenchmark({
      datasetId: dsId,
      strategies: [new PerfectWebSearchStub(pages)],
    });
    expect(report.rows[0].pageFoundRate).toBe(1);
    expect(report.recommendation).toBeNull(); // n=1 < minProducts
  });
});
