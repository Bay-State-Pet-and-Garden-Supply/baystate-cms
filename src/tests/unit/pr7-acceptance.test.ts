/**
 * PR7 C7 (issue #30): acceptance integration test — durable parent Page
 * coordination (coordinated_page outputs), replay-safe after commit.
 *
 * Harness: pr6-acceptance.test.ts structure (temp DB, migrations,
 * `createReadyCohort`, active v2 bundle) with the PAGE curation target
 * ENABLED and a VERIFIED Page import frozen at cohort freeze. The counting
 * llm-client mock serves `cohort_page_assignment` (group) and
 * `page_assignment` (singleton) calls, writes the audited
 * `classification_model_calls` started+success pairs, and returns CANNED
 * per-SKU page assignments derived from the prompt's frozen page list (so
 * two group siblings can be assigned to DIFFERENT pages from ONE group call
 * — prompt rule 7). `denyPageCalls` switches the mock into the
 * policy-denied/unavailable mode (config resolves null → the coordinator
 * abstains every member with ZERO transport).
 *
 * Scenario coverage (architecture-report §7, PR7 C7):
 *  1. freeze (page target enabled, verified pages frozen) → processCohort #1
 *     establishes durable Page outputs: ONE group call + one singleton call,
 *     persisted in ONE transaction; `countCohortPageOutputs === member count`;
 *     members consume the EXACT stored assignments;
 *  2. crash after member 1 commits → expire the lease + reclaim → processCohort
 *     #2 on the SAME run: page op REUSES the stored set with ZERO page calls;
 *     remaining members consume the stored assignments; the committed member is
 *     skipped by the resume guard;
 *  3. reset member 1 (pending + cleared curation) → processCohort #3: page op
 *     REUSES (zero page calls), member 1 re-executes against a NEW child run
 *     with the SAME stored assignments;
 *  4. pre-commit crash replay: `afterCoordinatedCall` throws after transport
 *     success → zero output rows committed → reclaim → ONE more audited call →
 *     commit → every later entry call-free;
 *  5. drift (stale-hash rows) → `CohortPageAuthorityDriftError` → parent
 *     `superseded` + running children terminalized (error_message 'Cohort
 *     output authority drift superseded parent run') → the next claim yields a
 *     DIFFERENT parent run id → old page rows unchanged;
 *  6. wrong-owner no-op: a stale worker's supersede attempt is a no-op;
 *  7. policy-denied/unavailable → persisted `abstained` rows (one per member);
 *     retries make ZERO page calls;
 *  8. legitimate sibling page differences survive ONE group call (two
 *     siblings on DIFFERENT pages);
 *  9. singleton member parent-owned: exactly ONE output row, child
 *     materializes it, retry → zero calls;
 * 10. flag OFF / shadow → the LEGACY path (cached `coordinateCohortPagesOnce`
 *     + per-item `llmAssignCategoryPages`) is used byte-identically — zero
 *     durable page output rows, zero parent-op page calls.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
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
  findItemById,
  updateItemExtractionData,
  updateItemStageStatus,
  updateItemCurationData,
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
  getCohortById,
  getCohortMembers,
  computeMembershipHash,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  getCohortRunById,
  getCohortSnapshotByHash,
  reclaimExpiredCohortRuns,
  supersedeOwnedCohortRunForOutputDrift,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import {
  getCohortPageOutputsByRun,
  insertCohortPageOutputsOnce,
  countCohortPageOutputs,
} from '../../db/repositories/classification-cohort-output-repo';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { OnboardingWorker } from '../../onboarding/job-queue';
import {
  freezeCohortForExecution,
  processCohort,
  verifyCohortRunFrozen,
  buildFrozenProductLineContext,
  MemberCommitCrashSimulationError,
} from '../../onboarding/cohort-curator';
import { ensureCohortPagesCoordinated } from '../../onboarding/cohort-page-coordinator';
import type { CoordinatedPageMemberValue } from '../../classification/types';
import type { PreparedCohortContext } from '../../onboarding/cohort-curator';
import { curateItemWithPipeline } from '../../onboarding/product-curator';
import { clearCohortCoordinationCache } from '../../onboarding/cohort-name-coordinator';
import { clearCohortPageCoordinationCache } from '../../classification/cohort-page-coordinator';
import { getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
  getCohortCurationFlags,
} from '../../classification/flags';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import { ExecutionEvidenceProjectionV1Schema, CohortPageOutputSchema } from '../../shared/schemas/cohorts';
import type {
  CohortRun,
  CurationCohort,
  ExecutionEvidenceProjectionV1,
} from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';

// ─── llm-client mock (counting; simulates the audited transport rows) ─────────

/** Total `cohort_page_assignment` (group) transport invocations. */
let groupPageCallCount = 0;
/** Total `page_assignment` (singleton + legacy per-item) invocations. */
let singletonPageCallCount = 0;
/** Invocations carrying an audit context (the parent op's audited calls). */
let auditedPageCallCount = 0;
/** When true, the page model route resolves NULL and every transport returns
 *  null — the coordinator abstains every member with ZERO transport (the
 *  policy-denied/unavailable scenario, architecture-report §2.3). */
