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
import { createPiRun, insertPiEvidence, insertPiImageCandidate, insertPiSource, listPiImageCandidatesByRun, listPiSources, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
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

  function runningRun(inputJson = '{}') {
    return createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson,
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    });
  }
  /** Round-7: server-created candidate provenance — the record verify_image_candidate must cite. */
  function candidateOf(runId: string, imageUrl: string, discoveringSourceId: string | null): string {
    return insertPiImageCandidate({ runId, imageUrl, discoveringSourceId }).id;
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
      const data = result.data as { candidates: Array<{ url: string; variantReference: string | null; extractionMethod: string; sourcePath: string; candidateId?: string }> };
      expect(data.candidates).toHaveLength(1);
      expect(data.candidates[0]).toMatchObject({
        variantReference: '123',
        extractionMethod: 'platform_api',
      });
      expect(data.candidates[0].url.startsWith('https://')).toBe(true);
      expect(result.evidence[0].kind).toBe('image_evidence');
      // Round-7: discovery SERVER-CREATED a durable candidate record bound to
      // the discovering page source (its candidateId is what verification cites).
      expect(data.candidates[0].candidateId).toBeTruthy();
      const rows = listPiImageCandidatesByRun(run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].imageUrl).toBe(data.candidates[0].url);
      expect(rows[0].discoveringSourceId).toBeTruthy();
      const pageSource = listPiSources(run.id).find((src) => src.url === 'https://shop.example.com/products/stella');
      expect(pageSource?.sourceType).toBe('other'); // fail-closed neutral tier until typed
      expect(rows[0].discoveringSourceId).toBe(pageSource?.id);
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
        candidateId: candidateOf(run.id, 'https://cdn.example.com/i.png', source.id),
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
    const run = runningRun(JSON.stringify({ gtin: '036000291452', registerName: 'Stella Chicken Broth 16 oz' }));
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
        candidateId: candidateOf(run.id, 'https://cdn.example.com/i.png', source.id),
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

  it('binds OCR facts to the exact image bytes: image A\'s evidence authorizes A and is dropped for image B (round-4)', async () => {
    const pngA = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const pngB = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png()
      .toBuffer();
    const hashA = createHash('sha256').update(pngA).digest('hex');
    const run = runningRun();
    const source = insertPiSource({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    // OCR fact recorded against image A\'s bytes.
    const gtinRow = insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      metadata: { contentHash: hashA },
    });
    const verifyWith = (bytes: Buffer) => {
      const gateway = new PolicyGateway({
        resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
        fetchFn: async () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' } }),
      });
      return defaultToolRegistry.dispatch(
        defaultToolRegistry.get('verify_image_candidate')!,
        { url: 'https://cdn.example.com/i.png', candidateId: candidateOf(run.id, 'https://cdn.example.com/i.png', source.id), gtin: '036000291452', declaredSourceType: 'supplier', evidenceIds: [gtinRow.id] },
        toolCtx(run.id, { gateway }),
      );
    };
    // Image A (hash matches the fact): the OCR gtin drives identity.
    const resultA = await verifyWith(pngA);
    expect(resultA.status).toBe('ok');
    if (resultA.status === 'ok') {
      const a = resultA.data as { observationProvenance: string; observedGtin: string | null };
      expect(a.observationProvenance).toBe('evidence');
      expect(a.observedGtin).toBe('036000291452');
    }
    // Image B (hash mismatch): image A\'s OCR fact can never authorize B.
    const resultB = await verifyWith(pngB);
    expect(resultB.status).toBe('ok');
    if (resultB.status === 'ok') {
      const b = resultB.data as { observationProvenance: string; observedGtin: string | null };
      expect(b.observedGtin).toBeNull();
      expect(b.observationProvenance).not.toBe('evidence');
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
    const run = runningRun(JSON.stringify({ gtin: '036000291452', registerName: 'Stella Chicken Broth 16 oz' }));
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
        candidateId: candidateOf(run.id, 'https://cdn.example.com/i.png', source.id),
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
    const run = runningRun(JSON.stringify({ gtin: '036000291452', registerName: 'Stella Chicken Broth 16 oz' }));
    const source = insertPiSource({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    // Round-4: the durable source row FOR THE IMAGE URL is what drives the
    // source kind (and therefore which reuse grant is consulted) — never the
    // agent's declaredSourceType string.
    insertPiSource({
      runId: run.id,
      url: 'https://cdn.example.com/i.png',
      domain: 'cdn.example.com',
      sourceType: 'manufacturer',
    });
    insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      // Round-6: byte-bound — the evidence carries the SHA-256 of the exact
      // bytes the verifier is inspecting (the fetched image), so it can
      // establish THIS image's identity. A null-hash generic fact could not.
      metadata: { toolEvidenceId: 'extract_product_page:abc123:gtin:def456', contentHash: createHash('sha256').update(png).digest('hex') },
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
        // Round-7: provenance authority = the server-created candidate record
        // (whose discovering source is the manufacturer page). The image-URL
        // source row below is still the fastest tier hit, but the candidate
        // binding is what survives without it.
        candidateId: candidateOf(run.id, 'https://cdn.example.com/i.png', source.id),
        gtin: '036000291452',
        // Round-4: this agent string is IGNORED — the durable source row for
        // the image URL (sourceType 'manufacturer') selects the grant. If the
        // string were authoritative ('supplier' != the 'manufacturer' grant),
        // rights would be restricted.
        declaredSourceType: 'supplier',
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

  it('resolves source kind through the server-created candidate record — manufacturer image approval works without a CDN source row (round-7)', async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) =>
        hostname.endsWith('example.com') || hostname.endsWith('shopify.com') ? ['93.184.216.34'] : [],
      fetchFn: async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun(JSON.stringify({ gtin: '036000291452', registerName: 'Stella Chicken Broth 16 oz' }));
    // The manufacturer product page that DISCOVERS the image — the tier comes
    // from the SERVER-CREATED candidate record's discovering source, never
    // from an agent-supplied sourcePageUrl.
    const pageSource = insertPiSource({
      runId: run.id,
      url: 'https://brand.example.com/p/stella-broth-16oz',
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    const gtinRow = insertPiEvidence({
      runId: run.id,
      sourceId: pageSource.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      metadata: { contentHash: createHash('sha256').update(png).digest('hex') },
    });
    insertPiEvidence({
      runId: run.id,
      sourceId: pageSource.id,
      targetField: 'product_name',
      value: 'Stella Chicken Broth 16 oz',
      extractionMethod: 'image_ocr',
    });
    upsertReusePolicy({
      workspaceId: wsId,
      sourceTier: 'manufacturer',
      domainPattern: 'cdn.shopify.com',
      allowed: true,
      terms: 'vendor license',
    });
    // Discover through the real tool: the server creates the candidate record
    // and binds it to the page source (by page URL).
    const html = `<script>var Shopify = Shopify || {};
Shopify.ProductVariants = [{"id":123,"title":"16 oz","option1":"16 oz","image_id":456}];
Shopify.ProductImages = [{"id":456,"src":"//cdn.shopify.com/s/files/a.jpg"}];</script>`;
    const discovered = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { pageUrl: 'https://brand.example.com/p/stella-broth-16oz', content: html, sourceType: 'shopify' },
      toolCtx(run.id),
    );
    expect(discovered.status).toBe('ok');
    const candidateId = ((discovered as { data?: unknown }).data as { candidates: Array<{ candidateId: string; url: string }> }).candidates[0].candidateId;
    expect(candidateId).toBeTruthy();
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: 'https://cdn.shopify.com/s/files/a.jpg',
        candidateId,
        gtin: '036000291452',
        evidenceIds: [gtinRow.id],
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
      // Tier resolved through the candidate record's discovering source (the
      // manufacturer page) — no CDN source row needed.
      expect(record.rightsStatus).toBe('approved');
      expect(record.rightsBasis).toBe('grant:manufacturer@cdn.shopify.com');
      expect(record.observationProvenance).toBe('evidence');
      expect(record.exactProductMatch).toBe(true);
      expect(record.commerceApproved).toBe(true);
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('stays restricted when the server-created candidate binds a retailer discovering source (round-7)', async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun(JSON.stringify({ gtin: '036000291452', registerName: 'Stella Chicken Broth 16 oz' }));
    // The image was discovered on a RETAILER page — the candidate record binds
    // that retailer source. An agent-supplied sourcePageUrl pointing at a
    // manufacturer page must NOT change the tier (the old round-5 attack).
    const pageSource = insertPiSource({
      runId: run.id,
      url: 'https://retailer.example.com/p/stella-broth-16oz',
      domain: 'retailer.example.com',
      sourceType: 'retailer',
    });
    const gtinRow = insertPiEvidence({
      runId: run.id,
      sourceId: pageSource.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      metadata: { contentHash: createHash('sha256').update(png).digest('hex') },
    });
    // Grants exist for OTHER tiers on the CDN domain — the resolved 'retailer'
    // tier must not be granted (fail closed). The shared test DB holds a
    // manufacturer grant from earlier tests; the tier must not match it.
    upsertReusePolicy({
      workspaceId: wsId,
      sourceTier: 'supplier',
      domainPattern: 'cdn.example.com',
      allowed: true,
      terms: 'supplier license',
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: 'https://cdn.example.com/i.png',
        candidateId: candidateOf(run.id, 'https://cdn.example.com/i.png', pageSource.id),
        // Attack attempt: the agent claims a manufacturer discovering page.
        // Round-7: ignored — the candidate record's retailer source decides.
        sourcePageUrl: 'https://brand.example.com/p/stella-broth-16oz',
        gtin: '036000291452',
        evidenceIds: [gtinRow.id],
      },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const record = result.data as { commerceApproved: boolean; rightsStatus: string };
      expect(record.rightsStatus).toBe('restricted');
      expect(record.commerceApproved).toBe(false);
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
    const pageSource = insertPiSource({
      runId: run.id,
      url: 'https://retailer.example.com/p/1',
      domain: 'retailer.example.com',
      sourceType: 'retailer',
    });
    // The shared DB may carry a manufacturer@cdn.example.com grant from an
    // earlier test — use a tier/domain no grant covers so this stays
    // deterministic regardless of execution order.
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: 'https://other.example.com/i.png',
        candidateId: candidateOf(run.id, 'https://other.example.com/i.png', pageSource.id),
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
    const pageSource = insertPiSource({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      { url: 'https://cdn.example.com/corrupt.png', candidateId: candidateOf(run.id, 'https://cdn.example.com/corrupt.png', pageSource.id), declaredSourceType: 'supplier' },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('no_result');
    expect((result as { reason: string }).reason).toContain('image');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('denies network access to non-allowlisted destinations through the gateway', async () => {
    const run = runningRun();
    const pageSource = insertPiSource({
      runId: run.id,
      url: 'https://blocked.example.com/p/1',
      domain: 'blocked.example.com',
      sourceType: 'other',
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      { url: 'https://blocked.example.com/i.png', candidateId: candidateOf(run.id, 'https://blocked.example.com/i.png', pageSource.id) },
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
