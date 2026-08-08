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
import { createPiRun, insertPiAsset, insertPiEvidence, insertPiImageCandidate, insertPiPageArtifact, insertPiSource, listPiAssetsByRun, listPiImageCandidatesByRun, listPiPageArtifactsByRun, listPiSources, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { defaultToolRegistry } from '../../product-intelligence/tools';
import { discoverCandidates } from '../../product-intelligence/assets/discovery';
import { verifyImageCandidateTool, discoverImageCandidatesTool } from '../../product-intelligence/tools/image-tools';
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

  it('discovers Shopify variant-image candidates from a retained artifact (artifact-driven)', async () => {
    const run = runningRun();
    const html = `<script>var Shopify = Shopify || {};
Shopify.ProductVariants = [{"id":123,"title":"16 oz","option1":"16 oz","image_id":456}];
Shopify.ProductImages = [{"id":456,"src":"//cdn.shopify.com/s/files/a.jpg"}];</script>`;
    // Round-9 (P1-1): the agent NEVER supplies artifact bytes — the server
    // retains the fetched page artifact (bytes + hash), and discovery loads it
    // by id. Seed the durable artifact record directly (in production
    // extract_product_page persists it at the fetch seam).
    const artifact = insertPiPageArtifact({
      runId: run.id,
      url: 'https://shop.example.com/products/stella',
      contentHash: createHash('sha256').update(html).digest('hex'),
      content: html,
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { artifactId: artifact.id, sourceType: 'shopify' },
      toolCtx(run.id),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const data = result.data as { candidates: Array<{ url: string; variantReference: string | null; extractionMethod: string; sourcePath: string; candidateId?: string; artifactId?: string }>; artifactId: string };
      expect(data.artifactId).toBe(artifact.id);
      expect(data.candidates).toHaveLength(1);
      expect(data.candidates[0]).toMatchObject({
        variantReference: '123',
        extractionMethod: 'platform_api',
      });
      expect(data.candidates[0].url.startsWith('https://')).toBe(true);
      expect(result.evidence[0].kind).toBe('image_evidence');
      expect(data.candidates[0].candidateId).toBeTruthy();
      const rows = listPiImageCandidatesByRun(run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].imageUrl).toBe(data.candidates[0].url);
      expect(rows[0].discoveringSourceId).toBeTruthy();
      // Round-9 (P1-5): the candidate row retains the ATTESTATION — which
      // retained artifact (and bytes hash) established the relationship.
      expect(rows[0].attestationArtifactId).toBe(artifact.id);
      expect(rows[0].attestedContentHash).toBe(artifact.contentHash);
      const pageSource = listPiSources(run.id).find((src) => src.url === 'https://shop.example.com/products/stella');
      expect(pageSource?.sourceType).toBe('other'); // fail-closed neutral tier until typed
      expect(rows[0].discoveringSourceId).toBe(pageSource?.id);
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('artifact-driven discovery fails closed on an unknown artifactId', async () => {
    const run = runningRun();
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { artifactId: 'no-such-artifact-id' },
      toolCtx(run.id),
    );
    expect(result.status).toBe('no_result');
    // No candidates, no source rows, no candidate rows — nothing durable minted.
    expect(listPiImageCandidatesByRun(run.id)).toHaveLength(0);
    expect(listPiSources(run.id).filter((s) => s.url.includes('shop.example.com'))).toHaveLength(0);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('extract_product_page retains the fetched page artifact and returns artifactId', async () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Stella Chicken Broth 16 oz","image":"https://cdn.example.com/stella-16oz.jpg","offers":{"price":"8.99","priceCurrency":"USD"}}</script></head><body>Stella Chicken Broth</body></html>`;
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const run = runningRun(JSON.stringify({ gtin: '085000079585', registerName: 'STELLA CHKN BROTH 16OZ', brandHint: 'Stella' }));
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('extract_product_page')!,
      { url: 'https://brand.example.com/p/stella-broth', gtin: '085000079585', expectedName: 'STELLA CHKN BROTH 16OZ', brandHint: 'Stella' },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const data = result.data as { artifactId?: string | null; contentHash?: string | null };
      expect(data.artifactId).toBeTruthy();
      const artifacts = listPiPageArtifactsByRun(run.id);
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      const retained = artifacts.find((a) => a.id === data.artifactId);
      expect(retained).toBeTruthy();
      expect(retained?.content).toBe(html);
      expect(retained?.contentHash).toBe(data.contentHash);
      // The artifact row feeds discovery: parse images from the retained bytes.
      const discovery = await defaultToolRegistry.dispatch(
        defaultToolRegistry.get('discover_image_candidates')!,
        { artifactId: data.artifactId },
        toolCtx(run.id),
      );
      expect(discovery.status).toBe('ok');
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
    // and binds it to the page source (by page URL). Round-8: the artifact
    // must be ATTESTED to a server-retained page fetch (the durable evidence
    // row carries the page-bytes hash the tool now verifies against).
    const html = `<script>var Shopify = Shopify || {};
Shopify.ProductVariants = [{"id":123,"title":"16 oz","option1":"16 oz","image_id":456}];
Shopify.ProductImages = [{"id":456,"src":"//cdn.shopify.com/s/files/a.jpg"}];</script>`;
    // Round-9 (P1-1): discovery is artifact-driven — the server retains the
    // page bytes and the tool loads them by id; the agent never supplies
    // content. The pre-typed manufacturer page source (pageSource above) is
    // what the artifact binds the candidate to.
    const artifact = insertPiPageArtifact({
      runId: run.id,
      url: 'https://brand.example.com/p/stella-broth-16oz',
      contentHash: createHash('sha256').update(html).digest('hex'),
      content: html,
    });
    const discovered = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { artifactId: artifact.id, sourceType: 'shopify' },
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
      // Round-10 (review P1): the verified asset persists its exact candidate
      // FK — supporting-role entity linkage joins by candidate_id instead of
      // reconstructing candidates heuristically.
      const assetRow = listPiAssetsByRun(run.id).find((a) => a.id === (result.data as { verifiedAssetId?: string | null }).verifiedAssetId);
      expect(assetRow).toBeTruthy();
      expect((assetRow as { candidateId?: string | null }).candidateId).toBe(candidateId);
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

  it('the agent can no longer supply artifact content or page URLs (round-9)', async () => {
    const run = runningRun();
    const pageUrl = 'https://brand.example.com/p/stella-broth-16oz';
    insertPiSource({
      runId: run.id,
      url: pageUrl,
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    const candidatesBefore = listPiImageCandidatesByRun(run.id).length;
    const sourcesBefore = listPiSources(run.id).length;
    // Fabrication is structurally impossible now: the tool's contract has no
    // content/pageUrl parameters — submitting them is a schema error, so no
    // durable candidate or source row can ever be minted from agent bytes.
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { pageUrl, content: '<script>fabricated image B</script>', sourceType: 'shopify' },
      toolCtx(run.id),
    );
    expect(result.status).toBe('error');
    expect(String((result as { message?: string }).message ?? '')).toMatch(/schema|property/i);
    expect(listPiImageCandidatesByRun(run.id)).toHaveLength(candidatesBefore);
    expect(listPiSources(run.id)).toHaveLength(sourcesBefore);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('refuses a stale URL-bound asset linkage when the image bytes changed (round-8 content-addressed linkage)', async () => {
    const pngH1 = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const pngH2 = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 60, b: 30 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(pngH2), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun(JSON.stringify({ gtin: '036000291452', registerName: 'Stella Chicken Broth 16 oz' }));
    const imageUrl = 'https://cdn.example.com/u.png';
    const source = insertPiSource({
      runId: run.id,
      url: imageUrl,
      domain: 'cdn.example.com',
      sourceType: 'manufacturer',
    });
    // time 1: U served H1 and was verified exact against GTIN X.
    insertPiAsset({
      runId: run.id,
      sourceId: source.id,
      sourceUrl: imageUrl,
      sourceType: 'manufacturer',
      sourceArtifactId: 'a1',
      extractionMethod: 'image_ocr',
      retrievedAt: new Date().toISOString(),
      originalContentHash: createHash('sha256').update(pngH1).digest('hex'),
      perceptualHash: 'phash-h1',
      rightsStatus: 'approved',
      rightsBasis: 'grant:manufacturer@cdn.example.com',
      rightsEvidenceRef: 'grant:manufacturer@cdn.example.com',
      exactProductMatch: true,
      exactVariantMatch: true,
      qualityStatus: 'usable',
      commerceApproved: true,
      conflicts: [],
      verifiedAgainstJson: JSON.stringify({ runId: run.id, gtin: '036000291452', name: 'Stella Chicken Broth 16 oz' }),
      verifiedAgainstHash: 'h1',
      declaredSourceType: 'manufacturer',
    });
    // time 2: a generic (null-hash) GTIN fact exists for X.
    const gtinRow = insertPiEvidence({
      runId: run.id,
      sourceId: source.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: imageUrl,
        candidateId: candidateOf(run.id, imageUrl, source.id),
        gtin: '036000291452',
        evidenceIds: [gtinRow.id],
      },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      // The old linkage (H1) does NOT authorize the new bytes (H2) — the
      // generic fact stays unqualified, so exact identity cannot be claimed.
      expect((result.data as { exactProductMatch: boolean }).exactProductMatch).toBe(false);
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('check_source_priority is non-authoritative: trusted registry only (round-8)', async () => {
    const run = runningRun();
    const tool = defaultToolRegistry.get('check_source_priority');
    // A CMS-managed brand-site registry entry makes the domain official.
    upsertBrandSite('Stella Chewys', 'stellachewys.com', null);
    const official = await defaultToolRegistry.dispatch(
      tool!,
      { url: 'https://www.stellachewys.com/p/1' },
      toolCtx(run.id),
    );
    expect(official.status).toBe('ok');
    expect(((official as { data?: unknown }).data as { tier: string; isOfficial: boolean }).tier).toBe('official');
    expect(((official as { data?: unknown }).data as { tier: string; isOfficial: boolean }).isOfficial).toBe(true);
    expect((official as { evidence?: Array<{ kind: string }> }).evidence?.[0]?.kind).toBe('official_evidence');
    // Agent assertions never mint authority: sourceKind 'manufacturer' and
    // officialDomains are advisory only.
    const manufactured = await defaultToolRegistry.dispatch(
      tool!,
      { url: 'https://fakebrand.example.com/p/1', sourceKind: 'manufacturer', officialDomains: ['fakebrand.example.com'] },
      toolCtx(run.id),
    );
    expect(manufactured.status).toBe('ok');
    expect(((manufactured as { data?: unknown }).data as { tier: string }).tier).not.toBe('official');
    expect(((manufactured as { data?: unknown }).data as { tier: string }).tier).toBe('unknown');
    expect((manufactured as { evidence?: Array<{ kind: string }> }).evidence?.[0]?.kind).not.toBe('official_evidence');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('image tool contracts are version 2.0.0 (round-8 breaking changes)', () => {
    expect(verifyImageCandidateTool.version).toBe('2.0.0');
    expect(discoverImageCandidatesTool.version).toBe('2.0.0');
  });

  it('candidate provenance fields win over agent params; verification method recorded separately (round-8 P1)', async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun(JSON.stringify({ gtin: '036000291452', registerName: 'Stella Chicken Broth 16 oz' }));
    const pageSource = insertPiSource({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      domain: 'brand.example.com',
      sourceType: 'manufacturer',
    });
    insertPiSource({
      runId: run.id,
      url: 'https://cdn.example.com/i.png',
      domain: 'cdn.example.com',
      sourceType: 'retailer', // an exact image-URL row with a DIFFERENT tier
    });
    // The server-created candidate carries the authoritative discovery
    // provenance (a json_ld artifact) — the agent's sourcePath/sourceArtifactId/
    // extractionMethod params below must be ignored in favor of these.
    const candidateId = insertPiImageCandidate({
      runId: run.id,
      imageUrl: 'https://cdn.example.com/i.png',
      discoveringSourceId: pageSource.id,
      sourceArtifactId: 'cand-artifact-9',
      sourcePath: 'json_ld.image.0',
      extractionMethod: 'json_ld',
      variantReference: null,
    }).id;
    insertPiEvidence({
      runId: run.id,
      sourceId: pageSource.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      metadata: { toolEvidenceId: 'extract_product_page:abc123:gtin:def456', contentHash: createHash('sha256').update(png).digest('hex') },
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: 'https://cdn.example.com/i.png',
        candidateId,
        evidenceIds: ['extract_product_page:abc123:gtin:def456'],
        // Agent-provided provenance hints that must NOT win:
        sourcePath: 'agent-invented-path',
        sourceArtifactId: 'agent-invented-artifact',
        extractionMethod: 'media_api',
      },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    const record = (result as { data?: unknown }).data as {
      sourcePath: string | null;
      sourceArtifactId: string | null;
      extractionMethod: string | null;
      verificationMethod: string | null;
    };
    expect(record.sourcePath).toBe('json_ld.image.0');
    expect(record.sourceArtifactId).toBe('cand-artifact-9');
    expect(record.extractionMethod).toBe('json_ld');
    expect(record.verificationMethod).toBe('image_verification_pipeline');
    // The persisted asset row carries the candidate's provenance too.
    const assets = listPiAssetsByRun(run.id);
    const persisted = assets[assets.length - 1];
    expect(persisted.sourcePath).toBe('json_ld.image.0');
    expect(persisted.sourceArtifactId).toBe('cand-artifact-9');
    expect(persisted.extractionMethod).toBe('json_ld');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('candidate discovering source outranks a sticky exact-image-URL tier (round-8 P1)', async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 100, g: 140, b: 180 } } })
      .png()
      .toBuffer();
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const run = runningRun(JSON.stringify({ gtin: '036000291452', registerName: 'Stella Chicken Broth 16 oz' }));
    // A 'sticky' image-URL source row from an earlier verification says
    // 'retailer' — if it outranked the candidate, rights would be restricted
    // (no retailer grant).
    insertPiSource({
      runId: run.id,
      url: 'https://cdn.example.com/i.png',
      domain: 'cdn.example.com',
      sourceType: 'retailer',
    });
    const supplierSource = insertPiSource({
      runId: run.id,
      url: 'https://supplier.example.com/p/1',
      domain: 'supplier.example.com',
      sourceType: 'supplier',
    });
    const candidateId = insertPiImageCandidate({
      runId: run.id,
      imageUrl: 'https://cdn.example.com/i.png',
      discoveringSourceId: supplierSource.id,
      sourceArtifactId: 'a1',
      sourcePath: 'json_ld.image.0',
      extractionMethod: 'json_ld',
      variantReference: null,
    }).id;
    insertPiEvidence({
      runId: run.id,
      sourceId: supplierSource.id,
      targetField: 'gtin',
      value: '036000291452',
      extractionMethod: 'image_ocr',
      metadata: { toolEvidenceId: 'extract_product_page:abc123:gtin:def456', contentHash: createHash('sha256').update(png).digest('hex') },
    });
    upsertReusePolicy({ workspaceId: wsId, sourceTier: 'supplier', domainPattern: 'cdn.example.com', allowed: true, terms: 'supplier license' });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      { url: 'https://cdn.example.com/i.png', candidateId, evidenceIds: ['extract_product_page:abc123:gtin:def456'] },
      toolCtx(run.id, { gateway }),
    );
    expect(result.status).toBe('ok');
    const record = (result as { data?: unknown }).data as { rightsStatus: string; sourceType: string };
    // The candidate's discovering source (supplier) won over the sticky
    // retailer image-URL row — the supplier grant approved the reuse.
    expect(record.sourceType).toBe('supplier');
    expect(record.rightsStatus).toBe('approved');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  describe('PI-6 round-10: run-scoped artifacts, typed artifact gates, exact candidate FK (review P0/P1)', () => {

  it('refuses a FOREIGN-RUN artifact: possession of an artifact UUID is not authorization (round-10 P0)', async () => {
    const runA = runningRun();
    const runB = runningRun();
    const html = `<script>var Shopify = Shopify || {};
Shopify.ProductVariants = [{"id":123,"title":"16 oz","option1":"16 oz","image_id":456}];
Shopify.ProductImages = [{"id":456,"src":"//cdn.shopify.com/s/files/a.jpg"}];</script>`;
    // Run A retains its own artifact (in production extract_product_page does
    // this at the fetch seam).
    const artifactA = insertPiPageArtifact({
      runId: runA.id,
      url: 'https://shop.example.com/products/stella',
      contentHash: createHash('sha256').update(html).digest('hex'),
      content: html,
    });
    // Run B knows artifact A's UUID. Artifact lookup is run-scoped now — the
    // foreign id must never mint current-run candidates or a source row.
    const foreign = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { artifactId: artifactA.id, sourceType: 'shopify' },
      toolCtx(runB.id),
    );
    expect(foreign.status).toBe('no_result');
    expect(String((foreign as { reason?: string }).reason ?? '')).toMatch(/in this run/i);
    expect(listPiImageCandidatesByRun(runB.id)).toHaveLength(0);
    expect(listPiSources(runB.id).filter((s) => s.url.includes('shop.example.com'))).toHaveLength(0);
    // Positive proof: the SAME artifact still works from its OWN run.
    const sameRun = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { artifactId: artifactA.id, sourceType: 'shopify' },
      toolCtx(runA.id),
    );
    expect(sameRun.status).toBe('ok');
    if (sameRun.status === 'ok') {
      const rows = listPiImageCandidatesByRun(runA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].attestationArtifactId).toBe(artifactA.id);
      expect(rows[0].attestedContentHash).toBe(artifactA.contentHash);
    }
    transitionPiRunStatus(runA.id, 'completed', {});
    transitionPiRunStatus(runB.id, 'completed', {});
  });

  it('fails closed on a non-page_html artifact type — network captures are not yet a retained artifact path (round-10 P1)', async () => {
    const run = runningRun();
    const capture = JSON.stringify([{ url: 'https://cdn.example.com/x.jpg', method: 'GET', response: { status: 200 } }]);
    const artifact = insertPiPageArtifact({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      contentHash: createHash('sha256').update(capture).digest('hex'),
      content: capture,
      artifactType: 'browser_network_capture',
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { artifactId: artifact.id },
      toolCtx(run.id),
    );
    expect(result.status).toBe('no_result');
    expect(String((result as { reason?: string }).reason ?? '')).toMatch(/not yet a supported discovery source/i);
    // Nothing durable minted — JSON.parse()-ing HTML as a capture would have
    // silently produced nothing; this fails honestly instead.
    expect(listPiImageCandidatesByRun(run.id)).toHaveLength(0);
    expect(listPiSources(run.id).filter((s) => s.url.includes('brand.example.com'))).toHaveLength(0);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('network_capture is no longer an advertised discovery sourceType (round-10 P1)', async () => {
    const run = runningRun();
    const html = '<html><head><script type="application/ld+json">{"@type":"Product","name":"Stella Broth"}</script></head><body>stella</body></html>';
    const artifact = insertPiPageArtifact({
      runId: run.id,
      url: 'https://brand.example.com/p/1',
      contentHash: createHash('sha256').update(html).digest('hex'),
      content: html,
    });
    // The schema no longer advertises network_capture — submitting it is a
    // schema error, and nothing durable is minted.
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { artifactId: artifact.id, sourceType: 'network_capture' },
      toolCtx(run.id),
    );
    expect(result.status).toBe('error');
    expect(listPiImageCandidatesByRun(run.id)).toHaveLength(0);
    expect(listPiSources(run.id).filter((s) => s.url.includes('brand.example.com'))).toHaveLength(0);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('persists the typed entity identity on the candidate row (round-10 P1)', async () => {
    const run = runningRun();
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      sku: 'SKU-123',
      name: 'Stella Chicken Broth 16 oz',
      image: 'https://cdn.example.com/stella.jpg',
    });
    const html = `<script type="application/ld+json">${ld}</script>`;
    const artifact = insertPiPageArtifact({
      runId: run.id,
      url: 'https://brand.example.com/p/stella-16oz',
      contentHash: createHash('sha256').update(html).digest('hex'),
      content: html,
    });
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { artifactId: artifact.id },
      toolCtx(run.id),
    );
    expect(result.status).toBe('ok');
    // The durable candidate row carries the serialized typed entity. The
    // parser emits a typed kind when it can classify the record; the durable
    // form is '{kind}:{value}' (never fabricated, raw id preserved when no
    // kind is declared).
    const parsed = discoverCandidates('json_ld', html, 'https://brand.example.com/p/stella-16oz');
    const parsedEntity = parsed[0]?.entityId ?? null;
    const parsedKind = parsed[0]?.entityKind ?? null;
    const expectedEntityId =
      parsedEntity === null
        ? null
        : parsedKind
          ? parsedEntity.startsWith(`${parsedKind}:`)
            ? parsedEntity
            : `${parsedKind}:${parsedEntity}`
          : parsedEntity;
    const rows = listPiImageCandidatesByRun(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(expectedEntityId);
    if (parsedKind) {
      expect(rows[0].entityId).toMatch(new RegExp(`^${parsedKind}:`));
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });
});

});

describe('PI-6 discovery parser media-set/entity capture (round-9 P1, round-10 typed)', () => {
  it('tags main-product images with the typed product entity id', () => {
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      '@id': 'https://brand.example.com/product/MAIN-1',
      name: 'Main Product',
      image: 'https://cdn.example.com/main.jpg',
    });
    const out = discoverCandidates('json_ld', `<script type="application/ld+json">${ld}</script>`, 'https://brand.example.com/p/1');
    const main = out.find((c) => c.url === 'https://cdn.example.com/main.jpg');
    // Round-10: entity identity is TYPED — a declared-product @id is the
    // platform_product_id, serialized as '{kind}:{value}'.
    expect(main?.entityKind).toBe('platform_product_id');
    expect(main?.entityId).toBe('platform_product_id:https://brand.example.com/product/MAIN-1');
  });

  it('tags recommendation-nested images with the recommendation entity, not the main product (round-9 P1)', () => {
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      '@id': 'https://brand.example.com/product/MAIN-1',
      name: 'Main Product',
      image: 'https://cdn.example.com/main.jpg',
      relatedProducts: [
        {
          '@type': 'Product',
          '@id': 'https://brand.example.com/product/REC-99',
          sku: 'REC-99',
          name: 'You May Also Like',
          image: 'https://cdn.example.com/rec.jpg',
        },
      ],
    });
    const out = discoverCandidates('json_ld', `<script type="application/ld+json">${ld}</script>`, 'https://brand.example.com/p/1');
    const main = out.find((c) => c.url === 'https://cdn.example.com/main.jpg');
    const rec = out.find((c) => c.url === 'https://cdn.example.com/rec.jpg');
    expect(main?.entityId).toBe('platform_product_id:https://brand.example.com/product/MAIN-1');
    // The nested recommendation carries its OWN identity — it overrides the
    // inherited main-product context. Its canonical @id (not its sku) is the
    // platform product identity.
    expect(rec?.entityKind).toBe('platform_product_id');
    expect(rec?.entityId).toBe('platform_product_id:https://brand.example.com/product/REC-99');
  });

  it('tags @graph product images independently (round-9 P1)', () => {
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Product', '@id': 'https://brand.example.com/product/MAIN-1', image: 'https://cdn.example.com/main.jpg' },
        { '@type': 'Product', '@id': 'https://brand.example.com/product/REC-99', sku: 'REC-99', image: 'https://cdn.example.com/rec.jpg' },
      ],
    });
    const out = discoverCandidates('json_ld', `<script type="application/ld+json">${ld}</script>`, 'https://brand.example.com/p/1');
    expect(out.find((c) => c.url === 'https://cdn.example.com/main.jpg')?.entityId).toBe('platform_product_id:https://brand.example.com/product/MAIN-1');
    expect(out.find((c) => c.url === 'https://cdn.example.com/rec.jpg')?.entityId).toBe('platform_product_id:https://brand.example.com/product/REC-99');
  });
});
