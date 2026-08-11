import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  findItemById,
  updateItemExtractionData,
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  getCohortRunById,
  getCurrentCohortRun,
  listCohortRunsByCohort,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import {
  freezeCohortForExecution,
  processCohort,
  verifyCohortRunFrozen,
} from '../../onboarding/cohort-curator';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
  getCohortCurationFlags,
} from '../../classification/flags';
import { hashCanonicalJson } from '../../shared/stable-id';
import type { ClassificationConfig } from '../../shared/schemas/classification';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CurationCohort } from '../../shared/schemas/cohorts';

let workspacePath: string;

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-worker-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

afterEach(() => resetCohortCurationFlagsOverride());

/**
 * Minimal legacy v1 classification config with EVERY curation target disabled.
 * With no enabled targets the modular pipeline emits no `reviewable_abstention`
 * (primary_product_type/attribute/category-page stages return succeeded-empty,
 * never abstained) and the name_consolidation stage always has title signals —
 * so a fully successful member run deterministically completes as `completed`
 * (parent status assertions stay exact).
 */
const V1_CONFIG: ClassificationConfig = {
  manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: '2026-08-01T12:00:00.000Z', updatedAt: '2026-08-01T12:00:00.000Z', fileVersions: {} },
  productTypes: [
    { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
  ],
  attributes: [
    { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'], valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }, { alias: 'beef', mapsTo: 'Beef' }], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Food' },
  ],
  attributeProfiles: [
    { id: 'dry-dog-food-profile', productTypeId: 'dry-dog-food', name: 'Dry Dog Food Profile', attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' as const, applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
  ],
  attributeMappings: [
    { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
  ],
  curationTargets: [
    { id: 'test-product-type', kind: 'product_type' as const, label: 'Test Product Type', enabled: false, selectionMode: 'single' as const, attributeId: null, catalogField: null, optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
    { id: 'test-pages', kind: 'page' as const, label: 'Test Pages', enabled: false, selectionMode: 'multiple' as const, attributeId: null, catalogField: null, optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 1 },
    { id: 'test-flavor', kind: 'product_field' as const, label: 'Test Flavor', enabled: false, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 2 },
  ],
  brands: [],
  guidance: [],
  modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
  dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
};

function newWorkspace(): { workspaceId: string; workspacePath: string } {
  const workspaceId = randomUUID();
  const wsPath = path.join(workspacePath, `ws-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: wsPath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  saveClassificationConfig(wsPath, V1_CONFIG);
  syncConfigToCache(workspaceId, loadClassificationConfig(wsPath));
  return { workspaceId, workspacePath: wsPath };
}

function settledExtraction(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    title: 'Original Web Title',
    brand: 'Acme',
    description: 'Original description',
    bulletPoints: ['Bullet one', 'Bullet two'],
    primaryImage: 'https://img.example.com/primary.jpg',
    additionalImages: ['https://img.example.com/alt1.jpg'],
    searchKeywords: 'kibble dog',
    customFields: { Flavor: 'Chicken' },
    fieldProvenance: { title: 'json-ld' },
    packagingTitle: 'Package OCR Title',
    packagingOcrData: {
      productName: 'Package OCR Name',
      brand: 'Acme',
      species: ['dog'],
      flavorVariety: 'Chicken',
      weight: '5 lb',
      confidenceByField: { productName: 0.95, weight: 0.8 },
      metadata: {
        imageSourceUrl: 'https://img.example.com/primary.jpg',
        model: 'test-vlm',
        extractedAt: new Date().toISOString(),
        modelCallIds: ['mock-call-1'],
      },
    },
    ocrOutcome: { status: 'succeeded', localStatus: 'succeeded', model: 'test-vlm', imageCount: 1 },
    productIntelligenceEvidence: [],
    ...overrides,
  };
}

/** ocrInputHash for the same canonical input set computeOcrInputHash uses. */
function expectedOcrInputHash(sourceUrl: string, ext: Record<string, any>): string {
  return hashCanonicalJson({
    sourceUrl,
    extractionSourceUrl: sourceUrl,
    primaryImage: ext.primaryImage ?? null,
    additionalImages: Array.isArray(ext.additionalImages) ? ext.additionalImages : [],
  });
}

/** Insert the batch + items, write extraction data, form cohorts, flip ready. */
function createReadyCohort(
  wsId: string,
  extByUpc: Record<string, Record<string, any>>,
): { batchId: string; items: OnboardingItem[]; cohorts: CurationCohort[] } {
  const itemsData: InsertItemData[] = Object.entries(extByUpc).map(([upc, ext], index) => ({
    upc,
    name: String(ext._name ?? ext.title ?? `Item ${upc}`),
    brandHint: String(ext._brandHint ?? ext.brand ?? 'Acme'),
    sourceUrl: String(ext._sourceUrl ?? `https://brand.example.com/${upc}`),
    rowNumber: index + 1,
    stage: 'curation' as const,
    stageStatus: 'pending' as const,
  }));
  const batchId = createBatch({ workspaceId: wsId, name: 'Worker Batch', fileName: 'worker.xlsx', totalItems: itemsData.length }).id;
  const items = insertItems(batchId, itemsData);
  for (const item of items) {
    const sourceUrl = item.sourceUrl ?? `https://brand.example.com/${item.upc}`;
    const ext: Record<string, any> = { ...extByUpc[item.upc] };
    delete ext._sourceUrl;
    delete ext._name;
    delete ext._brandHint;
    if (ext.ocrInputHash === undefined) {
      ext.ocrInputHash = expectedOcrInputHash(sourceUrl, ext);
    }
    updateItemExtractionData(item.id, JSON.stringify(ext));
    insertExtraction({
      itemId: item.id,
      sourceUrl,
      extractionDataJson: JSON.stringify(ext),
      extractionMethod: 'test',
      confidence: 1,
    });
  }
  const formed = refreshCandidateCohorts(wsId, batchId, listItemsByBatch(batchId));
  for (const cohort of formed) updateCohortStatus(cohort.id, 'ready');
  return { batchId, items: listItemsByBatch(batchId), cohorts: formed };
}

/** Await all in-flight worker promises (claim dispatch is fire-and-forget). */
async function drainWorker(worker: OnboardingWorker): Promise<void> {
  await worker.drain();
}

/** Count parent cohort runs in the workspace. */
function cohortRunCount(wsId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM classification_cohort_runs WHERE workspace_id = ?',
  ).get(wsId) as { cnt: number };
  return Number(row.cnt);
}

