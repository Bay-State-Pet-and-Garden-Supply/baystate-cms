/**
 * PR6 C4 (issue #30): the parent title coordination op —
 * `ensureCohortTitlesCoordinated`.
 *
 * bun:test harness mirroring cohort-worker.test.ts, with an ACTIVE v2 bundle
 * (mirroring cohort-freeze.test.ts's `writeActiveV2Bundle`) so the member
 * runtime snapshots are schema-v2 with a frozen model-execution plan — the
 * audited `cohort_title_consolidation` call (DECISION-N, ordinal-0 child
 * binding) actually resolves. `llm-client` is MOCKED (counting calls; the
 * mock also simulates the audited transport's `classification_model_calls`
 * started→success rows so the audit-pair assertions are real DB rows).
 *
 * Coverage:
 * - fresh run: ONE title call, 2 output rows sharing the same input_hash,
 *   returned map equals the persisted rows, exactly one audited started+
 *   success pair bound to the ordinal-0 child run;
 * - reuse: second call on the same run (after clearCohortCoordinationCache)
 *   → zero calls, identical map (DB authority, not process memory);
 * - hash mismatch: outputs written under an old input_hash → re-coordinate +
 *   replace;
 * - incomplete set: 1 of 2 rows present → re-coordinate + complete;
 * - all-or-nothing: forced insert failure (nonexistent workspace FK) → throws,
 *   zero rows remain;
 * - HeartbeatLostError after the LLM returns (sibling reclaim) → no rows,
 *   error propagates;
 * - LLM failure → deterministic fallback persisted (source cohort_fallback,
 *   model_call_id NULL);
 * - singleton members → no output row, no call (DECISION-O).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'bun:test';
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
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
  getCohortById,
  getCohortMembers,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  getCohortSnapshotByHash,
  reclaimExpiredCohortRuns,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import {
  getCohortTitleOutputsByRun,
  countCohortTitleOutputs,
} from '../../db/repositories/classification-cohort-output-repo';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import {
  getRuntimeSnapshotByHash,
  getModelExecutionPlanEntry,
} from '../../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import { computeCohortTitleInputHash } from '../../onboarding/cohort-title-hash';
import { ensureCohortTitlesCoordinated } from '../../onboarding/cohort-title-coordinator';
import {
  freezeCohortForExecution,
  buildFrozenProductLineContext,
  HeartbeatLostError,
} from '../../onboarding/cohort-curator';
import { clearCohortCoordinationCache } from '../../onboarding/cohort-name-coordinator';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import { ExecutionEvidenceProjectionV1Schema } from '../../shared/schemas/cohorts';
import type {
  CohortRun,
  CurationCohort,
  CurationCohortMember,
  ExecutionEvidenceProjectionV1,
} from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { FrozenProductLineContext } from '../../onboarding/cohort-curator';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';

// ─── llm-client mock (counting; simulates the audited transport rows) ─────────

let titleCallCount = 0;
let auditCallSeq = 0;
/** When true, the mock throws (simulating an LLM transport failure). */
let failNextTitleCall = false;
/** When true, the mock expires + reclaims `reclaimRunId` before returning. */
let reclaimAfterTitleCall = false;
let reclaimRunId: string | null = null;
let reclaimWorkspaceId: string | null = null;

function mockGetLlmConfigForTask(): Record<string, any> {
  return {
    provider: 'ollama',
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5vl:latest',
  };
}

function mockCallLlmForTask(): string {
  return JSON.stringify({
    '100000000001': 'Purina Pro Plan Dog Food Chicken 5 lb',
    '100000000002': 'Purina Pro Plan Dog Food Beef 10 lb',
  });
}

/** Simulate the audited transport's durable started + success rows. */
function writeAuditPair(runId: string, snapshotHash: string | null, callId: string): void {
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, 'name_consolidation', 'cohort_title_consolidation', 1, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
    [`${callId}-started`, runId, snapshotHash, 'cohort-title-consolidation-prompt-v1', 'cohort-title-consolidation-rules-v1', 'sys-hash', 'user-hash', now, null, now],
  );
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, 'name_consolidation', 'cohort_title_consolidation', 1, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
    [`${callId}-success`, runId, snapshotHash, 'cohort-title-consolidation-prompt-v1', 'cohort-title-consolidation-rules-v1', 'sys-hash', 'user-hash', now, now, now],
  );
}

