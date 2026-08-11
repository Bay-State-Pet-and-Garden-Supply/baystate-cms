import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  updateItemExtractionData,
  findItemById,
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
  getCohortMembers,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  getCohortRunById,
  getCohortSnapshotByHash,
  cancelFreezingRun,
  supersedeCohortRun,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { createRun, getRun } from '../../db/repositories/classification-run-repo';
import { upsertConfigSnapshot, syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { saveClassificationConfig, loadClassificationConfig, loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../../classification/config-loader';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { buildRuntimeSnapshot, getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import {
  freezeCohortForExecution,
  buildExecutionEvidenceProjection,
  captureCohortAuthorities,
  verifyCohortRunFrozen,
  runFrozenOcrPullForward,
  computeOcrExecutionDigest,
  HeartbeatLostError,
  buildFrozenItem,
  buildFrozenProductLineContext,
} from '../../onboarding/cohort-curator';
import type { PreparedCohortContext } from '../../onboarding/cohort-curator';
import { curateItemWithPipeline } from '../../onboarding/product-curator';
import { canonicalJsonFileString, hashCanonicalJson, sha256Hex } from '../../shared/stable-id';
import { ClassificationManifestV2Schema, ClassificationFocusedFileNames } from '../../shared/schemas/classification';
import { ExecutionEvidenceProjectionV1Schema } from '../../shared/schemas/cohorts';
import type { CurationCohort, ExecutionEvidenceProjectionMemberV1 } from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { ClassificationConfig } from '../../shared/schemas/classification';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { computeExtractionHash } from '../../db/repositories/curation-cohort-repo';
import { reclaimExpiredCohortRuns } from '../../db/repositories/classification-cohort-run-repo';

let workspacePath: string;

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-freeze-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});
const EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

/** Minimal but valid legacy v1 classification config (mirrors the pipeline test). */
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
    { id: 'test-product-type', kind: 'product_type' as const, label: 'Test Product Type', enabled: true, selectionMode: 'single' as const, attributeId: null, catalogField: null, optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
    { id: 'test-pages', kind: 'page' as const, label: 'Test Pages', enabled: true, selectionMode: 'multiple' as const, attributeId: null, catalogField: null, optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 1 },
    { id: 'test-flavor', kind: 'product_field' as const, label: 'Test Flavor', enabled: true, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 2 },
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
  return { workspaceId, workspacePath: wsPath };
}

function saveV1Config(wsId: string, wsPath: string): void {
  saveClassificationConfig(wsPath, V1_CONFIG);
  syncConfigToCache(wsId, loadClassificationConfig(wsPath));
}

/**
 * Write a lifecycle-ACTIVE v2 bundle to disk WITHOUT the DB config-snapshot
 * row (the fail-closed seam) using the reviewed generator. Page curation
 * targets are disabled so the run-start readiness gate passes without a
 * verified Page import; `store/field-registry.json` attests the mapped Catalog
 * Fields; a real catalog-evidence artifact + git commit satisfy the active
 * catalog binding checks.
 */
function writeActiveV2Bundle(wsPath: string): { bundle: ReturnType<typeof generateCandidate>['bundle']; xmlFields: string[] } {
  const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
  const bundle = candidate.bundle;
  const xmlFields = [...new Set(bundle.attributeMappings.map(mapping => mapping.catalogField))];
  fs.writeFileSync(
    path.join(wsPath, 'store', 'field-registry.json'),
    JSON.stringify({ entries: xmlFields.map(xmlField => ({ xmlField })) }),
  );

  // Real git commit + real catalog-evidence artifact so the active loader's
  // catalog binding checks (commit ancestry + artifact hash) pass.
  const artifactPath = path.join(wsPath, 'store', 'classification', 'catalog-evidence.json');
  const artifactContent = JSON.stringify({ schemaVersion: 1, xmlFields });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, artifactContent);
  const catalogEvidenceHash = sha256Hex(artifactContent);
  let sourceCatalogCommit: string | null;
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'test evidence'], { cwd: wsPath, stdio: 'ignore' });
    sourceCatalogCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsPath, encoding: 'utf-8' }).trim();
  } catch (err) {
    throw new Error(`Unable to prepare the test git workspace for the active v2 bundle: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const targets = bundle.curationTargets.map(target => (
    target.kind === 'page'
      ? { ...target, enabled: false, mandatory: false }
      : target
  ));
  const adjusted = { ...bundle, curationTargets: targets };
  const focusedFiles = buildFocusedFiles(adjusted);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const manifestWithoutHash = {
    ...adjusted.manifest,
    activeRevision: 'bay-state-v2',
    lifecycle: 'active' as const,
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: { kind: 'reviewed_generation' as const },
    sourceCatalogCommit,
    catalogEvidenceHash,
    fileVersions,
  };
  const manifest = ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
  const dir = path.join(wsPath, 'store', 'classification');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), canonicalJsonFileString(manifest));
  for (const [name, content] of Object.entries(focusedFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { bundle: { ...adjusted, manifest }, xmlFields };
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

/** Run-scoped shared-state row counts (fix 1c race assertions). */
function tableCounts(): Record<string, number> {
  const tables = [
    'classification_model_calls',
    'classification_stage_results',
    'classification_evidence',
    'classification_proposals',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = getDb().query(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
    counts[table] = Number(row.cnt);
  }
  return counts;
}

function makeItemsData(extByUpc: Record<string, Record<string, any>>): InsertItemData[] {
  return Object.entries(extByUpc).map(([upc, ext], index) => ({
    upc,
    // `_name` is the spreadsheet register name used for candidate grouping
    // (stable name stem); `ext.title` stays the web-extracted title.
    name: String(ext._name ?? ext.title ?? `Item ${upc}`),
    brandHint: String(ext._brandHint ?? ext.brand ?? 'Acme'),
    sourceUrl: String(ext._sourceUrl ?? `https://brand.example.com/${upc}`),
    rowNumber: index + 1,
    stage: 'curation' as const,
    stageStatus: 'pending' as const,
  }));
}

/** Insert the batch + items, write extraction_data_json + extraction rows,
 *  form cohorts, and flip them to `ready`. `ocrInputHash` is injected into
 *  each item's extraction data (matching the current input set) so the freeze
 *  sees settled OCR. */
