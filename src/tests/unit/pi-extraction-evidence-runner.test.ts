import { describe, expect, it, vi } from 'vitest';
import { createDeterministicExtractionContract, runDeterministicExtraction, replayDeterministicExtraction } from '../../product-intelligence/extraction/evidence-runner';
import type { FetchedPage } from '../../product-intelligence/extraction/platforms';
import type { LadderOptions } from '../../product-intelligence/extraction/ladder';

function page(html: string, url = 'https://brand.example/p/product'): FetchedPage {
  return { html, finalUrl: url, status: 200, contentHash: '0'.repeat(64) };
}

const JSON_LD = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Example Food 16 oz","sku":"EX-16","brand":{"name":"Example"},"gtin":"012345678905","image":"https://img.example/product.jpg"}</script></head></html>`;
const NEXT_STATE = `<html><head><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Embedded Food 8 oz","sku":"EM-8","gtin":"098765432109","brand":"Embedded","variants":[{"id":1,"title":"8 oz","sku":"EM-8"}]}}}}</script></head></html>`;

const expected = { gtin: '012345678905', name: 'Example Food 16 oz' };

const modelExtract = vi.fn();
const noModelOptions: LadderOptions = {
  fetchPage: async () => page(JSON_LD),
  llm: { adapter: { extract: modelExtract } as never },
};

