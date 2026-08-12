/**
 * PR9 acceptance (issue #30): semantic cohort validation.
 *
 * C4 — PR5 dependency P2 (DECISION-B): universal-attribute `field_assignment`
 * proposals carry NO product-type dependency (execution-driven AND
 * reviewed-driven); type-dependent proposals keep the exact same value hash;
 * `category_page` stamping (PR7 C6) unchanged.
 *
 * Harness: pr7/pr8-acceptance structure (temp DB, migrations,
 * `prepareActiveV2Workspace`, verified Page import, THREE-member cohort with
 * one 2-sibling group + one singleton) plus the counting llm-client mock.
 * The Bay State seed's `brand` attribute is UNIVERSAL with an enabled
 * product_field target, and `flavor` is non-universal + pet-food-profile —
 * so members deterministically emit BOTH a universal and a type-dependent
 * field_assignment proposal. The parent ops persist durable title rows
 * (cohort_fallback) + durable page rows (canned per-SKU assignments) BEFORE
 * the member loop.
 *
 * C5 (later commit) extends this file with the full reviewer acceptance list.
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
  listDependenciesForProposal,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import {
  getCohortTitleOutputsByRun,
  getCohortPageOutputsByRun,
} from '../../db/repositories/classification-cohort-output-repo';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { freezeCohortForExecution, processCohort } from '../../onboarding/cohort-curator';
import { clearCohortCoordinationCache } from '../../onboarding/cohort-name-coordinator';
import { clearCohortPageCoordinationCache } from '../../classification/cohort-page-coordinator';
import { getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
} from '../../classification/flags';
import type { ModelCallContext } from '../../classification/model-operation-registry';
import { canonicalJsonFileString, sha256Hex, hashCanonicalJson } from '../../shared/stable-id';
import {
  ClassificationManifestV2Schema,
  ClassificationFocusedFileNames,
} from '../../shared/schemas/classification';
import { ExecutionEvidenceProjectionV1Schema, CohortPageOutputSchema } from '../../shared/schemas/cohorts';
import type { CohortRun, CurationCohort, ExecutionEvidenceProjectionV1 } from '../../shared/schemas/cohorts';
import type { OnboardingItem, CurationData } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import type { CoordinatedPageMemberValue } from '../../classification/types';

// ─── llm-client mock (counting; production audit semantics) ───────────────────

let auditCallSeq = 0;

const PAGE_NAMES = ['Dog Food Dry', 'Dog Treats', 'Brand - Acme'];

function pageListFromPrompt(prompt: string): Array<{ id: string; name: string }> {
  const matches = [...prompt.matchAll(/\[ID:([^\]]+)\]\s+([^\n(]+)/g)];
  return matches.map(match => ({ id: match[1], name: match[2].trim() }));
}

function findPage(pages: Array<{ id: string; name: string }>, name: string) {
  return pages.find(page => page.name === name) ?? null;
}

/** The group response: every SKU in the prompt assigned to a FROZEN page.
 *  Siblings differ by design (rule 7): the SKU VALUE decides the page. */
function cannedGroupResponse(prompt: string): string {
  const pages = pageListFromPrompt(prompt);
  const skus = [...prompt.matchAll(/^SKU (\d{10,})$/gm)].map(match => match[1]);
  const payload: Record<string, unknown> = {};
  for (const sku of skus) {
    const evenSku = Number(sku.slice(-2)) % 2 === 0;
    const page = findPage(pages, evenSku ? PAGE_NAMES[1] : PAGE_NAMES[0]);
    payload[sku] = page ? [{ pageId: page.id, pageName: page.name, confidence: 0.85 }] : [];
  }
  return JSON.stringify(payload);
}

function mockGetLlmConfigForTask(): Record<string, any> {
  return {
    provider: 'ollama',
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5vl:latest',
  };
}

