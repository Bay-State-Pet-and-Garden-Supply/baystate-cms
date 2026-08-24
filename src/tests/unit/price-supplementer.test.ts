import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { supplementPrice } from '../../onboarding/price-supplementer';
import { clearSerperCache } from '../../db/repositories/serper-cache-repo';

describe('Price Supplementer Error Handling', () => {
  const testDbPath = '/tmp/baystate-cms-price-supplementer-test.db';
  const originalFetch = global.fetch;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    upsertApiKey('serper', 'test-serper-api-key');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    clearSerperCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should catch extractViaHttpFn errors on initial candidate and fall back to subsequent candidate', async () => {
    // Mock Serper fetch to return 2 candidate URLs with no price snippets
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://google.serper.dev/search') {
        return {
          ok: true,
          json: async () => ({
            organic: [
              {
                title: 'Item at Retailer 1',
                link: 'https://chewy.com/item1',
                snippet: 'In stock now',
                position: 1,
              },
              {
                title: 'Item at Retailer 2',
                link: 'https://petco.com/item2',
                snippet: 'Free shipping on orders',
                position: 2,
              },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any;

    const extractViaHttpMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://chewy.com/item1') {
        throw new Error('Network timeout during HTTP extraction');
      }
      if (url === 'https://petco.com/item2') {
        return { price: '$24.99' };
      }
      return { price: null };
    });

    const result = await supplementPrice('Cat Tree Scratching Post', extractViaHttpMock);

    expect(extractViaHttpMock).toHaveBeenCalledTimes(2);
    expect(extractViaHttpMock).toHaveBeenNthCalledWith(1, 'https://chewy.com/item1');
    expect(extractViaHttpMock).toHaveBeenNthCalledWith(2, 'https://petco.com/item2');
    expect(result.price).toBe('$24.99');
    expect(result.sourceUrl).toBe('https://petco.com/item2');
  });

  it('should catch extractViaHttpFn errors across all candidates gracefully and return null price', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://google.serper.dev/search') {
        return {
          ok: true,
          json: async () => ({
            organic: [
              {
                title: 'Item at Retailer 1',
                link: 'https://chewy.com/item1',
                snippet: 'In stock now',
                position: 1,
              },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any;

    const extractViaHttpMock = vi.fn().mockRejectedValue(new Error('HTTP 500 Internal Server Error'));

    const result = await supplementPrice('Cat Toy Wand', extractViaHttpMock);

    expect(extractViaHttpMock).toHaveBeenCalledWith('https://chewy.com/item1');
    expect(result.price).toBeNull();
    expect(result.sourceUrl).toBeNull();
  });
});