function createReadyCohort(
  wsId: string,
  extByUpc: Record<string, Record<string, any>>,
): { batchId: string; items: OnboardingItem[]; cohorts: CurationCohort[] } {
  const itemsData = makeItemsData(extByUpc);
  const batchId = createBatch({ workspaceId: wsId, name: 'Freeze Batch', fileName: 'freeze.xlsx', totalItems: itemsData.length }).id;
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

describe('execution-evidence projection builder (PR3 M2)', () => {
  it('builds a complete execution-evidence-v1 projection, members sorted by onboardingItemId', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, item.sourceUrl ?? '']));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);

    expect(projection.version).toBe('execution-evidence-v1');
    expect(projection.cohortId).toBe(cohort.id);
    expect(projection.batchId).toBe(cohort.batchId);
    expect(projection.groupingVersion).toBe('product-family-v1');
    // Sorted by onboardingItemId (deterministic hashing).
    const ids = projection.members.map(m => m.onboardingItemId);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(projection.members).toHaveLength(items.length);

    const byItem = new Map(items.map(item => [item.id, item]));
    for (const member of projection.members) {
      const item = byItem.get(member.onboardingItemId)!;
      expect(member.extractionComplete).toBe(true);
      expect(member.ordinal).toBeTypeOf('number');
      expect(member.productSku).toBe(item.upc);
      expect(member.sourceUrl ?? null).toBe(item.sourceUrl ?? null);
      expect(member.extractionSourceUrl).toBe(item.sourceUrl ?? null);
      expect(member.spreadsheetIdentity.name).toBe(item.name);
      expect(member.spreadsheetIdentity.brandHint).toBe(item.brandHint);
      expect(member.spreadsheetIdentity.rowNumber).toBe(item.rowNumber);
      expect(member.spreadsheetIdentity.upc).toBe(item.upc);
      expect(member.extraction.title).toBe('Original Web Title');
      expect(member.extraction.description).toBe('Original description');
      expect(member.extraction.brand).toBe('Acme');
      expect(member.extraction.bulletPoints).toEqual(['Bullet one', 'Bullet two']);
      expect(member.extraction.primaryImage).toBe('https://img.example.com/primary.jpg');
      expect(member.extraction.additionalImages).toEqual(['https://img.example.com/alt1.jpg']);
      expect(member.extraction.customFields).toEqual({ Flavor: 'Chicken' });
      expect(member.extraction.fieldProvenance).toEqual({ title: 'json-ld' });
      expect(member.extraction.packagingTitle).toBe('Package OCR Title');
      expect(member.extraction.ocr.outcome?.status).toBe('succeeded');
      expect(member.extraction.ocr.packagingOcrData?.productName).toBe('Package OCR Name');
      expect(member.extraction.ocr.ocrInputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(member.extraction.piEvidence).toEqual([]);
      expect(member.extraction.piImportComplete).toBe(true);
      expect(member.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    }
    // The projection round-trips through the versioned schema.
    expect(ExecutionEvidenceProjectionV1Schema.safeParse(projection).success).toBe(true);
  });

  it('ocrInputHash is stable for the same input set and changes when the image set changes', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction(),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, item.sourceUrl ?? '']));
    const a = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    const b = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    expect(a.members[0].extraction.ocr.ocrInputHash).toBe(b.members[0].extraction.ocr.ocrInputHash);

    // Image set change ⇒ input hash changes (the OCR belongs to different inputs).
    const mutated = findItemById(items[0].id)!;
    const ext = JSON.parse(JSON.stringify(mutated.extractionData));
    ext.primaryImage = 'https://img.example.com/CHANGED.jpg';
    updateItemExtractionData(items[0].id, JSON.stringify(ext));
    const item2 = findItemById(items[0].id)!;
    const c = buildExecutionEvidenceProjection(workspaceId, cohort, members, [item2], sources);
    expect(c.members[0].extraction.ocr.ocrInputHash).not.toBe(a.members[0].extraction.ocr.ocrInputHash);
    // And the member evidence hash changes with the extraction data too.
    expect(c.members[0].evidenceHash).not.toBe(a.members[0].evidenceHash);
  });

  it('evidenceHash is per-member and equals computeExtractionHash', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, item.sourceUrl ?? '']));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    for (const member of projection.members) {
      const item = items.find(i => i.id === member.onboardingItemId)!;
      expect(computeExtractionHash(item)).toBe(member.evidenceHash);
    }
    const hashes = new Set(projection.members.map(m => m.evidenceHash));
    expect(hashes.size).toBe(2);
  });
});

