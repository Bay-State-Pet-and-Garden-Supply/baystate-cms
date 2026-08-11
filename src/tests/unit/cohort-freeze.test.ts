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
    // Frozen OCR evidence materialized from the frozen projection.
    const ocrEvidence = evidence.filter(e => e.metadata && (e.metadata as any).provenance === 'packaging_ocr');
    expect(ocrEvidence.length).toBeGreaterThan(0);
    expect(ocrEvidence.some(e => String(e.value) === 'Package OCR Name')).toBe(true);
    // The frozen child run completed — never a second running run. Some stages
    // may abstain in the fixture config, so both completion statuses are valid.
    const childStatus = getRun(String(child.id))!.status;
    expect(['completed', 'completed_with_abstentions']).toContain(childStatus);
    const runningChildren = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_runs WHERE cohort_run_id = ? AND status = 'running'",
    ).get(run.id) as { cnt: number };
    expect(Number(runningChildren.cnt)).toBe(0);
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
  it('freeze runs ZERO model calls for a member with terminal OCR + matching ocrInputHash', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, { '100000000001': settledExtraction() });
    const before = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    const after = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(Number(after.cnt)).toBe(Number(before.cnt));
    // extraction_data_json was not rewritten (the stored OCR already matched).
    const stored = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    expect(JSON.parse(stored.extraction_data_json).ocrOutcome.status).toBe('succeeded');
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
    } finally {
      serverA.stop(true);
      serverB.stop(true);
    }
  });
});

