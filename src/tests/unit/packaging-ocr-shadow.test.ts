/**
 * P2-T4 (packaging-OCR overhaul) — dual-run shadow harness.
 *
 * Covers: the additive `packaging_ocr_shadow_comparisons` migration, the
 * shadow-comparison repository (insert / list-by-item / count), the dual-run
 * writer invoked from the packaging_ocr stage when the legacy inline result is
 * available, per-field agreement payload, and the hard isolation rule:
 * shadow-only runs NEVER mutate live extraction keys even when the comparison
 * writer fires.
 *
 * DB-backed (bun:test) — bun:sqlite is imported transitively.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import {
  insertPackagingOcrShadowComparison,
  listPackagingOcrShadowComparisonsByItem,
  countPackagingOcrShadowComparisons,
  deleteOlderThan,
  parseOcrShadowRetentionDays,
} from '../../db/repositories/packaging-ocr-shadow-repo';
import {
  comparePackagingOcrResults,
  packagingOcrStage,
} from '../../classification/stages/packaging-ocr-stage';
import {
  overrideOcrStageFlags,
  resetOcrStageFlagsOverride,
} from '../../classification/ocr-stage-flags';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot } from '../../classification/runtime-snapshot';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { PackagingOcrData } from '../../shared/schemas/onboarding';

let tmpDir: string;
let workspaceId: string;
let workspacePath: string;

const HB_EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

const STAGE_OCR_JSON = {
  productName: 'Stage Kibble',
  brand: 'Acme',
  weight: '5 lb',
  visibleTextLines: ['STAGE KIBBLE'],
  confidenceByField: { productName: 0.95 },
};

function startOllamaServer(ocrJson: Record<string, unknown>): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { content: JSON.stringify(ocrJson) } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function seedWorkspace(): void {
  workspaceId = randomUUID();
  workspacePath = path.join(tmpDir, 'ws');
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  insertWorkspace({
    id: workspaceId,
    name: 'shadow-test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

function seedLocalImage(): string {
  fs.writeFileSync(path.join(workspacePath, 'img-primary.bin'), Buffer.alloc(2048, 0x64));
  // Workspace-relative — production extraction data never stores absolute
  // filesystem paths (FIX-A round 2 rejects them outright).
  return 'img-primary.bin';
}

function seedItem(ext: Record<string, unknown>) {
  const batchId = createBatch({ workspaceId, name: 'B', fileName: 'b.xlsx', totalItems: 1 }).id;
  const [item] = insertItems(batchId, [
    { upc: randomUUID().slice(0, 13), name: 'Test Product', brandHint: 'Acme', rowNumber: 1 },
  ]);
  getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?')
    .run(JSON.stringify(ext), item.id);
  return findItemById(item.id)!;
}

function makeSnapshot(vlmBaseUrl: string) {
  upsertApiKey('ollama_vlm', 'enabled', vlmBaseUrl, 'stage-test-vlm');
  const candidate = generateCandidate(BayStatePetGardenSeed, HB_EVIDENCE);
  return buildRuntimeSnapshot({
    workspaceId,
    workspacePath,
    productSku: 'SKU-SHADOW',
    authority: { kind: 'v2' as const, bundle: candidate.bundle },
    configSnapshotRef: {
      id: candidate.bundle.manifest.bundleHash,
      hash: candidate.bundle.manifest.bundleHash,
      sourceCommit: null,
      createdAt: new Date().toISOString(),
    },
    sourceProductHash: '',
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-shadow-'));
  initDb(path.join(tmpDir, '.baystate-cms', 'app.db'));
  runMigrations();
  resetOcrStageFlagsOverride();
});

afterEach(() => {
  closeDb();
  resetOcrStageFlagsOverride();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('packaging_ocr_shadow_comparisons migration + repo', () => {
  it('creates the table and supports insert / list-by-item / count', () => {
    seedWorkspace();
    const batchId = createBatch({ workspaceId, name: 'B2', fileName: 'b2.xlsx', totalItems: 1 }).id;
    const [item] = insertItems(batchId, [{ upc: '1', name: 'X', rowNumber: 1 }]);
    const row = insertPackagingOcrShadowComparison({
      itemId: item.id,
      batchId,
      runId: 'run-1',
      legacyStatus: 'succeeded',
      legacyReason: null,
      stageStatus: 'failed',
      stageReason: 'timeout',
      fieldAgreementJson: '{"productName":{"agree":false}}',
    });
    expect(row.id).toBeTruthy();

    const listed = listPackagingOcrShadowComparisonsByItem(item.id);
    expect(listed.length).toBe(1);
    expect(listed[0].itemId).toBe(item.id);
    expect(listed[0].legacyStatus).toBe('succeeded');
    expect(listed[0].stageStatus).toBe('failed');
    expect(countPackagingOcrShadowComparisons(item.id)).toBe(1);
    expect(countPackagingOcrShadowComparisons(randomUUID())).toBe(0);
  });

  it('redacts and caps legacy_reason/stage_reason at write time (post-review fixup 7d)', () => {
    seedWorkspace();
    const batchId = createBatch({ workspaceId, name: 'B3', fileName: 'b3.xlsx', totalItems: 1 }).id;
    const [item] = insertItems(batchId, [{ upc: '2', name: 'Y', rowNumber: 1 }]);
    const secretReason = `Authorization: Bearer super-secret-token-value and ${'x'.repeat(900)}`;
    insertPackagingOcrShadowComparison({
      itemId: item.id,
      batchId,
      runId: null,
      legacyStatus: 'failed',
      legacyReason: secretReason,
      stageStatus: 'failed',
      stageReason: 'http_error with api_key=plain-secret-key-42 at https://internal.example.com/vlm',
      fieldAgreementJson: null,
    });
    const [row] = listPackagingOcrShadowComparisonsByItem(item.id);
    expect(row.legacyReason).toContain('[REDACTED]');
    expect(row.legacyReason).not.toContain('super-secret-token-value');
    expect((row.legacyReason ?? '').length).toBeLessThanOrEqual(500);
    expect(row.stageReason).toContain('[REDACTED]');
    expect(row.stageReason).not.toContain('plain-secret-key-42');
    expect((row.stageReason ?? '').length).toBeLessThanOrEqual(500);
  });

  it('parseOcrShadowRetentionDays: integer env with default fallback (post-review fixup 6)', () => {
    expect(parseOcrShadowRetentionDays(undefined)).toBe(30);
    expect(parseOcrShadowRetentionDays(null)).toBe(30);
    expect(parseOcrShadowRetentionDays('')).toBe(30);
    expect(parseOcrShadowRetentionDays('   ')).toBe(30);
    expect(parseOcrShadowRetentionDays('garbage')).toBe(30);
    expect(parseOcrShadowRetentionDays('-3')).toBe(30);
    expect(parseOcrShadowRetentionDays('1.5')).toBe(30);
    expect(parseOcrShadowRetentionDays('7')).toBe(7);
    expect(parseOcrShadowRetentionDays('0')).toBe(0);
  });

  it('deleteOlderThan prunes only rows created before the cutoff (post-review fixup 6)', () => {
    seedWorkspace();
    const batchId = createBatch({ workspaceId, name: 'B4', fileName: 'b4.xlsx', totalItems: 2 }).id;
    const items = insertItems(batchId, [
      { upc: 'R1', name: 'Old', rowNumber: 1 },
      { upc: 'R2', name: 'New', rowNumber: 2 },
    ]);
    const oldRow = insertPackagingOcrShadowComparison({
      itemId: items[0].id, batchId, runId: null,
      legacyStatus: 'succeeded', legacyReason: null,
      stageStatus: 'succeeded', stageReason: null, fieldAgreementJson: null,
    });
    insertPackagingOcrShadowComparison({
      itemId: items[1].id, batchId, runId: null,
      legacyStatus: 'succeeded', legacyReason: null,
      stageStatus: 'succeeded', stageReason: null, fieldAgreementJson: null,
    });
    // Backdate the first row beyond any plausible cutoff.
    getDb().query("UPDATE packaging_ocr_shadow_comparisons SET created_at = ? WHERE id = ?")
      .run('2020-01-01T00:00:00.000Z', oldRow.id);

    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const deleted = deleteOlderThan(cutoff);
    expect(deleted).toBe(1);
    expect(countPackagingOcrShadowComparisons(items[0].id)).toBe(0);
    expect(countPackagingOcrShadowComparisons(items[1].id)).toBe(1);
  });
});

describe('comparePackagingOcrResults (pure)', () => {
  const base = { species: [], healthConcernFunction: [], dietaryLabels: [], ingredients: [], ingredientKeywords: [], claims: [], visibleTextLines: [], confidenceByField: {} };

  it('marks agreement and disagreement per scalar field with capped values', () => {
    const legacy = {
      ...base,
      productName: 'Same Name',
      brand: 'Legacy Brand',
      weight: 'x'.repeat(500),
    } as unknown as PackagingOcrData;
    const stage = {
      ...base,
      productName: 'Same Name',
      brand: 'Stage Brand',
      weight: 'y'.repeat(10),
    } as unknown as PackagingOcrData;

    const agreement = comparePackagingOcrResults(legacy, stage);
    expect(agreement.productName).toEqual({ agree: true, legacyValue: 'Same Name', stageValue: 'Same Name' });
    expect(agreement.brand?.agree).toBe(false);
    // Value capped at 200 chars.
    expect((agreement.weight?.legacyValue ?? '').length).toBe(200);
    expect(agreement.weight?.agree).toBe(false);
  });

  it('returns an empty map when either side is missing', () => {
    expect(comparePackagingOcrResults(null, null)).toEqual({});
  });
});

describe('dual-run comparison writer', () => {
  it('writes a comparison row comparing legacy vs stage results for the same item/run', async () => {
    const { server, port } = await startOllamaServer(STAGE_OCR_JSON);
    try {
      seedWorkspace();
      const img = seedLocalImage();
      const snapshot = makeSnapshot(`http://127.0.0.1:${port}`);
      const item = seedItem({
        title: 'Web Title',
        primaryImage: img,
        // Legacy inline result already stored — the dual-run baseline.
        packagingOcrData: { productName: 'Legacy Name', brand: 'Acme', confidenceByField: { productName: 0.8 } },
        ocrOutcome: { status: 'succeeded', model: 'legacy-vlm', imageCount: 1 },
      });
      overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: false, packagingOcrDualRunCompare: true });

      const result = await packagingOcrStage.execute(
        { sku: item.upc, onboardingItemId: item.id, sourceKind: 'catalog_product', evidence: [], acceptedProposals: [], allProposals: [] },
        { workspacePath, workspaceId, configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: new Date().toISOString() }, runId: String(createRun(workspaceId, 'SKU-SHADOW', null, null, { sourceKind: 'onboarding' }).id), snapshot, modelFetchFn: ((globalThis as any).Bun?.fetch ?? globalThis.fetch) } as any,
      );
      expect(result.status).toBe('succeeded');

      const rows = listPackagingOcrShadowComparisonsByItem(item.id);
      expect(rows.length).toBe(1);
      expect(rows[0].runId).toBeTruthy();
      expect(rows[0].batchId).toBe(item.batchId);
      expect(rows[0].legacyStatus).toBe('succeeded');
      expect(rows[0].stageStatus).toBe('succeeded');
      const agreement = JSON.parse(rows[0].fieldAgreementJson!) as Record<string, any>;
      expect(agreement.productName.agree).toBe(false);
      expect(agreement.productName.legacyValue).toBe('Legacy Name');
      expect(agreement.productName.stageValue).toBe('Stage Kibble');
      expect(agreement.brand?.agree).toBe(true);
    } finally {
      server.close();
    }
  });

  it('writes NO comparison row when no legacy inline result exists', async () => {
    const { server, port } = await startOllamaServer(STAGE_OCR_JSON);
    try {
      seedWorkspace();
      const img = seedLocalImage();
      const snapshot = makeSnapshot(`http://127.0.0.1:${port}`);
      const item = seedItem({ title: 'Fresh Item', primaryImage: img });
      overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: false, packagingOcrDualRunCompare: true });

      await packagingOcrStage.execute(
        { sku: item.upc, onboardingItemId: item.id, sourceKind: 'catalog_product', evidence: [], acceptedProposals: [], allProposals: [] },
        { workspacePath, workspaceId, configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: new Date().toISOString() }, runId: String(createRun(workspaceId, 'SKU-SHADOW', null, null, { sourceKind: 'onboarding' }).id), snapshot, modelFetchFn: ((globalThis as any).Bun?.fetch ?? globalThis.fetch) } as any,
      );

      expect(countPackagingOcrShadowComparisons(item.id)).toBe(0);
    } finally {
      server.close();
    }
  });

  it('shadow-only + dual-run: comparison rows are written while live keys stay untouched', async () => {
    const { server, port } = await startOllamaServer(STAGE_OCR_JSON);
    try {
      seedWorkspace();
      const img = seedLocalImage();
      const snapshot = makeSnapshot(`http://127.0.0.1:${port}`);
      const legacyExt = {
        title: 'Web Title',
        primaryImage: img,
        packagingOcrData: { productName: 'Legacy Name', confidenceByField: {} },
        packagingTitle: 'Legacy Name',
        ocrOutcome: { status: 'succeeded', model: 'legacy-vlm', imageCount: 1 },
        ocrInputHash: 'legacy-hash',
        ocrExecutionDigest: 'legacy-digest',
      };
      const item = seedItem(legacyExt);
      overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: true, packagingOcrDualRunCompare: true });

      await packagingOcrStage.execute(
        { sku: item.upc, onboardingItemId: item.id, sourceKind: 'catalog_product', evidence: [], acceptedProposals: [], allProposals: [] },
        { workspacePath, workspaceId, configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: new Date().toISOString() }, runId: String(createRun(workspaceId, 'SKU-SHADOW', null, null, { sourceKind: 'onboarding' }).id), snapshot, modelFetchFn: ((globalThis as any).Bun?.fetch ?? globalThis.fetch) } as any,
      );

      // Comparison observed…
      expect(countPackagingOcrShadowComparisons(item.id)).toBe(1);
      // …but the live extraction keys are EXACTLY the legacy values.
      const stored = JSON.parse(String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(item.id) as any).extraction_data_json)) as Record<string, any>;
      expect(stored.packagingOcrData).toEqual(legacyExt.packagingOcrData);
      expect(stored.packagingTitle).toBe('Legacy Name');
      expect(stored.ocrOutcome).toEqual(legacyExt.ocrOutcome);
      expect(stored.ocrInputHash).toBe('legacy-hash');
      expect(stored.ocrExecutionDigest).toBe('legacy-digest');
      expect((stored.shadowPackagingOcrData as any).productName).toBe('Stage Kibble');
    } finally {
      server.close();
    }
  });
});

// ─── P2 follow-ups: stale-shadow hygiene + dual-run baseline-drift guard ──────

describe('P2 stale-shadow hygiene', () => {
  it('shadow-only run on a NO-IMAGE item clears a stale shadowPackagingOcrData key', async () => {
    seedWorkspace();
    const item = seedItem({
      title: 'Lost Its Image',
      // No primaryImage → the coded no_image branch.
      shadowPackagingOcrData: { productName: 'Stale Observation', confidenceByField: {} },
    });
    overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: true });

    const result = await packagingOcrStage.execute(
      { sku: item.upc, onboardingItemId: item.id, sourceKind: 'catalog_product', evidence: [], acceptedProposals: [], allProposals: [] },
      { workspacePath, workspaceId, configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: new Date().toISOString() }, runId: 'run-stale-1' } as any,
    );
    expect(result.status).toBe('succeeded');

    // JSON.stringify drops the null-valued key — absence IS the cleared state.
    expect(findItemById(item.id)!.extractionData?.shadowPackagingOcrData ?? null).toBeNull();
  });

  it('shadow-only run on a distributor_record item clears a stale shadowPackagingOcrData key', async () => {
    seedWorkspace();
    const batchId = createBatch({ workspaceId, name: 'B3', fileName: 'b3.xlsx', totalItems: 1 }).id;
    const [raw] = insertItems(batchId, [{ upc: randomUUID().slice(0, 13), name: 'Distro Item', brandHint: null, rowNumber: 1 }]);
    getDb().query("UPDATE onboarding_items SET source_type = 'distributor_record', extraction_data_json = ? WHERE id = ?")
      .run(JSON.stringify({ title: 'Distro Title', shadowPackagingOcrData: { productName: 'Stale Observation' } }), raw.id);
    const item = findItemById(raw.id)!;
    overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: true });

    const result = await packagingOcrStage.execute(
      { sku: item.upc, onboardingItemId: item.id, sourceKind: 'catalog_product', evidence: [], acceptedProposals: [], allProposals: [] },
      { workspacePath, workspaceId, configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: new Date().toISOString() }, runId: 'run-stale-2' } as any,
    );
    expect(result.status).toBe('succeeded');

    // JSON.stringify drops the null-valued key — absence IS the cleared state.
    expect(findItemById(item.id)!.extractionData?.shadowPackagingOcrData ?? null).toBeNull();
  });
});

describe('P2 dual-run baseline-drift guard', () => {
  it('second consecutive non-shadow stage run writes NO further comparison row (stage-authored baseline)', async () => {
    const { server, port } = await startOllamaServer(STAGE_OCR_JSON);
    try {
      seedWorkspace();
      const img = seedLocalImage();
      const snapshot = makeSnapshot(`http://127.0.0.1:${port}`);
      const item = seedItem({
        title: 'Web Title',
        primaryImage: img,
        packagingOcrData: { productName: 'Legacy Name', brand: 'Acme', confidenceByField: { productName: 0.8 } },
        ocrOutcome: { status: 'succeeded', model: 'legacy-vlm', imageCount: 1 },
      });
      overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: false, packagingOcrDualRunCompare: true });
      const makeCtx = () => ({
        workspacePath,
        workspaceId,
        configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: new Date().toISOString() },
        runId: String(createRun(workspaceId, 'SKU-SHADOW', null, null, { sourceKind: 'onboarding' }).id),
        snapshot,
        modelFetchFn: ((globalThis as any).Bun?.fetch ?? globalThis.fetch),
      } as any);
      const input = { sku: item.upc, onboardingItemId: item.id, sourceKind: 'catalog_product', evidence: [], acceptedProposals: [], allProposals: [] };

      // Run 1: genuine legacy baseline present → exactly one comparison row.
      const first = await packagingOcrStage.execute(input as any, makeCtx());
      expect(first.status).toBe('succeeded');
      expect(countPackagingOcrShadowComparisons(item.id)).toBe(1);

      // Run 2: live keys are now STAGE-authored (marker written with them) —
      // comparing stage-vs-stage would be meaningless; no new row.
      const second = await packagingOcrStage.execute(input as any, makeCtx());
      expect(second.status).toBe('succeeded');
      expect(countPackagingOcrShadowComparisons(item.id)).toBe(1);

      // The marker key was persisted alongside the live authority keys.
      expect(typeof findItemById(item.id)!.extractionData?.packagingOcrStageRunId).toBe('string');
    } finally {
      server.close();
    }
  });
});