describe('two-phase freeze service (PR3 M2)', () => {
  it('matching state -> freezing→running with H1–H5 written + evidence_snapshot_id set', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const cohort = cohorts[0];
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(run.status).toBe('freezing');

    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.startedAt).not.toBeNull();
    expect(finalized.evidenceSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(finalized.evidenceSnapshotId).not.toBeNull();
    // H1 — membership identity.
    expect(finalized.candidateMembershipHash).toBe(cohort.membershipHash);
    // H3 — v1 config snapshot ref is a real persisted row.
    expect(finalized.configSnapshotId).not.toBeNull();
    expect(finalized.configSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    // H4 — no verified Page import in this workspace.
    expect(finalized.pageImportId).toBeNull();
    expect(finalized.pageImportHash).toBeNull();
    // H5 — v1 authority carries no model-execution digest.
    expect(finalized.modelPolicyDigest).toBeNull();

    // The content-addressed snapshot row exists; H2 = digest over the payload.
    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    expect(snap).not.toBeNull();
    const projection = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snap.payloadJson));
    expect(projection.version).toBe('execution-evidence-v1');
    expect(projection.members).toHaveLength(2);
    expect(hashCanonicalJson(projection)).toBe(finalized.evidenceSnapshotHash!);

    // Child runs exist (eager, freeze-created) + linked + persisted snapshot refs.
    for (const item of items) {
      const child = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
      ).get(run.id, item.id) as Record<string, any> | undefined;
      expect(child).toBeTruthy();
      expect(String(child!.status)).toBe('running');
      expect(child!.config_snapshot_id).not.toBeNull();
      expect(child!.config_snapshot_hash).not.toBeNull();
    }

    // A second freeze of a run that already left `freezing` fails fast —
    // execution is never re-frozen.
    expect(() => freezeCohortForExecution(finalized, wsPath, workspaceId)).toThrow(/not in 'freezing' state/);
  });

  it('two-phase CAS: freeze-window mutation -> run superseded, never transitions to running; fresh claim re-freezes on the mutated state', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction(),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    let mutated = false;
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId, {
      beforeFinalCas: () => {
        if (mutated) return;
        mutated = true;
        const live = findItemById(items[0].id)!;
        updateItemExtractionData(
          items[0].id,
          JSON.stringify({ ...live.extractionData, title: 'MUTATED IN WINDOW' }),
        );
      },
    });
    expect(mutated).toBe(true);
    expect(finalized.status).toBe('superseded');
    expect(finalized.errorMessage).toContain('Freeze CAS drift');
    expect(getCohortRunById(run.id)!.status).toBe('superseded');
    // Linked running children are failed so a retry is never blocked.
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ?',
    ).all(run.id) as Array<Record<string, any>>;
    expect(child.length).toBe(1);
    expect(String(child[0].status)).toBe('failed');

    // The cohort stays READY; the next claim + freeze succeeds and the new
    // snapshot reflects the mutation (never the stale pre-mutation evidence).
    const retried = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].id).not.toBe(run.id);
    const rerun = await freezeCohortForExecution(retried[0], wsPath, workspaceId);
    expect(rerun.status).toBe('running');
    const snap = getCohortSnapshotByHash(workspaceId, rerun.evidenceSnapshotHash!)!;
    const projection = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snap.payloadJson));
    expect(projection.members[0].extraction.title).toBe('MUTATED IN WINDOW');
  });

  it('frozen-means-frozen: member executes on the frozen projection only — a post-freeze mutation is never visible', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    // The fixture's stored OCR predates the execution-authority binding (no
    // ocrExecutionDigest), so the freeze re-runs it under the CURRENT
    // authority. With the VLM disabled the re-run settles as `disabled` with
    // NO usable OCR — the unbound stored OCR is CLEARED (fix 2a: never
    // preserved and re-stamped), and the frozen evidence stage materializes no
    // packaging-OCR evidence from it (fail-closed on the authority digest).
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction(),
    });
    const item = items[0];
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // MUTATE extraction_data_json + source_url AFTER freeze.
    const live = findItemById(item.id)!;
    const mutatedExt = JSON.parse(JSON.stringify(live.extractionData));
    mutatedExt.title = 'MUTATED AFTER FREEZE';
    mutatedExt.description = 'MUTATED DESC AFTER FREEZE';
    updateItemExtractionData(item.id, JSON.stringify(mutatedExt));
    getDb().run('UPDATE onboarding_items SET source_url = ? WHERE id = ?', ['https://brand.example.com/mutated', item.id]);
    insertExtraction({
      itemId: item.id,
      sourceUrl: 'https://brand.example.com/mutated',
      extractionDataJson: JSON.stringify(mutatedExt),
      extractionMethod: 'test',
      confidence: 1,
    });

    // Build the prepared-cohort context from the frozen run + snapshot.
    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    const projection = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snap.payloadJson));
    const memberProjection = projection.members.find(m => m.onboardingItemId === item.id)!;
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, item.id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
    const prepared: PreparedCohortContext = {
      memberProjection,
      parentRunId: run.id,
      memberSnapshotId: String(child.config_snapshot_id),
      memberSnapshotHash: String(child.config_snapshot_hash),
      sharedAuthorities: {
        configSnapshotRef: memberSnapshot.configSnapshotRef,
        pages: memberSnapshot.pages,
        pageImportId: memberSnapshot.pageImportId,
        pageImportHash: memberSnapshot.pageImportHash,
        fieldOptions: memberSnapshot.fieldOptions,
        focusedFileHashes: memberSnapshot.focusedFileHashes,
        catalogEvidenceHash: memberSnapshot.catalogEvidenceHash,
        modelPolicyView: memberSnapshot.modelPolicy
          ? modelPolicyViewFromConfig(memberSnapshot.modelPolicy as never, memberSnapshot.snapshotHash)
          : null,
      },
    };

    const mutatedLiveItem = findItemById(item.id)!;
    const curationData = await curateItemWithPipeline(mutatedLiveItem, wsPath, workspaceId, prepared);

    // Evidence was built ONLY from the frozen projection: the mutation is
    // absent, the frozen web + OCR evidence is present, and the frozen child
    // run completed (no second run created).
    const evidence = curationData.classificationEvidence;
    const nameValues = evidence.filter(e => e.sourceField === 'name').map(e => String(e.value));
    expect(nameValues.some(v => v.includes('MUTATED AFTER FREEZE'))).toBe(false);
    expect(nameValues.some(v => v === 'Original Web Title')).toBe(true);
    expect(evidence.some(e => e.sourceField === 'description' && String(e.value).includes('MUTATED DESC'))).toBe(false);
    expect(evidence.some(e => e.sourceField === 'description' && String(e.value) === 'Original description')).toBe(true);
    // Frozen OCR evidence: the unbound stored OCR was re-run under the
    // current authority and settled as `disabled` with no usable data — the
    // frozen stage materializes NO packaging-OCR evidence from it (fix 2a
    // fail-closed; the stale 'Package OCR Name' from the fixture is gone).
    const ocrEvidence = evidence.filter(e => e.metadata && (e.metadata as any).provenance === 'packaging_ocr');
    expect(ocrEvidence.length).toBe(0);
    expect(ocrEvidence.some(e => String(e.value) === 'Package OCR Name')).toBe(false);
    // The frozen child run STAYS RUNNING (PR3 hardening, Commit B / R3): the
    // prepared pipeline no longer completes the child — the terminal child
    // write is part of the atomic member-projection commit in processCohort
    // (curation_data_json + item stage + child terminal in ONE transaction).
    // Exactly ONE child (the freeze-created run) exists; no second run was
    // created.
    const childStatus = getRun(String(child.id))!.status;
    expect(childStatus).toBe('running');
    const runningChildren = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_runs WHERE cohort_run_id = ? AND status = 'running'",
    ).get(run.id) as { cnt: number };
    expect(Number(runningChildren.cnt)).toBe(1);
  });

  it('verifyCohortRunFrozen: NULL-hash freezing run resumes vacuously; a frozen run drifts when evidence changed', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, { '100000000001': settledExtraction() });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    // Crash mid-freeze (NULL hashes) → vacuous match, same run resumes.
    expect(verifyCohortRunFrozen(run, wsPath, workspaceId)).toBe(true);

    // Complete a freeze → the frozen world still matches.
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(verifyCohortRunFrozen(finalized, wsPath, workspaceId)).toBe(true);

    // Mutate evidence after freeze → drift (supersede + new run).
    const live = findItemById(items[0].id)!;
    updateItemExtractionData(items[0].id, JSON.stringify({ ...live.extractionData, brand: 'CHANGED BRAND' }));
    expect(verifyCohortRunFrozen(finalized, wsPath, workspaceId)).toBe(false);

    // A reclaim path (simulated) supersedes on drift; the next claim creates a
    // fresh run — the mutation is never silently consumed.
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
    const reclaim = reclaimExpiredCohortRuns(workspaceId, new Date().toISOString(), () => verifyCohortRunFrozen(finalized, wsPath, workspaceId) ? 'match' : 'drift', 'worker-b', COHORT_LEASE_TTL_MS);
    expect(reclaim.resumed.length).toBe(0);
    expect(reclaim.superseded.length).toBe(1);
    const retried = claimReadyCurationCohorts(workspaceId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].id).not.toBe(finalized.id);
    const rerun = await freezeCohortForExecution(retried[0], wsPath, workspaceId);
    expect(rerun.status).toBe('running');
    const snap = getCohortSnapshotByHash(workspaceId, rerun.evidenceSnapshotHash!)!;
    const projection = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snap.payloadJson));
    expect(projection.members[0].extraction.brand).toBe('CHANGED BRAND');
  });

  it('fieldOptions injected at freeze: buildRuntimeSnapshot uses the frozen override, never the live store', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const config: ClassificationConfig = {
      ...V1_CONFIG,
      attributes: [
        { ...V1_CONFIG.attributes[0], allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'] },
      ],
    };
    void wsPath;
    const authority = { kind: 'v1' as const, config };
    const frozenOptions = { 'test-flavor': [{ value: 'Chicken', label: 'Chicken' }] };

    const snapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath: wsPath,
      productSku: 'SKU-FZ',
      authority,
      configSnapshotRef: { id: 'cfg', hash: 'h'.repeat(64), sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: '',
      fieldOptions: frozenOptions,
    });
    expect(snapshot.fieldOptions['test-flavor']).toEqual(frozenOptions['test-flavor']);

    // Without the override the same config would compute the FULL allowed list —
    // proving the injected options were frozen, not re-resolved.
    const withoutOverride = buildRuntimeSnapshot({
      workspaceId,
      workspacePath: wsPath,
      productSku: 'SKU-FZ',
      authority,
      configSnapshotRef: { id: 'cfg', hash: 'h'.repeat(64), sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: '',
    });
    expect(withoutOverride.fieldOptions['test-flavor'].length).toBeGreaterThan(frozenOptions['test-flavor'].length);

    // The snapshot is deep-frozen — a post-freeze store mutation cannot change it.
    expect(() => {
      (snapshot.fieldOptions as Record<string, unknown>)['test-flavor'] = [];
    }).toThrow();
  });

  it('fail-closed: active v2 without a persisted config snapshot row -> capture (and thus freeze) fails; freeze succeeds once the row is persisted', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);

    const activationContext = createRuntimeActivationContext(wsPath, workspaceId);
    const authority = loadRuntimeConfigAuthority(wsPath, activationContext);
    expect(authority.kind).toBe('v2');

    // No persisted classification_config_snapshots row for the bundle hash yet.
    expect(() => captureCohortAuthorities(wsPath, workspaceId)).toThrow(/no persisted classification_config_snapshot row/);

    // Persisting the snapshot row makes the same capture succeed with H5.
    upsertConfigSnapshot(workspaceId, bundle);
    const captured = captureCohortAuthorities(wsPath, workspaceId);
    expect(captured.configSnapshotRef.hash).toBe(bundle.manifest.bundleHash);
    expect(captured.configSnapshotRef.id).not.toBeNull();
    expect(captured.modelExecutionDigest).toMatch(/^[a-f0-9]{64}$/);

    // Full v2 freeze: ready cohort + persisted config snapshot → running with H5.
    createReadyCohort(workspaceId, { '100000000001': settledExtraction() });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.configSnapshotHash).toBe(bundle.manifest.bundleHash);
    expect(finalized.modelPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(finalized.evidenceSnapshotId).not.toBeNull();
  });
});

