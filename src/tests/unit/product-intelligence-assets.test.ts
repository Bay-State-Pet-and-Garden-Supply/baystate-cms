/**
 * PI-6 image asset tests: dHash determinism, discovery parsers (JSON-LD,
 * Shopify/WooCommerce variant-image mappings, network captures), rights
 * resolution, identity classification, the end-to-end verification pipeline
 * (stub gateway fetch + sharp decode), and duplicate detection.
 *
 * DB-backed (bun test): the policy gateway's audit path writes rows, and the
 * run-service persistence tests need a seeded workspace.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/23
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { dhashFromRaw, perceptualHammingDistance } from '../../product-intelligence/assets/image-hash';
import { parseJsonLdImages, parseShopifyVariantImages, parseWooCommerceVariantImages, parseNetworkCaptures, discoverCandidates } from '../../product-intelligence/assets/discovery';
import { resolveRights, computeCommerceApproved } from '../../product-intelligence/assets/rights';
import { classifyAssetIdentity, findDuplicateAssets, parseNetContent, verifyImageCandidate } from '../../product-intelligence/assets/verification';
import { PolicyGateway } from '../../product-intelligence/policy/policy-gateway';
import { buildDefaultPiPolicy } from '../../product-intelligence/run-service';

const wsId = 'pi-assets-test-workspace';
const GTIN = '036000291452';
const PAGE = 'https://brand.example.com/p/1';

// ---------------------------------------------------------------------------
// Image fixtures (sharp-created, deterministic)
// ---------------------------------------------------------------------------

/** Horizontal ramp: every row strictly increases -> dHash all-ones at any size. */
function makeRampPng(width: number, height: number, vertical = false): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      if (vertical) {
        buf[idx] = 40;
        buf[idx + 1] = (y * 255) / height;
        buf[idx + 2] = 40;
      } else {
        buf[idx] = (x * 255) / width;
        buf[idx + 1] = 80;
        buf[idx + 2] = 160;
      }
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Solid color image (valid, decodable, no structure). */
function makeSolidPng(width = 640, height = 480): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 100, g: 140, b: 180 } } })
    .png()
    .toBuffer();
}

