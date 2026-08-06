/**
 * Product Intelligence → Onboarding import tests (PI-8).
 *
 * DB-backed (bun test). Covers create, augment, idempotency, atomicity,
 * merge policy (excluded/overridden/deduped values), stale-state
 * invalidation, the promotion gate, shadow-mode denial, newer-run
 * coexistence, and the HTTP import route.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/25
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { findItemById, insertItems, listItemsByBatch } from '../../db/repositories/onboarding-item-repo';
import {
  createPiRun,
  deletePiRun,
  getPiImportByRunAndItem,
  insertPiAsset,
  insertPiResult,
  listPiImportsByRun,
  transitionPiRunStatus,
} from '../../db/repositories/product-intelligence-repo';
import {
  DEFAULT_PRODUCT_INTELLIGENCE_FLAGS,
  overrideProductIntelligenceFlags,
} from '../../product-intelligence/flags';
import {
  importRunToOnboarding,
  verifyImportedResultGate,
} from '../../product-intelligence/onboarding-import';
import { validSubmission } from './product-intelligence/test-helpers';
import app from '../../server/app';

const wsId = 'pi-import-test-workspace';

function makeCompletedRun(gtin: string, registerName: string, envelope: unknown) {
  const run = createPiRun({
    workspaceId: wsId,
    mode: 'shadow',
    executor: 'pi',
    inputJson: JSON.stringify({ gtin, registerName }),
    policyJson: JSON.stringify({ configId: 'cfg' }),
    configSnapshotId: 'cfg',
    configSnapshotHash: 'cfg',
  });
  transitionPiRunStatus(run.id, 'completed', {});
  insertPiResult({ runId: run.id, schemaVersion: 1, disposition: 'submitted', result: envelope });
  return run.id;
}

function envelopeWithTitle(title: string, extra: Record<string, unknown> = {}) {
  const base = validSubmission();
  return {
    ...base,
    productProposal: { fields: [{ field: 'title', value: title, evidenceIds: ['ev-gtin-1'] }] },
    ...extra,
  };
}

describe('PI-8 onboarding import', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-import-test.db');

  beforeAll(() => {
    try {
      resetDb();
    } catch {
      // ok
    }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Import Test',
      workspacePath: '/tmp/pi-import-workspace',
      gitPath: '/tmp/pi-import-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    overrideProductIntelligenceFlags({
      productIntelligenceEnabled: true,
      piEnabled: true,
      shadowOnly: false,
      allowOnboardingImport: true,
      allowBatchRuns: false,
    });
  });

  afterAll(() => {
    overrideProductIntelligenceFlags(DEFAULT_PRODUCT_INTELLIGENCE_FLAGS);
    closeDb();
    try {
      unlinkSync(testDbPath);
    } catch {
      // ok
    }
  });

  function seedAsset(runId: string, commerceApproved: boolean) {
    return insertPiAsset({
      runId,
      sourceId: null,
      sourceUrl: 'https://cdn.example.com/i.jpg',
      sourcePageUrl: 'https://brand.example.com/p/1',
      sourceType: 'supplier',
      sourcePath: 'json_ld.image',
      sourceArtifactId: 'a1',
      extractionMethod: 'media_api',
      retrievedAt: '2026-08-05T00:00:00.000Z',
      originalContentHash: 'c'.repeat(64),
      perceptualHash: 'phash',
      variantReference: null,
      rightsStatus: 'approved',
      rightsBasis: 'supplier_authorized_asset',
      rightsEvidenceRef: 'ev:supplier-1',
      observedBrand: null,
      observedProductName: null,
      observedVariant: null,
      observedNetContent: null,
      observedPackCount: null,
      observedGtin: null,
      exactProductMatch: true,
      exactVariantMatch: true,
      qualityStatus: 'usable',
      commerceApproved,
      conflicts: [],
      payload: {},
    });
  }

  it('create: batch + item created from a reviewed run with approved images only', () => {
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelopeWithTitle('Stella & Chewys Chicken Broth 16 oz'));
    seedAsset(runId, true);
    seedAsset(runId, false);

    const result = importRunToOnboarding(runId, { mode: 'create', importingUser: 'tester' });
    expect(result.created).toBe(true);
    expect(result.importRecord.mode).toBe('create');
    expect(result.importRecord.status).toBe('active');
    expect(result.importRecord.importingUser).toBe('tester');

    const item = findItemById(result.item.id);
    expect(item).toBeTruthy();
    expect(item?.upc).toBe('085000079585');
    expect(item?.name).toBe('STELLA CHKN BROTH 16OZ');

    const evidence = item?.extractionData?.productIntelligenceEvidence;
    expect(evidence).toBeTruthy();
    expect(evidence?.[0]?.runId).toBe(runId);
    expect(evidence?.[0]?.resultHash).toBeTruthy();
    expect(evidence?.[0]?.approvedImageIds).toHaveLength(1); // only commerce-approved
  });

  it('create is idempotent: second import is a no-op on the same item', () => {
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelopeWithTitle('Stella & Chewys Chicken Broth 16 oz'));
    const first = importRunToOnboarding(runId, { mode: 'create' });
    const second = importRunToOnboarding(runId, { mode: 'create' });
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(listItemsByBatch(first.batchId as string)).toHaveLength(1);
  });

  it('augment: writes imported evidence, records overridden values, leaves item fields untouched', () => {
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', {
      submission: envelopeWithTitle('Stella & Chewys Chicken Broth 16 oz', {
        productProposal: {
          fields: [
            { field: 'title', value: 'Stella & Chewys Chicken Broth 16 oz', evidenceIds: ['ev-gtin-1'] },
            { field: 'price', value: '12.99', evidenceIds: ['ev-price-1'] },
          ],
        },
      }),
    });
    const batch = createBatch({ workspaceId: wsId, name: 'augment seed', fileName: 'seed', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '085000079585', name: 'Existing Product', rowNumber: 1 }]);

    const result = importRunToOnboarding(runId, { mode: 'augment', onboardingItemId: item.id });
    expect(result.created).toBe(true);
    const refreshed = findItemById(item.id);
    expect(refreshed?.name).toBe('Existing Product'); // never overwritten
    expect(refreshed?.price).toBeNull();
    const evidence = refreshed?.extractionData?.productIntelligenceEvidence;
    expect(evidence?.[0]?.evidence.map((e) => e.field)).toContain('price');
    expect(JSON.parse(result.importRecord.overriddenValuesJson)).toMatchObject({ price: '12.99' });
    expect(JSON.parse(result.importRecord.excludedValuesJson)).toMatchObject({ title: { itemValue: 'Existing Product', importedValue: 'Stella & Chewys Chicken Broth 16 oz' } });
  });

  it('augment: conflicting manual value is excluded, identical value is deduped', () => {
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', {
      productProposal: {
        fields: [
          { field: 'title', value: 'New Imported Title', evidenceIds: ['ev-1'] },
          { field: 'price', value: '9.99', evidenceIds: ['ev-2'] },
        ],
      },
    });
    const batch = createBatch({ workspaceId: wsId, name: 'conflict seed', fileName: 'seed', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '085000079585', name: 'Manual Title', price: '9.99', rowNumber: 1 }]);

    const result = importRunToOnboarding(runId, { mode: 'augment', onboardingItemId: item.id });
    const excluded = JSON.parse(result.importRecord.excludedValuesJson) as Record<string, unknown>;
    expect(excluded.title).toEqual({ itemValue: 'Manual Title', importedValue: 'New Imported Title' });
    // Identical price is neither excluded nor overridden nor written.
    const overridden = JSON.parse(result.importRecord.overriddenValuesJson) as Record<string, unknown>;
    expect(overridden.price).toBeUndefined();
    expect(excluded.price).toBeUndefined();
    const refreshed = findItemById(item.id);
    expect(refreshed?.extractionData?.productIntelligenceEvidence?.[0]?.evidence.map((e) => e.field)).not.toContain('title');
    expect(refreshed?.extractionData?.productIntelligenceEvidence?.[0]?.evidence.map((e) => e.field)).not.toContain('price');
  });

  it('deletePiRun marks imports stale and the promotion gate rejects a missing origin', () => {
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelopeWithTitle('Title'));
    const { item } = importRunToOnboarding(runId, { mode: 'create' });
    const gateBefore = verifyImportedResultGate(findItemById(item.id) as never);
    expect(gateBefore).toEqual({ ok: true });

    expect(deletePiRun(runId)).toBe(true);
    const record = listPiImportsByRun(runId);
    expect(record).toHaveLength(0); // run_id nulled + row query by runId returns nothing
    const gate = verifyImportedResultGate(findItemById(item.id) as never);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain('missing');
  });

  it('promotion gate rejects a mismatched result hash and passes normal items', async () => {
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelopeWithTitle('Title'));
    const { item } = importRunToOnboarding(runId, { mode: 'create' });
    const { getDb } = await import('../../db/connection');
    const db = getDb();
    const refreshed = findItemById(item.id);
    const extraction = (refreshed?.extractionData ?? {}) as Record<string, unknown>;
    const piEvidence = (Array.isArray(extraction.productIntelligenceEvidence)
      ? extraction.productIntelligenceEvidence
      : [{}]) as Array<Record<string, unknown>>;
    const tampered = {
      ...extraction,
      productIntelligenceEvidence: [{ ...(piEvidence[0] ?? {}), resultHash: 'deadbeef' }],
    };
    db.run('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?', [JSON.stringify(tampered), item.id]);
    const gate = verifyImportedResultGate(findItemById(item.id) as never);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain('no longer matches');

    // A plain item without PI evidence always passes.
    const batch = createBatch({ workspaceId: wsId, name: 'plain seed', fileName: 'seed', totalItems: 1 });
    const [plain] = insertItems(batch.id, [{ upc: '111111111111', name: 'Plain', rowNumber: 1 }]);
    expect(verifyImportedResultGate(plain)).toEqual({ ok: true });
  });

  it('shadowOnly blocks import entirely', () => {
    overrideProductIntelligenceFlags({ ...DEFAULT_PRODUCT_INTELLIGENCE_FLAGS, productIntelligenceEnabled: true, allowOnboardingImport: true, shadowOnly: true });
    try {
      const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelopeWithTitle('Title'));
      expect(() => importRunToOnboarding(runId, { mode: 'create' })).toThrow(/shadow/i);
    } finally {
      overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: true, shadowOnly: false, allowOnboardingImport: true, allowBatchRuns: false });
    }
  });

  it('a newer run import does not silently replace an older import', () => {
    const runA = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelopeWithTitle('Title A'));
    const runB = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelopeWithTitle('Title B'));
    const batch = createBatch({ workspaceId: wsId, name: 'newer seed', fileName: 'seed', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '085000079585', name: 'Item', rowNumber: 1 }]);

    importRunToOnboarding(runA, { mode: 'augment', onboardingItemId: item.id });
    importRunToOnboarding(runB, { mode: 'augment', onboardingItemId: item.id });

    const recordA = getPiImportByRunAndItem(runA, item.id);
    const recordB = getPiImportByRunAndItem(runB, item.id);
    expect(recordA?.status).toBe('active'); // NOT silently superseded
    expect(recordB?.status).toBe('active');

    // The item's evidence payload keeps BOTH runs (no silent replacement).
    const refreshed = findItemById(item.id);
    const entries = refreshed?.extractionData?.productIntelligenceEvidence ?? [];
    expect(entries.map((e) => e.runId).sort()).toEqual([runA, runB].sort());
    // Re-importing run A again refreshes only its own entry.
    importRunToOnboarding(runA, { mode: 'augment', onboardingItemId: item.id });
    const entries2 = findItemById(item.id)?.extractionData?.productIntelligenceEvidence ?? [];
    expect(entries2.map((e) => e.runId).sort()).toEqual([runA, runB].sort());
    expect(entries2).toHaveLength(2);
  });

  it('failures are atomic: no import rows or batches on a gate failure', () => {
    // Mismatched UPC on augment -> nothing written.
    const runId = makeCompletedRun('036000291452', 'OTHER PRODUCT', envelopeWithTitle('Other'));
    const batch = createBatch({ workspaceId: wsId, name: 'atomic seed', fileName: 'seed', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '085000079585', name: 'Item', rowNumber: 1 }]);
    expect(() => importRunToOnboarding(runId, { mode: 'augment', onboardingItemId: item.id })).toThrow(/UPC does not match/);
    expect(listPiImportsByRun(runId)).toHaveLength(0);

    // Unparseable result JSON on create -> no batch/item created.
    const badRun = createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: '085000079585', registerName: 'X' }),
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    });
    transitionPiRunStatus(badRun.id, 'completed', {});
    insertPiResult({ runId: badRun.id, schemaVersion: 1, disposition: 'submitted', result: { n: 1 } });
    getDb().run("UPDATE product_intelligence_results SET result_json = '{not json' WHERE run_id = ?", [badRun.id]);
    expect(() => importRunToOnboarding(badRun.id, { mode: 'create' })).toThrow(/could not be parsed/);
    expect(listPiImportsByRun(badRun.id)).toHaveLength(0);
  });

  it('route: 403 when disabled, 201 create, 200 idempotent, 404 cross-workspace', async () => {
    // Reset flags to defaults first: import disabled.
    overrideProductIntelligenceFlags(DEFAULT_PRODUCT_INTELLIGENCE_FLAGS);
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelopeWithTitle('Title'));
    const disabled = await app.request(`http://localhost/api/product-intelligence/runs/${runId}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'create' }),
    });
    expect(disabled.status).toBe(403);

    // Enable import.
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: true, shadowOnly: false, allowOnboardingImport: true, allowBatchRuns: false });
    const created = await app.request(`http://localhost/api/product-intelligence/runs/${runId}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'create' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { itemId: string; created: boolean };
    expect(body.created).toBe(true);

    const again = await app.request(`http://localhost/api/product-intelligence/runs/${runId}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'create' }),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { itemId: string }).itemId).toBe(body.itemId);

    // Cross-workspace run -> 404.
    insertWorkspace({
      id: 'other-import-workspace',
      name: 'Other',
      workspacePath: '/tmp/other-import',
      gitPath: '/tmp/other-import/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const otherRun = createPiRun({
      workspaceId: 'other-import-workspace',
      mode: 'shadow',
      executor: 'pi',
      inputJson: '{}',
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    });
    transitionPiRunStatus(otherRun.id, 'completed', {});
    const cross = await app.request(`http://localhost/api/product-intelligence/runs/${otherRun.id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'create' }),
    });
    expect(cross.status).toBe(404);
  });
});
