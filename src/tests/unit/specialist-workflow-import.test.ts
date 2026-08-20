/** e01s01 + e01s02 SpecialistWorkflowResult handoff — TDD guards. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { unlinkSync } from 'node:fs';
import { closeDb, initDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { getPiImportByWorkflowAndItem } from '../../db/repositories/product-intelligence-repo';
import {
  importSpecialistWorkflowToOnboarding,
  verifySpecialistWorkflowImportGate,
} from '../../product-intelligence/specialist-workflow-import';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { findItemById, insertItems } from '../../db/repositories/onboarding-item-repo';
import { getReviewState } from '../../db/repositories/onboarding-review-repo';
import type { SpecialistWorkflowResult } from '../../product-intelligence/workflow/orchestrator';

const workspaceId = 'specialist-import-test-workspace';
const workflowId = 'wf:run-specialist-import';

function workflow(): SpecialistWorkflowResult {
  return {
    runId: 'run-specialist-import',
    status: 'completed',
    productSeed: { sku: '085000079585', name: 'Seed product', price: '12.00' },
    extractionBundles: [],
    curatorOutput: {
      catalogTitle: 'Verified product',
      brand: 'Brand',
      upc: '085000079585',
      gtin: '085000079585',
      productTypeId: null,
      categoryIds: [],
      attributes: {},
      images: [],
      grounding: [{ field: 'title', claim: 'Verified product', supportingFactFields: ['name'], evidenceIds: ['evidence-1'] }],
    } as never,
    curatorArtifact: {
      contentHash: 'c'.repeat(64),
      artifactType: 'curated-product-draft',
      schemaVersion: '1.0.0',
      payload: {},
      lineage: {},
      provenance: { specialist: 'curator', specialistVersion: '1.0.0', codeCommit: 'test', createdAt: new Date().toISOString() },
    } as never,
    verifierOutput: { verdict: 'pass' } as never,
    verifierArtifact: {
      contentHash: 'b'.repeat(64),
      artifactType: 'verification-report',
      schemaVersion: '1.0.0',
      payload: {},
      lineage: {},
      provenance: { specialist: 'verifier', specialistVersion: '1.0.0', codeCommit: 'test', createdAt: new Date().toISOString() },
    } as never,
    events: [],
    retriesCount: 0,
    totalDispatches: 1,
    totalDurationMs: 1,
    workflowState: {
      runId: 'run-specialist-import',
      version: '1.0.0',
      status: 'completed',
      currentPhase: 'review',
      retriesCount: 0,
      totalDispatches: 1,
      invocations: {},
      capabilityInvocationIds: { curator: ['invoke-1'] },
      extractionArtifactRefs: [],
      routeRecords: [],
      usage: {} as never,
      artifactIds: [],
      totalDurationMs: 1,
    },
  };
}

describe('SpecialistWorkflowResult onboarding handoff', () => {
  const dbPath = path.resolve(import.meta.dirname, 'specialist-workflow-import-test.db');
  beforeAll(() => {
    try {
      resetDb();
    } catch {
      /* no active db */
    }
    initDb(dbPath);
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'Specialist import test',
      workspacePath: '/tmp/specialist-import',
      gitPath: '/tmp/specialist-import/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });
  afterAll(() => {
    closeDb();
    try {
      unlinkSync(dbPath);
    } catch {
      /* already removed */
    }
  });

  it('creates an onboarding item and preserves workflow provenance, then is idempotent', () => {
    const first = importSpecialistWorkflowToOnboarding(workflow(), { mode: 'create', workspaceId, importingUser: 'tester' });
    expect(first.created).toBe(true);
    expect(first.importRecord.workflowId).toBe(workflowId);
    expect(JSON.parse(first.importRecord.artifactHashesJson)).toEqual(['c'.repeat(64), 'b'.repeat(64)]);
    expect(JSON.parse(first.importRecord.capabilityInvocationIdsJson)).toEqual({ curator: ['invoke-1'] });
    const stored = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(first.item.id) as { extraction_data_json: string };
    expect(JSON.parse(stored.extraction_data_json).productIntelligenceEvidence[0].workflowId).toBe(workflowId);
    const second = importSpecialistWorkflowToOnboarding(workflow(), { mode: 'create', workspaceId });
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(getPiImportByWorkflowAndItem(workflowId, first.item.id)?.id).toBe(first.importRecord.id);
  });

  it('augments an existing item without changing its manual name', () => {
    const batch = getDb().query('SELECT id FROM onboarding_batches LIMIT 1').get() as { id: string };
    const item = insertItems(batch.id, [{ upc: '085000079585', name: 'Manual name', price: null, quantity: null, rowNumber: 2, isDuplicate: false, existingSku: null }], 'review', 0)[0];
    const result = importSpecialistWorkflowToOnboarding(workflow(), { mode: 'augment', workspaceId, onboardingItemId: item.id });
    expect(result.created).toBe(false);
    expect(result.item.name).toBe('Manual name');
  });

  it('rejects failed status', () => {
    const wf = { ...workflow(), status: 'failed' as const };
    expect(() => importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId })).toThrow(/not eligible/);
  });

  it('rejects when verifier verdict is not pass', () => {
    const wf = workflow();
    (wf.verifierOutput as unknown as { verdict: string }).verdict = 'human_review';
    expect(() => importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId })).toThrow(/did not pass/);
  });

  it('rejects when curator artifact is missing', () => {
    const wf = workflow();
    (wf as unknown as { curatorOutput: null }).curatorOutput = null;
    expect(() => importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId })).toThrow(/curated product/);
  });

  it('rejects augment with wrong workspace (cross-workspace)', () => {
    const batch = getDb().query('SELECT id FROM onboarding_batches LIMIT 1').get() as { id: string };
    const item = insertItems(batch.id, [{ upc: '085000079585', name: 'Other', price: null, quantity: null, rowNumber: 3, isDuplicate: false, existingSku: null }], 'review', 0)[0];
    expect(() => importSpecialistWorkflowToOnboarding(workflow(), { mode: 'augment', workspaceId: 'other-workspace', onboardingItemId: item.id })).toThrow(/different workspace/);
  });

  it('persists importer, timestamp and verifier provenance', () => {
    const wf = workflow();
    wf.runId = `run-provenance-${Date.now()}`;
    const result = importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId, importingUser: 'alice' });
    expect(result.importRecord.importingUser).toBe('alice');
    expect(result.importRecord.verifierProvenanceJson).toContain('verifier');
    const provenance = JSON.parse(result.importRecord.verifierProvenanceJson) as { report?: unknown; artifactHash?: string };
    expect(provenance.artifactHash).toBe('b'.repeat(64));
    const stored = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(result.item.id) as { extraction_data_json: string };
    const evidence = JSON.parse(stored.extraction_data_json).productIntelligenceEvidence.find((e: { workflowId: string }) => e.workflowId === `wf:${wf.runId}`) as {
      importedAt: string;
      verifier: { provenance: unknown };
    };
    expect(evidence.importedAt).toBeDefined();
    expect(evidence.verifier.provenance).toBeDefined();
  });

  it('rejects invalid artifact hash format', () => {
    const wf = workflow();
    wf.runId = `run-bad-hash-${Date.now()}`;
    (wf.curatorArtifact as unknown as { contentHash: string }).contentHash = 'not-hex';
    expect(() => importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId })).toThrow(/Invalid artifact hash/);
  });

  it('non-Agent onboarding still works (no regression)', () => {
    const batch = createBatch({ workspaceId, name: 'Manual batch', fileName: 'manual.csv', totalItems: 1, columnMappingJson: '{}' });
    const items = insertItems(batch.id, [{ upc: '123456789012', name: 'Manual only', price: '9.99', quantity: 1, rowNumber: 1, isDuplicate: false, existingSku: null }], 'discovery', 0);
    expect(items[0].name).toBe('Manual only');
    expect(findItemById(items[0].id)?.name).toBe('Manual only');
  });

  // e01s02 guards
  it('manual preservation — differing manual name is excluded, not overwritten, and remains visible', () => {
    const batch = createBatch({ workspaceId, name: 'Manual preservation batch', fileName: 'manual.csv', totalItems: 1, columnMappingJson: '{}' });
    const item = insertItems(batch.id, [{ upc: '085000079585', name: 'Reviewed manual title', price: null, quantity: null, rowNumber: 1, isDuplicate: false, existingSku: null }], 'review', 0)[0];
    const wf = workflow();
    wf.runId = `run-manual-${Date.now()}`;
    // curator wants different title
    (wf.curatorOutput as unknown as { catalogTitle: string }).catalogTitle = 'Imported title';
    const result = importSpecialistWorkflowToOnboarding(wf, { mode: 'augment', workspaceId, onboardingItemId: item.id });
    expect(findItemById(item.id)?.name).toBe('Reviewed manual title');
    const rec = getPiImportByWorkflowAndItem(`wf:${wf.runId}`, item.id);
    expect(rec).toBeDefined();
    const excluded = JSON.parse(rec!.excludedValuesJson) as Record<string, { itemValue: string; importedValue: string }>;
    expect(excluded.title.itemValue).toBe('Reviewed manual title');
    expect(excluded.title.importedValue).toBe('Imported title');
    const stored = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(item.id) as { extraction_data_json: string };
    const evidence = JSON.parse(stored.extraction_data_json).productIntelligenceEvidence.find((e: { workflowId: string }) => e.workflowId === `wf:${wf.runId}`);
    expect(evidence.excludedFields.title.itemValue).toBe('Reviewed manual title');
    // review state never auto-resolved
    expect(getReviewState(item.id)?.approvedAt ?? null).toBeNull();
  });

  it('identical manual value is deduped, not excluded', () => {
    const batch = createBatch({ workspaceId, name: 'Dedupe batch', fileName: 'manual.csv', totalItems: 1, columnMappingJson: '{}' });
    const item = insertItems(batch.id, [{ upc: '085000079585', name: 'Same title', price: null, quantity: null, rowNumber: 1, isDuplicate: false, existingSku: null }], 'review', 0)[0];
    const wf = workflow();
    wf.runId = `run-dedupe-${Date.now()}`;
    (wf.curatorOutput as unknown as { catalogTitle: string }).catalogTitle = 'Same title';
    const result = importSpecialistWorkflowToOnboarding(wf, { mode: 'augment', workspaceId, onboardingItemId: item.id });
    const rec = getPiImportByWorkflowAndItem(`wf:${wf.runId}`, item.id)!;
    const excluded = JSON.parse(rec.excludedValuesJson);
    const overridden = JSON.parse(rec.overriddenValuesJson);
    expect(excluded.title).toBeUndefined();
    expect(overridden.title).toBeUndefined();
  });

  it('idempotent — same workflow import twice returns same record, no duplicate onboarding rows', () => {
    const wf = workflow();
    wf.runId = `run-idempotent-${Date.now()}`;
    const first = importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId });
    const second = importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId });
    expect(second.created).toBe(false);
    expect(second.importRecord.id).toBe(first.importRecord.id);
    expect(second.item.id).toBe(first.item.id);
    const count = getDb().query('SELECT COUNT(*) as c FROM product_intelligence_imports WHERE workflow_id = ?').get(`wf:${wf.runId}`) as { c: number };
    expect(count.c).toBe(1);
  });

  it('newer workflow does not silently replace earlier import — both evidences coexist', () => {
    const batch = createBatch({ workspaceId, name: 'Coexist batch', fileName: 'manual.csv', totalItems: 1, columnMappingJson: '{}' });
    const item = insertItems(batch.id, [{ upc: '085000079585', name: 'Coexist item', price: null, quantity: null, rowNumber: 1, isDuplicate: false, existingSku: null }], 'review', 0)[0];
    const wf1 = workflow();
    wf1.runId = `run-coexist-1-${Date.now()}`;
    const wf2 = workflow();
    wf2.runId = `run-coexist-2-${Date.now()}`;
    // make second curator hash distinct to avoid duplicate-hash guard
    (wf2.curatorArtifact as unknown as { contentHash: string }).contentHash = 'd'.repeat(64);
    (wf2.verifierArtifact as unknown as { contentHash: string }).contentHash = 'e'.repeat(64);
    importSpecialistWorkflowToOnboarding(wf1, { mode: 'augment', workspaceId, onboardingItemId: item.id });
    importSpecialistWorkflowToOnboarding(wf2, { mode: 'augment', workspaceId, onboardingItemId: item.id });
    const stored = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(item.id) as { extraction_data_json: string };
    const evidence = JSON.parse(stored.extraction_data_json).productIntelligenceEvidence as Array<{ workflowId: string }>;
    expect(evidence.filter((e) => e.workflowId === `wf:${wf1.runId}`).length).toBe(1);
    expect(evidence.filter((e) => e.workflowId === `wf:${wf2.runId}`).length).toBe(1);
  });

  it('stale/mismatched artifact hash fails closed with no onboarding mutation', () => {
    const beforeItems = (getDb().query('SELECT COUNT(*) as c FROM onboarding_items').get() as { c: number }).c;
    const beforeImports = (getDb().query('SELECT COUNT(*) as c FROM product_intelligence_imports').get() as { c: number }).c;
    const wf = workflow();
    wf.runId = `run-stale-${Date.now()}`;
    (wf.curatorArtifact as unknown as { contentHash: string }).contentHash = 'not-hex-hash';
    expect(() => importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId })).toThrow(/Invalid artifact hash/);
    const afterItems = (getDb().query('SELECT COUNT(*) as c FROM onboarding_items').get() as { c: number }).c;
    const afterImports = (getDb().query('SELECT COUNT(*) as c FROM product_intelligence_imports').get() as { c: number }).c;
    expect(afterItems).toBe(beforeItems);
    expect(afterImports).toBe(beforeImports);
  });

  it('image guard — primary not commerce-approved is rejected', () => {
    const wf = workflow();
    wf.runId = `run-image-primary-${Date.now()}`;
    (wf.curatorOutput as unknown as { images: unknown[] }).images = [{ role: 'primary', assetId: 'asset-1', commerceApproved: false, rightsStatus: 'restricted' }];
    expect(() => importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId })).toThrow(/commerce-approved/);
  });

  it('image guard — supporting without approved rights is rejected', () => {
    const wf = workflow();
    wf.runId = `run-image-supporting-${Date.now()}`;
    (wf.curatorOutput as unknown as { images: unknown[] }).images = [
      { role: 'primary', assetId: 'primary-1', commerceApproved: true, sourcePageUrl: 'https://example.com/p/1' },
      { role: 'alternate', assetId: 'alt-1', commerceApproved: false, rightsStatus: 'restricted', sourcePageUrl: 'https://example.com/p/1' },
    ];
    expect(() => importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId })).toThrow(/rights are 'restricted'/);
  });

  it('promotion guard — verification never directly creates approved catalog truth', () => {
    const wf = workflow();
    wf.runId = `run-promotion-${Date.now()}`;
    const result = importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId });
    expect(getReviewState(result.item.id)?.approvedAt ?? null).toBeNull();
    expect(verifySpecialistWorkflowImportGate(result.item).ok).toBe(true);
    // stale import should block promotion
    getDb().run("UPDATE product_intelligence_imports SET status = 'stale' WHERE id = ?", [result.importRecord.id]);
    const staleItem = findItemById(result.item.id)!;
    expect(verifySpecialistWorkflowImportGate(staleItem).ok).toBe(false);
  });

  it('duplicate artifact hashes fail closed', () => {
    const wf = workflow();
    wf.runId = `run-dup-hash-${Date.now()}`;
    const dup = 'f'.repeat(64);
    (wf.curatorArtifact as unknown as { contentHash: string }).contentHash = dup;
    (wf.verifierArtifact as unknown as { contentHash: string }).contentHash = dup;
    expect(() => importSpecialistWorkflowToOnboarding(wf, { mode: 'create', workspaceId })).toThrow(/Duplicate artifact hashes/);
  });
});