/** True when ANY classification run for these items was created WITHOUT cohort linkage (the legacy per-item path). */
function hasLegacyPerItemRuns(itemIds: string[]): boolean {
  const placeholders = itemIds.map(() => '?').join(', ');
  const row = getDb().query(
    `SELECT COUNT(*) AS cnt FROM classification_runs
     WHERE onboarding_item_id IN (${placeholders}) AND cohort_run_id IS NULL`,
  ).get(...itemIds) as { cnt: number };
  return Number(row.cnt) > 0;
}

/** Every classification run for these items must be a cohort-linked child. */
function assertAllRunsCohortLinked(itemIds: string[]): void {
  expect(hasLegacyPerItemRuns(itemIds)).toBe(false);
}

describe('OnboardingWorker Curation cohort integration (issue #30, PR3 M3)', () => {
  it('flag OFF: poll claims per-item curation exactly as today — no cohort runs are ever created', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // The per-item Curation path claimed + curated each item (legacy runs,
    // no cohort linkage), and NO cohort run row exists.
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stage).toBe('curation');
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData).not.toBeNull();
    }
    expect(cohortRunCount(workspaceId)).toBe(0);
    expect(hasLegacyPerItemRuns(items.map(i => i.id))).toBe(true);
  });

  it('flag ON: poll claims ready cohorts (freezing rows + lease), freezes, executes, completes — zero per-item curation claims', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // Exactly one cohort run row, terminal with a valid completion status.
    const runs = getDb().query(
      'SELECT * FROM classification_cohort_runs WHERE workspace_id = ?',
    ).all(workspaceId) as Array<Record<string, any>>;
    expect(runs.length).toBe(1);
    const run = getCohortRunById(String(runs[0].id))!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(run.status);
    expect(run.status).not.toBe('failed');
    expect(run.claimedBy).not.toBeNull();
    expect(run.claimedAt).not.toBeNull();
    expect(run.leaseExpiresAt).not.toBeNull();
    expect(run.startedAt).not.toBeNull();

    // Members were executed through the cohort path and advanced to completed.
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData).not.toBeNull();
    }
    // The per-item Curation claim was NEVER invoked: every run for these
    // items is a cohort-linked child (freeze-created), none legacy.
    assertAllRunsCohortLinked(items.map(i => i.id));
  });

  it('flag ON + shadowOnly: no cohort claiming at all — the legacy per-item path stays in place', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // Shadow observes only: no cohort run rows, items curated via the legacy
    // per-item path (runs without cohort linkage).
    expect(cohortRunCount(workspaceId)).toBe(0);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData).not.toBeNull();
    }
    expect(hasLegacyPerItemRuns(items.map(i => i.id))).toBe(true);
  });

  it('completed run is NOT re-claimed while the frozen world matches; evidence drift supersedes it and a fresh run replaces it', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);
    expect(cohortRunCount(workspaceId)).toBe(1);
    const firstRun = getCurrentCohortRun(firstCohortId(workspaceId))!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(firstRun.status);

    // A second poll with an unchanged world: the terminal run is the current
    // historical decision — reconcile keeps it, the claim is blocked.
    await worker.poll();
    await drainWorker(worker);
    expect(cohortRunCount(workspaceId)).toBe(1);
    expect(getCohortRunById(firstRun.id)!.status).toBe(firstRun.status);

    // Mutate extraction evidence → the next poll reconciles drift, supersedes
    // the old run and claims a FRESH run that executes the new state.
    const live = findItemById(items[0].id)!;
    updateItemExtractionData(items[0].id, JSON.stringify({ ...live.extractionData, brand: 'CHANGED BRAND' }));

    await worker.poll();
    await drainWorker(worker);
    expect(cohortRunCount(workspaceId)).toBe(2);
    const history = listCohortRunsByCohort(firstRun.cohortId);
    expect(history.length).toBe(2);
    const oldRun = history.find(r => r.id === firstRun.id)!;
    expect(oldRun.status).toBe('superseded');
    expect(oldRun.errorMessage).toContain('pre-claim reconciliation');
    const newRun = history.find(r => r.id !== firstRun.id)!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(newRun.status);
    // The fresh run executed against the mutated evidence.
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
  });

  it('reclaim in poll (match): an expired freezing lease resumes the SAME run id, then freezes + executes', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    // A previous (crashed) worker claimed the cohort and died mid-freeze.
    const [claimed] = claimReadyCurationCohorts(workspaceId, 10, 'crashed-worker', COHORT_LEASE_TTL_MS);
    expect(claimed.status).toBe('freezing');
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', claimed.id]);

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // Reclaim resumed the SAME run (never a new claim), and it executed.
    expect(cohortRunCount(workspaceId)).toBe(1);
    const resumed = getCohortRunById(claimed.id)!;
    expect(resumed.status).toBe('completed');
    expect(resumed.claimedBy).not.toBe('crashed-worker');
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
  });

  it('reclaim in poll (drift): an expired lease whose frozen world changed is superseded, then a fresh run is claimed and executes', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    // A previous worker claimed AND froze the run, then crashed mid-execution.
    const [claimed] = claimReadyCurationCohorts(workspaceId, 10, 'crashed-worker', COHORT_LEASE_TTL_MS);
    const frozen = await freezeCohortForExecution(claimed, wsPath, workspaceId);
    expect(frozen.status).toBe('running');
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', frozen.id]);

    // The world moved on while the owner was down → drift.
    const live = findItemById(items[0].id)!;
    updateItemExtractionData(items[0].id, JSON.stringify({ ...live.extractionData, title: 'MUTATED WHILE DOWN' }));
    expect(verifyCohortRunFrozen(frozen, wsPath, workspaceId)).toBe(false);

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    const history = listCohortRunsByCohort(frozen.cohortId);
    expect(history.length).toBe(2);
    expect(history.find(r => r.id === frozen.id)!.status).toBe('superseded');
    const fresh = history.find(r => r.id !== frozen.id)!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(fresh.status);
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
  });
});

