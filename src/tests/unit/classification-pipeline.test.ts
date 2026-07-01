import { describe, it, expect, beforeAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache, getCachedProductTypes, getCachedAttributes, getCachedAttributeProfiles, getCachedAttributeMappings, createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { createRun, getProposalsByRun, recordDecision, getAcceptedProposals } from '../../db/repositories/classification-run-repo';
import { runPipeline } from '../../classification/pipeline-runner';
import { evidenceExtractionStage, categoryPageProposalsStage, productAttributeProposalsStage, attributeApplicabilityStage, primaryProductTypeStage } from '../../classification';
import { upsertPage } from '../../db/repositories/page-repo';
import { migrateLegacyToClassificationConfig } from '../../classification/legacy-migration';
import { getDb } from '../../db/connection';

describe('Classification Pipeline Integration', () => {
  let workspacePath: string;
  let workspaceId: string;

  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `shopsite-cms-class-test-${workspaceId.slice(0, 8)}`);
    const dbPath = path.join(workspacePath, '.shopsite-cms', 'app.db');
    fs.mkdirSync(path.join(workspacePath, '.shopsite-cms'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
    initDb(dbPath);
    runMigrations();
    insertWorkspace({ id: workspaceId, name: 'test', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });

    const now = new Date().toISOString();
    saveClassificationConfig(workspacePath, {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
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
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
      dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));
  });

  it('loads classification config and verifies cached reads', () => {
    const config = loadClassificationConfig(workspacePath);
    expect(config.productTypes.length).toBe(1);
    expect(config.attributes.length).toBe(1);
    expect(getCachedProductTypes(workspaceId).length).toBe(1);
    expect(getCachedAttributes(workspaceId).length).toBe(1);
  });

  it('runs category page proposals from evidence', async () => {
    upsertPage({ name: 'Dog Food', fileName: 'dog-food.html', parentId: null, pageHash: 'abc', lastSyncedAt: null });
    const config = loadClassificationConfig(workspacePath);
    const snapId = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-1', snapId, snapId);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-1', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Dog Food Chicken', value: 'Dog Food Chicken', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const result = await runPipeline([evidenceExtractionStage, categoryPageProposalsStage], { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapId, sourceCommit: null, createdAt: new Date().toISOString() } }, { sku: 'TEST-SKU-1', evidence, acceptedProposals: [], allProposals: [] });
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    const persisted = getProposalsByRun(run.id);
    expect(persisted.length).toBeGreaterThanOrEqual(1);
  });

  it('produces attribute proposals via alias matching', async () => {
    const config = loadClassificationConfig(workspacePath);
    const snapId = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-2', snapId, snapId);
    const acceptedType = { id: randomUUID(), runId: run.id, productSku: 'TEST-SKU-2', proposalType: 'primary_product_type' as const, targetId: 'dry-dog-food', proposedValue: {}, confidence: 1, evidenceIds: [], status: 'accepted' as const, isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: new Date().toISOString() };
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-2', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Beef Recipe', value: 'Beef Recipe', metadata: {}, capturedAt: new Date().toISOString() },
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-2', attributeId: null, source: 'official_product_page' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'description', snippet: 'Made with Chicken and Lamb', value: 'Made with Chicken and Lamb', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const result = await runPipeline([evidenceExtractionStage, primaryProductTypeStage, attributeApplicabilityStage, productAttributeProposalsStage], { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapId, sourceCommit: null, createdAt: new Date().toISOString() } }, { sku: 'TEST-SKU-2', evidence, acceptedProposals: [acceptedType], allProposals: [] });
    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBeGreaterThan(0);
    recordDecision({ id: randomUUID(), proposalId: fieldProposals[0].id, decision: 'accepted', revisedFromId: null, reviewerId: null, reviewerNote: null, createdAt: new Date().toISOString() });
    expect(getAcceptedProposals('TEST-SKU-2').length).toBeGreaterThan(0);
  });

  it('migrates legacy product types to classification config', () => {
    const db = getDb();
    const ltId = randomUUID();
    const now = new Date().toISOString();
    db.run('INSERT INTO product_types (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [ltId, workspaceId, 'Wet Cat Food', now, now]);
    db.run('INSERT INTO product_type_fields (id, product_type_id, xml_field, label, data_type, required, validation_rules_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [randomUUID(), ltId, 'CustomField1', 'Flavor', 'string', 1, null, now, now]);
    const result = migrateLegacyToClassificationConfig(workspacePath, workspaceId, true);
    expect(result).not.toBeNull();
    expect(result!.productTypes.length).toBeGreaterThanOrEqual(1);
    expect(result!.attributes.length).toBeGreaterThanOrEqual(1);
    expect(result!.attributeProfiles.length).toBeGreaterThanOrEqual(1);
    expect(result!.attributeMappings.length).toBeGreaterThanOrEqual(1);
  });
});
