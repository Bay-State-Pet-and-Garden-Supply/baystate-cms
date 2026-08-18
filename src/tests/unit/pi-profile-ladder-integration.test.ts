/**
 * Unit tests for PI ladder profile wiring (Layer 4 integration).
 * Tests lazy profile resolution, provenance tagging, allowlist enforcement,
 * and translation into ExtractedFieldEvidence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lazyProfileResolver, defaultLadderOptions } from '../../product-intelligence/extraction/wiring';
import { runExtractionLadder } from '../../product-intelligence/extraction/ladder';
import type { ExtractedFieldEvidence } from '../../product-intelligence/tools/contract';

describe('PI ladder profile wiring', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lazyProfileResolver returns resolver matching registered domain', () => {
    const resolver = lazyProfileResolver();
    expect(resolver).toHaveLength(1);
    expect(resolver![0].name).toBe('onboarding_domain_profiles');
  });

  it('lazyProfileResolver filters against sourcesAllowlist when specified', () => {
    const resolver = lazyProfileResolver(['allowed.example.com']);
    expect(resolver).toHaveLength(1);
    // When URL hostname is not in allowlist, matches returns false
    expect(resolver![0].matches('https://disallowed.example.com/product/1')).toBe(false);
  });

  it('preserves resolver-provided field method/sourcePath and only tags profile_selector on explicit selector provenance', async () => {
    const resolver = {
      name: 'mixed_provenance_profile',
      matches: () => true,
      extract: async () => ({
        fields: [
          { field: 'product_name', value: 'Acme Kibble', method: 'json_ld', sourcePath: 'json-ld:Product.name' },
          { field: 'description', value: 'Acme desc', method: 'meta', sourcePath: 'meta:og:description' },
          { field: 'size', value: '15 lb', method: 'profile_selector', sourcePath: 'profile:prof_1:size' },
          // No explicit method: the `profile:` source path IS explicit selector
          // provenance, so the ladder tags profile_selector.
          { field: 'sku', value: 'SKU-9', sourcePath: 'profile:prof_1:sku' } as unknown as ExtractedFieldEvidence,
          // No explicit method and no selector path: never relabeled.
          { field: 'brand', value: 'Acme', sourcePath: 'fallback:brand' } as unknown as ExtractedFieldEvidence,
        ],
        images: [],
      }),
    };
    const { result } = await runExtractionLadder(
      'https://acmepet.com/products/kibble-15lb',
      {},
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => ({
          html: '<html><body>No structured data</body></html>',
          finalUrl: 'https://acmepet.com/products/kibble-15lb',
          status: 200,
          contentHash: 'hash123',
        }),
        profiles: [resolver],
      },
    );
    const byField = Object.fromEntries(result.fields.map((f) => [f.field, f]));
    // Structured/meta fallbacks keep their true method and source path.
    expect(byField['product_name']?.method).toBe('json_ld');
    expect(byField['product_name']?.sourcePath).toBe('json-ld:Product.name');
    expect(byField['description']?.method).toBe('meta');
    expect(byField['description']?.sourcePath).toBe('meta:og:description');
    // Explicit selector provenance is preserved as profile_selector.
    expect(byField['size']?.method).toBe('profile_selector');
    expect(byField['size']?.sourcePath).toBe('profile:prof_1:size');
    // `profile:` source path without an explicit method => profile_selector.
    expect(byField['sku']?.method).toBe('profile_selector');
    // Unknown provenance is never upgraded to profile_selector.
    expect(byField['brand']?.method).toBe('profile_fallback');
    expect(byField['brand']?.sourcePath).toBe('fallback:brand');
  });

  it('runs ladder with profile and produces profile_selector field evidence', async () => {
    const mockProfile = {
      name: 'test_domain_profile',
      matches: (url: string) => url.includes('acmepet.com'),
      extract: async (url: string) => ({
        fields: [
          {
            field: 'product_name',
            value: 'Acme Premium Kibble 15lb',
            method: 'profile_selector',
            sourcePath: 'profile:prof_123:title',
          },
          {
            field: 'brand',
            value: 'Acme Pet',
            method: 'profile_selector',
            sourcePath: 'profile:prof_123:brand',
          },
          {
            field: 'size',
            value: '15 lb',
            method: 'profile_selector',
            sourcePath: 'profile:prof_123:size',
          },
        ],
        images: [{ url: 'https://acmepet.com/images/kibble.jpg', sourcePath: 'profile:prof_123:primaryImage' }],
      }),
    };

    const { result, layersUsed } = await runExtractionLadder(
      'https://acmepet.com/products/kibble-15lb',
      { gtin: '012345678905' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => ({
          html: '<html><body>No structured data</body></html>',
          finalUrl: 'https://acmepet.com/products/kibble-15lb',
          status: 200,
          contentHash: 'hash123',
        }),
        profiles: [mockProfile],
      },
    );

    expect(layersUsed).toContain('profile_selector');
    const titleField = result.fields.find((f) => f.field === 'product_name');
    expect(titleField?.value).toBe('Acme Premium Kibble 15lb');
    expect(titleField?.method).toBe('profile_selector');
    expect(titleField?.sourcePath).toBe('profile:prof_123:title');

    const brandField = result.fields.find((f) => f.field === 'brand');
    expect(brandField?.value).toBe('Acme Pet');

    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toBe('https://acmepet.com/images/kibble.jpg');
  });

  it('defaultLadderOptions includes both browser and profile seams', () => {
    const opts = defaultLadderOptions(['test.com']);
    expect(opts.profiles).toBeDefined();
    expect(opts.profiles).toHaveLength(1);
  });

  it('lazyProfileResolver.extract preserves the worker true method/path keyed by title (real worker provenance shape)', async () => {
    // The extraction worker reports provenance/details under ITS field keys
    // (title, brand, description, price, primaryImage) — not the ladder's
    // (product_name, ...). This stubs the lazily-loaded worker/DB modules and
    // feeds the resolver a response shaped exactly like the real worker, then
    // proves the true selector/meta/JSON-LD method+path passes through instead
    // of a fabricated profile_fallback / fallback:product_name entry.
    const profile = {
      id: 'prof_123',
      domain: 'acmepet.com',
      runtime: 'static' as const,
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const workerResponse = {
      ok: true,
      data: {
        title: 'Acme Premium Kibble 15lb',
        brand: 'Acme Pet',
        description: 'Delicious kibble',
        price: '9.99',
        primaryImage: 'https://acmepet.com/images/kibble.jpg',
        additionalImages: [] as string[],
        fieldProvenance: {
          title: 'profile-selector',
          brand: 'json-ld',
          description: 'meta',
          price: 'spreadsheet-import',
          primaryImage: 'profile-selector',
        },
      },
      fieldProvenance: {
        title: 'profile-selector',
        brand: 'json-ld',
        description: 'meta',
        price: 'spreadsheet-import',
        primaryImage: 'profile-selector',
      },
      fieldProvenanceDetails: {
        title: { method: 'profile_selector', sourcePath: 'h1.title' },
        brand: { method: 'json_ld', sourcePath: 'json-ld:Product.brand' },
        description: { method: 'meta', sourcePath: 'meta:og:description' },
        price: { method: 'spreadsheet-import', sourcePath: 'expected:price' },
        primaryImage: { method: 'profile_selector', sourcePath: '.gallery img' },
      },
      sourceContentHash: 'hash123',
      sourceArtifactId: 'artifact-1',
    };
    const fakeRequireFn = (id: string): unknown => {
      if (id === '../../db/connection') return { isDbInitialized: () => true };
      if (id === '../../db/repositories/extractor-profile-repo') {
        return { findProfileByDomain: (d: string) => (d === 'acmepet.com' ? profile : null) };
      }
      if (id === '../../onboarding/profile-runner-client') {
        return { runProfileExtraction: async () => workerResponse };
      }
      throw new Error(`unexpected lazy require in test: ${id}`);
    };

    const resolver = lazyProfileResolver(['acmepet.com'], fakeRequireFn)!;
    const extracted = await resolver[0].extract(
      'https://acmepet.com/products/kibble-15lb',
      new AbortController().signal,
      5000,
      { name: 'Acme Premium Kibble 15lb', brandHint: null },
    );

    expect(extracted).not.toBeNull();
    const byField = Object.fromEntries(extracted!.fields.map((f) => [f.field, f]));

    // product_name maps to the worker's `title` key: the true selector method
    // and path are preserved (NOT a fabricated profile_fallback entry).
    expect(byField['product_name'].value).toBe('Acme Premium Kibble 15lb');
    expect(byField['product_name'].method).toBe('profile_selector');
    expect(byField['product_name'].sourcePath).toBe('h1.title');
    expect(byField['product_name'].sourceContentHash).toBe('hash123');
    expect(byField['product_name'].sourceArtifactId).toBe('artifact-1');

    // The other worker-keyed fields keep their true method/path too.
    expect(byField['brand'].method).toBe('json_ld');
    expect(byField['brand'].sourcePath).toBe('json-ld:Product.brand');
    expect(byField['description'].method).toBe('meta');
    expect(byField['description'].sourcePath).toBe('meta:og:description');
    expect(byField['price'].method).toBe('spreadsheet-import');
    expect(byField['price'].sourcePath).toBe('expected:price');

    // The primary image preserves the true selector path.
    expect(extracted!.images).toHaveLength(1);
    expect(extracted!.images[0].url).toBe('https://acmepet.com/images/kibble.jpg');
    expect(extracted!.images[0].sourcePath).toBe('.gallery img');
  });
});
