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
  insertPiEvidence,
  insertPiResult,
  insertPiSource,
  listPiImportsByRun,
  transitionPiRunStatus,
} from '../../db/repositories/product-intelligence-repo';
import {
  DEFAULT_PRODUCT_INTELLIGENCE_FLAGS,
  overrideProductIntelligenceFlags,
} from '../../product-intelligence/flags';
import {
  importRunToOnboarding,
  UnresolvedEvidenceError,
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

/** Seed a durable field-level evidence row + source (P1-1 normalized world). */
function seedFieldEvidence(
  runId: string,
  field: string,
  value: unknown,
  evidenceId: string,
  sourceUrl = 'https://supplier.example.com/p/1',
  extractionMethod = 'json_ld',
) {
  const source = insertPiSource({ runId, url: sourceUrl, domain: 'supplier.example.com', sourceType: 'supplier' });
  return insertPiEvidence({
    runId,
    sourceId: source.id,
    targetField: field,
    value,
    extractionMethod,
    snippet: `<${field}> ${String(value)}`,
    metadata: { toolEvidenceId: evidenceId, path: `jsonLd.${field}` },
  });
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

    // The selected price fact must resolve to durable field-level evidence (P1-1).
    seedFieldEvidence(runId, 'price', '12.99', 'ev-price-1');

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

  it('P1-1: resolves every selected fact from durable field-level evidence and carries provenance', () => {
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', {
      ...validSubmission(),
      productProposal: {
        fields: [
          { field: 'netContent', value: '16 oz', evidenceIds: ['ev-nc-1'] },
          { field: 'size', value: '16 oz', evidenceIds: ['ev-size-1'] },
        ],
      },
    });
    const source = insertPiSource({
      runId,
      url: 'https://brand.example.com/p/wormeze',
      domain: 'brand.example.com',
      sourceType: 'registry',
    });
    insertPiEvidence({
      runId,
      sourceId: source.id,
      targetField: 'netContent',
      value: '16 oz',
      extractionMethod: 'json_ld',
      snippet: '<span>16 oz</span>',
      metadata: { toolEvidenceId: 'ev-nc-1', path: 'jsonLd.offers.size' },
    });
    insertPiEvidence({
      runId,
      sourceId: source.id,
      targetField: 'size',
      value: '16 oz',
      extractionMethod: 'profile_selector',
      snippet: 'size 16 oz',
      metadata: { toolEvidenceId: 'ev-size-1' },
    });
    const batch = createBatch({ workspaceId: wsId, name: 'p1 seed', fileName: 'seed', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '085000079585', name: 'Item', rowNumber: 1 }]);

    const result = importRunToOnboarding(runId, { mode: 'augment', onboardingItemId: item.id });
    const refreshed = findItemById(item.id);
    const evidence = refreshed?.extractionData?.productIntelligenceEvidence?.[0]?.evidence ?? [];
    expect(evidence.map((e) => e.field).sort()).toEqual(['netContent', 'size']);
    const nc = evidence.find((e) => e.field === 'netContent');
    expect(nc?.evidenceId).toBe('ev-nc-1');
    expect(nc?.extractionMethod).toBe('json_ld');
    expect(nc?.snippet).toBe('<span>16 oz</span>');
    const size = evidence.find((e) => e.field === 'size');
    expect(size?.evidenceId).toBe('ev-size-1');
    expect(size?.extractionMethod).toBe('profile_selector');
    // Durable source row (URL/domain) rides through, never the runId.
    expect(refreshed?.extractionData?.productIntelligenceEvidence?.[0]?.sources?.[0]?.url).toBe('https://brand.example.com/p/wormeze');
    expect(JSON.parse(result.importRecord.importedEvidenceIdsJson)).toContain('ev-nc-1');
    expect(JSON.parse(result.importRecord.importedSourceIdsJson)).toContain(source.id);
  });

  it('P1-1: fails closed with a per-field report when a selected fact lacks durable evidence', () => {
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', {
      ...validSubmission(),
      productProposal: {
        fields: [
          { field: 'netContent', value: '16 oz', evidenceIds: ['ev-nc-1'] },
          { field: 'size', value: '16 oz', evidenceIds: ['ev-size-1'] },
        ],
      },
    });
    seedFieldEvidence(runId, 'netContent', '16 oz', 'ev-nc-1'); // size intentionally not seeded
    const batch = createBatch({ workspaceId: wsId, name: 'fail seed', fileName: 'seed', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '085000079585', name: 'Item', rowNumber: 1 }]);

    let caught: unknown = null;
    try {
      importRunToOnboarding(runId, { mode: 'augment', onboardingItemId: item.id });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const e = caught as { name?: string; unresolvedFields?: Array<{ field: string }> };
    expect(e.name).toBe('UnresolvedEvidenceError');
    expect(e.unresolvedFields?.map((f) => f.field)).toContain('size');
    expect(e.unresolvedFields?.map((f) => f.field)).not.toContain('netContent');
    // Atomic: no import record, no extraction payload written.
    expect(listPiImportsByRun(runId)).toHaveLength(0);
    expect(findItemById(item.id)?.extractionData?.productIntelligenceEvidence ?? []).toHaveLength(0);
  });

  it('P1-1: legacy envelope fails closed unless its evidence resolves to durable rows', () => {
    const envelope = {
      ...validSubmission(),
      productProposal: { fields: [{ field: 'netContent', value: '16 oz', evidenceIds: ['ev-gtin-1'] }] },
    };

    // No durable rows -> fail closed, nothing written.
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelope);
    const batch = createBatch({ workspaceId: wsId, name: 'legacy seed', fileName: 'seed', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '085000079585', name: 'Item', rowNumber: 1 }]);
    let caught: unknown = null;
    try {
      importRunToOnboarding(runId, { mode: 'augment', onboardingItemId: item.id });
    } catch (error) {
      caught = error;
    }
    expect((caught as { name?: string }).name).toBe('UnresolvedEvidenceError');
    expect(listPiImportsByRun(runId)).toHaveLength(0);

    // A durable legacy submission row (metadata.submissionEvidenceId) resolves.
    const runId2 = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', envelope);
    const source2 = insertPiSource({
      runId: runId2,
      url: 'https://supplier.example.com/p/x',
      domain: 'supplier.example.com',
      sourceType: 'supplier',
    });
    insertPiEvidence({
      runId: runId2,
      sourceId: source2.id,
      targetField: 'netContent',
      value: '16 oz',
      extractionMethod: 'manual',
      metadata: { submissionEvidenceId: 'ev-gtin-1' },
    });
    const batch2 = createBatch({ workspaceId: wsId, name: 'legacy seed 2', fileName: 'seed', totalItems: 1 });
    const [item2] = insertItems(batch2.id, [{ upc: '085000079585', name: 'Item', rowNumber: 1 }]);
    const result2 = importRunToOnboarding(runId2, { mode: 'augment', onboardingItemId: item2.id });
    const ev2 = findItemById(item2.id)?.extractionData?.productIntelligenceEvidence?.[0]?.evidence ?? [];
    expect(ev2.map((e) => e.field)).toContain('netContent');
    expect(ev2[0]?.extractionMethod).toBe('manual');
    expect(JSON.parse(result2.importRecord.importedSourceIdsJson)).toContain(source2.id);
  });

  it('P1-1: never fabricates evidence or source ids', () => {
    const runId = makeCompletedRun('085000079585', 'STELLA CHKN BROTH 16OZ', {
      ...validSubmission(),
      productProposal: { fields: [{ field: 'netContent', value: '16 oz', evidenceIds: ['ev-nc-1'] }] },
    });
    seedFieldEvidence(runId, 'netContent', '16 oz', 'ev-nc-1');
    const batch = createBatch({ workspaceId: wsId, name: 'nofab seed', fileName: 'seed', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '085000079585', name: 'Item', rowNumber: 1 }]);

    const result = importRunToOnboarding(runId, { mode: 'augment', onboardingItemId: item.id });
    const evidenceIds = JSON.parse(result.importRecord.importedEvidenceIdsJson) as string[];
    const sourceIds = JSON.parse(result.importRecord.importedSourceIdsJson) as string[];
    expect(evidenceIds).toContain('ev-nc-1');
    // No `${runId}:${field}` fabrications, no runId-as-source fallbacks.
    expect(evidenceIds.some((id) => /:netContent$/.test(id))).toBe(false);
    expect(evidenceIds.some((id) => id.startsWith(runId))).toBe(false);
    expect(sourceIds.some((id) => id === runId)).toBe(false);
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
    // P1-2: the import route now requires a durable human approval bound to
    // the exact stored result before any import may cross into onboarding.
    const reviewed = await app.request(`http://localhost/api/product-intelligence/runs/${runId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', reviewer: 'tester', note: 'route test' }),
    });
    expect(reviewed.status).toBe(201);
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

  it('value binding (finding 4): proposal value must equal its cited evidence value', () => {
    const runId = makeCompletedRun('085000079585', 'REGISTER', {
      productProposal: {
        fields: [{ field: 'description', value: 'Stella Chicken Treats', evidenceIds: ['ev-desc-1'] }],
      },
    });
    seedFieldEvidence(runId, 'description', 'Stella & Chewy Chicken Bone Broth', 'ev-desc-1');

    let caught: unknown;
    try {
      importRunToOnboarding(runId, { mode: 'create' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnresolvedEvidenceError);
    const entry = (caught as UnresolvedEvidenceError).unresolvedFields.find((f) => f.field === 'description');
    expect(entry).toBeTruthy();
    expect(entry?.reason).toMatch(/value mismatch/);
    expect(entry?.reason).toContain('Stella Chicken Treats');
    expect(entry?.reason).toContain('Stella & Chewy Chicken Bone Broth');
  });

  it('value binding (finding 4): a field with no citation is unresolved', () => {
    const runId = makeCompletedRun('085000079585', 'REGISTER', {
      productProposal: { fields: [{ field: 'description', value: 'Chicken Broth', evidenceIds: [] }] },
    });

    let caught: unknown;
    try {
      importRunToOnboarding(runId, { mode: 'create' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnresolvedEvidenceError);
    const entry = (caught as UnresolvedEvidenceError).unresolvedFields.find((f) => f.field === 'description');
    expect(entry).toBeTruthy();
    expect(entry?.reason).toMatch(/no citation/);
  });

  it('value binding (finding 4): a cited row targeting a different field is unresolved', () => {
    const runId = makeCompletedRun('085000079585', 'REGISTER', {
      productProposal: { fields: [{ field: 'size', value: '16 oz', evidenceIds: ['ev-size-1'] }] },
    });
    // Evidence row exists for the cited id but its targetField is description.
    seedFieldEvidence(runId, 'description', '16 oz', 'ev-size-1');

    let caught: unknown;
    try {
      importRunToOnboarding(runId, { mode: 'create' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnresolvedEvidenceError);
    const entry = (caught as UnresolvedEvidenceError).unresolvedFields.find((f) => f.field === 'size');
    expect(entry).toBeTruthy();
    expect(entry?.reason).toMatch(/field mismatch/);
  });

  it('value binding (finding 4): normalized equality passes (whitespace/case folded)', () => {
    const runId = makeCompletedRun('085000079585', 'REGISTER', {
      productProposal: {
        fields: [{ field: 'description', value: 'Stella & Chewy', evidenceIds: ['ev-desc-1'] }],
      },
    });
    seedFieldEvidence(runId, 'description', '  Stella & Chewy  ', 'ev-desc-1');

    const result = importRunToOnboarding(runId, { mode: 'create' });
    expect(result.created).toBe(true);
    const item = findItemById(result.item.id);
    const evidence = item?.extractionData?.productIntelligenceEvidence;
    expect(evidence?.[0]?.evidence.map((e) => e.field)).toContain('description');
  });

  it('value binding (finding 4): matching cited evidence imports the field (happy path)', () => {
    const runId = makeCompletedRun('085000079585', 'REGISTER', {
      productProposal: {
        fields: [{ field: 'description', value: 'Chicken Bone Broth', evidenceIds: ['ev-desc-1'] }],
      },
    });
    seedFieldEvidence(runId, 'description', 'Chicken Bone Broth', 'ev-desc-1');

    const result = importRunToOnboarding(runId, { mode: 'create' });
    expect(result.created).toBe(true);
    const item = findItemById(result.item.id);
    const evidence = item?.extractionData?.productIntelligenceEvidence;
    expect(evidence?.[0]?.evidence).toContainEqual(
      expect.objectContaining({ field: 'description', value: 'Chicken Bone Broth', evidenceId: 'ev-desc-1' }),
    );
  });
});
