import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { discoverSources } from '../../onboarding/source-discovery';
import { supplementPrice } from '../../onboarding/price-supplementer';
import { clearSerperCache } from '../../db/repositories/serper-cache-repo';

describe('Serper Caching Integration', () => {
  const testDbPath = '/tmp/shopsite-cms-serper-cache-int-test.db';
  const originalFetch = global.fetch;
  let fetchCount = 0;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Configure the Serper API key in the DB
    upsertApiKey('serper', 'test-serper-api-key');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    fetchCount = 0;
    clearSerperCache();

    // Mock fetch
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      fetchCount++;
      if (url === 'https://google.serper.dev/search') {
        const body = JSON.parse(init?.body as string);
        return {
          ok: true,
          json: async () => ({
            organic: [
              {
                title: `Result for ${body.q}`,
                link: `https://example.com/product/${body.q}`,
                snippet: `Snippet for ${body.q} showing price $19.99`,
                position: 1,
              },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should cache UPC search results in discoverSources and reuse them', async () => {
    const upc = '123456789012';
    // First call to discoverSources
    const firstResults = await discoverSources(upc, 'Test Product', 'Brand');
    expect(fetchCount).toBeGreaterThan(0); // Runs at least the UPC search (and potentially follow ups)

    // Reset fetchCount
    fetchCount = 0;

    // Second call to discoverSources with the same UPC and name
    const secondResults = await discoverSources(upc, 'Test Product', 'Brand');
    // It should hit the cache and not make any new Serper fetch calls!
    expect(fetchCount).toBe(0);
    expect(secondResults.candidates).toHaveLength(firstResults.candidates.length);
    expect(secondResults.candidates[0].url).toBe(firstResults.candidates[0].url);
  });

  it('should cache pricing search results in supplementPrice and reuse them', async () => {
    const productName = 'Premium Dog Food';
    const extractViaHttpMock = vi.fn().mockResolvedValue({ price: null });

    // First call to supplementPrice
    const firstPrice = await supplementPrice(productName, extractViaHttpMock);
    expect(fetchCount).toBe(1);
    expect(firstPrice.price).toBe('$19.99');

    // Reset fetchCount
    fetchCount = 0;

    // Second call to supplementPrice
    const secondPrice = await supplementPrice(productName, extractViaHttpMock);
    // It should hit the cache and not make any fetch calls
    expect(fetchCount).toBe(0);
    expect(secondPrice.price).toBe('$19.99');
    expect(secondPrice.sourceUrl).toBe(firstPrice.sourceUrl);
  });
});