describe('OCR pull-forward exactly-once (PR3 M2)', () => {
  it('A2 fail-closed OCR authority: stored OCR with NO execution digest is NEVER reused — the freeze re-runs under the v1 legacy authority and persists the digest', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, { '100000000001': settledExtraction() });
    const before = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };

    // The stored OCR is terminal + input-hash matched but predates the
    // execution-authority binding (no ocrExecutionDigest). Under Commit A's
    // null==null acceptance this legacy OCR was reusable; under the A2
    // fail-closed semantics reuse requires BOTH digests non-null AND equal,
    // so the freeze re-runs OCR under the CURRENT v1 legacy authority.
    const pre = JSON.parse(
      String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json),
    ) as Record<string, any>;
    expect(pre.ocrOutcome.status).toBe('succeeded');
    expect(pre.ocrExecutionDigest).toBeUndefined();

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    const after = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    // VLM disabled in the test env → the re-run settles as `disabled` WITHOUT
    // a transport (zero model calls, exactly-once by guard).
    expect(Number(after.cnt)).toBe(Number(before.cnt));
    const storedRow = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    const stored = JSON.parse(storedRow.extraction_data_json) as Record<string, any>;
    // The old unbound OCR was NOT accepted: the re-run overwrote the outcome
    // and bound the result to the current v1 legacy authority digest.
    expect(stored.ocrOutcome.status).toBe('disabled');
    expect(stored.ocrExecutionDigest).toMatch(/^[a-f0-9]{64}$/);
    // The persisted digest is the deterministic v1 legacy authority digest of
    // the member's frozen runtime snapshot.
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, items[0].id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
    expect(stored.ocrExecutionDigest).toBe(computeOcrExecutionDigest(memberSnapshot));
  });

  it('freeze runs ONE attempt for an unresolved member, writes the terminal outcome + ocrInputHash back, and the frozen stage materializes OCR without a call', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    // No OCR outcome at all (unresolved) → the freeze must settle it.
    const unresolved = settledExtraction();
    delete unresolved.ocrOutcome;
    delete unresolved.packagingOcrData;
    delete unresolved.packagingTitle;
    delete unresolved.ocrInputHash;
    const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });
    const before = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // VLM disabled in the test env → the attempt settles as `disabled` with a
    // write-back (no transport ⇒ no model-call rows, exactly-once by guard).
    const after = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(Number(after.cnt)).toBe(Number(before.cnt));
    const storedRow = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    const stored = JSON.parse(storedRow.extraction_data_json) as any;
    expect(stored.ocrOutcome.status).toBe('disabled');
    expect(stored.ocrInputHash).toMatch(/^[a-f0-9]{64}$/);

    // Frozen-mode evidence stage materializes from the frozen stored OCR with
    // NO model call (the projection ocrInputHash matches its own input set).
    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    const projection = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snap.payloadJson));
    const memberProjection = projection.members[0];
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, items[0].id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;

    const { evidenceExtractionStage } = await import('../../classification/stages/evidence-extraction');
    const result = await evidenceExtractionStage.execute(
      { sku: items[0].upc, onboardingItemId: items[0].id, evidence: [], acceptedProposals: [], allProposals: [] },
      {
        workspacePath: wsPath,
        workspaceId,
        runId: String(child.id),
        configSnapshotRef: memberSnapshot.configSnapshotRef,
        snapshot: memberSnapshot,
        cohortFrozenEvidence: memberProjection,
      } as never,
    );
    expect(result.status).toBe('succeeded');
    const output = (result as { status: 'succeeded'; output: { evidence: Array<Record<string, any>> } }).output;
    expect(output.evidence.some(e => e.sourceField === 'name' && e.source === 'spreadsheet')).toBe(true);
    expect(output.evidence.some(e => e.sourceField === 'name' && e.source === 'official_product_page' && e.value === 'Original Web Title')).toBe(true);
    // No model calls were created by the frozen stage.
    const afterStage = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(Number(afterStage.cnt)).toBe(Number(after.cnt));
  });

  it('run-bound OCR pull-forward makes EXACTLY ONE model call with start-before-transport provenance on the child run', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    // Enable the local VLM with a loopback test route captured at snapshot build.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Frozen Pkg Title', brand: 'FrozenBrand' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${server.port}`, 'test-vlm');
      // In-memory v2 snapshot with a frozen local-VLM route.
      const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
      const bundle = candidate.bundle;
      const authority = { kind: 'v2' as const, bundle };
      const snapshot = buildRuntimeSnapshot({
        workspaceId,
        workspacePath: wsPath,
        productSku: 'SKU-OCR',
        authority,
        configSnapshotRef: { id: bundle.manifest.bundleHash, hash: bundle.manifest.bundleHash, sourceCommit: null, createdAt: new Date().toISOString() },
        sourceProductHash: '',
      });
      expect(snapshot.schemaVersion).toBe(2);
      const entry = snapshot.modelExecutionPlan!.entries.find(e => e.operation === 'evidence_extraction')!;
      expect(entry.localVlmBaseUrl).toBe(`http://127.0.0.1:${server.port}`);

      const run = createRun(workspaceId, 'SKU-OCR', null, null, { sourceKind: 'onboarding' });
      const item = {
        upc: 'SKU-OCR',
        extractionData: {
          primaryImage: `http://127.0.0.1:${server.port}/img.png`,
          additionalImages: [],
        },
      } as never;

      const result = await runFrozenOcrPullForward({ snapshot, childRunId: run.id, item, workspacePath: wsPath });
      expect(result.ocrOutcome.status).toBe('succeeded');
      expect(result.packagingOcrData?.productName).toBe('Frozen Pkg Title');
      expect(result.packagingOcrData?.metadata?.modelCallIds?.length).toBe(1);

      // Exactly ONE model-call row on the child run (the `started` row is
      // updated in place to its terminal status — start-before-transport).
      const calls = getDb().query(
        'SELECT operation, status FROM classification_model_calls WHERE run_id = ?',
      ).all(run.id) as Array<{ operation: string; status: string }>;
      expect(calls.length).toBe(1);
      expect(calls[0].operation).toBe('evidence_extraction');
      expect(calls[0].status).toBe('success');
    } finally {
      server.stop(true);
    }
  });
});