describe('deterministic extraction evidence runner', () => {
  it('emits field-level JSON-LD provenance and never calls a supplied model seam', async () => {
    const result = await runDeterministicExtraction({ url: 'https://brand.example/p/product', expected }, { ladder: noModelOptions });
    expect(result.bundle.schemaVersion).toBe(1);
    expect(result.bundle.deterministicOnly).toBe(true);
    expect(result.bundle.observations.find((o) => o.field === 'product_name')).toMatchObject({
      value: 'Example Food 16 oz',
      method: 'json_ld',
      sourcePath: 'JSON-LD Product.name',
      provenanceQuality: 'exact_path',
    });
    expect(result.bundle.observations.find((o) => o.field === 'gtin')?.sourcePath).toBe('JSON-LD Product.gtin');
    expect(result.bundle.images[0]).toMatchObject({ variantRef: null, sourcePath: 'JSON-LD Product.image' });
    expect(modelExtract).not.toHaveBeenCalled();
  });

  it('replays retained HTML without invoking the page transport', async () => {
    const fetchPage = vi.fn(async () => page('<html>network should not be read</html>'));
    const replay = await replayDeterministicExtraction(
      { artifactId: 'artifact-48', content: JSON_LD, contentHash: undefined, finalUrl: 'https://brand.example/p/product', retrievedAt: '2025-01-01T00:00:00.000Z' },
      { url: 'https://brand.example/p/product', expected },
      { ladder: { fetchPage } },
    );
    expect(fetchPage).not.toHaveBeenCalled();
    expect(replay.bundle.artifactRefs).toEqual(['artifact-48']);
    expect(replay.bundle.retrievedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(replay.bundle.observations.some((o) => o.artifactId === 'artifact-48')).toBe(true);
  });

  it('replay disables every transport and does not invoke the policy gate', async () => {
    const transports = {
      fetchPage: vi.fn(async () => page(JSON_LD)),
      fetchShopify: vi.fn(async () => ({ title: 'network', variants: [] })) as never,
      browser: { snapshot: vi.fn() },
      interaction: { type: 'select_option', selector: '#size', optionLabel: '16 oz' } as never,
      managedFallback: { fetch: vi.fn() } as never,
      profiles: [{ name: 'network-profile', matches: () => true, extract: vi.fn() }],
      llm: { adapter: { extract: vi.fn() } as never },
    };
    const networkGate = vi.fn(async () => ({ allowed: true }));
    const replay = await replayDeterministicExtraction(
      { artifactId: 'artifact-replay', content: JSON_LD, finalUrl: 'https://brand.example/p/product' },
      { url: 'https://brand.example/p/product', expected },
      { ladder: transports, networkGate },
    );
    expect(replay.bundle.observations.length).toBeGreaterThan(0);
    expect(Object.values(transports).flatMap((transport) => {
      if (typeof transport === 'function') return [transport];
      if (transport && typeof transport === 'object') return Object.values(transport as Record<string, unknown>).filter((v): v is ReturnType<typeof vi.fn> => typeof v === 'function');
      return [];
    }).every((spy) => !spy.mock.calls.length)).toBe(true);
    expect(networkGate).not.toHaveBeenCalled();
  });

  it('returns structured failure for a missing retained artifact without network', async () => {
    const fetchPage = vi.fn();
    const result = await runDeterministicExtraction(
      { url: 'https://brand.example/p/product', artifactId: 'missing-artifact' },
      { artifactReader: { load: async () => null }, ladder: { fetchPage } },
    );
    expect(result.bundle.failures[0]).toMatchObject({ code: 'artifact_unavailable', stage: 'replay' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('retains embedded state observations as deterministic evidence', async () => {
    const run = await runDeterministicExtraction(
      { url: 'https://brand.example/p/embedded', expected: { gtin: '098765432109', name: 'Embedded Food 8 oz' } },
      { ladder: { fetchPage: async () => page(NEXT_STATE, 'https://brand.example/p/embedded') } },
    );
    expect(run.bundle.observations.find((o) => o.field === 'product_name')).toMatchObject({ method: 'platform_api' });
    expect(run.bundle.observations.find((o) => o.field === 'product_name')?.sourcePath).toBe('__NEXT_DATA__ product');
    expect(run.bundle.identityStatus).toBe('exact_match');
  });

  it('persists profile id/version and selector paths, including profile-version changes', async () => {
    const ladder = {
      fetchPage: async () => page('<html><body>profile fixture</body></html>'),
      profiles: [{
        name: 'approved-profile', id: 'profile-1', version: 1, runtime: 'static' as const,
        matches: () => true,
        extract: async () => ({ fields: [
          { field: 'product_name', value: 'Profile Food', method: 'selectors', sourcePath: 'h1.product-title', sourceContentHash: '0'.repeat(64) },
          { field: 'brand', value: 'Profile Brand', method: 'selectors', sourcePath: '.brand', sourceContentHash: '0'.repeat(64) },
        ], images: [], profile: { id: 'profile-1', version: 1, runtime: 'static' as const } }),
      }],
    };
    const first = await runDeterministicExtraction({ url: 'https://brand.example/p/profile', profile: { id: 'profile-1', version: 1, runtime: 'static' } }, { ladder });
    const second = await runDeterministicExtraction({ url: 'https://brand.example/p/profile', profile: { id: 'profile-1', version: 2, runtime: 'static' } }, { ladder });
    expect(first.bundle.profile?.version).toBe(1);
    expect(second.bundle.profile?.version).toBe(1);
    expect(first.bundle.observations.find((o) => o.field === 'product_name')).toMatchObject({ profileId: 'profile-1', profileVersion: 1, sourcePath: 'h1.product-title' });
    expect(first.bundle.extractionPath.some((step) => step.sourcePath === 'h1.product-title')).toBe(true);
    expect(second.bundle.observations.find((o) => o.field === 'product_name')?.profileVersion).toBe(1);
  });

  it('uses source metadata from platform payloads and preserves variant references', async () => {
    const sourceHash = '1'.repeat(64);
    const run = await runDeterministicExtraction(
      { url: 'https://shop.example/products/family', expected: { name: 'Example Food', gtin: '111111111111' } },
      {
        ladder: {
          fetchPage: async () => page('<script src="/cdn/shop/theme.js"></script>', 'https://shop.example/products/family'),
          fetchShopify: async () => ({
            id: 1, title: 'Example Food', vendor: 'Example', handle: 'family',
            variants: [{ id: 42, title: '16 oz', sku: 'EX-16', barcode: '111111111111', available: true, price: null, option1: '16 oz', option2: null, option3: null }],
            images: [], options: [], product_type: null, sourceContentHash: sourceHash, sourcePath: 'shopify-response',
          }),
        },
      },
    );
    expect(run.bundle.observations.find((o) => o.field === 'sku')).toMatchObject({ contentHash: sourceHash, variantRef: '42' });
    expect(run.bundle.observations.find((o) => o.field === 'gtin')).toMatchObject({ contentHash: sourceHash, variantRef: '42' });
    expect(run.bundle.observations.find((o) => o.field === 'product_name')?.contentHash).toBe(sourceHash);
  });

  it('routes wrong variants, blocked pages, and missing fields with stable failure codes', async () => {
    const wrongVariant = await runDeterministicExtraction(
      { url: 'https://shop.example/products/family', expected },
      {
        ladder: {
          fetchPage: async () => page('<script src="/cdn/shop/theme.js"></script>', 'https://shop.example/products/family'),
          fetchShopify: async () => ({
            id: 1, title: 'Example Food', vendor: 'Example', handle: 'family', variants: [
              { id: 1, title: '8 oz', sku: 'EX-8', available: true, price: null, option1: '8 oz', option2: null, option3: null },
              { id: 2, title: '16 oz', sku: 'EX-16', available: true, price: null, option1: '16 oz', option2: null, option3: null },
            ], images: [], options: [], product_type: null,
          }),
        },
      },
    );
    expect(wrongVariant.bundle.failures.some((f) => f.code === 'parent_product_only')).toBe(true);

    const blocked = await runDeterministicExtraction(
      { url: 'https://blocked.example/product', expected },
      { ladder: { fetchPage: async () => { throw new Error('HTTP 403 for blocked page'); } } },
    );
    expect(blocked.bundle.failures[0]).toMatchObject({ code: 'blocked', stage: 'retrieval' });

    const missing = await runDeterministicExtraction(
      { url: 'https://empty.example/product', expected },
      { ladder: { fetchPage: async () => page('<html><body>empty</body></html>', 'https://empty.example/product') } },
    );
    expect(missing.bundle.failures.some((f) => f.code === 'missing_fields')).toBe(true);
  });

  it('wires the production contract through the deterministic runner', async () => {
    const contract = createDeterministicExtractionContract({ ladder: { fetchPage: async () => page(JSON_LD) } });
    const result = await contract.extract({ url: 'https://brand.example/p/product', expected, signal: new AbortController().signal, timeoutMs: 5000 });
    expect(contract.name).toBe('deterministic_extraction_evidence');
    expect(result.deterministicOnly).toBe(true);
    expect(result.fields.some((field) => field.method === 'json_ld')).toBe(true);
  });
});