let denyPageCalls = false;
let auditCallSeq = 0;

const PAGE_NAMES = ['Dog Food Dry', 'Dog Treats', 'Brand - Acme'];

/** Extract the frozen page list from a page prompt (`[ID:xxx] Name ...`). */
function pageListFromPrompt(prompt: string): Array<{ id: string; name: string }> {
  const matches = [...prompt.matchAll(/\[ID:([^\]]+)\]\s+([^\n(]+)/g)];
  return matches.map(match => ({ id: match[1], name: match[2].trim() }));
}

function findPage(pages: Array<{ id: string; name: string }>, name: string) {
  return pages.find(page => page.name === name) ?? null;
}

/** The group response: every SKU in the prompt assigned to a FROZEN page.
 *  Siblings differ by design (rule 7): SKU1 → Dog Food Dry, SKU2 → Dog
 *  Treats — both from ONE group call. */
function cannedGroupResponse(prompt: string): string {
  const pages = pageListFromPrompt(prompt);
  const skus = [...prompt.matchAll(/^SKU (\d{10,})$/gm)].map(match => match[1]);
  const payload: Record<string, unknown> = {};
  skus.forEach((sku, index) => {
    const page = index % 2 === 0 ? findPage(pages, PAGE_NAMES[0]) : findPage(pages, PAGE_NAMES[1]);
    payload[sku] = page ? [{ pageId: page.id, pageName: page.name, confidence: 0.85 }] : [];
  });
  return JSON.stringify(payload);
}

/** The singleton response: `{"pages":[...]}` (llmAssignCategoryPages shape). */
function cannedSingletonResponse(prompt: string): string {
  const pages = pageListFromPrompt(prompt);
  const page = findPage(pages, PAGE_NAMES[0]);
  return JSON.stringify({ pages: page ? [{ pageId: page.id, pageName: page.name, confidence: 0.85 }] : [] });
}

function mockGetLlmConfigForTask(_task: string, options: Record<string, any>): Record<string, any> | null {
  const operation = options?.protectedOperation;
  if (denyPageCalls && (operation === 'cohort_page_assignment' || operation === 'page_assignment')) {
    return null;
  }
  return {
    provider: 'ollama',
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5vl:latest',
  };
}

/** Simulate the audited transport's durable started + success rows. The
 *  RETURNED call id must be a real `classification_model_calls.id` (the
 *  materialized proposals link to it), so the success row carries the returned
 *  id and the started row a suffixed mirror. */
function writeAuditPair(runId: string, snapshotHash: string | null, callId: string, operation: string): void {
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, 'category_page_proposals', ?, 1, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
    [`${callId}-started`, runId, operation, snapshotHash, 'page-assignment-prompt-v1', 'page-assignment-rules-v1', 'sys-hash', 'user-hash', now, null, now],
  );
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, 'category_page_proposals', ?, 1, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
    [callId, runId, operation, snapshotHash, 'page-assignment-prompt-v1', 'page-assignment-rules-v1', 'sys-hash', 'user-hash', now, now, now],
  );
}