// Reference the projection member type so the type-level contract is exercised.
export type { ExecutionEvidenceProjectionMemberV1 };

describe('PR3 hardening — Commit B (R2 frozen execution purity)', () => {
  it('R2 buildFrozenItem: constructs from the frozen projection only — identity from live, semantics from projection, authoritative null sourceUrl stays null', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, item.sourceUrl ?? '']));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    const member = projection.members[0];

    // MUTATE the live item after freeze: name/brand_hint/source_url/extraction
    // PLUS live semantic fields (sourcing decision, accepted attempt IDs,
    // prior curation data, source type) that must never leak into the
    // executed member.
    const live = findItemById(items[0].id)!;
    const mutatedExt = JSON.parse(JSON.stringify(live.extractionData));
    mutatedExt.title = 'MUTATED TITLE';
    mutatedExt.description = 'MUTATED DESC';
    mutatedExt.distributorEvidenceAttemptIds = ['att-mutated'];
    const mutatedLive: OnboardingItem = {
      ...live,
      name: 'MUTATED NAME',
      brandHint: 'MUTATED BRAND',
      sourceUrl: 'https://brand.example.com/mutated',
      extractionData: mutatedExt,
      sourcingDecision: {
        route: 'fallback_to_discovery',
        origin: 'operator_override',
        acceptedEvidenceAttemptIds: ['att-mutated-live'],
        providerIds: ['provider-mutated'],
        conflicts: [],
        warnings: [],
        decidedAt: new Date().toISOString(),
      },
      acceptedEvidenceAttemptIds: ['att-mutated-live'],
      curationData: { curatedTitle: 'MUTATED CURATION' } as never,
      sourceType: 'distributor_record',
    };

    const frozen = buildFrozenItem(member, mutatedLive);

    // Identity is pipeline state from the live item.
    expect(frozen.id).toBe(mutatedLive.id);
    expect(frozen.upc).toBe(mutatedLive.upc);
    expect(frozen.batchId).toBe(mutatedLive.batchId);
    expect(frozen.rowNumber).toBe(mutatedLive.rowNumber);
    expect(frozen.stage).toBe(mutatedLive.stage);
    expect(frozen.stageStatus).toBe(mutatedLive.stageStatus);
    // Semantic fields come from the frozen projection, never the live mutation.
    expect(frozen.name).toBe(member.spreadsheetIdentity.name);
    expect(frozen.expectedName).toBe(member.spreadsheetIdentity.expectedName);
    expect(frozen.brandHint).toBe(member.spreadsheetIdentity.brandHint);
    expect(frozen.price).toBe(member.spreadsheetIdentity.price);
    expect(frozen.quantity).toBe(member.spreadsheetIdentity.quantity);
    expect(frozen.sourceUrl).toBe(member.sourceUrl);
    // extractionData is built PURELY from projection fields — no live spread.
    expect(frozen.extractionData?.title).toBe(member.extraction.title);
    expect(frozen.extractionData?.description).toBe(member.extraction.description);
    expect(frozen.extractionData?.brand).toBe(member.extraction.brand);
    expect(frozen.extractionData?.packagingOcrData?.productName).toBe(member.extraction.ocr.packagingOcrData?.productName);
    expect((frozen.extractionData as any).distributorEvidenceAttemptIds).toBeUndefined();
    expect((frozen.extractionData as any).ocrInputHash).toBe(member.extraction.ocr.ocrInputHash);
    expect((frozen.extractionData as any).ocrExecutionDigest).toBe(member.extraction.ocr.ocrExecutionDigest ?? null);
    // The frozen extraction view carries the projection's member evidence
    // identity (the execution contract's H2 input).
    expect((frozen.extractionData as any).evidenceHash).toBe(member.evidenceHash);
    // Live semantic fields never leak: sourcingDecision comes from the
    // projection (null here), attempt IDs are cleared, curation data is null,
    // and the source type is the neutral official-page value.
    expect(frozen.sourcingDecision).toBe(member.sourcingDecision);
    expect(frozen.acceptedEvidenceAttemptIds).toEqual([]);
    expect(frozen.acceptedEvidenceAttemptId).toBeNull();
    expect(frozen.curationData).toBeNull();
    expect(frozen.sourceType).toBe('official_page');
    expect(frozen.coordinatedTitle).toBeNull();

    // Authoritative null sourceUrl STAYS null even when the live value is set
    // post-freeze — never `?? item.sourceUrl`.
    const nullSource = { ...member, sourceUrl: null };
    const frozenNull = buildFrozenItem(nullSource, { ...mutatedLive, sourceUrl: 'https://brand.example.com/post-freeze' });
    expect(frozenNull.sourceUrl).toBeNull();
  });

  it('R2 buildFrozenProductLineContext: sibling context derived purely from the persisted cohort + frozen projections — a post-freeze sibling mutation is invisible', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    // Give member 2 a distinct spreadsheet brand hint AFTER cohort formation
    // (the family is still grouped on the original 'Acme' hint): the frozen
    // sibling brand must come from spreadsheetIdentity, never the
    // web-extracted brand 'Acme'.
    const siblingItem = items.find(i => i.upc === '100000000002')!;
    getDb().run('UPDATE onboarding_items SET brand_hint = ? WHERE id = ?', ['Spreadsheet Brand', siblingItem.id]);
    const updatedItems = items.map(item => findItemById(item.id)!);
    const sources = new Map(updatedItems.map(item => [item.id, item.sourceUrl ?? '']));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, updatedItems, sources);

    const ctx = buildFrozenProductLineContext(cohort, members, projection.members);
    expect(ctx.productLineContext.groupId).toBe(cohort.groupKey);
    expect(ctx.productLineContext.groupLabel).toBe(cohort.groupLabel);
    expect(ctx.productLineContext.siblingNames).toHaveLength(2);
    expect(ctx.productLineContext.siblingSkus).toHaveLength(2);
    // Ordinal order (insertion), while projection.members are sorted by item id —
    // compare as sets.
    expect([...ctx.productLineContext.siblingSkus].sort()).toEqual(
      projection.members.map(m => m.productSku).filter((sku): sku is string => sku !== null).sort(),
    );
    // webTitles from projection titles, ocrTitles from projection OCR.
    for (const m of projection.members) {
      expect(ctx.productLineContext.siblingWebTitles).toContain(m.extraction.title ?? '');
    }
    for (const m of projection.members) {
      const ocrName = m.extraction.ocr.packagingOcrData?.productName?.trim();
      if (ocrName) expect(ctx.productLineContext.siblingOcrTitles).toContain(ocrName);
    }
    expect(ctx.productLineItems).toHaveLength(2);
    for (const line of ctx.productLineItems) {
      const m = projection.members.find(member => member.productSku === line.sku)!;
      expect(line.webTitle).toBe(m.extraction.title);
      expect(line.description).toBe(m.extraction.description ?? '');
      // Frozen sibling brand is sourced from spreadsheetIdentity (PR3
      // hardening C / R2) — never the web-extracted extraction brand.
      expect(line.brand).toBe(m.spreadsheetIdentity.brandHint);
    }
    // Item 2 proves the precedence: its web-extracted brand is 'Acme' but the
    // frozen sibling brand is the spreadsheet hint 'Spreadsheet Brand'.
    const beefLine = ctx.productLineItems.find(line => line.sku === '100000000002')!;
    const beefProjection = projection.members.find(m => m.productSku === '100000000002')!;
    expect(beefProjection.extraction.brand).toBe('Acme');
    expect(beefLine.brand).toBe('Spreadsheet Brand');
    // Frozen member views carry frozen web/OCR titles (title-coordination input).
    for (const frozenItem of ctx.frozenBatchItems) {
      expect(frozenItem.extractionData?.title).toBe('Original Web Title');
      expect(frozenItem.extractionData?.packagingOcrData?.productName).toBe('Package OCR Name');
    }

    // MUTATE a sibling's live extraction_data_json AFTER the freeze — the
    // projection-derived context is byte-identical (a pure function of the
    // persisted cohort + projections; no live reads at all).
    const sibling = items.find(i => i.upc === '100000000002')!;
    const live = findItemById(sibling.id)!;
    const mutatedSibling = JSON.parse(JSON.stringify(live.extractionData));
    mutatedSibling.title = 'MUTATED SIBLING TITLE';
    mutatedSibling.packagingOcrData = { ...mutatedSibling.packagingOcrData, productName: 'MUTATED SIBLING OCR' };
    updateItemExtractionData(sibling.id, JSON.stringify(mutatedSibling));

    const ctxAfter = buildFrozenProductLineContext(cohort, getCohortMembers(cohort.id), projection.members);
    expect(ctxAfter.productLineContext.siblingWebTitles).toEqual(ctx.productLineContext.siblingWebTitles);
    expect(ctxAfter.productLineContext.siblingOcrTitles).toEqual(ctx.productLineContext.siblingOcrTitles);
    expect(ctxAfter.productLineItems.map(l => l.webTitle)).toEqual(ctx.productLineItems.map(l => l.webTitle));
    expect(ctxAfter.productLineContext.siblingWebTitles).not.toContain('MUTATED SIBLING TITLE');
    expect(ctxAfter.productLineContext.siblingOcrTitles).not.toContain('MUTATED SIBLING OCR');
  });
});