function mockCallLlmForTaskWithProvenance(
  _task: string,
  _prompt: string,
  _systemPrompt: string,
  options: Record<string, any>,
): { content: string; callId: string; provider: string; model: string; usage: Record<string, number | null> } | null {
  if (options?.protectedOperation !== 'cohort_title_consolidation') return null;
  titleCallCount++;
  if (failNextTitleCall) {
    throw new Error('transport down');
  }
  const callId = `title-call-${++auditCallSeq}`;
  if (options.modelCall) {
    writeAuditPair(options.modelCall.runId, options.modelCall.snapshotHash ?? null, callId);
  }
  if (reclaimAfterTitleCall && reclaimRunId && reclaimWorkspaceId) {
    getDb().run(
      'UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?',
      ['2000-01-01T00:00:00.000Z', reclaimRunId],
    );
    reclaimExpiredCohortRuns(
      reclaimWorkspaceId,
      new Date().toISOString(),
      () => 'match',
      'sibling-worker',
      COHORT_LEASE_TTL_MS,
    );
  }
  return {
    content: JSON.stringify({
      '100000000001': 'Purina Pro Plan Dog Food Chicken 5 lb',
      '100000000002': 'Purina Pro Plan Dog Food Beef 10 lb',
    }),
    callId,
    provider: 'ollama',
    model: 'qwen2.5vl:latest',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

vi.mock('../../onboarding/llm-client', () => ({
  getLlmConfigForTask: () => mockGetLlmConfigForTask(),
  callLlmForTask: () => mockCallLlmForTask(),
  callLlmForTaskWithProvenance: (
    task: string,
    prompt: string,
    systemPrompt: string,
    options: Record<string, any>,
  ) => mockCallLlmForTaskWithProvenance(task, prompt, systemPrompt, options),
}));

// ─── DB harness ───────────────────────────────────────────────────────────────

let workspacePath: string;

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-title-coord-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

afterEach(() => {
  titleCallCount = 0;
  failNextTitleCall = false;
  reclaimAfterTitleCall = false;
  reclaimRunId = null;
  reclaimWorkspaceId = null;
  clearCohortCoordinationCache();
});

// ─── Fixtures (mirror cohort-worker.test.ts + cohort-freeze.test.ts v2) ───────

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

/** Write a lifecycle-ACTIVE v2 bundle (reviewed Bay State seed) to disk so the
 *  freeze captures schema-v2 member snapshots with a frozen model-execution
 *  plan. Mirrors `writeActiveV2Bundle` in cohort-freeze.test.ts. */
function writeActiveV2Bundle(
  wsPath: string,
): { bundle: ReturnType<typeof generateCandidate>['bundle']; xmlFields: string[] } {
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

function expectedOcrInputHash(sourceUrl: string, ext: Record<string, any>): string {
  return hashCanonicalJson({
    sourceUrl,
    extractionSourceUrl: sourceUrl,
    primaryImage: ext.primaryImage ?? null,
    additionalImages: Array.isArray(ext.additionalImages) ? ext.additionalImages : [],
  });
}

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
  const batchId = createBatch({ workspaceId: wsId, name: 'Title Coord Batch', fileName: 'title-coord.xlsx', totalItems: itemsData.length }).id;
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

interface FrozenCohortFixture {
  workspaceId: string;
  workspacePath: string;
  run: CohortRun;
  projection: ExecutionEvidenceProjectionV1;
  cohort: CurationCohort;
  members: CurationCohortMember[];
  frozenLineContext: FrozenProductLineContext;
  items: OnboardingItem[];
}

/** Freeze a ready cohort under the ACTIVE v2 bundle and return every input the
 *  parent op needs. */
async function freezeCohortFixture(extByUpc: Record<string, Record<string, any>>): Promise<FrozenCohortFixture> {
  const { workspaceId, workspacePath: wsPath } = newWorkspace();
  const { bundle } = writeActiveV2Bundle(wsPath);
  upsertConfigSnapshot(workspaceId, bundle);
  const { items } = createReadyCohort(workspaceId, extByUpc);
  const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
  const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
  expect(finalized.status).toBe('running');
  const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
  const projection = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snap.payloadJson)) as ExecutionEvidenceProjectionV1;
  const cohort = getCohortById(finalized.cohortId)!;
  const members = getCohortMembers(cohort.id);
  const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
  return { workspaceId, workspacePath: wsPath, run: finalized, projection, cohort, members, frozenLineContext, items };
}

/** Recompute the T-hash the parent op uses (mirrors its step 1). */
function expectedInputHash(fixture: FrozenCohortFixture): string {
  const ordered = [...fixture.projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const child = getDb().query(
    'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(fixture.run.id, ordered[0].onboardingItemId) as { config_snapshot_hash: string } | undefined;
  const snapshot = child?.config_snapshot_hash
    ? getRuntimeSnapshotByHash(fixture.workspaceId, child.config_snapshot_hash)
    : null;
  const view = snapshot?.modelPolicy
    ? modelPolicyViewFromConfig(snapshot.modelPolicy as never, snapshot.snapshotHash)
    : null;
  return computeCohortTitleInputHash({
    run: fixture.run,
    projection: fixture.projection,
    modelPolicyDigest: view?.policyDigest ?? null,
    titlePlanEntry: snapshot
      ? (getModelExecutionPlanEntry(snapshot, 'cohort_title_consolidation') ?? undefined)
      : undefined,
  });
}

/** The ordinal-0 member's child run id (the DECISION-N audit binding). */
function ordinal0ChildRunId(fixture: FrozenCohortFixture): string {
  const ordered = [...fixture.projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const row = getDb().query(
    'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(fixture.run.id, ordered[0].onboardingItemId) as { id: string };
  return row.id;
}

const TWO_MEMBER_EXTRACTIONS = {
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
};

describe('ensureCohortTitlesCoordinated — PR6 C4 (issue #30)', () => {
  it('fresh run: ONE title call, 2 output rows sharing input_hash, map equals persisted rows, one audited started+success pair on the ordinal-0 child run', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const childRunId = ordinal0ChildRunId(fixture);
    const inputHash = expectedInputHash(fixture);

    const map = await ensureCohortTitlesCoordinated({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.workspacePath,
      projection: fixture.projection,
      cohort: fixture.cohort,
      members: fixture.members,
      frozenLineContext: fixture.frozenLineContext,
    });

    expect(titleCallCount).toBe(1);
    expect(map.size).toBe(2);
    expect(map.get('100000000001')).toEqual({ title: 'Purina Pro Plan Dog Food Chicken 5 lb', source: 'llm_cohort' });
    expect(map.get('100000000002')).toEqual({ title: 'Purina Pro Plan Dog Food Beef 10 lb', source: 'llm_cohort' });

    // Persisted rows: 2, sharing the canonical input_hash, matching the map.
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].inputHash).toBe(inputHash);
    expect(rows[1].inputHash).toBe(inputHash);
    const persisted = new Map(rows.map(r => [r.productSku, JSON.parse(r.outputValueJson)]));
    expect(persisted.get('100000000001')).toEqual({ title: 'Purina Pro Plan Dog Food Chicken 5 lb', source: 'llm_cohort' });
    expect(persisted.get('100000000002')).toEqual({ title: 'Purina Pro Plan Dog Food Beef 10 lb', source: 'llm_cohort' });
    // model_call_id provenance: the audited call id from the mock. (The call
    // id sequence is monotonic across the file so rows never collide.)
    expect(rows.every(r => r.modelCallId === `title-call-${auditCallSeq}`)).toBe(true);

    // Exactly one audited started+success pair, bound to the ordinal-0 child run.
    const calls = getDb().query(
      "SELECT * FROM classification_model_calls WHERE operation = 'cohort_title_consolidation'",
    ).all() as Array<Record<string, any>>;
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.status).sort()).toEqual(['started', 'success']);
    expect(calls.every(c => c.run_id === childRunId)).toBe(true);
  });

  it('reuse: second call on the same run (cache cleared) → zero calls, identical map', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const first = await ensureCohortTitlesCoordinated({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.workspacePath,
      projection: fixture.projection,
      cohort: fixture.cohort,
      members: fixture.members,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(titleCallCount).toBe(1);

    // Prove DB authority: clear the in-memory coordinator cache first — the
    // parent op never consults it, so the durable outputs alone drive reuse.
    clearCohortCoordinationCache();
    const second = await ensureCohortTitlesCoordinated({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.workspacePath,
      projection: fixture.projection,
      cohort: fixture.cohort,
      members: fixture.members,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(titleCallCount).toBe(1);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(2);
  });

  it('hash mismatch: outputs written under an old input_hash → re-coordinates and replaces the set', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const inputHash = expectedInputHash(fixture);

    // Simulate a prior write under a different title authority (stale hash).
    const { replaceCohortTitleOutputs } = await import('../../db/repositories/classification-cohort-output-repo');
    replaceCohortTitleOutputs({
      workspaceId: fixture.workspaceId,
      runId: fixture.run.id,
      inputHash: 'a'.repeat(64),
      outputs: [
        { productSku: '100000000001', title: 'Old Chicken Title', source: 'cohort_fallback' },
        { productSku: '100000000002', title: 'Old Beef Title', source: 'cohort_fallback' },
      ],
    });

    const map = await ensureCohortTitlesCoordinated({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.workspacePath,
      projection: fixture.projection,
      cohort: fixture.cohort,
      members: fixture.members,
      frozenLineContext: fixture.frozenLineContext,
    });

    // Re-coordinated: one more title call, old rows replaced with the fresh T-hash.
    expect(titleCallCount).toBe(1);
    expect(map.get('100000000001')).toEqual({ title: 'Purina Pro Plan Dog Food Chicken 5 lb', source: 'llm_cohort' });
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.inputHash === inputHash)).toBe(true);
    expect(rows.some(r => r.productSku === '100000000001' && r.outputValueJson.includes('Old Chicken Title'))).toBe(false);
  });

  it('incomplete set: only 1 of 2 rows present → re-coordinates and completes the set', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    const first = await ensureCohortTitlesCoordinated({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.workspacePath,
      projection: fixture.projection,
      cohort: fixture.cohort,
      members: fixture.members,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(first.size).toBe(2);
    expect(titleCallCount).toBe(1);

    // Remove one member's row → the set is incomplete → re-coordinate.
    getDb().run(
      "DELETE FROM classification_cohort_outputs WHERE cohort_run_id = ? AND output_kind = 'curated_title' AND product_sku = '100000000002'",
      [fixture.run.id],
    );
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(1);

    const second = await ensureCohortTitlesCoordinated({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.workspacePath,
      projection: fixture.projection,
      cohort: fixture.cohort,
      members: fixture.members,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(titleCallCount).toBe(2);
    expect(second.size).toBe(2);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(2);
    expect(getCohortTitleOutputsByRun(fixture.run.id).every(r => r.inputHash === expectedInputHash(fixture))).toBe(true);
  });

  it('all-or-nothing: a forced insert failure (nonexistent workspace FK) → throws, zero rows remain', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    await expect(
      ensureCohortTitlesCoordinated({
        run: fixture.run,
        workspaceId: 'no-such-workspace',
        workspacePath: fixture.workspacePath,
        projection: fixture.projection,
        cohort: fixture.cohort,
        members: fixture.members,
        frozenLineContext: fixture.frozenLineContext,
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
  });

  it('HeartbeatLostError after the LLM returns (sibling reclaim) → no output rows, error propagates', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    reclaimAfterTitleCall = true;
    reclaimRunId = fixture.run.id;
    reclaimWorkspaceId = fixture.workspaceId;

    await expect(
      ensureCohortTitlesCoordinated({
        run: fixture.run,
        workspaceId: fixture.workspaceId,
        workspacePath: fixture.workspacePath,
        projection: fixture.projection,
        cohort: fixture.cohort,
        members: fixture.members,
        frozenLineContext: fixture.frozenLineContext,
      }),
    ).rejects.toBeInstanceOf(HeartbeatLostError);

    // The stale owner wrote NOTHING: no output rows (the reclaiming sibling
    // will reuse-or-coordinate on its own re-entry).
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
  });

  it('LLM failure → deterministic fallback persisted (source cohort_fallback, model_call_id NULL)', async () => {
    const fixture = await freezeCohortFixture(TWO_MEMBER_EXTRACTIONS);
    failNextTitleCall = true;

    const map = await ensureCohortTitlesCoordinated({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.workspacePath,
      projection: fixture.projection,
      cohort: fixture.cohort,
      members: fixture.members,
      frozenLineContext: fixture.frozenLineContext,
    });

    expect(map.size).toBe(2);
    for (const entry of map.values()) {
      expect(entry.source).toBe('cohort_fallback');
      expect(entry.title.length).toBeGreaterThan(0);
    }
    const rows = getCohortTitleOutputsByRun(fixture.run.id);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.modelCallId === null)).toBe(true);
    const parsed = rows.map(r => JSON.parse(r.outputValueJson));
    expect(parsed.every((p: any) => p.source === 'cohort_fallback')).toBe(true);
  });

  it('singleton members: no output row, no call (DECISION-O)', async () => {
    const fixture = await freezeCohortFixture({
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const map = await ensureCohortTitlesCoordinated({
      run: fixture.run,
      workspaceId: fixture.workspaceId,
      workspacePath: fixture.workspacePath,
      projection: fixture.projection,
      cohort: fixture.cohort,
      members: fixture.members,
      frozenLineContext: fixture.frozenLineContext,
    });
    expect(map.size).toBe(0);
    expect(titleCallCount).toBe(0);
    expect(countCohortTitleOutputs(fixture.run.id)).toBe(0);
  });
});