function mockCallLlmForTaskWithProvenance(
  task: string,
  prompt: string,
  systemPrompt: string,
  options: Record<string, any>,
): { content: string; callId: string; provider: string; model: string; usage: Record<string, number | null> } | null {
  const operation = options?.protectedOperation;
  if (operation !== 'cohort_page_assignment' && operation !== 'page_assignment') return null;
  if (denyPageCalls) return null;
  const callId = `page-call-${++auditCallSeq}`;
  if (operation === 'cohort_page_assignment') {
    groupPageCallCount++;
    if (options.modelCall) {
      auditedPageCallCount++;
      writeAuditPair(options.modelCall.runId, options.modelCall.snapshotHash ?? null, callId, operation);
    }
    return {
      content: cannedGroupResponse(prompt),
      callId,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  singletonPageCallCount++;
  if (options.modelCall) {
    auditedPageCallCount++;
    writeAuditPair(options.modelCall.runId, options.modelCall.snapshotHash ?? null, callId, operation);
  }
  return {
    content: cannedSingletonResponse(prompt),
    callId,
    provider: 'ollama',
    model: 'qwen2.5vl:latest',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

mock.module('../../onboarding/llm-client', () => ({
  getLlmConfigForTask: (task: string, options: Record<string, any>) => mockGetLlmConfigForTask(task, options),
  callLlmForTask: () => null,
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
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr7-acceptance-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

afterEach(() => {
  groupPageCallCount = 0;
  singletonPageCallCount = 0;
  auditedPageCallCount = 0;
  denyPageCalls = false;
  resetCohortCurationFlagsOverride();
  clearCohortCoordinationCache();
  clearCohortPageCoordinationCache();
  // NOTE: `auditCallSeq` is deliberately NOT reset — the audit-row ids must
  // stay globally unique across tests in this shared database file.
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

/** Write a lifecycle-ACTIVE v2 bundle (reviewed Bay State seed) to disk with
 *  the PAGE curation target left ENABLED (unlike the PR6 acceptance harness),
 *  so the frozen member snapshots resolve a verified Page catalog and the
 *  parent page op coordinates real pages. */
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

  const focusedFiles = buildFocusedFiles(bundle);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const manifestWithoutHash = {
    ...bundle.manifest,
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
  return { bundle: { ...bundle, manifest }, xmlFields };
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

/** ocrInputHash for the same canonical input set computeOcrInputHash uses. */
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
  const batchId = createBatch({ workspaceId: wsId, name: 'PR7 Acceptance Batch', fileName: 'pr7.xlsx', totalItems: itemsData.length }).id;
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

function cohortRunCount(wsId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM classification_cohort_runs WHERE workspace_id = ?',
  ).get(wsId) as { cnt: number };
  return Number(row.cnt);
}

function countPageAuditRowsForRun(cohortRunId: string): number {
  const row = getDb().query(
    `SELECT COUNT(*) AS cnt FROM classification_model_calls
     WHERE operation IN ('cohort_page_assignment', 'page_assignment')
       AND run_id IN (SELECT id FROM classification_runs WHERE cohort_run_id = ?)`,
  ).get(cohortRunId) as { cnt: number };
  return Number(row.cnt);
}

function countOutputRowsForWorkspace(wsId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM classification_cohort_outputs WHERE workspace_id = ?',
  ).get(wsId) as { cnt: number };
  return Number(row.cnt);
}

// ─── Scenario helpers ─────────────────────────────────────────────────────────

const THREE_MEMBER_EXTRACTIONS = {
  // Members 1 + 2 share brand + name stem → ONE `groupByProductLine` group.
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme' }),
  // Member 3: a DIFFERENT stem → a singleton group of 1 (parent-owned too).
  '100000000003': settledExtraction({ _name: 'Purina Pro Plan Adult Dog Food Salmon 5 lb', _brandHint: 'Acme' }),
};

const TWO_MEMBER_EXTRACTIONS = {
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme' }),
};

/** Activate ONE verified Page import with the fixture pages (Dog Food Dry,
 *  Dog Treats, Brand - Acme). Returns the generated page_index ids. */
function activateVerifiedPages(wsId: string): Map<string, string> {
  const pages = [
    { key: 'dog-food-dry', name: 'Dog Food Dry' },
    { key: 'dog-treats', name: 'Dog Treats' },
    { key: 'brand-acme', name: 'Brand - Acme' },
  ];
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('pr7-acceptance-pages'),
    parserFormatVersion: 'pages-xml-1',
    records: pages.map(page => ({
      identity: { kind: 'exported_guid' as const, key: page.key, status: 'verified' as const },
      name: page.name,
      parentRef: null,
      availability: 'available' as const,
    })),
    activatedBy: 'test',
  });
  const byName = new Map<string, string>();
  for (const row of listVerifiedPageOptions(wsId)) byName.set(row.name, row.id);
  const result = new Map<string, string>();
  for (const page of pages) {
    const id = byName.get(page.name);
    if (!id) throw new Error(`verified fixture page not created: ${page.name}`);
    result.set(page.key, id);
  }
  return result;
}

/** Write the active v2 bundle + persist its config snapshot, activate the
 *  verified Page import, then create the ready cohort. The product-line
 *  cohort formation can split the fixture into multiple cohorts (one per
 *  brand+stem) — they are merged into a SINGLE cohort (the singleton's cohort
 *  is superseded and its members moved) so the parent page op covers a
 *  mixed group+singleton P-set in ONE run (mirrors the PR6 SHOULD-FIX 2
 *  merge). */
function prepareActiveV2Workspace(
  wsId: string,
  wsPath: string,
  extByUpc: Record<string, Record<string, any>>,
): { items: OnboardingItem[]; cohorts: CurationCohort[] } {
  const { bundle } = writeActiveV2Bundle(wsPath);
  upsertConfigSnapshot(wsId, bundle);
  activateVerifiedPages(wsId);
  const created = createReadyCohort(wsId, extByUpc);
  if (created.cohorts.length > 1) {
    const target = created.cohorts[0];
    for (const donor of created.cohorts.slice(1)) {
      getDb().run('UPDATE curation_cohort_members SET cohort_id = ? WHERE cohort_id = ?', [target.id, donor.id]);
      getDb().run(
        "UPDATE curation_cohorts SET status = 'superseded', superseded_at = ? WHERE id = ?",
        [new Date().toISOString(), donor.id],
      );
    }
    getDb().run(
      'UPDATE curation_cohorts SET membership_hash = ? WHERE id = ?',
      [computeMembershipHash(created.items.map(item => item.id)), target.id],
    );
    // The donor members kept their ORIGINAL cohort ordinals — renumber every
    // merged member 0..n-1 in item order so the parent op's ordinal-sorted
    // member loop matches the fixture's intended order.
    const members = getDb().query(
      'SELECT onboarding_item_id FROM curation_cohort_members WHERE cohort_id = ? ORDER BY rowid',
    ).all(target.id) as Array<{ onboarding_item_id: string }>;
    members.forEach((member, index) => {
      getDb().run(
        'UPDATE curation_cohort_members SET ordinal = ? WHERE cohort_id = ? AND onboarding_item_id = ?',
        [index, target.id, member.onboarding_item_id],
      );
    });
  }
  return { items: created.items, cohorts: created.cohorts };
}

/** Freeze a ready cohort under the ACTIVE v2 bundle with the flags ON. */
async function freezeActiveCohort(
  wsId: string,
  wsPath: string,
): Promise<CohortRun> {
  overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
  const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
  const finalized = await freezeCohortForExecution(run, wsPath, wsId);
  expect(finalized.status).toBe('running');
  return finalized;
}

function loadFrozenProjection(workspaceId: string, run: CohortRun): ExecutionEvidenceProjectionV1 {
  const snap = getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash!)!;
  return ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snap.payloadJson)) as ExecutionEvidenceProjectionV1;
}

/** Build a prepared-cohort context for one member from the frozen run. */
function buildPreparedContext(
  workspaceId: string,
  run: CohortRun,
  item: OnboardingItem,
  frozenLineContext: ReturnType<typeof buildFrozenProductLineContext>,
): PreparedCohortContext {
  const snap = getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash!)!;
  const projection = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snap.payloadJson)) as ExecutionEvidenceProjectionV1;
  const memberProjection = projection.members.find(m => m.onboardingItemId === item.id)!;
  const child = getDb().query(
    'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
  ).get(run.id, item.id) as Record<string, any>;
  const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
  return {
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
    productLineContext: frozenLineContext.productLineContext,
    productLineItems: frozenLineContext.productLineItems,
    frozenBatchItems: frozenLineContext.frozenBatchItems,
    coordinatedPages: new Map<string, CoordinatedPageMemberValue>(
      getCohortPageOutputsByRun(run.id).map(row => [
        row.productSku,
        {
          output: CohortPageOutputSchema.parse(JSON.parse(row.outputValueJson)),
          modelCallId: row.modelCallId,
        },
      ]),
    ),
  };
}

