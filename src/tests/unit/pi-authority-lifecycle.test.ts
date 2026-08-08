/**
 * Round-11 merge-gate integration regression (reviewer item 5):
 *
 *   extract manufacturer page -> discover primary/supporting candidates ->
 *   OCR/verify primary (exact GTIN + brand) -> deterministic authority ->
 *   re-verify supporting nutrition image -> submit primary + nutrition ->
 *   terminal validator accepts the media-set-linked supporting asset and
 *   persistence preserves the exact candidate FK.
 *
 * Exercises every seam the last several review rounds hardened: artifact-
 * driven discovery (run-scoped), typed entity capture, exact candidate FK,
 * evidence-provenanced manufacturer authority, the removed stale source
 * cache, the media-set supporting-role linkage, and terminal persistence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, getDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createPiRun } from '../../db/repositories/product-intelligence-repo';
import {
  insertPiAsset,
  insertPiEvidence,
  insertPiImageCandidate,
  insertPiPageArtifact,
  listPiAssetsByRun,
  listPiSources,
  listSourceAuthoritiesByRun,
} from '../../db/repositories/product-intelligence-repo';
import { upsertReusePolicy } from '../../db/repositories/pi-reuse-policy-repo';
import { findWorkspace, insertWorkspace } from '../../db/repositories/workspace-repo';
import { defaultToolRegistry } from '../../product-intelligence/tools';
import { PolicyGateway } from '../../product-intelligence/policy';
import { testPolicy } from './product-intelligence/test-helpers';
import { assetEvidenceFromRow, persistBundleAssets } from '../../product-intelligence/run-service';
import { validateTerminalSubmission } from '../../product-intelligence/workflow/bundle-validator';
import type { ProductResearchBundle, BundleImageCandidate } from '../../product-intelligence/workflow/bundle';
import { PersistingExecutionEventSink } from '../../product-intelligence/run-service';
import sharp from 'sharp';

const GTIN = '036000291452';
const PAGE_URL = 'https://brand.example.com/p/stella-broth-16oz';
const FRONT_URL = 'https://cdn.example.com/stella-front.jpg';
const NUTRITION_URL = 'https://cdn.example.com/stella-nutrition.jpg';
const wsId = 'pi-authority-lifecycle-workspace';

describe('PI authority lifecycle (round-11 integration)', () => {
  let png: Buffer;
  let nutritionPng: Buffer;
  let runId: string;
  let artifactId: string;
  let frontCandidateId: string;
  let nutritionCandidateId: string;

  beforeAll(async () => {
    try { resetDb(); } catch { /* ok */ }
    const dbPath = path.resolve(import.meta.dirname, 'pi-authority-lifecycle-test.db');
    initDb(dbPath);
    runMigrations();
    if (!findWorkspace()) {
      insertWorkspace({
        id: wsId,
        name: 'Integration',
        workspacePath: '/tmp/pi-authority-lifecycle',
        gitPath: '/tmp/pi-authority-lifecycle/.git',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        bootstrapStatus: 'complete',
        baselineCommit: null,
      });
    }
    png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 150, b: 190 } } })
      .png()
      .toBuffer();
    nutritionPng = await sharp({ create: { width: 480, height: 480, channels: 3, background: { r: 220, g: 220, b: 235 } } })
      .png()
      .toBuffer();
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(path.resolve(import.meta.dirname, 'pi-authority-lifecycle-test.db'));
    } catch {
      /* ok */
    }
  });

  function gateway(): PolicyGateway {
    return new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/p/stella')) {
          const html = `<html><head><script type="application/ld+json">${JSON.stringify({
            '@type': 'Product',
            '@id': `${PAGE_URL}#product`,
            name: 'Stella Chicken Broth 16 oz',
            brand: { '@type': 'Brand', name: 'Stella' },
            sku: 'STL-16',
            gtin: GTIN,
            image: [FRONT_URL, NUTRITION_URL],
          })}</script></head><body>Stella Chicken Broth 16 oz</body></html>`;
          return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        if (url.includes('nutrition')) {
          return new Response(new Uint8Array(nutritionPng), { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } });
      },
    });
  }

  const toolCtx = (overrides: { gateway?: PolicyGateway } = {}) => ({
    runId,
    workspaceId: wsId,
    workspacePath: '/tmp/pi-authority-lifecycle-workspace',
    policy: testPolicy({ networkPolicy: 'allowlisted_remote', allowedSourceDomains: [] }),
    gateway: overrides.gateway,
    signal: new AbortController().signal,
    remainingMs: 60_000,
  });

  it('extract -> discover -> verify -> authority -> supporting verify -> submit (full chain)', async () => {
    runId = createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: GTIN, registerName: 'Stella Chicken Broth 16 oz' }),
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    }).id;
    upsertReusePolicy({
      workspaceId: wsId,
      sourceTier: 'manufacturer',
      domainPattern: 'cdn.example.com',
      allowed: true,
      terms: 'vendor license',
    });

    // (1) Workflow ranks the source BEFORE any verification: no exact
    //     evidence exists -> authority fails closed (recoverable).
    const first = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('check_source_priority')!,
      { url: PAGE_URL },
      toolCtx(),
    );
    expect(first.status).toBe('ok');
    expect((first as { data?: { authorityEstablished?: boolean } }).data?.authorityEstablished).toBe(false);
    expect(listSourceAuthoritiesByRun(runId).length).toBe(0);

    // (2) EXTRACT the manufacturer page through the real tool: the gateway
    //     fetch seam retains the TYPED artifact and returns artifactId.
    const extracted = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('extract_product_page')!,
      { url: PAGE_URL, gtin: GTIN, expectedName: 'STELLA CHKN BROTH 16OZ' },
      toolCtx({ gateway: gateway() }),
    );
    if (extracted.status !== 'ok') {
      // eslint-disable-next-line no-console
      console.error('extract status:', extracted.status, JSON.stringify((extracted as { data?: unknown }).data ?? {}).slice(0, 400));
    }
    expect(extracted.status).toBe('ok');
    const extractData = (extracted as { data?: { artifactId?: string | null } }).data ?? {};
    expect(extractData.artifactId).toBeTruthy();
    artifactId = extractData.artifactId!;
    // Extraction does not create a source row — discovery does (the
    // candidate's discovering source). Asserted after discovery below.

    // (3) DISCOVER through the real tool: artifact-driven, no agent bytes;
    //     both product images share the typed platform entity.
    const discovered = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('discover_image_candidates')!,
      { artifactId },
      toolCtx(),
    );
    expect(discovered.status).toBe('ok');
    const candidates = (discovered as { data?: { candidates: Array<{ candidateId: string; url: string; entityId: string | null }> } }).data
      ?.candidates ?? [];
    const front = candidates.find((c) => c.url === FRONT_URL);
    const nutrition = candidates.find((c) => c.url === NUTRITION_URL);
    expect(front).toBeTruthy();
    expect(nutrition).toBeTruthy();
    expect(front!.entityId).toBeTruthy();
    // Same media-set entity for both images of the same product.
    expect(front!.entityId).toBe(nutrition!.entityId);
    frontCandidateId = front!.candidateId;
    nutritionCandidateId = nutrition!.candidateId;
    const pageSource = listPiSources(runId).find((source) => source.url === PAGE_URL);
    expect(pageSource).toBeTruthy();
    expect(pageSource?.sourceType).toBe('other');

    // (4) OCR/VERIFY the PRIMARY: hash-bound exact GTIN + brand evidence
    //     make the durable brand resolvable; the persist seam runs the
    //     deterministic authority refresh.
    const pngHash = createHash('sha256').update(png).digest('hex');
    const gtinRow = insertPiEvidence({
      runId,
      sourceId: pageSource!.id,
      targetField: 'gtin',
      value: GTIN,
      extractionMethod: 'image_ocr',
      metadata: { contentHash: pngHash },
    });
    const brandRow = insertPiEvidence({
      runId,
      sourceId: pageSource!.id,
      targetField: 'brand',
      value: 'Stella',
      extractionMethod: 'image_ocr',
      // Same image bytes as the GTIN observation: the evidence-phase
      // authority refresh binds the brand to the exact-GTIN image.
      metadata: { contentHash: pngHash },
    });
    const verified = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: FRONT_URL,
        candidateId: frontCandidateId,
        gtin: GTIN,
        evidenceIds: [gtinRow.id, brandRow.id],
      },
      toolCtx({ gateway: gateway() }),
    );
    expect(verified.status).toBe('ok');
    const frontRecord = (verified as { data?: { exactProductMatch?: boolean; rightsStatus?: string; commerceApproved?: boolean } }).data ?? {};
    expect(frontRecord.exactProductMatch).toBe(true);

    // (5) AUTHORITY is now a deterministic server consequence: evidence-
    //     provenanced manufacturer record + upgraded source tier.
    const authorities = listSourceAuthoritiesByRun(runId);
    expect(authorities.length).toBe(1);
    expect(authorities[0].authorityType).toBe('manufacturer');
    expect(authorities[0].brandName).toBe('stella');
    expect(authorities[0].establishedBy).toBe('verified_asset_evidence');
    const frontAsset = listPiAssetsByRun(runId).find((a) => a.observedBrand === 'Stella');
    expect(frontAsset).toBeTruthy();
    expect(frontAsset?.candidateId).toBe(frontCandidateId);
    expect(frontAsset).not.toBeNull();
    expect(authorities[0].brandEvidenceId).toBe(frontAsset!.id);
    expect(authorities[0].brandEvidenceHash).toBe(frontAsset!.originalContentHash);
    expect(authorities[0].brandEvidenceKind).toBe('verified_asset');
    expect(listPiSources(runId).find((source) => source.url === PAGE_URL)?.sourceType).toBe('manufacturer');

    // (6) RE-VERIFY the SUPPORTING nutrition image: separate candidate row
    //     (one candidate = one image URL), exactProductMatch false, same
    //     entity — rights resolve from the FRESH manufacturer source tier.
    const nutritionVerified = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('verify_image_candidate')!,
      {
        url: NUTRITION_URL,
        candidateId: nutritionCandidateId,
        // No GTIN evidence for the nutrition panel: exactProductMatch must
        // stay false — rights come from the manufacturer source tier.
      },
      toolCtx({ gateway: gateway() }),
    );
    expect(nutritionVerified.status).toBe('ok');
    const nutritionRecord = (nutritionVerified as { data?: { exactProductMatch?: boolean; rightsStatus?: string; commerceApproved?: boolean } }).data ?? {};
    expect(nutritionRecord.exactProductMatch).toBe(false);
    expect(nutritionRecord.rightsStatus).toBe('approved');
    const nutritionAsset = listPiAssetsByRun(runId).find((a) => a.candidateId === nutritionCandidateId);
    expect(nutritionAsset).toBeTruthy();
    expect(nutritionAsset?.sourceUrl).toBe(NUTRITION_URL);

    // (7) check_source_priority now reports the durable authority.
    const second = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('check_source_priority')!,
      { url: PAGE_URL },
      toolCtx(),
    );
    const secondData = (second as { data?: { authorityEstablished?: boolean } }).data;
    expect(secondData?.authorityEstablished).toBe(true);

    // (8) SUBMIT the terminal bundle: primary (commerce) + nutrition
    //     (supporting alternate) — the validator accepts the media-set
    //     linkage, and persistence preserves the exact candidate FK.
    const frontEvidence = insertPiEvidence({
      runId,
      sourceId: pageSource!.id,
      targetField: 'brand',
      value: 'Stella',
      extractionMethod: 'image_ocr',
    });
    const bundle: ProductResearchBundle = {
      schemaVersion: 1,
      gtin: GTIN,
      inputName: 'Stella Chicken Broth 16 oz',
      identity: {
        status: 'exact_match',
        brand: 'Stella',
        canonicalName: 'Stella Chicken Broth 16 oz',
        variant: null,
        manufacturer: null,
        netContent: null,
        packCount: null,
        evidenceIds: [frontEvidence.id],
      },
      commerceFacts: [],
      classificationProposals: [],
      imageCandidates: [
        imageCandidateOf(frontAsset!, 'primary', frontAsset!.rightsStatus as never),
        imageCandidateOf(nutritionAsset!, 'alternate', nutritionAsset!.rightsStatus as never),
      ],
      conflicts: [],
      disposition: 'research_complete',
    };
    const validation = validateTerminalSubmission(bundle, GTIN, wsId, runId);
    expect(validation.valid).toBe(true);
    if (!validation.valid) {
      throw new Error(`validator rejected the integration bundle: ${validation.issues.join('; ')}`);
    }

    const sink = { emitDomain: () => undefined } as unknown as PersistingExecutionEventSink;
    persistBundleAssets(runId, bundle, sink);

    const persisted = listPiAssetsByRun(runId).map(assetEvidenceFromRow);
    const persistedPrimary = persisted.find((a) => a.candidateId === frontCandidateId);
    const persistedNutrition = persisted.find((a) => a.candidateId === nutritionCandidateId);
    expect(persistedPrimary).toBeTruthy();
    expect(persistedPrimary?.candidateId).toBe(frontCandidateId);
    expect(persistedNutrition).toBeTruthy();
    expect(persistedNutrition?.candidateId).toBe(nutritionCandidateId);
    // The supporting nutrition asset survived terminal persistence with its
    // exact relationship intact.
    expect(persistedNutrition?.rightsStatus).toBe('approved');
  });
});

function imageCandidateOf(
  asset: NonNullable<ReturnType<typeof listPiAssetsByRun>>[number],
  role: BundleImageCandidate['role'],
  rightsStatus: BundleImageCandidate['rightsStatus'],
): BundleImageCandidate {
  return {
    sourceId: asset.sourceId ?? '',
    sourceArtifactId: asset.sourceArtifactId ?? '',
    url: asset.sourceUrl,
    role,
    verifiedAssetId: asset.id,
    exactProductMatch: asset.exactProductMatch === 1,
    exactVariantMatch: asset.exactVariantMatch === 1,
    variantReference: asset.variantReference ?? null,
    rightsStatus,
    evidenceIds: [],
    sourcePageUrl: asset.sourcePageUrl ?? null,
    sourcePath: asset.sourcePath ?? null,
    extractionMethod: asset.extractionMethod as BundleImageCandidate['extractionMethod'],
    retrievedAt: asset.retrievedAt,
    rightsBasis: asset.rightsBasis ?? null,
    rightsEvidenceRef: asset.rightsEvidenceRef ?? null,
    originalContentHash: asset.originalContentHash,
    perceptualHash: asset.perceptualHash ?? null,
    qualityStatus: asset.qualityStatus as BundleImageCandidate['qualityStatus'],
    commerceApproved: asset.commerceApproved === 1,
    observedNetContent: asset.observedNetContentJson ? JSON.parse(asset.observedNetContentJson) : null,
    observedPackCount: asset.observedPackCount ?? null,
    conflicts: asset.conflictsJson ? JSON.parse(asset.conflictsJson) : [],
  };
}
