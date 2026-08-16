/**
 * Onboarding distributor imagery verification (epic #46 follow-up).
 *
 * Proves the PI-6 reuse for the onboarding pipeline: rights-attested
 * distributor approvals flow through `verifyImageCandidate` with byte-bound
 * OCR identity (when a VLM is configured), grants are seeded per domain, and
 * durable assets persist (origin 'onboarding_distributor') — commerce-
 * approved only when identity+quality+rights hold, display-only otherwise.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, updateItemStageStatus } from '../../db/repositories/onboarding-item-repo';
import { insertEvidenceAttempt, startSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { createConnection } from '../../db/repositories/distributor-repo';
import { listReusePolicies } from '../../db/repositories/pi-reuse-policy-repo';
import { listPiAssetsByOnboardingItem } from '../../db/repositories/product-intelligence-repo';
import { verifyDistributorImageryForBatch } from '../../onboarding/distributor-imagery';
import { sha256Hex } from '../../shared/stable-id';
import type { ImageVerificationContract } from '../../product-intelligence/assets/contract';
import type { ExtractPackagingOcrParams } from '../../onboarding/packaging-ocr';
import type { PackagingOcrData } from '../../shared/schemas/onboarding';
import type { Workspace } from '../../shared/types';

const IMAGE_URL = 'https://d56ygyjv466yj.cloudfront.net/297001.jpg';

describe('onboarding distributor imagery verification', () => {
  let tempDir: string;
  let workspaceId: string;
  let wsPath: string;
  let batchId: string;
  let itemId: string;
  let pngBytes: Uint8Array;
  let pngHash: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distributor-imagery-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    wsPath = path.join(tempDir, 'ws');
    fs.mkdirSync(wsPath, { recursive: true });
    workspaceId = 'ws-imagery';
    const ws: Workspace = {
      id: workspaceId,
      name: 'W',
      workspacePath: wsPath,
      gitPath: tempDir + '/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
    batchId = createBatch({ workspaceId, name: 'B', fileName: 'b.csv', totalItems: 1 }).id;

    // 240x240 PNG so the sharp decoder reports 'usable'.
    pngBytes = new Uint8Array(
      await sharp({ create: { width: 240, height: 240, channels: 3, background: { r: 200, g: 60, b: 40 } } })
        .png()
        .toBuffer(),
    );
    pngHash = sha256Hex(Buffer.from(pngBytes));

    const [item] = insertItems(
      batchId,
      [{ upc: '627987480993', name: 'Fromm Gold Adult 4 lb', brandHint: 'Fromm', rowNumber: 1, stage: 'review' }],
      'review',
      1,
    );
    itemId = item.id;
    updateItemStageStatus(item.id, 'completed');
    getDb().query("UPDATE onboarding_items SET source_type = 'distributor_record' WHERE id = ?").run(item.id);

    // Extraction payload with rights-attested approvals (what the materializer writes).
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(
      JSON.stringify({
        title: 'Fromm Gold Adult 4 lb',
        brand: 'Fromm',
        sourceType: 'distributor_record',
        distributorImageApprovals: [
          {
            imageUrl: IMAGE_URL,
            sourceAttemptIds: ['att-1'],
            approvedAt: '2026-08-16T00:00:00.000Z',
            rightsAttested: true,
            approvalOrigin: 'distributor_channel_opt_in',
          },
        ],
      }),
      item.id,
    );

    // Durable distributor evidence attempt carrying the image URL.
    const gen = startSourcingGeneration(item.id, 'automatic');
    const conn = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'FIXTURE_KEY' });
    insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc', 'name', 'images'],
      identityJson: JSON.stringify({
        upc: item.upc,
        name: 'Fromm Gold Adult 4 lb',
        brand: 'Fromm',
        images: [IMAGE_URL],
      }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-16T00:00:00.000Z',
      sourcingGenerationId: gen.id,
    });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function fetchStub(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return async () =>
      new Response(Buffer.from(pngBytes), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(pngBytes.length) },
      });
  }

  function contractStub(): ImageVerificationContract {
    return {
      name: 'stub_contract',
      version: '1.0.0',
      async verify() {
        return {
          verified: true,
          image: { width: 240, height: 240, aspectRatio: 1, contentHash: pngHash, perceptualHash: 'ph' },
          observed: { brand: null, productName: null, variant: null, netContent: null, packCount: null, gtin: null },
          qualityStatus: 'usable',
          rejectionReason: null,
        };
      },
    };
  }

  function ocrStub(overrides: Partial<PackagingOcrData> = {}): typeof import('../../onboarding/packaging-ocr').extractPackagingOcr {
    return (async (_params: ExtractPackagingOcrParams) => {
      return {
        productName: 'Fromm Gold Adult 4 lb',
        brand: 'Fromm',
        upc: '627987480993',
        species: [],
        flavorVariety: null,
        color: null,
        material: null,
        size: null,
        weight: null,
        ...overrides,
        contentHash: pngHash,
      } as PackagingOcrData & { contentHash: string };
    }) as typeof import('../../onboarding/packaging-ocr').extractPackagingOcr;
  }

  test('byte-bound OCR identity + licensed grants → commerce-approved durable asset', async () => {
    const summary = await verifyDistributorImageryForBatch(batchId, workspaceId, wsPath, {
      fetchFn: fetchStub(),
      ocr: ocrStub(),
      contract: contractStub(),
    });

    expect(summary.items).toBe(1);
    expect(summary.images).toBe(1);
    expect(summary.verified).toBe(1);
    expect(summary.commerceApproved).toBe(1);
    expect(summary.displayOnly).toBe(0);
    expect(summary.skippedVlmOcr).toBe(false);

    // Reuse grant seeded for the image domain (the operator's channel opt-in).
    const grants = listReusePolicies(workspaceId);
    expect(grants.some((g) => g.sourceTier === 'supplier' && g.domainPattern === 'd56ygyjv466yj.cloudfront.net' && g.allowed === 1)).toBe(true);

    // Durable asset persisted with onboarding origin + item linkage.
    const assets = listPiAssetsByOnboardingItem(itemId);
    expect(assets.length).toBe(1);
    expect(assets[0].sourceUrl).toBe(IMAGE_URL);
    expect(assets[0].commerceApproved).toBe(1);
    expect(assets[0].rightsStatus).toBe('approved');
    expect(assets[0].exactProductMatch).toBe(1);
    expect(assets[0].observedGtin).toBe('627987480993');
  });

  test('no OCR (VLM unconfigured) → display-only asset, never commerce-approved', async () => {
    const summary = await verifyDistributorImageryForBatch(batchId, workspaceId, wsPath, {
      fetchFn: fetchStub(),
      ocr: (async () => null) as never,
      contract: contractStub(),
    });

    expect(summary.verified).toBe(1);
    expect(summary.commerceApproved).toBe(0);
    expect(summary.displayOnly).toBe(1);
    expect(summary.skippedVlmOcr).toBe(true);

    const assets = listPiAssetsByOnboardingItem(itemId);
    expect(assets.length).toBe(1);
    expect(assets[0].commerceApproved).toBe(0);
    expect(assets[0].exactProductMatch).toBe(0);
  });

  test('non-opt-in approval origins are display-only — never granted, never verified (review round 2 HIGH-1)', async () => {
    // Re-stamp the item's approval with a non-opt-in origin.
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(
      JSON.stringify({
        title: 'Fromm Gold Adult 4 lb',
        brand: 'Fromm',
        sourceType: 'distributor_record',
        distributorImageApprovals: [
          {
            imageUrl: IMAGE_URL,
            sourceAttemptIds: ['att-1'],
            approvedAt: '2026-08-16T00:00:00.000Z',
            rightsAttested: true,
            approvalOrigin: 'manual_reviewer',
          },
        ],
      }),
      itemId,
    );

    const summary = await verifyDistributorImageryForBatch(batchId, workspaceId, wsPath, {
      fetchFn: fetchStub(),
      ocr: ocrStub(),
      contract: contractStub(),
    });

    // The URL was counted but never fetched/verified and never granted.
    expect(summary.images).toBe(1);
    expect(summary.verified).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.commerceApproved).toBe(0);
    const grants = listReusePolicies(workspaceId);
    expect(grants.some((g) => g.domainPattern === 'd56ygyjv466yj.cloudfront.net')).toBe(false);
    expect(listPiAssetsByOnboardingItem(itemId)).toEqual([]);
  });

  test('fetch failure → failed outcome, no asset persisted', async () => {
    const summary = await verifyDistributorImageryForBatch(batchId, workspaceId, wsPath, {
      fetchFn: async () => new Response('not found', { status: 404, headers: { 'content-type': 'image/png' } }),
      ocr: (async () => null) as never,
      contract: contractStub(),
    });

    expect(summary.verified).toBe(0);
    expect(summary.failed).toBe(1);
    expect(listPiAssetsByOnboardingItem(itemId)).toEqual([]);
  });

  test('idempotent: re-running skips already-verified URLs (no re-fetch, no dup rows)', async () => {
    const deps = { fetchFn: fetchStub(), ocr: ocrStub(), contract: contractStub() };
    await verifyDistributorImageryForBatch(batchId, workspaceId, wsPath, deps);
    const second = await verifyDistributorImageryForBatch(batchId, workspaceId, wsPath, deps);

    // The durable (item, url) row is the verified-state authority — the
    // second run skips the URL entirely (review round 2 MEDIUM-4).
    expect(second.verified).toBe(0);
    expect(second.skipped).toBe(1);
    expect(listPiAssetsByOnboardingItem(itemId).length).toBe(1);
  });
});