/** Alternating stripes (16px) — a non-monotonic pattern with real dHash bits. */
function makeStripePng(width: number, height: number, vertical: boolean): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      const stripe = Math.floor((vertical ? x : y) / 16) % 2 === 0;
      buf[idx] = stripe ? 230 : 30;
      buf[idx + 1] = 120;
      buf[idx + 2] = 120;
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('PI-6 image asset pipeline', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-assets-test.db');
  let solidPng: Buffer;

  beforeAll(async () => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Assets Test',
      workspacePath: '/tmp/pi-assets-workspace',
      gitPath: '/tmp/pi-assets-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    solidPng = await makeSolidPng();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  // -------------------------------------------------------------------------
  // Perceptual hashing
  // -------------------------------------------------------------------------

  describe('dhashFromRaw', () => {
    it('is deterministic for the same pixels', async () => {
      const png = await makeRampPng(64, 64);
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      const raw = { data, width: info.width, height: info.height, channels: info.channels ?? 4 };
      expect(dhashFromRaw(raw)).toBe(dhashFromRaw(raw));
    });

    it('keeps the same hash across resizes of the same artwork', async () => {
      const big = await makeRampPng(640, 480);
      const small = await makeRampPng(320, 240);
      const hashBig = dhashFromRaw(await decodeRaw(big));
      const hashSmall = dhashFromRaw(await decodeRaw(small));
      expect(hashBig).toBe(hashSmall);
      expect(hashBig).toMatch(/^[0-9a-f]{16}$/);
    });

    it('distinguishes different artwork', async () => {
      const verticalStripes = dhashFromRaw(await decodeRaw(await makeStripePng(640, 480, true)));
      const horizontalStripes = dhashFromRaw(await decodeRaw(await makeStripePng(640, 480, false)));
      expect(verticalStripes).not.toBe(horizontalStripes);
      expect(perceptualHammingDistance(verticalStripes, horizontalStripes)).toBeGreaterThan(10);
    });
  });

  // -------------------------------------------------------------------------
  // Discovery parsers
  // -------------------------------------------------------------------------

  describe('image discovery parsers', () => {
    it('preserves JSON-LD image candidates and variant mappings', () => {
      const html = `<script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Product","name":"Stella Broth",
         "image":["https://cdn.example.com/a.jpg","https://cdn.example.com/b.jpg"],
         "variants":[{"@type":"Product","sku":"SKU-16","gtin":"${GTIN}","image":"https://cdn.example.com/v16.jpg"}]}
      </script>`;
      const candidates = parseJsonLdImages(html, PAGE, '2026-08-05T00:00:00.000Z');
      expect(candidates.length).toBe(3);
      const urls = candidates.map((c) => c.url);
      expect(urls).toContain('https://cdn.example.com/a.jpg');
      expect(urls).toContain('https://cdn.example.com/v16.jpg');
      for (const candidate of candidates) {
        expect(candidate.extractionMethod).toBe('json_ld');
        expect(candidate.sourcePageUrl).toBe(PAGE);
        expect(candidate.retrievedAt).toBe('2026-08-05T00:00:00.000Z');
        expect(candidate.sourceArtifactId).toMatch(/^[0-9a-f]{24}$/);
      }
      const variant = candidates.find((c) => c.url === 'https://cdn.example.com/v16.jpg');
      expect(variant?.variantReference).toBe('SKU-16');
    });

    it('preserves Shopify variant-to-image mappings from embedded state', () => {
      const html = `<script>var Shopify = Shopify || {};
Shopify.ProductVariants = [{"id":123,"title":"16 oz","option1":"16 oz","sku":"SKU16","image_id":456},{"id":124,"title":"8 oz","option1":"8 oz","sku":"SKU8","image_id":457}];
Shopify.ProductImages = [{"id":456,"src":"//cdn.shopify.com/s/files/a.jpg"},{"id":457,"src":"//cdn.shopify.com/s/files/b.jpg"}];</script>`;
      const candidates = parseShopifyVariantImages(html, 'https://shop.example.com/products/stella-broth', '2026-08-05T00:00:00.000Z');
      expect(candidates.length).toBe(2);
      expect(candidates.map((c) => c.variantReference).sort()).toEqual(['123', '124']);
      expect(candidates.map((c) => c.variantName).sort()).toEqual(['16 oz', '8 oz']);
      expect(candidates[0].extractionMethod).toBe('platform_api');
      expect(candidates[0].sourcePath).toContain('ProductVariants');
      expect(candidates[0].url.startsWith('https://')).toBe(true); // protocol-relative resolved
    });

    it('preserves Shopify inline product JSON variant images', () => {
      const html = `<script type="application/json">{"product":{"title":"Stella Broth","variants":[{"id":9,"title":"16oz","image":{"src":"https://cdn.example.com/v9.jpg"}}]}}</script>`;
      const candidates = parseShopifyVariantImages(html, 'https://shop.example.com/products/x', '2026-08-05T00:00:00.000Z');
      expect(candidates.length).toBe(1);
      expect(candidates[0].variantReference).toBe('9');
      expect(candidates[0].url).toBe('https://cdn.example.com/v9.jpg');
    });

    it('preserves WooCommerce variation-to-image mappings', () => {
      const html = `<script type="text/javascript">var wc_single_product_params = {"product_variations": [
        {"variation_id":1001,"attributes":{"attribute_pa_size":"16oz","attribute_pa_flavor":"chicken"},"image":{"src":"https://cdn.example.com/w16.jpg"}},
        {"variation_id":1002,"attributes":{"attribute_pa_size":"8oz","attribute_pa_flavor":"chicken"},"image":{"src":"https://cdn.example.com/w8.jpg"}}
      ]};</script>`;
      const candidates = parseWooCommerceVariantImages(html, 'https://shop.example.com/product/stella/', '2026-08-05T00:00:00.000Z');
      expect(candidates.length).toBe(2);
      expect(candidates.map((c) => c.variantReference).sort()).toEqual(['1001', '1002']);
      expect(candidates.map((c) => c.variantName).sort()).toEqual(['16oz / chicken', '8oz / chicken']);
      expect(candidates[0].extractionMethod).toBe('platform_api');
    });

    it('normalizes network-capture responses with network_response method', () => {
      const captures = [
        {
          url: 'https://api.example.com/products/1',
          status: 200,
          responseContentType: 'application/json',
          jsonBody: {
            data: {
              product: {
                featuredImage: 'https://cdn.example.com/feat.jpg',
                images: [{ url: 'https://cdn.example.com/i1.jpg' }],
                variants: [{ id: 'v1', image: 'https://cdn.example.com/v1.jpg' }],
              },
            },
          },
        },
      ];
      const candidates = parseNetworkCaptures(captures, PAGE, '2026-08-05T00:00:00.000Z');
      const urls = candidates.map((c) => c.url);
      expect(urls).toContain('https://cdn.example.com/feat.jpg');
      expect(urls).toContain('https://cdn.example.com/i1.jpg');
      expect(urls).toContain('https://cdn.example.com/v1.jpg');
      for (const candidate of candidates) {
        expect(candidate.extractionMethod).toBe('network_response');
        expect(candidate.sourcePath).toContain('network:https://api.example.com');
      }
    });

    it('returns [] for malformed input and routes through discoverCandidates', () => {
      expect(parseJsonLdImages('not html', PAGE)).toEqual([]);
      expect(parseShopifyVariantImages('', PAGE)).toEqual([]);
      expect(parseWooCommerceVariantImages('no scripts here', PAGE)).toEqual([]);
      expect(parseNetworkCaptures([], PAGE)).toEqual([]);
      expect(discoverCandidates('network_capture', 'not json', PAGE)).toEqual([]);
      expect(discoverCandidates('json_ld', '<script type="application/ld+json">{"image":"https://cdn.example.com/x.jpg"}</script>', PAGE)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Rights resolution
  // -------------------------------------------------------------------------

  describe('resolveRights', () => {
    it('approves supplier assets with a referenced basis', () => {
      expect(resolveRights('supplier', 'supplier_authorized_asset', 'ev:supplier-1')).toMatchObject({ rightsStatus: 'approved' });
    });

    it('restricts a basis without an evidence reference', () => {
      expect(resolveRights('supplier', 'supplier_authorized_asset', null).rightsStatus).toBe('restricted');
    });

    it('never auto-approves retailer images', () => {
      expect(resolveRights('retailer', null, null).rightsStatus).toBe('restricted');
    });

    it('gives network-discovered URLs unknown rights', () => {
      expect(resolveRights('network_discovered', null, null).rightsStatus).toBe('unknown');
      expect(resolveRights(null, null, null).rightsStatus).toBe('unknown');
    });

    it('restricts generated imagery (not authoritative)', () => {
      expect(resolveRights('generated', null, null).rightsStatus).toBe('restricted');
    });

    it('approves manual photography and licensed datasets with a license ref', () => {
      expect(resolveRights('manual_photography', null, null).rightsStatus).toBe('approved');
      expect(resolveRights('licensed_dataset', null, 'ev:license-1').rightsStatus).toBe('approved');
    });

    it('computes commerce approval deterministically', () => {
      const base = {
        rightsStatus: 'approved' as const,
        exactProductMatch: true,
        exactVariantMatch: true,
        qualityStatus: 'usable' as const,
        conflicts: [],
      };
      expect(computeCommerceApproved(base)).toBe(true);
      expect(computeCommerceApproved({ ...base, rightsStatus: 'unknown' })).toBe(false);
      expect(computeCommerceApproved({ ...base, exactProductMatch: false })).toBe(false);
      expect(computeCommerceApproved({ ...base, exactVariantMatch: false })).toBe(false);
      expect(computeCommerceApproved({ ...base, qualityStatus: 'low_quality' })).toBe(false);
      expect(computeCommerceApproved({ ...base, conflicts: ['net_content_mismatch'] })).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Identity classification
  // -------------------------------------------------------------------------

  describe('classifyAssetIdentity', () => {
    const expected = {
      expectedGtin: GTIN,
      expectedBrand: 'Stella',
      expectedName: 'Stella Chicken Broth 16 oz',
      expectedVariant: '16 oz',
      expectedNetContent: { value: 16, unit: 'oz' },
      expectedPackCount: 1,
      expectedFlavor: 'Chicken',
      expectedFormula: 'Broth',
    };

    it('exact match with agreement on every field', () => {
      const result = classifyAssetIdentity(
        { brand: 'Stella', productName: 'Stella Chicken Broth 16 oz', variant: '16 oz', netContent: { value: 16, unit: 'oz' }, packCount: 1, gtin: GTIN },
        expected,
      );
      expect(result.exactProductMatch).toBe(true);
      expect(result.exactVariantMatch).toBe(true);
      expect(result.conflicts).toEqual([]);
    });

    it('flags a wrong net content (16oz expected, 8oz observed)', () => {
      const result = classifyAssetIdentity(
        { brand: 'Stella', productName: 'Stella Chicken Broth 8 oz', variant: '8 oz', netContent: { value: 8, unit: 'oz' }, packCount: 1, gtin: GTIN },
        expected,
      );
      expect(result.conflicts.some((c) => c.startsWith('net_content_mismatch'))).toBe(true);
      expect(result.exactProductMatch).toBe(false);
    });

    it('flags a wrong pack count', () => {
      const result = classifyAssetIdentity(
        { brand: 'Stella', productName: 'Stella Chicken Broth 16 oz', variant: '16 oz', netContent: { value: 16, unit: 'oz' }, packCount: 2, gtin: GTIN },
        expected,
      );
      expect(result.conflicts.some((c) => c.startsWith('pack_count_mismatch'))).toBe(true);
    });

    it('flags a wrong flavor on the visible packaging', () => {
      const result = classifyAssetIdentity(
        { brand: 'Stella', productName: 'Stella Beef Broth 16 oz', variant: '16 oz', netContent: { value: 16, unit: 'oz' }, packCount: 1, gtin: GTIN },
        expected,
      );
      expect(result.conflicts.some((c) => c.startsWith('flavor_mismatch'))).toBe(true);
    });

    it('flags a GTIN mismatch and rejects exact-product on conflicting GTIN', () => {
      const result = classifyAssetIdentity(
        { brand: 'Stella', productName: 'Stella Chicken Broth 16 oz', variant: '16 oz', netContent: { value: 16, unit: 'oz' }, packCount: 1, gtin: '0000000000000' },
        expected,
      );
      expect(result.conflicts.some((c) => c.startsWith('gtin_mismatch'))).toBe(true);
      expect(result.exactProductMatch).toBe(false);
    });

    it('flags a mismatched variant (exactVariantMatch false + variant_mismatch conflict)', () => {
      const result = classifyAssetIdentity(
        { brand: 'Stella', productName: 'Stella Chicken Broth 16 oz', variant: '8 oz', netContent: { value: 8, unit: 'oz' }, packCount: 1, gtin: GTIN },
        expected,
      );
      expect(result.conflicts.some((c) => c.startsWith('variant_mismatch'))).toBe(true);
      expect(result.exactVariantMatch).toBe(false);
      expect(result.exactProductMatch).toBe(false);
    });

    it('keeps exactVariantMatch null when the variant is unknown', () => {
      const result = classifyAssetIdentity(
        { brand: 'Stella', productName: 'Stella Chicken Broth 16 oz', variant: null, netContent: { value: 16, unit: 'oz' }, packCount: 1, gtin: GTIN },
        expected,
      );
      expect(result.exactProductMatch).toBe(true);
      expect(result.exactVariantMatch).toBeNull();
      expect(result.conflicts).toEqual([]);
    });

    it('matches on strong name + net-content agreement when GTIN is absent', () => {
      const result = classifyAssetIdentity(
        { brand: 'Stella', productName: 'Stella & Chewys Chicken Broth 16 oz', variant: null, netContent: { value: 16, unit: 'oz' }, packCount: 1, gtin: null },
        expected,
      );
      expect(result.exactProductMatch).toBe(true);
    });
  });

  describe('parseNetContent', () => {
    it('parses common forms', () => {
      expect(parseNetContent('12 oz')).toEqual({ value: 12, unit: 'oz' });
      expect(parseNetContent('12oz')).toEqual({ value: 12, unit: 'oz' });
      expect(parseNetContent('1.5 lb')).toEqual({ value: 1.5, unit: 'lb' });
      expect(parseNetContent('nonsense')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end verification pipeline
  // -------------------------------------------------------------------------

  describe('verifyImageCandidate', () => {
    function gatewayReturning(buffer: Buffer): PolicyGateway {
      return new PolicyGateway({
        resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
        fetchFn: async () => new Response(new Uint8Array(buffer), { status: 200, headers: { 'content-type': 'image/png' } }),
      });
    }

    const deps = (gateway: PolicyGateway) => ({
      runId: 'run-assets-1',
      policy: buildDefaultPiPolicy(),
      gateway,
    });

    it('approves a verified supplier asset with evidence-resolved facts and a reuse grant', async () => {
      const record = await verifyImageCandidate(
        {
          url: 'https://cdn.example.com/i.png',
          sourcePageUrl: PAGE,
          sourcePath: 'json_ld.image',
          // Round-4: comparison target is the server-derived run identity.
          runIdentity: { runId: 'run-assets-1', gtin: GTIN, name: 'Stella Chicken Broth 16 oz', netContent: { value: 16, unit: 'oz' }, packCount: 1 },
          expectedGtin: GTIN,
          expectedName: 'Stella Chicken Broth 16 oz',
          expectedNetContent: { value: 16, unit: 'oz' },
          expectedPackCount: 1,
          declaredSourceType: 'supplier',
          evidenceIds: ['ev-gtin-1', 'ev-name-1', 'ev-net-1'],
        },
        {
          ...deps(gatewayReturning(solidPng)),
          // Server-resolved durable evidence rows (the only authority).
          evidenceResolver: (ids) =>
            ids.map((id) => {
              if (id === 'ev-gtin-1') return { id, targetField: 'gtin', value: GTIN, extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: null };
              if (id === 'ev-name-1') return { id, targetField: 'product_name', value: 'Stella Chicken Broth 16 oz', extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: null };
              return { id, targetField: 'net_content', value: { value: 16, unit: 'oz' }, extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: null };
            }),
          reuseGrantResolver: (tier) =>
            tier === 'supplier'
              ? { allowed: true as const, grantId: 'grant-supplier-1', sourceTier: 'supplier', domainPattern: '*', terms: null }
              : null,
          // Round-4: source kind derives from the durable source row.
          sourceTypeResolver: (url) => (url === 'https://cdn.example.com/i.png' ? 'supplier' : null),
        },
      );
      expect(record.qualityStatus).toBe('usable');
      expect(record.rightsStatus).toBe('approved');
      expect(record.exactProductMatch).toBe(true);
      expect(record.exactVariantMatch).toBeNull();
      expect(record.commerceApproved).toBe(true);
      expect(record.originalContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.perceptualHash).toMatch(/^[0-9a-f]{16}$/);
      expect(record.conflicts).toEqual([]);
      expect(record.observationProvenance).toBe('evidence');
      expect(record.agentAsserted).toBeNull();
    });

    it('ignores agent-asserted observations without durable evidence (never authoritative)', async () => {
      const record = await verifyImageCandidate(
        {
          url: 'https://cdn.example.com/asserted.png',
          sourcePageUrl: PAGE,
          expectedGtin: GTIN,
          expectedName: 'Stella Chicken Broth 16 oz',
          declaredSourceType: 'supplier',
          // Agent-asserted: the model claims the observed packaging facts.
          observed: { productName: 'Stella Chicken Broth 16 oz', gtin: GTIN },
        },
        {
          ...deps(gatewayReturning(solidPng)),
          evidenceResolver: () => [], // no durable evidence rows resolve
          reuseGrantResolver: () => null,
        },
      );
      expect(record.exactProductMatch).toBe(false);
      expect(record.commerceApproved).toBe(false);
      expect(record.rightsStatus).toBe('restricted');
      expect(record.observationProvenance).toBe('agent_asserted');
      // The assertion is recorded for review but never used for matching.
      expect(record.agentAsserted?.gtin).toBe(GTIN);
    });

    it('denies approval for a manufacturer-hosted image without a reuse grant even when identity resolves', async () => {
      const record = await verifyImageCandidate(
        {
          url: 'https://cdn.example.com/mfr.png',
          sourcePageUrl: PAGE,
          runIdentity: { runId: 'run-assets-1', gtin: GTIN },
          expectedGtin: GTIN,
          declaredSourceType: 'manufacturer',
          evidenceIds: ['ev-gtin-1'],
        },
        {
          ...deps(gatewayReturning(solidPng)),
          evidenceResolver: (ids) =>
            ids.map((id) => ({ id, targetField: 'gtin', value: GTIN, extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: null })),
          // Round-4: durable source kind (origin proves nothing by itself).
          sourceTypeResolver: (url) => (url === 'https://cdn.example.com/mfr.png' ? 'manufacturer' : null),
          // No reuse grant at all (default): origin proves nothing.
        },
      );
      expect(record.exactProductMatch).toBe(true); // identity resolves from evidence
      expect(record.rightsStatus).toBe('restricted'); // but reuse is not authorized
      expect(record.commerceApproved).toBe(false);
    });

    it('binds OCR-method evidence to the image content hash', async () => {
      const pngHash = createHash('sha256').update(solidPng).digest('hex');
      const record = await verifyImageCandidate(
        {
          url: 'https://cdn.example.com/ocr.png',
          sourcePageUrl: PAGE,
          extractionMethod: 'image_ocr',
          expectedGtin: GTIN,
          evidenceIds: ['ev-gtin-ocr'],
        },
        {
          ...deps(gatewayReturning(solidPng)),
          evidenceResolver: (ids) =>
            ids.map((id) => ({ id, targetField: 'gtin', value: GTIN, extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: pngHash })),
          reuseGrantResolver: () => ({ allowed: true as const, grantId: 'grant-hash-1', sourceTier: 'supplier', domainPattern: '*', terms: null }),
        },
      );
      expect(record.qualityStatus).toBe('usable');
      expect(record.extractionMethod).toBe('image_ocr');
      expect(record.originalContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.observationProvenance).toBe('evidence');
    });

    it('drops OCR evidence whose content hash does not match the bytes being inspected (round-3 adversarial)', async () => {
      // Evidence recorded against image A (hash X) must never authorize
      // identity for image B (the current bytes hash differently).
      const wrongHash = '0'.repeat(64);
      const record = await verifyImageCandidate(
        {
          url: 'https://cdn.example.com/ocr.png',
          sourcePageUrl: PAGE,
          extractionMethod: 'image_ocr',
          expectedGtin: GTIN,
          evidenceIds: ['ev-gtin-ocr'],
        },
        {
          ...deps(gatewayReturning(solidPng)),
          evidenceResolver: (ids) =>
            ids.map((id) => ({ id, targetField: 'gtin', value: GTIN, extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: wrongHash })),
          reuseGrantResolver: () => ({ allowed: true as const, grantId: 'grant-hash-1', sourceTier: 'supplier', domainPattern: '*', terms: null }),
        },
      );
      // The mismatching-hash OCR fact is dropped: provenance falls back to
      // the decoder and no exact match can be claimed from image A's facts.
      expect(record.observationProvenance).toBe('decoder');
      expect(record.exactProductMatch).toBe(false);
      expect(record.commerceApproved).toBe(false);
    });

    it('blocks commerce approval on a net-content conflict even with a reuse grant', async () => {
      const record = await verifyImageCandidate(
        {
          url: 'https://cdn.example.com/wrong.png',
          sourcePageUrl: PAGE,
          runIdentity: { runId: 'run-assets-1', gtin: GTIN, name: 'Stella Chicken Broth 16 oz', netContent: { value: 16, unit: 'oz' } },
          expectedGtin: GTIN,
          expectedName: 'Stella Chicken Broth 16 oz',
          expectedNetContent: { value: 16, unit: 'oz' },
          declaredSourceType: 'supplier',
          evidenceIds: ['ev-gtin-1', 'ev-name-wrong', 'ev-net-wrong'],
        },
        {
          ...deps(gatewayReturning(solidPng)),
          evidenceResolver: (ids) =>
            ids.map((id) => {
              if (id === 'ev-gtin-1') return { id, targetField: 'gtin', value: GTIN, extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: null };
              if (id === 'ev-name-wrong') return { id, targetField: 'product_name', value: 'Stella Chicken Broth 8 oz', extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: null };
              return { id, targetField: 'net_content', value: { value: 8, unit: 'oz' }, extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: null };
            }),
          reuseGrantResolver: () => ({ allowed: true as const, grantId: 'grant-wrong-1', sourceTier: 'supplier', domainPattern: '*', terms: null }),
        },
      );
      expect(record.exactProductMatch).toBe(false);
      expect(record.conflicts.some((c) => c.startsWith('net_content_mismatch'))).toBe(true);
      expect(record.commerceApproved).toBe(false);
    });

    it('gives network-discovered URLs restricted rights without a grant and no approval', async () => {
      const record = await verifyImageCandidate(
        {
          url: 'https://cdn.example.com/unknown.png',
          sourcePageUrl: PAGE,
          expectedGtin: GTIN,
          declaredSourceType: 'network_discovered',
          evidenceIds: ['ev-gtin-1'],
        },
        {
          ...deps(gatewayReturning(solidPng)),
          evidenceResolver: (ids) =>
            ids.map((id) => ({ id, targetField: 'gtin', value: GTIN, extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: null })),
          reuseGrantResolver: () => null,
        },
      );
      expect(record.rightsStatus).toBe('restricted');
      expect(record.commerceApproved).toBe(false);
    });

    it('rejects corrupt content with qualityStatus invalid', async () => {
      const record = await verifyImageCandidate(
        { url: 'https://cdn.example.com/corrupt.png', declaredSourceType: 'supplier' },
        deps(gatewayReturning(Buffer.from('this is definitely not an image'))),
      );
      expect(record.qualityStatus).toBe('invalid');
      expect(record.commerceApproved).toBe(false);
      expect(record.conflicts.some((c) => c.startsWith('invalid_image'))).toBe(true);
    });

    it('marks tiny images low_quality', async () => {
      const tiny = await makeSolidPng(120, 90);
      const record = await verifyImageCandidate(
        { url: 'https://cdn.example.com/tiny.png', declaredSourceType: 'supplier', evidenceIds: ['ev-gtin-1'], expectedGtin: GTIN },
        {
          ...deps(gatewayReturning(tiny)),
          evidenceResolver: (ids) =>
            ids.map((id) => ({ id, targetField: 'gtin', value: GTIN, extractionMethod: 'image_ocr', snippet: null, sourceUrl: PAGE, sourceDomain: 'brand.example.com', contentHash: null })),
          reuseGrantResolver: () => ({ allowed: true as const, grantId: 'grant-tiny-1', sourceTier: 'supplier', domainPattern: '*', terms: null }),
        },
      );
      expect(record.qualityStatus).toBe('low_quality');
      expect(record.commerceApproved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate detection
  // -------------------------------------------------------------------------

  describe('findDuplicateAssets', () => {
    it('detects exact duplicates by content hash', async () => {
      const png = await makeRampPng(320, 240);
      const hash = (await sharp(png).raw().toBuffer({ resolveWithObject: true })).data.toString('hex');
      const ref = { id: 'a1', originalContentHash: `h${hash.slice(0, 16)}`, perceptualHash: 'abc' };
      const same = { id: 'a2', originalContentHash: ref.originalContentHash, perceptualHash: 'abc' };
      expect(findDuplicateAssets([ref], same)).toMatchObject({ duplicate: true, referenceId: 'a1', kind: 'exact' });
    });

    it('detects perceptual duplicates across resizes', async () => {
      const big = await makeRampPng(640, 480);
      const small = await makeRampPng(320, 240);
      const dHashBig = dhashFromRaw(await decodeRaw(big));
      const dHashSmall = dhashFromRaw(await decodeRaw(small));
      expect(dHashBig).toBe(dHashSmall);
      const ref = { id: 'b1', originalContentHash: 'hash-big', perceptualHash: dHashBig };
      const resized = { id: 'b2', originalContentHash: 'hash-small', perceptualHash: dHashSmall };
      expect(findDuplicateAssets([ref], resized)).toMatchObject({ duplicate: true, referenceId: 'b1', kind: 'perceptual' });
    });

    it('does not flag distinct artwork as duplicates', async () => {
      const verticalStripes = dhashFromRaw(await decodeRaw(await makeStripePng(640, 480, true)));
      const horizontalStripes = dhashFromRaw(await decodeRaw(await makeStripePng(640, 480, false)));
      const ref = { id: 'c1', originalContentHash: 'h1', perceptualHash: verticalStripes };
      const other = { id: 'c2', originalContentHash: 'h2', perceptualHash: horizontalStripes };
      expect(findDuplicateAssets([ref], other).duplicate).toBe(false);
    });
  });
});

async function decodeRaw(png: Buffer): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels ?? 4 };
}