describe('PR7 acceptance — durable parent page coordination, replay-safe after commit (issue #30)', () => {
  it('1-2-3: freeze writes verified pages; processCohort #1 coordinates ONE group call + ONE singleton call and persists a row per member; kill/restart reuses with ZERO page calls; a NEW child re-execution consumes the SAME stored assignments', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    // Freeze: running + execution type + a VERIFIED page catalog.
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBe('dog-food-dry');

    // ── processCohort #1: crash after the SECOND member's pipeline completes
    // (before ITS atomic commit) — member 1 COMMITS, members 2 and 3 do not.
    // The parent page op already persisted every member's page output BEFORE
    // the member loop (one group call + one singleton call).
    let pipelineCount = 0;
    await expect(processCohort(finalized, wsPath, workspaceId, {
      afterMemberPipeline: () => {
        pipelineCount++;
        if (pipelineCount === 2) {
          throw new MemberCommitCrashSimulationError('simulated kill after member 1 commit');
        }
      },
    })).rejects.toThrow('simulated kill after member 1 commit');

    // The durable set: EXACTLY ONE group call + ONE singleton call; a row for
    // EVERY member (the P-set, DECISION-A).
    expect(groupPageCallCount).toBe(1);
    expect(singletonPageCallCount).toBe(1);
    expect(countCohortPageOutputs(finalized.id)).toBe(3);
    const rows = getCohortPageOutputsByRun(finalized.id);
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.inputHash === rows[0].inputHash)).toBe(true);
    expect(rows.every(r => r.inputHash.length === 64)).toBe(true);
    // One audited started+success pair per invocation (group + singleton).
    expect(auditedPageCallCount).toBe(2);

    // Member 1 committed with its stored assignment; members 2+3 untouched.
    const memberOne = findItemById(items[0].id)!;
    expect(memberOne.stageStatus).toBe('completed');
    const memberOnePages = memberOne.curationData!.classificationProposals.filter(
      proposal => proposal.proposalType === 'category_page',
    );
    expect(memberOnePages.length).toBeGreaterThan(0);
    expect(memberOnePages.every(p => (p.proposedValue as any).identityVerified === true)).toBe(true);
    const memberTwo = findItemById(items[1].id)!;
    const memberThree = findItemById(items[2].id)!;
    expect(memberTwo.stageStatus).toBe('pending');
    expect(memberThree.stageStatus).toBe('pending');

    // Kill/restart: clear BOTH caches (DB authority), expire the lease,
    // reclaim with a NEW worker id → resume the SAME run via the frozen-match.
    clearCohortCoordinationCache();
    clearCohortPageCoordinationCache();
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
    const reclaim = reclaimExpiredCohortRuns(
      workspaceId,
      new Date().toISOString(),
      () => verifyCohortRunFrozen(getCohortRunById(finalized.id)!, wsPath, workspaceId) ? 'match' : 'drift',
      'worker-b',
      COHORT_LEASE_TTL_MS,
    );
    expect(reclaim.resumed.length).toBe(1);
    expect(reclaim.resumed[0].id).toBe(finalized.id);
    const resumed = getCohortRunById(finalized.id)!;

    // ── processCohort #2: page op REUSES the stored set with ZERO page
    // calls; member 1 skipped by the resume guard; member 2 commits; crash
    // again after member 3's pipeline so the parent STAYS running (the
    // member-1 retry below must run against a live parent).
    const pageCallsBefore = groupPageCallCount + singletonPageCallCount;
    const auditRowsBefore = countPageAuditRowsForRun(finalized.id);
    let resumePipelineCount = 0;
    await expect(processCohort(resumed, wsPath, workspaceId, {
      afterMemberPipeline: () => {
        resumePipelineCount++;
        if (resumePipelineCount === 2) {
          throw new MemberCommitCrashSimulationError('simulated kill after member 2 commit');
        }
      },
    })).rejects.toThrow('simulated kill after member 2 commit');
    expect(groupPageCallCount + singletonPageCallCount).toBe(pageCallsBefore); // ZERO new page calls
    expect(countPageAuditRowsForRun(finalized.id)).toBe(auditRowsBefore);

    const memberTwoAfter = findItemById(items[1].id)!;
    const memberThreeAfter = findItemById(items[2].id)!;
    expect(memberTwoAfter.stageStatus).toBe('completed');
    expect(memberThreeAfter.stageStatus).toBe('pending');

    // ── Retry member 1 with a NEW child run: reset the item (stage pending,
    // curation cleared) and processCohort #3. The old child is terminal, so
    // ensureMemberRun creates a NEW child; the page op REUSES (zero calls);
    // the re-executed member materializes the SAME stored assignments and
    // member 3 finally commits; the parent completes.
    updateItemStageStatus(items[0].id, 'pending');
    updateItemCurationData(items[0].id, '');
    const childBefore = getDb().query(
      'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(finalized.id, items[0].id) as { id: string } | undefined;
    const summary3 = await processCohort(resumed, wsPath, workspaceId);
    expect(summary3.parentStatus).not.toBe('failed');
    expect(groupPageCallCount + singletonPageCallCount).toBe(pageCallsBefore); // STILL zero page calls
    const childAfter = getDb().query(
      'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(finalized.id, items[0].id) as { id: string } | undefined;
    expect(childAfter).toBeTruthy();
    expect(childAfter!.id).not.toBe(childBefore!.id); // a NEW child run

    // Every member now consumes the EXACT stored assignments (containment — a
    // crash-recovered member may carry pre-crash-attempt proposals on the SAME
    // child run, PR4 documented additive behavior; the durable rows are the
    // byte-stable authority).
    const storedBySku = new Map(rows.map(r => [r.productSku, JSON.parse(r.outputValueJson)]));
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const pageProposals = stored.curationData!.classificationProposals.filter(
        proposal => proposal.proposalType === 'category_page',
      );
      expect(pageProposals.length).toBeGreaterThan(0);
      const storedRow = storedBySku.get(item.upc) as { pages: Array<{ pageId: string; pageName: string; confidence: number }> };
      const storedPageIds = storedRow.pages.map(page => page.pageId);
      const proposalPageIds = pageProposals.map(proposal => proposal.targetId);
      for (const pageId of storedPageIds) {
        expect(proposalPageIds).toContain(pageId);
      }
      expect(new Set(proposalPageIds).size).toBeGreaterThanOrEqual(new Set(storedPageIds).size);
      expect(pageProposals.every(p => (p.proposedValue as any).identityVerified === true)).toBe(true);
    }
    const rerunMemberOne = findItemById(items[0].id)!;
    const rerunPages = rerunMemberOne.curationData!.classificationProposals.filter(
      proposal => proposal.proposalType === 'category_page',
    );
    const storedMemberOne = storedBySku.get(items[0].upc) as { pages: Array<{ pageId: string; pageName: string }> };
    expect(rerunPages.map(p => p.targetId).sort()).toEqual(storedMemberOne.pages.map(page => page.pageId).sort());

    // Total transport: exactly ONE group + ONE singleton call across the
    // whole kill/restart/re-execute scenario (replay-safe after commit).
    expect(groupPageCallCount).toBe(1);
    expect(singletonPageCallCount).toBe(1);
  });

  it('4: pre-commit crash replay — afterCoordinatedCall throws after transport success → zero rows committed → reclaim re-invokes → commit → later entries are call-free', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    prepareActiveV2Workspace(workspaceId, wsPath, TWO_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);
    const projection = loadFrozenProjection(workspaceId, finalized);
    const cohort = getCohortById(finalized.cohortId)!;
    const members = getCohortMembers(cohort.id);
    const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);

    // The parent page op's group transport SUCCEEDS (audited rows are durable)
    // but the crash seam throws before the outputs transaction — no row is
    // committed. The seam throws ONLY on this direct invocation; the reclaim
    // re-invokes via processCohort and commits.
    await expect(
      ensureCohortPagesCoordinated({
        run: finalized,
        workspaceId,
        workspacePath: wsPath,
        projection,
        cohort,
        members,
        frozenLineContext,
        afterCoordinatedCall: () => {
          throw new MemberCommitCrashSimulationError('simulated pre-commit crash after transport success');
        },
      }),
    ).rejects.toThrow('simulated pre-commit crash after transport success');

    expect(countCohortPageOutputs(finalized.id)).toBe(0); // nothing committed
    expect(auditedPageCallCount).toBe(1); // one audited group invocation

    // Reclaim + resume: the set is still empty → ONE more audited call, then
    // the transaction commits.
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
    const reclaim = reclaimExpiredCohortRuns(
      workspaceId,
      new Date().toISOString(),
      () => verifyCohortRunFrozen(getCohortRunById(finalized.id)!, wsPath, workspaceId) ? 'match' : 'drift',
      'worker-b',
      COHORT_LEASE_TTL_MS,
    );
    expect(reclaim.resumed.length).toBe(1);
    const resumed = getCohortRunById(finalized.id)!;
    const summary = await processCohort(resumed, wsPath, workspaceId);
    expect(summary.parentStatus).not.toBe('failed');
    expect(countCohortPageOutputs(finalized.id)).toBe(2);
    expect(auditedPageCallCount).toBe(2); // 1 failed invocation + 1 successful

    // Subsequent entries: ZERO calls — re-invoking the parent page op on the
    // now-completed run reuses the committed set (pure read; the coordinate
    // path is unreachable once the set is complete + hash-matched).
    const pageCalls = groupPageCallCount + singletonPageCallCount;
    const reused = await ensureCohortPagesCoordinated({
      run: resumed,
      workspaceId,
      workspacePath: wsPath,
      projection,
      cohort,
      members,
      frozenLineContext,
    });
    expect(reused.size).toBe(2);
    expect([...reused.values()].every(value => value.output.status === 'assigned')).toBe(true);
    expect(groupPageCallCount + singletonPageCallCount).toBe(pageCalls);
    expect(countPageAuditRowsForRun(finalized.id)).toBe(4); // no new audited rows
  });

  it('5-6: drift rows → CohortPageAuthorityDriftError → parent SUPERSEDED + running children terminalized → next claim yields a DIFFERENT run id; wrong-owner supersede is a no-op; old page rows unchanged', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    // Corrupt the committed set BEFORE any processCohort entry: seed rows with
    // a STALE hash (as if the frozen page authority had drifted).
    const projection = loadFrozenProjection(workspaceId, finalized);
    const skus = projection.members.map(member => member.productSku ?? '');
    insertCohortPageOutputsOnce({
      workspaceId,
      runId: finalized.id,
      inputHash: 'b'.repeat(64), // stale authority hash
      outputs: skus.map(productSku => ({
        productSku,
        output: { status: 'abstained', reason: 'seeded stale page output' },
        modelCallId: null,
      })),
    });
    expect(countCohortPageOutputs(finalized.id)).toBe(3);

    const childrenBefore = getDb().query(
      'SELECT id, status FROM classification_runs WHERE cohort_run_id = ?',
    ).all(finalized.id) as Array<{ id: string; status: string }>;
    expect(childrenBefore.length).toBeGreaterThan(0);

    await expect(processCohort(finalized, wsPath, workspaceId)).rejects.toThrow(/CohortPageAuthorityDrift/);

    const terminal = getCohortRunById(finalized.id)!;
    expect(terminal.status).toBe('superseded');
    expect(terminal.errorMessage).toContain('CohortPageAuthorityDrift');
    expect(terminal.errorMessage).toContain(finalized.id);
    for (const child of childrenBefore) {
      const after = getDb().query(
        'SELECT status, error_message FROM classification_runs WHERE id = ?',
      ).get(child.id) as { status: string; error_message: string | null };
      expect(after.status).toBe('failed');
      // Terminalized children carry the deterministic supersede message.
      expect(after.error_message).toContain('Cohort output authority drift superseded parent run');
    }
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('pending');
      expect(stored.curationData).toBeNull();
    }
    // Old page rows unchanged (immutable historical truth).
    expect(getCohortPageOutputsByRun(finalized.id)).toHaveLength(3);

    // Wrong-owner no-op: a STALE worker (never claimed the run) cannot
    // supersede it — the owner-guarded drift primitive is a no-op.
    const staleChanges = supersedeOwnedCohortRunForOutputDrift(
      finalized.id,
      'stale-worker',
      'stale worker supersede attempt',
    );
    expect(staleChanges).toBe(false);
    const stillSuperseded = getCohortRunById(finalized.id)!;
    expect(stillSuperseded.status).toBe('superseded');
    expect(stillSuperseded.errorMessage).toContain('CohortPageAuthorityDrift');
    expect(stillSuperseded.errorMessage).not.toContain('stale worker');

    // The next claim immediately yields a DIFFERENT parent run id.
    const [run2] = claimReadyCurationCohorts(workspaceId, 10, 'worker-next', COHORT_LEASE_TTL_MS);
    expect(run2).toBeTruthy();
    expect(run2.id).not.toBe(finalized.id);
  });

  it('7: policy-denied/unavailable → persisted abstained rows (one per member); retries make ZERO page calls', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    denyPageCalls = true;
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    // The parent op coordinates with a DENIED page route: the group core
    // records an unavailable terminal preflight and abstains every group
    // member; the singleton path deterministically abstains — with ZERO
    // transport. Every member's result persists as a durable abstained row.
    const summary = await processCohort(finalized, wsPath, workspaceId);
    expect(summary.parentStatus).not.toBe('failed');
    expect(groupPageCallCount).toBe(0);
    expect(singletonPageCallCount).toBe(0);
    expect(auditedPageCallCount).toBe(0);
    expect(countCohortPageOutputs(finalized.id)).toBe(3);
    const rows = getCohortPageOutputsByRun(finalized.id);
    expect(rows.every(r => JSON.parse(r.outputValueJson).status === 'abstained')).toBe(true);
    // Children materialize the stored abstention (the category_page stage
    // abstains with the stored reason — no LLM, no invention).
    for (const item of getDb().query(
      `SELECT i.id FROM onboarding_items i
       JOIN onboarding_batches b ON b.id = i.batch_id
       WHERE b.workspace_id = ?`,
    ).all(workspaceId) as Array<{ id: string }>) {
      const stored = findItemById(item.id)!;
      expect(['completed', 'completed_with_abstentions']).toContain(stored.stageStatus);
      const pageProposals = stored.curationData!.classificationProposals.filter(
        proposal => proposal.proposalType === 'category_page',
      );
      expect(pageProposals).toHaveLength(0);
    }

    // Retry (still denied): the durable set is complete + hash-matched → the
    // page op REUSES with ZERO calls. The parent completed after the first
    // entry, so the reuse is proven by re-invoking the parent op directly
    // (pure read on the committed set).
    const projection = loadFrozenProjection(workspaceId, finalized);
    const cohort = getCohortById(finalized.cohortId)!;
    const members = getCohortMembers(cohort.id);
    const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
    const pageCalls = groupPageCallCount + singletonPageCallCount;
    const reused = await ensureCohortPagesCoordinated({
      run: finalized,
      workspaceId,
      workspacePath: wsPath,
      projection,
      cohort,
      members,
      frozenLineContext,
    });
    expect(reused.size).toBe(3);
    expect([...reused.values()].every(value => value.output.status === 'abstained')).toBe(true);
    expect(groupPageCallCount + singletonPageCallCount).toBe(pageCalls);
    expect(countCohortPageOutputs(finalized.id)).toBe(3);
    expect(getCohortPageOutputsByRun(finalized.id).every(r => JSON.parse(r.outputValueJson).status === 'abstained')).toBe(true);
  });

  it('8: legitimate sibling page differences survive ONE group call (two siblings assigned to DIFFERENT pages)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    const summary = await processCohort(finalized, wsPath, workspaceId);
    expect(summary.parentStatus).not.toBe('failed');
    // ONE group call for the two siblings; the singleton used the per-item
    // parent path.
    expect(groupPageCallCount).toBe(1);
    expect(countCohortPageOutputs(finalized.id)).toBe(3);

    const siblingOne = findItemById(items[0].id)!;
    const siblingTwo = findItemById(items[1].id)!;
    const pagesOne = siblingOne.curationData!.classificationProposals.filter(p => p.proposalType === 'category_page');
    const pagesTwo = siblingTwo.curationData!.classificationProposals.filter(p => p.proposalType === 'category_page');
    expect(pagesOne.length).toBeGreaterThan(0);
    expect(pagesTwo.length).toBeGreaterThan(0);
    // Rule 7: siblings may legitimately differ — the canned response assigned
    // one to Dog Food Dry and the other to Dog Treats from ONE group call.
    const pagesByName = new Map<string, string[]>();
    for (const row of getCohortPageOutputsByRun(finalized.id)) {
      const names = (JSON.parse(row.outputValueJson).pages as Array<{ pageName: string }>).map(p => p.pageName);
      pagesByName.set(row.productSku, names);
    }
    const namesOne = pagesByName.get(items[0].upc)!;
    const namesTwo = pagesByName.get(items[1].upc)!;
    expect(namesOne.some(name => name === 'Dog Food Dry')).toBe(true);
    expect(namesTwo.some(name => name === 'Dog Treats')).toBe(true);
    expect(pagesOne[0].targetId).not.toBe(pagesTwo[0].targetId);
  });

  it('9: singleton member parent-owned — exactly ONE output row; the child materializes it; retry → zero calls', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    const finalized = await freezeActiveCohort(workspaceId, wsPath);

    const summary = await processCohort(finalized, wsPath, workspaceId);
    expect(summary.parentStatus).not.toBe('failed');
    // The singleton member (100000000003) has exactly ONE durable row AND its
    // proposals came from the stored row — the per-item child path was NOT
    // consulted (no second call).
    expect(singletonPageCallCount).toBe(1);
    const singleton = findItemById(items[2].id)!;
    expect(singleton.stageStatus).toBe('completed');
    const singletonPages = singleton.curationData!.classificationProposals.filter(p => p.proposalType === 'category_page');
    expect(singletonPages.length).toBeGreaterThan(0);
    const singletonRow = getCohortPageOutputsByRun(finalized.id).find(row => row.productSku === items[2].upc)!;
    expect(singletonRow).toBeTruthy();
    const rowPages = JSON.parse(singletonRow.outputValueJson).pages as Array<{ pageId: string }>;
    expect(singletonPages.map(p => p.targetId).sort()).toEqual(rowPages.map(page => page.pageId).sort());
    expect(singletonPages.every(p => (p.proposedValue as any).identityVerified === true)).toBe(true);

    // Retry the singleton (reset + re-run the member pipeline in prepared
    // mode against the persisted outputs): ZERO page calls.
    const projection = loadFrozenProjection(workspaceId, finalized);
    const cohort = getCohortById(finalized.cohortId)!;
    const members = getCohortMembers(cohort.id);
    const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
    const pageCalls = groupPageCallCount + singletonPageCallCount;
    updateItemStageStatus(singleton.id, 'pending');
    updateItemCurationData(singleton.id, '');
    const prepared = buildPreparedContext(workspaceId, finalized, singleton, frozenLineContext);
    const rerun = await curateItemWithPipeline(findItemById(singleton.id)!, wsPath, workspaceId, prepared);
    const rerunPages = rerun.classificationProposals.filter(p => p.proposalType === 'category_page');
    expect(rerunPages.length).toBeGreaterThan(0);
    expect(rerunPages.map(p => p.targetId).sort()).toEqual(rowPages.map(page => page.pageId).sort());
    expect(groupPageCallCount + singletonPageCallCount).toBe(pageCalls);
  });

  it('10: flag OFF / shadow — the LEGACY path (cached coordinateCohortPagesOnce + per-item llmAssignCategoryPages) is used byte-identically; zero durable page rows, zero parent-op calls', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS);
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);

    // The legacy child path keeps the reviewed-Type gate: seed an ACCEPTED
    // Primary Product Type fact (bundle-compatible snapshot hash) for every
    // member so the `category_page_proposals` stage passes the gate and runs
    // the legacy coordinator + per-item singleton paths (the flag-OFF/shadow
    // byte-identity this scenario proves).
    const { bundle } = writeActiveV2Bundle(wsPath);
    for (const item of items) {
      const now = new Date().toISOString();
      const runId = `legacy-type-run-${item.id}`;
      const proposalId = `legacy-type-proposal-${item.id}`;
      getDb().run(
        `INSERT INTO classification_runs
         (id, workspace_id, onboarding_item_id, product_sku, source_kind, config_snapshot_hash, status, started_at)
         VALUES (?, ?, ?, ?, 'onboarding', ?, 'completed', ?)`,
        [runId, workspaceId, item.id, item.upc, bundle.manifest.bundleHash, now],
      );
      getDb().run(
        `INSERT INTO classification_proposals
         (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'primary_product_type', ?, ?, 0.95, 'accepted', ?)`,
        [proposalId, runId, item.upc, 'dog-food-dry', JSON.stringify({ productTypeId: 'dog-food-dry' }), now],
      );
      getDb().run(
        `INSERT INTO classification_proposal_decisions
         (id, proposal_id, decision, revised_value_json, revised_target_id, created_at, superseded_at)
         VALUES (?, ?, 'accepted', ?, ?, ?, NULL)`,
        [`legacy-type-decision-${item.id}`, proposalId, JSON.stringify({ productTypeId: 'dog-food-dry' }), 'dog-food-dry', now],
      );
    }

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // Legacy per-item path, byte-identical: NO cohort runs and NO durable
    // page output rows — the parent op (`ensureCohortPagesCoordinated`) never
    // ran. Unlike the parent op (whose audited calls bind to the ordinal-0
    // child), the LEGACY child page calls ARE audited on each member's own
    // child run (issue #17 work item E — `processPageTarget` builds a
    // modelCall context) — so the discriminator is the absent cohort
    // machinery, not a zero call count.
    expect(cohortRunCount(workspaceId)).toBe(0);
    expect(countOutputRowsForWorkspace(workspaceId)).toBe(0);
    expect(groupPageCallCount).toBeGreaterThanOrEqual(1); // legacy group coordinator
    expect(singletonPageCallCount).toBeGreaterThanOrEqual(1); // legacy per-item singleton
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData!.classificationProposals.some(p => p.proposalType === 'category_page')).toBe(true);
    }
  });
});