function writeAuditPair(ctx: ModelCallContext, callId: string): void {
  const now = new Date().toISOString();
  const stageName = ctx.stage ?? 'name_consolidation';
  const attempt = ctx.attempt;
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
    [`${callId}-started`, ctx.runId, stageName, ctx.operation, attempt, ctx.snapshotHash, ctx.promptTemplateVersion, ctx.ruleVersion, 'sys-hash', 'user-hash', now, null, now],
  );
  getDb().run(
    `INSERT INTO classification_model_calls
       (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash,
        prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, started_at,
        ended_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'ollama', 'qwen2.5vl:latest', 'local', ?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
    [callId, ctx.runId, stageName, ctx.operation, attempt, ctx.snapshotHash, ctx.promptTemplateVersion, ctx.ruleVersion, 'sys-hash', 'user-hash', now, now, now],
  );
}

function mockCallLlmForTaskWithProvenance(
  task: string,
  prompt: string,
  _systemPrompt: string,
  options: Record<string, any>,
): { content: string; callId: string; provider: string; model: string; usage: Record<string, number | null> } | null {
  const operation = options?.protectedOperation;
  const callId = `call-${++auditCallSeq}`;
  if (operation === 'cohort_title_consolidation') {
    if (options.modelCall) writeAuditPair(options.modelCall as unknown as ModelCallContext, callId);
    return null;
  }
  if (operation === 'cohort_page_assignment_parent') {
    if (options.modelCall) writeAuditPair(options.modelCall as unknown as ModelCallContext, callId);
    return {
      content: cannedGroupResponse(prompt),
      callId,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  return null;
}

mock.module('../../onboarding/llm-client', () => ({
  getLlmConfigForTask: () => mockGetLlmConfigForTask(),
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
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr9-acceptance-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

afterEach(() => {
  resetCohortCurationFlagsOverride();
  clearCohortCoordinationCache();
  clearCohortPageCoordinationCache();
});

// ─── Fixtures (mirror pr7/pr8-acceptance) ─────────────────────────────────────

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
 *  the PAGE curation target left ENABLED. `seed` is overridable so tests can
 *  adjust attribute config (e.g. give the universal brand a controlled value
 *  list so its field_assignment proposal materializes). */
function writeActiveV2Bundle(
  wsPath: string,
  seed: typeof BayStatePetGardenSeed = BayStatePetGardenSeed,
): { bundle: ReturnType<typeof generateCandidate>['bundle']; xmlFields: string[] } {
  const candidate = generateCandidate(seed, EVIDENCE);
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
  const batchId = createBatch({ workspaceId: wsId, name: 'PR9 Acceptance Batch', fileName: 'pr9.xlsx', totalItems: itemsData.length }).id;
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

const THREE_MEMBER_EXTRACTIONS = {
  '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', _brandHint: 'Acme' }),
  '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme' }),
  '100000000003': settledExtraction({ _name: 'Purina Pro Plan Adult Dog Food Salmon 5 lb', _brandHint: 'Acme' }),
};

function activateVerifiedPages(wsId: string): void {
  const pages = [
    { key: 'dog-food-dry', name: 'Dog Food Dry' },
    { key: 'dog-treats', name: 'Dog Treats' },
    { key: 'brand-acme', name: 'Brand - Acme' },
  ];
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: sha256Hex('pr9-acceptance-pages'),
    parserFormatVersion: 'pages-xml-1',
    records: pages.map(page => ({
      identity: { kind: 'exported_guid' as const, key: page.key, status: 'verified' as const },
      name: page.name,
      parentRef: null,
      availability: 'available' as const,
    })),
    activatedBy: 'test',
  });
  for (const page of pages) {
    if (!listVerifiedPageOptions(wsId).some(row => row.name === page.name)) {
      throw new Error(`verified fixture page not created: ${page.name}`);
    }
  }
}

function prepareActiveV2Workspace(
  wsId: string,
  wsPath: string,
  extByUpc: Record<string, Record<string, any>>,
  seed: typeof BayStatePetGardenSeed = BayStatePetGardenSeed,
): { items: OnboardingItem[]; cohorts: CurationCohort[]; configSnapshotHash: string } {
  const { bundle } = writeActiveV2Bundle(wsPath, seed);
  const { hash: configSnapshotHash } = upsertConfigSnapshot(wsId, bundle);
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
  return { items: created.items, cohorts: created.cohorts, configSnapshotHash };
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

/** Seed a reviewed Primary Product Type decision for a member (reviewed-first
 *  effective-type precedence). The prior run references the WORKSPACE's v2
 *  config snapshot hash so the accepted decision is provenance-compatible and
 *  rides into the frozen member snapshot's reviewed facts. */
function seedReviewedTypeDecision(
  wsId: string,
  configSnapshotHash: string,
  sku: string,
  itemId: string,
  typeId: string,
): void {
  const now = new Date().toISOString();
  const runId = `prior-type-run-${itemId}`;
  const proposalId = `prior-type-proposal-${itemId}`;
  getDb().run(
    `INSERT INTO classification_runs
     (id, workspace_id, onboarding_item_id, product_sku, source_kind, config_snapshot_hash, status, started_at)
     VALUES (?, ?, ?, ?, 'onboarding', ?, 'completed', ?)`,
    [runId, wsId, itemId, sku, configSnapshotHash, now],
  );
  getDb().run(
    `INSERT INTO classification_proposals
     (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, ?, 'primary_product_type', ?, ?, 0.95, 'accepted', ?)`,
    [proposalId, runId, sku, typeId, JSON.stringify({ productTypeId: typeId }), now],
  );
  getDb().run(
    `INSERT INTO classification_proposal_decisions
     (id, proposal_id, decision, revised_value_json, revised_target_id, created_at, superseded_at)
     VALUES (?, ?, 'accepted', ?, ?, ?, NULL)`,
    [`prior-type-decision-${itemId}`, proposalId, JSON.stringify({ productTypeId: typeId }), typeId, now],
  );
}

/** The member's field_assignment proposals keyed by target id. */
function fieldAssignmentsByTarget(curationData: CurationData): Map<string, CurationData['classificationProposals'][number]> {
  const byTarget = new Map<string, CurationData['classificationProposals'][number]>();
  for (const proposal of curationData.classificationProposals) {
    if (proposal.proposalType !== 'field_assignment' || !proposal.targetId) continue;
    byTarget.set(proposal.targetId, proposal);
  }
  return byTarget;
}

// ─── PR9 C4 (issue #30, DECISION-B): universal-attribute dependency skip ─────

/** Bay State seed with the UNIVERSAL `brand` attribute switched to controlled
 *  with allowedValues ['Acme'] — its enabled product_field target then has
 *  options, so the member pipeline deterministically emits a brand
 *  field_assignment proposal (the brand shortcut fires on the member's brand
 *  evidence). `flavor` stays non-universal + pet-food-profile. */
const BRAND_CONTROLLED_SEED: typeof BayStatePetGardenSeed = {
  ...BayStatePetGardenSeed,
  attributes: BayStatePetGardenSeed.attributes.map(attribute =>
    attribute.id === 'brand'
      ? { ...attribute, valueMode: 'controlled' as const, allowedValues: ['Acme'] }
      : attribute,
  ),
};

describe('PR9 C4 — universal-attribute field_assignment proposals carry no product-type dependency (issue #30, DECISION-B)', () => {
  it('execution-driven run: universal brand proposals get NO execution_product_type row; type-dependent proposals keep exactly one', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS, BRAND_CONTROLLED_SEED);
    const run = await freezeActiveCohort(workspaceId, wsPath);
    expect(run.executionProductTypeId).toBe('dog-food-dry');

    const summary = await processCohort(run, wsPath, workspaceId);
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(3);

    for (const item of items) {
      const stored = findItemById(item.id)!;
      const assignments = fieldAssignmentsByTarget(stored.curationData!);
      // The seed's `brand` attribute is UNIVERSAL with an enabled target — the
      // member's pipeline emits a brand field_assignment proposal.
      const brand = assignments.get('brand');
      const flavor = assignments.get('flavor');
      expect(brand).toBeDefined();
      expect(flavor).toBeDefined();
      // DECISION-B: universal applicability is type-independent → NO row.
      expect(listDependenciesForProposal(brand!.id)).toHaveLength(0);
      // Type-dependent proposals keep the exact same single execution row.
      const flavorDeps = listDependenciesForProposal(flavor!.id);
      expect(flavorDeps).toHaveLength(1);
      expect(flavorDeps[0].dependencyKind).toBe('execution_product_type');
      expect(flavorDeps[0].dependencyTargetId).toBe('dog-food-dry');
      expect(flavorDeps[0].dependencyValueHash).toBe(
        hashCanonicalJson({
          executionProductTypeId: run.executionProductTypeId!,
          productTypeConfidence: run.productTypeConfidence!,
        }),
      );
    }
  });

  it('reviewed-driven run: universal brand proposals get NO reviewed_product_type row; type-dependent proposals keep exactly one', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const prepared = prepareActiveV2Workspace(workspaceId, wsPath, THREE_MEMBER_EXTRACTIONS, BRAND_CONTROLLED_SEED);
    // Member 1 gets a provenance-compatible reviewed type fact (reviewed-first
    // precedence) → its field_assignment proposals stamp reviewed_product_type.
    seedReviewedTypeDecision(workspaceId, prepared.configSnapshotHash, prepared.items[0].upc, prepared.items[0].id, 'dog-food-dry');
    const run = await freezeActiveCohort(workspaceId, wsPath);

    const summary = await processCohort(run, wsPath, workspaceId);
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    const reviewedMember = findItemById(prepared.items[0].id)!;
    expect(reviewedMember.curationData!.effectiveProductType).toEqual({ id: 'dog-food-dry', source: 'reviewed' });
    const assignments = fieldAssignmentsByTarget(reviewedMember.curationData!);
    const brand = assignments.get('brand');
    const flavor = assignments.get('flavor');
    expect(brand).toBeDefined();
    expect(flavor).toBeDefined();
    expect(listDependenciesForProposal(brand!.id)).toHaveLength(0);
    const flavorDeps = listDependenciesForProposal(flavor!.id);
    expect(flavorDeps).toHaveLength(1);
    expect(flavorDeps[0].dependencyKind).toBe('reviewed_product_type');
    expect(flavorDeps[0].dependencyTargetId).toBe('dog-food-dry');
  });
});