describe('PR3 hardening — Commit A (recovery/atomicity)', () => {
  it('R5: a cancelled pre-freeze run is NOT a vacuous match — reclaim supersedes it so the slot reopens', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    createReadyCohort(workspaceId, { '100000000001': settledExtraction() });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(cancelFreezingRun(run.id, 'Freeze could never finalize')).toBe(true);
    const cancelled = getCohortRunById(run.id)!;

    // A cancelled pre-freeze run carries no frozen evidence AND is not a live
    // freezing claim — it is never a vacuous match.
    expect(cancelled.evidenceSnapshotHash).toBeNull();
    expect(verifyCohortRunFrozen(cancelled, wsPath, workspaceId)).toBe(false);

    // Retry semantics (Commit A / R5): the reconcile path treats a `cancelled`
    // current run as retryable — it is superseded before claiming (a cancelled
    // run is TERMINAL, so lease reclaim never selects it), which reopens the
    // slot for a fresh claim.
    expect(supersedeCohortRun(cancelled.id, 'Cancelled run retry (slot reopen)')).toBe(true);
    expect(getCohortRunById(cancelled.id)!.status).toBe('superseded');

    // A fresh claim creates a NEW run.
    const retried = claimReadyCurationCohorts(workspaceId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].id).not.toBe(cancelled.id);
  });

  it('R4: OCR runs under a changed execution authority after a crash-before-final-CAS — old OCR is never accepted and a side-effect child is retired + recreated', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);

    // Authority A: local VLM route A (loopback mock). BOTH servers stay alive
    // — the primary image URL stays bound to server A while the VLM route
    // moves to server B, so the OCR re-run under B can still load the image.
    const serverA = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under A', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const serverB = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under B', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverA.port}`, 'vlm-model-a');

      // Unsettled OCR extraction (no outcome, no input hash): the freeze must
      // run OCR under authority A.
      const unresolved = settledExtraction({
        _name: 'Purina Pro Plan Dog Food Chicken 5 lb',
        primaryImage: `http://127.0.0.1:${serverA.port}/img.png`,
        additionalImages: [],
      });
      delete unresolved.ocrOutcome;
      delete unresolved.packagingOcrData;
      delete unresolved.packagingTitle;
      delete unresolved.ocrInputHash;
      const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });

      const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

      // Freeze attempt 1: OCR runs under authority A, then the worker crashes
      // BEFORE the final CAS (the test seam hook throws). The run stays
      // `freezing` with NULL hashes and the OCR write-back persists.
      let crashed = false;
      await expect(freezeCohortForExecution(run, wsPath, workspaceId, {
        beforeFinalCas: () => {
          if (crashed) return;
          crashed = true;
          throw new Error('simulated crash before final CAS');
        },
      })).rejects.toThrow('simulated crash before final CAS');
      expect(crashed).toBe(true);
      expect(getCohortRunById(run.id)!.status).toBe('freezing');
      expect(getCohortRunById(run.id)!.evidenceSnapshotHash).toBeNull();

      const readStoredExt = (): Record<string, any> => JSON.parse(
        String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json),
      );
      const storedA = readStoredExt();
      expect(storedA.ocrOutcome.status).toBe('succeeded');
      expect(storedA.packagingOcrData.productName).toBe('Pkg Under A');
      const digestA = storedA.ocrExecutionDigest;
      expect(digestA).toMatch(/^[a-f0-9]{64}$/);

      // The first child run recorded ONE model call under route A (side effect).
      const childA = getDb().query(
        `SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = 'running'`,
      ).get(run.id, items[0].id) as Record<string, any>;
      expect(childA).toBeTruthy();
      const callsA = getDb().query('SELECT * FROM classification_model_calls WHERE run_id = ?').all(String(childA.id)) as Array<Record<string, any>>;
      expect(callsA.length).toBe(1);
      expect(String(callsA[0].model)).toBe('vlm-model-a');

      // The world moved on: the local VLM route changes to authority B.
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverB.port}`, 'vlm-model-b');

      // Reclaim the SAME parent (crash mid-freeze → vacuous match).
      getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
      const reclaim = reclaimExpiredCohortRuns(
        workspaceId,
        new Date().toISOString(),
        () => (verifyCohortRunFrozen(getCohortRunById(run.id)!, wsPath, workspaceId) ? 'match' : 'drift'),
        'worker-b',
        COHORT_LEASE_TTL_MS,
      );
      expect(reclaim.resumed.length).toBe(1);
      expect(reclaim.resumed[0].id).toBe(run.id);
      const resumed = getCohortRunById(run.id)!;
      expect(resumed.claimedBy).toBe('worker-b');

      // Re-freeze under authority B: the old OCR is NOT accepted (execution
      // digest mismatch) — it re-runs with NEW provenance; the running child
      // that accumulated side effects under A is retired and recreated.
      const finalized = await freezeCohortForExecution(resumed, wsPath, workspaceId);
      expect(finalized.status).toBe('running');

      // Child retirement: old child failed, a NEW child under the same parent
      // carries the new snapshot.
      expect(getRun(String(childA.id))!.status).toBe('failed');
      expect(getRun(String(childA.id))!.errorMessage).toBe('snapshot changed during resume');
      const children = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at ASC',
      ).all(run.id, items[0].id) as Array<Record<string, any>>;
      expect(children.length).toBe(2);
      expect(String(children[0].id)).toBe(String(childA.id));
      const childB = children[1];
      expect(String(childB.status)).toBe('running');
      expect(String(childB.cohort_run_id)).toBe(run.id);

      // OCR re-ran under authority B with new provenance.
      const storedB = readStoredExt();
      expect(storedB.packagingOcrData.productName).toBe('Pkg Under B');
      expect(storedB.ocrExecutionDigest).not.toBe(digestA);
      const snapshotB = getRuntimeSnapshotByHash(workspaceId, String(childB.config_snapshot_hash))!;
      expect(storedB.ocrExecutionDigest).toBe(computeOcrExecutionDigest(snapshotB));
      const callsB = getDb().query('SELECT * FROM classification_model_calls WHERE run_id = ?').all(String(childB.id)) as Array<Record<string, any>>;
      expect(callsB.length).toBe(1);
      expect(String(callsB[0].model)).toBe('vlm-model-b');

      // Positive path of the digest guard (fix 2b): the digest-bound OCR
      // (stored digest === snapshot B's plan/rule digest) materializes through
      // the frozen evidence stage with NO additional model call.
      const snapB = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
      const projectionB = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snapB.payloadJson));
      const memberProjectionB = projectionB.members[0];
      const { evidenceExtractionStage } = await import('../../classification/stages/evidence-extraction');
      const stageContext = {
        workspacePath: wsPath,
        workspaceId,
        runId: String(childB.id),
        configSnapshotRef: snapshotB.configSnapshotRef,
        snapshot: snapshotB,
        cohortFrozenEvidence: memberProjectionB,
      };
      const stageInput = { sku: items[0].upc, onboardingItemId: items[0].id, evidence: [], acceptedProposals: [], allProposals: [] };
      const stageResult = await evidenceExtractionStage.execute(stageInput, stageContext as never);
      expect(stageResult.status).toBe('succeeded');
      const stageOut = (stageResult as { status: 'succeeded'; output: { evidence: Array<Record<string, any>> } }).output;
      expect(stageOut.evidence.some(e => e.metadata?.provenance === 'packaging_ocr' && String(e.value) === 'Pkg Under B')).toBe(true);
      // And the SAME projection with a MISMATCHED stored digest never
      // materializes the OCR (fail-closed on the execution authority, not just
      // the input hash).
      const tamperedProjection = {
        ...memberProjectionB,
        extraction: {
          ...memberProjectionB.extraction,
          ocr: { ...memberProjectionB.extraction.ocr, ocrExecutionDigest: 'f'.repeat(64) },
        },
      } as never;
      const tamperedResult = await evidenceExtractionStage.execute(
        stageInput,
        { ...stageContext, cohortFrozenEvidence: tamperedProjection } as never,
      );
      const tamperedOut = (tamperedResult as { status: 'succeeded'; output: { evidence: Array<Record<string, any>> } }).output;
      expect(tamperedOut.evidence.some(e => e.metadata?.provenance === 'packaging_ocr')).toBe(false);
    } finally {
      serverA.stop(true);
      serverB.stop(true);
    }
  });

  it('R4 fail-closed rerun: authority B FAILS (HTTP 500) → A\'s OCR is cleared from extraction_data_json and the terminal outcome is B\'s, never A\'s values', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);

    // Authority A: loopback VLM succeeds. Authority B: image loads but the
    // VLM route returns HTTP 500 — the re-run produces NO usable OCR.
    const serverA = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under A', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const serverB = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return new Response('VLM exploded', { status: 500 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverA.port}`, 'vlm-model-a');

      // Unsettled OCR: the first freeze must run a real transport under A.
      const unresolved = settledExtraction({
        _name: 'Purina Pro Plan Dog Food Chicken 5 lb',
        primaryImage: `http://127.0.0.1:${serverA.port}/img.png`,
        additionalImages: [],
      });
      delete unresolved.ocrOutcome;
      delete unresolved.packagingOcrData;
      delete unresolved.packagingTitle;
      delete unresolved.ocrInputHash;
      const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });
      const readStoredExt = (): Record<string, any> => JSON.parse(
        String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json),
      );

      const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

      // Freeze attempt 1: OCR runs under authority A, then crash before the
      // final CAS. A's OCR + digest persist in extraction_data_json.
      let crashed = false;
      await expect(freezeCohortForExecution(run, wsPath, workspaceId, {
        beforeFinalCas: () => {
          if (crashed) return;
          crashed = true;
          throw new Error('simulated crash before final CAS');
        },
      })).rejects.toThrow('simulated crash before final CAS');
      const storedA = readStoredExt();
      expect(storedA.ocrOutcome.status).toBe('succeeded');
      expect(storedA.packagingOcrData.productName).toBe('Pkg Under A');
      const digestA = storedA.ocrExecutionDigest;
      expect(digestA).toMatch(/^[a-f0-9]{64}$/);

      // The world moved on: the local VLM route changes to authority B.
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverB.port}`, 'vlm-model-b');

      // Reclaim the SAME parent (crash mid-freeze → vacuous match).
      getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
      const reclaim = reclaimExpiredCohortRuns(
        workspaceId,
        new Date().toISOString(),
        () => (verifyCohortRunFrozen(getCohortRunById(run.id)!, wsPath, workspaceId) ? 'match' : 'drift'),
        'worker-b',
        COHORT_LEASE_TTL_MS,
      );
      expect(reclaim.resumed.length).toBe(1);
      const resumed = getCohortRunById(run.id)!;
      expect(resumed.claimedBy).toBe('worker-b');

      // Re-freeze under B: the digest mismatch re-runs OCR under B; B's
      // transport FAILS → no usable OCR. Fix 2a: A's OCR data/title are
      // UNCONDITIONALLY cleared — never preserved and re-stamped with B's
      // digest.
      const finalized = await freezeCohortForExecution(resumed, wsPath, workspaceId);
      expect(finalized.status).toBe('running');

      const storedB = readStoredExt();
      expect(storedB.packagingOcrData).toBeNull();
      expect(storedB.packagingTitle).toBeNull();
      expect(storedB.ocrOutcome.status).toBe('failed');
      expect(storedB.ocrOutcome.model).toBe('vlm-model-b');
      expect(storedB.ocrExecutionDigest).not.toBe(digestA);
      const childB = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = ?',
      ).get(run.id, items[0].id, 'running') as Record<string, any>;
      const snapshotB = getRuntimeSnapshotByHash(workspaceId, String(childB.config_snapshot_hash))!;
      expect(storedB.ocrExecutionDigest).toBe(computeOcrExecutionDigest(snapshotB));
      // The frozen projection reflects B's terminal outcome — A's OCR is gone.
      const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
      const projection = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snap.payloadJson));
      expect(projection.members[0].extraction.ocr.packagingOcrData).toBeNull();
      expect(projection.members[0].extraction.ocr.ocrExecutionDigest).toBe(storedB.ocrExecutionDigest);
    } finally {
      serverA.stop(true);
      serverB.stop(true);
    }
  });

  it('A2 heartbeat: a sibling reclaim during an in-flight freeze OCR aborts the freeze with NO post-loss writes; the new owner keeps the run', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);

    // Loopback VLM + image source: the member's freeze OCR transport is
    // genuinely in flight while the test seam fires.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Frozen Pkg Title', brand: 'FrozenBrand' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${server.port}`, 'vlm-model-a');

      // Unresolved OCR extraction (no outcome, no input hash, no digest): the
      // freeze MUST run a transport under authority A.
      const unresolved = settledExtraction({
        _name: 'Purina Pro Plan Dog Food Chicken 5 lb',
        primaryImage: `http://127.0.0.1:${server.port}/img.png`,
        additionalImages: [],
      });
      delete unresolved.ocrOutcome;
      delete unresolved.packagingOcrData;
      delete unresolved.packagingTitle;
      delete unresolved.ocrInputHash;
      const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });

      // Snapshot the extraction JSON BEFORE the freeze: the aborted freeze
      // must leave it byte-identical (no write-back at all).
      const extractionBefore = String(
        (getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json,
      );

      const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

      // The seam fires while the member's OCR transport is IN FLIGHT (inside
      // the awaited op): the lease is expired and a sibling worker reclaims
      // the run. The transport completes, the keeper's post-await ownership
      // assertion fails, and the freeze aborts with NO extraction_data_json
      // write-back and NO terminal write.
      let reclaimed = false;
      // Run-scoped shared state snapshot AT the reclaim instant: after the
      // abort the stale owner must not have added/updated a single row in
      // these tables (fix 1c). Model-call rows are scoped to THIS freeze's
      // child run (start-before-transport provenance already inserted).
      let tablesAtReclaim: Record<string, number> = {};
      let modelCallsAtReclaim: Array<{ id: string; status: string }> = [];
      const childRunIdForCalls = (): string | null => {
        const row = getDb().query(
          'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
        ).get(run.id, items[0].id) as { id: string } | undefined;
        return row ? String(row.id) : null;
      };
      await expect(freezeCohortForExecution(run, wsPath, workspaceId, {
        onOcrInFlight: () => {
          if (reclaimed) return;
          reclaimed = true;
          getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
          const reclaim = reclaimExpiredCohortRuns(
            workspaceId,
            new Date().toISOString(),
            () => 'match',
            'worker-b',
            COHORT_LEASE_TTL_MS,
          );
          expect(reclaim.resumed.length).toBe(1);
          expect(reclaim.resumed[0].id).toBe(run.id);
          // Snapshot run-scoped tables + the in-flight model-call row state
          // at the moment ownership moved — no NEW or UPDATED rows may appear
          // afterwards.
          tablesAtReclaim = tableCounts();
          const childId = childRunIdForCalls();
          modelCallsAtReclaim = childId
            ? (getDb().query('SELECT id, status FROM classification_model_calls WHERE run_id = ?').all(childId) as Array<{ id: string; status: string }>)
              .map(r => ({ id: String(r.id), status: String(r.status) }))
            : [];
        },
      })).rejects.toBeInstanceOf(HeartbeatLostError);
      expect(reclaimed).toBe(true);

      // Fix 1c: the stale owner never persisted run-scoped shared state after
      // ownership moved — model calls / stage results / evidence / proposals
      // are row-count-identical, and the in-flight OCR model call on THIS
      // freeze's child was NEVER terminalized (still `started`, never
      // `success`/`failed`).
      expect(tableCounts()).toEqual(tablesAtReclaim);
      const childIdAfter = childRunIdForCalls();
      const modelCallsAfter = childIdAfter
        ? (getDb().query('SELECT id, status FROM classification_model_calls WHERE run_id = ?').all(childIdAfter) as Array<{ id: string; status: string }>)
          .map(r => ({ id: String(r.id), status: String(r.status) }))
        : [];
      expect(modelCallsAfter).toEqual(modelCallsAtReclaim);
      expect(modelCallsAfter.every(call => call.status === 'started')).toBe(true);

      // The new owner's run is INTACT: still `freezing` (no supersede, no
      // terminal write), claimed by worker-b, nothing finalized.
      const after = getCohortRunById(run.id)!;
      expect(after.status).toBe('freezing');
      expect(after.claimedBy).toBe('worker-b');
      expect(after.evidenceSnapshotHash).toBeNull();
      expect(after.supersededAt).toBeNull();

      // No post-loss write-back: extraction_data_json is byte-identical to
      // the pre-freeze state (the OCR outcome/digest never landed).
      const extractionAfter = String(
        (getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json,
      );
      expect(extractionAfter).toBe(extractionBefore);
      const stored = JSON.parse(extractionAfter) as Record<string, any>;
      expect(stored.ocrOutcome).toBeUndefined();
      expect(stored.ocrExecutionDigest).toBeUndefined();

      // The freeze-created child run is untouched — the abort path failed or
      // retired nothing.
      const child = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = ?',
      ).get(run.id, items[0].id, 'running') as Record<string, any> | undefined;
      expect(child).toBeTruthy();
    } finally {
      server.stop(true);
    }
  });
});