describe('processCohort completion semantics (issue #30, PR3 M3)', () => {
  it('all members ok -> parent completes with completed; every item advances', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    const summary = await processCohort(finalized, wsPath, workspaceId);
    expect(summary.parentStatus).toBe('completed');
    expect(summary.completedMembers).toBe(2);
    expect(summary.memberCount).toBe(2);
    expect(summary.memberFailures).toEqual([]);

    const completed = getCohortRunById(finalized.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).not.toBeNull();
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const curationData = stored.curationData;
      expect(curationData).not.toBeNull();
      expect(curationData!.curatedTitle).not.toBeNull();
    }
  });

  it('member failure -> parent completes with completed_with_member_failures; surviving members still commit', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // Sabotage ONE member's frozen child snapshot ref so its prepared-cohort
    // context cannot be rebuilt — a deterministic member-level failure.
    const sabotaged = items[0].id;
    getDb().run(
      'UPDATE classification_runs SET config_snapshot_hash = ? WHERE cohort_run_id = ? AND onboarding_item_id = ?',
      ['deadbeef'.repeat(8), finalized.id, sabotaged],
    );

    const summary = await processCohort(finalized, wsPath, workspaceId);
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.completedMembers).toBe(1);
    expect(summary.memberFailures.length).toBe(1);
    expect(summary.memberFailures[0].itemId).toBe(sabotaged);
    expect(summary.memberFailures[0].error).toContain('frozen member runtime snapshot');

    const completed = getCohortRunById(finalized.id)!;
    expect(completed.status).toBe('completed_with_member_failures');
    expect(completed.errorMessage).toContain('1 member(s) failed');

    // The failed member is deterministic-failed in Curation (user reset to
    // retry); the surviving member committed fully.
    expect(findItemById(sabotaged)!.stageStatus).toBe('failed');
    const survivor = findItemById(items[1].id)!;
    expect(survivor.stageStatus).toBe('completed');
    expect(survivor.curationData).not.toBeNull();
  });

  it('cohort-level unreachable state -> parent completes with failed + error_message (write-once)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // The frozen execution-evidence contract disappears → the cohort-level
    // semantic state is unreachable: parent completes `failed` with a reason.
    // (The snapshot row itself is FK-referenced, so the run's hash is repointed
    // at a snapshot that does not exist instead of deleting the row.)
    getDb().run('UPDATE classification_cohort_runs SET evidence_snapshot_hash = ? WHERE id = ?', ['f'.repeat(64), finalized.id]);
    const unreachable = getCohortRunById(finalized.id)!;
    await expect(processCohort(unreachable, wsPath, workspaceId)).rejects.toThrow(/no persisted execution-evidence snapshot/);
    const failed = getCohortRunById(finalized.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.completedAt).not.toBeNull();
    expect(failed.errorMessage).toContain('no persisted execution-evidence snapshot');

    // Write-once: the terminal failure is never overwritten by a later completion.
    const { completeCohortRun } = await import('../../db/repositories/classification-cohort-run-repo');
    expect(completeCohortRun(finalized.id, 'completed')).toBe(false);
    expect(getCohortRunById(finalized.id)!.status).toBe('failed');
  });
});

/** The single cohort formed for the (singleton) batch. */
function firstCohortId(workspaceId: string): string {
  const row = getDb().query(
    'SELECT id FROM curation_cohorts WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1',
  ).get(workspaceId) as { id: string } | undefined;
  if (!row) throw new Error('no cohort formed');
  return row.id;
}

// Reference the exported execution types so the module graph is exercised.
export type { OnboardingItem };
