/**
 * PI-6 image tool tests: registry presence, discovery through the registry
 * (Shopify fixture), and verify_image_candidate end-to-end with a stubbed
 * gateway fetch (tiny PNG fixture) — no network.
 *
 * DB-backed (bun test): the registry requires a real running run row.
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
import { upsertReusePolicy } from '../../db/repositories/pi-reuse-policy-repo';
import { createPiRun, insertPiEvidence, insertPiSource, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
import { defaultToolRegistry } from '../../product-intelligence/tools';
import { PolicyGateway } from '../../product-intelligence/policy/policy-gateway';
import { testPolicy } from './product-intelligence/test-helpers';

const wsId = 'pi-image-tools-test-workspace';

describe('PI-6 image tools', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-image-tools-test.db');

  beforeAll(async () => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Image Tools Test',
      workspacePath: '/tmp/pi-image-tools-workspace',
      gitPath: '/tmp/pi-image-tools-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  function runningRun() {
    return createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: '{}',
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    });
  }

  const toolCtx = (runId: string, overrides: Partial<{ gateway: PolicyGateway }> = {}) => ({
    runId,
    workspaceId: wsId,
    workspacePath: '/tmp/pi-image-tools-workspace',
    policy: testPolicy({ networkPolicy: 'allowlisted_remote', allowedSourceDomains: [] }),
    gateway: overrides.gateway,
    signal: new AbortController().signal,
    remainingMs: 60_000,
  });

  it('exposes verify_image_candidate and discover_image_candidates with stable versions', () => {
    const names = defaultToolRegistry.names();
    expect(names).toContain('verify_image_candidate');
    expect(names).toContain('discover_image_candidates');
    expect(defaultToolRegistry.get('verify_image_candidate')?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(defaultToolRegistry.get('discover_image_candidates')?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('discovers Shopify variant-image candidates through the registry', async () => {
    const run = runningRun();
    const html = `<script>var Shopify = Shopify || {};
Shopify.ProductVariants = [{"id":123,"title":"16 oz","option1":"16 oz","image_id":456}];
Shopify.ProductImages = [{"id":456,"src":"//cdn.shopify.com/s/files/a.jpg"}];</script>`;
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { pageUrl: 'https://shop.example.com/products/stella', content: html, sourceType: 'shopify' },
      toolCtx(run.id),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const data = result.data as { candidates: Array<{ url: string; variantReference: string | null; extractionMethod: string; sourcePath: string }> };
      expect(data.candidates).toHaveLength(1);
      expect(data.candidates[0]).toMatchObject({
        variantReference: '123',
        extractionMethod: 'platform_api',
      });
      expect(data.candidates[0].url.startsWith('https://')).toBe(true);
      expect(result.evidence[0].kind).toBe('image_evidence');
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('verifies a supplier image candidate from durable evidence — identity resolves, rights stay restricted without a grant', async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun();
    // Seed durable evidence rows (server-authoritative facts) for the run.
    const source = insertPiSource({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      metadata: { contentHash: createHash('sha256').update(png).digest('hex') },
    });
    insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'product_name',
      value: 'Stella Chicken Broth 16 oz',
      extractionMethod: 'image_ocr',
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: 'https://cdn.example.com/i.png',
        gtin: '036000291452',
        expectedName: 'Stella Chicken Broth 16 oz',
        netContentValue: 16,
        netContentUnit: 'oz',
        declaredSourceType: 'supplier',
        evidenceIds: ['ignored-non-matching-id'],
      },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const record = result.data as {
        commerceApproved: boolean;
        rightsStatus: string;
        qualityStatus: string;
        exactProductMatch: boolean;
        perceptualHash: string | null;
        observationProvenance: string;
        observedGtin: string | null;
      };
      // A non-matching evidence id resolves nothing -> no authoritative facts.
      expect(record.observedGtin).toBeNull();
      expect(record.observationProvenance).toBe('agent_asserted');
      expect(record.exactProductMatch).toBe(false);
      expect(record.rightsStatus).toBe('restricted'); // no reuse grant wired yet
      expect(record.qualityStatus).toBe('usable');
      expect(record.commerceApproved).toBe(false);
      expect(record.perceptualHash).toMatch(/^[0-9a-f]{16}$/);
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('verifies from matching durable evidence ids and fails closed without a grant', async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun();
    const source = insertPiSource({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    const gtinRow = insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      metadata: { contentHash: createHash('sha256').update(png).digest('hex') },
    });
    insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'net_content',
      value: { value: 16, unit: 'oz' },
      extractionMethod: 'image_ocr',
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: 'https://cdn.example.com/i.png',
        gtin: '036000291452',
        expectedName: 'Stella Chicken Broth 16 oz',
        netContentValue: 16,
        netContentUnit: 'oz',
        declaredSourceType: 'supplier',
        evidenceIds: [gtinRow.id],
      },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const record = result.data as {
        commerceApproved: boolean;
        rightsStatus: string;
        qualityStatus: string;
        exactProductMatch: boolean;
        observationProvenance: string;
      };
      expect(record.observationProvenance).toBe('evidence');
      expect(record.exactProductMatch).toBe(true);
      expect(record.qualityStatus).toBe('usable');
      // Deterministic rights: no durable reuse grant -> restricted, never approved.
      expect(record.rightsStatus).toBe('restricted');
      expect(record.commerceApproved).toBe(false);
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('resolves the agent-facing toolEvidenceId namespace (dual-namespace evidence resolution)', async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun();
    const source = insertPiSource({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    // The row UUID differs from the agent-visible deterministic id stored in
    // metadata.toolEvidenceId — exactly what a real Pi session receives.
    insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      metadata: { toolEvidenceId: 'extract_product_page:abc123:gtin:def456', contentHash: createHash('sha256').update(png).digest('hex') },
    });
    insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'product_name',
      value: 'Stella Chicken Broth 16 oz',
      extractionMethod: 'image_ocr',
      metadata: { toolEvidenceId: 'extract_product_page:abc123:name:abc789' },
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: 'https://cdn.example.com/i.png',
        gtin: '036000291452',
        expectedName: 'Stella Chicken Broth 16 oz',
        netContentValue: 16,
        netContentUnit: 'oz',
        declaredSourceType: 'supplier',
        // Agent-visible toolEvidenceIds — NOT the DB row UUIDs.
        evidenceIds: ['extract_product_page:abc123:gtin:def456', 'extract_product_page:abc123:name:abc789'],
      },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const record = result.data as {
        commerceApproved: boolean;
        rightsStatus: string;
        qualityStatus: string;
        exactProductMatch: boolean;
        observationProvenance: string;
        observedGtin: string | null;
      };
      // Both namespaces resolve to the same durable rows; the toolEvidenceId
      // path is canonical for the agent-facing flow.
      expect(record.observationProvenance).toBe('evidence');
      expect(record.observedGtin).toBe('036000291452');
      expect(record.exactProductMatch).toBe(true);
      expect(record.qualityStatus).toBe('usable');
      expect(record.rightsStatus).toBe('restricted'); // no reuse grant seeded
      expect(record.commerceApproved).toBe(false);
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('derives rights from the durable grant record and ignores caller-asserted rights strings', async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun();
    const source = insertPiSource({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      metadata: { toolEvidenceId: 'extract_product_page:abc123:gtin:def456' },
    });
    const grant = upsertReusePolicy({
      workspaceId: wsId,
      sourceTier: 'manufacturer',
      domainPattern: 'cdn.example.com',
      allowed: true,
      terms: 'vendor license',
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: 'https://cdn.example.com/i.png',
        gtin: '036000291452',
        declaredSourceType: 'manufacturer',
        evidenceIds: ['extract_product_page:abc123:gtin:def456'],
        // Caller-asserted rights strings must NOT become the durable basis.
        rightsBasis: 'supplier_authorized_asset',
        rightsEvidenceRef: 'caller-invented-ref',
      },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const record = result.data as {
        commerceApproved: boolean;
        rightsStatus: string;
        rightsBasis: string | null;
        rightsEvidenceRef: string | null;
        exactProductMatch: boolean;
        observationProvenance: string;
      };
      expect(record.rightsStatus).toBe('approved');
      // Derived from the grant record, not the caller's strings.
      expect(record.rightsBasis).toBe('grant:manufacturer@cdn.example.com');
      expect(record.rightsEvidenceRef).toBe(grant.id);
      expect(record.observationProvenance).toBe('evidence');
      expect(record.exactProductMatch).toBe(true);
      expect(record.commerceApproved).toBe(true);
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('ignores caller-asserted rights strings when no grant exists (stays restricted)', async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun();
    // The shared DB may carry a manufacturer@cdn.example.com grant from an
    // earlier test — use a tier/domain no grant covers so this stays
    // deterministic regardless of execution order.
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: 'https://other.example.com/i.png',
        declaredSourceType: 'retailer',
        rightsBasis: 'supplier_authorized_asset',
        rightsEvidenceRef: 'caller-invented-ref',
      },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const record = result.data as { rightsStatus: string; rightsBasis: string | null; rightsEvidenceRef: string | null };
      expect(record.rightsStatus).toBe('restricted');
      expect(record.rightsBasis).toBeNull();
      expect(record.rightsEvidenceRef).toBeNull();
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('returns no_result for corrupt or non-image content', async () => {
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(Buffer.from('definitely not an image')), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun();
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      { url: 'https://cdn.example.com/corrupt.png', declaredSourceType: 'supplier' },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('no_result');
    expect((result as { reason: string }).reason).toContain('image');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('denies network access to non-allowlisted destinations through the gateway', async () => {
    const run = runningRun();
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      { url: 'https://blocked.example.com/i.png' },
      toolCtx(run.id),
    );
    // The default test policy is local_only; the pre-flight must deny before fetch.
    expect(result.status).toBe('policy_denied');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('rejects malformed parameters via the registry schema gate', async () => {
    const run = runningRun();
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { pageUrl: 'not-a-url', content: 'x'.repeat(300_000), sourceType: 'shopify' },
      toolCtx(run.id),
    );
    expect(result.status).toBe('error');
    expect((result as { message: string }).message).toContain('schema');
    transitionPiRunStatus(run.id, 'completed', {});
  });
});
