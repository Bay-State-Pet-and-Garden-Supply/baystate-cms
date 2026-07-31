import { describe, it, expect, beforeAll, mock } from 'bun:test';

// Mock the LLM client so page assignment works in test environment
mock.module('../../onboarding/llm-client', () => ({
  callLlmForTask: mock(async () => '{"pages":[{"pageName":"Dog Food","confidence":0.8}]}'),
  getLlmConfigForTask: mock(() => ({ provider: 'ollama', apiKey: 'test', baseUrl: 'http://localhost:11434/v1', model: 'test-model' })),
}));

import { randomUUID } from 'node:crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache, getCachedProductTypes, getCachedAttributes, createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { createRun, completeRun, getProposalsByRun, getStageResults, getEvidenceByRun, recordDecision, getAcceptedProposals } from '../../db/repositories/classification-run-repo';
import { runPipeline } from '../../classification/pipeline-runner';
import { evidenceExtractionStage, nameConsolidationStage, categoryPageProposalsStage, productAttributeProposalsStage, attributeApplicabilityStage, primaryProductTypeStage } from '../../classification';
import { upsertPage } from '../../db/repositories/page-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { migrateLegacyToClassificationConfig } from '../../classification/legacy-migration';
import { listCurationTargetCandidates } from '../../classification/curation-targets';
import { getDb } from '../../db/connection';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { validateReviewCompletionGate } from '../../classification/review-completion-gate';

describe('Classification Pipeline Integration', () => {
  let workspacePath: string;
  let workspaceId: string;
  const BASELINE_CURATION_TARGETS = [
    { id: 'test-product-type', kind: 'product_type' as const, label: 'Test Product Type', enabled: true, selectionMode: 'single' as const, attributeId: null, catalogField: null, optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
    { id: 'test-pages', kind: 'page' as const, label: 'Test Pages', enabled: true, selectionMode: 'multiple' as const, attributeId: null, catalogField: null, optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 1 },
    { id: 'test-flavor', kind: 'product_field' as const, label: 'Test Flavor', enabled: true, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 2 },
  ];

  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-class-test-${workspaceId.slice(0, 8)}`);
    const dbPath = path.join(workspacePath, '.baystate-cms', 'app.db');
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
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
      curationTargets: BASELINE_CURATION_TARGETS,
      brands: [],
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
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-1', snapId, snapHash);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-1', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Dog Food Chicken', value: 'Dog Food Chicken', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const result = await runPipeline([evidenceExtractionStage, categoryPageProposalsStage], { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } }, { sku: 'TEST-SKU-1', evidence, acceptedProposals: [], allProposals: [] });
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    const persisted = getProposalsByRun(run.id);
    expect(persisted.length).toBeGreaterThanOrEqual(1);
  });

  it('produces attribute proposals via alias matching', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-2', snapId, snapHash);
    const acceptedType = { id: randomUUID(), runId: run.id, productSku: 'TEST-SKU-2', proposalType: 'primary_product_type' as const, targetId: 'dry-dog-food', proposedValue: {}, confidence: 1, evidenceIds: [], status: 'accepted' as const, isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: new Date().toISOString() };
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-2', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Beef Recipe', value: 'Beef Recipe', metadata: {}, capturedAt: new Date().toISOString() },
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-2', attributeId: null, source: 'official_product_page' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'description', snippet: 'Made with Chicken and Lamb', value: 'Made with Chicken and Lamb', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const result = await runPipeline([evidenceExtractionStage, primaryProductTypeStage, attributeApplicabilityStage, productAttributeProposalsStage], { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } }, { sku: 'TEST-SKU-2', evidence, acceptedProposals: [acceptedType], allProposals: [] });
    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBeGreaterThan(0);
    recordDecision({ id: randomUUID(), proposalId: fieldProposals[0].id, decision: 'accepted', revisedFromId: null, reviewerId: null, reviewerNote: null, createdAt: new Date().toISOString() });
    expect(getAcceptedProposals('TEST-SKU-2', run.id).length).toBeGreaterThan(0);
  });

  it('name consolidation stage returns metadata without field_assignment proposals', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-NAME', snapId, snapHash);
    const evidence = [
      {
        id: randomUUID(),
        runId: run.id,
        stageName: 'evidence_extraction' as const,
        productSku: 'TEST-SKU-NAME',
        attributeId: null,
        source: 'spreadsheet' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'name',
        snippet: 'Dr. Marty Bark Stoppers Digestion Formula',
        value: 'Dr. Marty Bark Stoppers Digestion Formula',
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        runId: run.id,
        stageName: 'evidence_extraction' as const,
        productSku: 'TEST-SKU-NAME',
        attributeId: null,
        source: 'spreadsheet' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'brand',
        snippet: 'Dr. Marty',
        value: 'Dr. Marty',
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: new Date().toISOString(),
      },
    ];
    // Run nameConsolidationStage directly (without evidenceExtractionStage which
    // would abstain and create a reviewable_abstention proposal on this test DB)
    const result = await runPipeline(
      [nameConsolidationStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-NAME', evidence, acceptedProposals: [], allProposals: [] },
    );

    // name_consolidation should produce metadata without field_assignment proposals
    const nameMeta = result.stageOutputs.name_consolidation?.metadata as Record<string, unknown> | undefined;
    expect(nameMeta).toBeDefined();
    expect(nameMeta!.curatedTitle).toBeDefined();
    expect(nameMeta!.titleSource).toBeDefined();
    expect(typeof nameMeta!.curatedTitle).toBe('string');

    // Name consolidation produces no field_assignment proposals
    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBe(0);
  });

  it('produces attribute proposals from provisional Product Type (no accepted proposals)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-PROV', snapId, snapHash);
    const evidence = [
      {
        id: randomUUID(),
        runId: run.id,
        stageName: 'evidence_extraction' as const,
        productSku: 'TEST-SKU-PROV',
        attributeId: null,
        source: 'spreadsheet' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'name',
        snippet: 'Beef Recipe Dry Dog Food',
        value: 'Beef Recipe Dry Dog Food',
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        runId: run.id,
        stageName: 'evidence_extraction' as const,
        productSku: 'TEST-SKU-PROV',
        attributeId: null,
        source: 'official_product_page' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'description',
        snippet: 'Made with real Beef, Chicken, and Lamb',
        value: 'Made with real Beef, Chicken, and Lamb',
        metadata: { provenance: 'web_scrape' },
        capturedAt: new Date().toISOString(),
      },
    ];

    // Run pipeline WITHOUT any accepted proposals — the pipeline should
    // use provisional (pending) Product Type proposals for downstream stages.
    const result = await runPipeline(
      [
        evidenceExtractionStage,
        primaryProductTypeStage,
        attributeApplicabilityStage,
        productAttributeProposalsStage,
      ],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-PROV', evidence, acceptedProposals: [], allProposals: [] },
    );

    // Should have a primary_product_type proposal (pending)
    const typeProposals = result.proposals.filter(p => p.proposalType === 'primary_product_type');
    expect(typeProposals.length).toBeGreaterThanOrEqual(1);
    expect(typeProposals[0].status).toBe('pending');

    // Should have field_assignment proposals using the provisional Product Type
    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBeGreaterThanOrEqual(1);

    // Verify there's at least one flavor proposal
    const flavorProposal = fieldProposals.find(p => p.targetId === 'flavor');
    expect(flavorProposal).toBeDefined();
    expect(flavorProposal!.status).toBe('pending');
  });

  it('uses live-store curation target options for a selected ProductField', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    upsertRegistryEntry({
      id: randomUUID(),
      workspaceId,
      xmlField: 'ProductField24',
      label: 'Product Field 24',
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: 'Curation',
      sampleValuesJson: null,
      createdAt: now,
      updatedAt: now,
    });
    db.run(
      `INSERT OR REPLACE INTO product_index
       (id, sku, file_path, title, status, product_hash, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), 'LIVE-OPT-1', 'products/live-opt-1.json', 'Existing Cat Toy', 'active', 'hash-live-1', JSON.stringify({ ProductField24: 'Cat Toys' }), now, now],
    );
    db.run(
      `INSERT OR REPLACE INTO product_index
       (id, sku, file_path, title, status, product_hash, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), 'LIVE-OPT-2', 'products/live-opt-2.json', 'Existing Dog Food', 'active', 'hash-live-2', JSON.stringify({ ProductField24: 'Dog Food' }), now, now],
    );

    const current = loadClassificationConfig(workspacePath);
    saveClassificationConfig(workspacePath, {
      ...current,
      productTypes: [],
      attributeProfiles: [],
      attributes: [
        ...current.attributes.filter(a => a.id !== 'field-productfield24'),
        { id: 'field-productfield24', name: 'Product Field 24', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Curation' },
      ],
      attributeMappings: [
        ...current.attributeMappings.filter(m => m.attributeId !== 'field-productfield24'),
        { id: 'field-productfield24-mapping', attributeId: 'field-productfield24', catalogField: 'ProductField24', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        { id: 'target-productfield24', kind: 'product_field' as const, label: 'Product Field 24', enabled: true, selectionMode: 'single' as const, attributeId: 'field-productfield24', catalogField: 'ProductField24', optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 0 },
      ],
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));

    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-24', snapId, snapHash);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-24', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Premium Cat Toys assortment', value: 'Premium Cat Toys assortment', metadata: {}, capturedAt: now },
    ];

    const result = await runPipeline(
      [productAttributeProposalsStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: now } },
      { sku: 'TEST-SKU-24', evidence, acceptedProposals: [], allProposals: [] },
    );

    const proposal = result.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'field-productfield24');
    expect(proposal?.proposedValue).toBe('Cat Toys');
  });

  it('discovers ProductField candidates from product_index even when field_registry is incomplete', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert a product with ProductField24 (which is NOT in field_registry)
    db.run(
      `INSERT OR REPLACE INTO product_index
       (id, sku, file_path, title, status, product_hash, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), 'DISCOVER-24', 'products/discover-24.json', 'Field 24 Product', 'active', 'hash-disc-24', JSON.stringify({ ProductField24: 'Cat Toys', ProductField16: 'Pet Brands' }), now, now],
    );

    const config = loadClassificationConfig(workspacePath);
    const candidates = listCurationTargetCandidates(workspaceId, config);

    // ProductField24 should appear as a candidate even beyond the initial
    // registry set (it was upserted in the previous test, but the point is
    // that fields discovered from product_index.custom_fields are included).
    const pf24 = candidates.productFields.find(f => f.catalogField === 'ProductField24');
    expect(pf24).toBeDefined();
    expect(pf24!.values).toContain('Cat Toys');

    // Fields discovered from catalog data that were never in the registry
    // (ProductField16 came only from the product we inserted, not from registry).
    expect(candidates.productFields.length).toBeGreaterThanOrEqual(2);
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

  it('disabled product type target skips primary product type proposal', async () => {
    // Save a config with page target only (no product_type target)
    const current = loadClassificationConfig(workspacePath);
    saveClassificationConfig(workspacePath, {
      ...current,
      curationTargets: [
        { id: 'test-pages-only', kind: 'page', label: 'Test Pages', enabled: true, selectionMode: 'multiple', attributeId: null, catalogField: null, optionSource: 'live_store', required: false, mandatory: false, sortOrder: 0 },
      ],
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));

    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-NOPT', snapId, snapHash);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-NOPT', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Dry Dog Food Chicken Recipe', value: 'Dry Dog Food Chicken Recipe', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const result = await runPipeline(
      [evidenceExtractionStage, primaryProductTypeStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-NOPT', evidence, acceptedProposals: [], allProposals: [] },
    );

    const typeProposals = result.proposals.filter(p => p.proposalType === 'primary_product_type');
    expect(typeProposals.length).toBe(0);

    // Restore original config for subsequent tests
    const restored = loadClassificationConfig(workspacePath);
    saveClassificationConfig(workspacePath, { ...restored, curationTargets: BASELINE_CURATION_TARGETS });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));
  });

  it('product field proposals work without product type target', async () => {
    // Save an explicit config with product_field target but no product_type,
    // so we are not affected by any prior test's config mutations.
    const now = new Date().toISOString();
    saveClassificationConfig(workspacePath, {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [],
      attributes: [
        { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'], valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }, { alias: 'beef', mapsTo: 'Beef' }], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Food' },
      ],
      attributeProfiles: [],
      attributeMappings: [
        { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        { id: 'test-flavor-only', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
      ],
      brands: [],
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama' as const, defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
      dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
    });
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));

    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-FIELDONLY', snapId, snapHash);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-FIELDONLY', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Chicken Recipe Dry Dog Food', value: 'Chicken Recipe Dry Dog Food', metadata: {}, capturedAt: new Date().toISOString() },
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-FIELDONLY', attributeId: null, source: 'official_product_page' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'description', snippet: 'Made with real Chicken', value: 'Made with real Chicken', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const result = await runPipeline(
      [productAttributeProposalsStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-FIELDONLY', evidence: evidence, acceptedProposals: [], allProposals: [] },
    );

    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Fail-closed tests ─────────────────────────────────────────────────

  it('aborts pipeline when a stage returns failed status; downstream stage is not called', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-FAIL', snapId, snapHash);

    let stage3Called = false;

    const okStage: import('../../classification/types').StageDefinition = {
      name: 'name_consolidation',
      requires: [],
      evidenceFrom: [],
      execute: async () => ({
        status: 'succeeded' as const,
        output: { evidence: [], proposals: [], abstained: false, metadata: { dummy: true } },
      }),
    };

    const failingStage: import('../../classification/types').StageDefinition = {
      name: 'primary_product_type_proposal',
      requires: [],
      evidenceFrom: [],
      execute: async () => ({
        status: 'failed' as const,
        error: 'Intentional test failure',
      }),
    };

    const spyStage: import('../../classification/types').StageDefinition = {
      name: 'attribute_applicability',
      requires: [],
      evidenceFrom: [],
      execute: async () => {
        stage3Called = true;
        return { status: 'succeeded' as const, output: { evidence: [], proposals: [], abstained: false } };
      },
    };

    await expect(
      runPipeline(
        [okStage, failingStage, spyStage],
        { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
        { sku: 'TEST-SKU-FAIL', evidence: [], acceptedProposals: [], allProposals: [] },
      ),
    ).rejects.toThrow('Intentional test failure');

    expect(stage3Called).toBe(false);

    // One failed stage result recorded for the failing stage
    const stageResults = getStageResults(run.id);
    const failResults = stageResults.filter((sr: any) => sr.stage_name === 'primary_product_type_proposal');
    expect(failResults.length).toBe(1);
    expect(failResults[0].status).toBe('failed');
    expect(failResults[0].error_message).toContain('Intentional test failure');

    // The preceding stage should have a succeeded result
    const okResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation');
    expect(okResults.length).toBe(1);
    expect(okResults[0].status).toBe('succeeded');

    // The spy stage should have no result (never executed)
    const spyResults = stageResults.filter((sr: any) => sr.stage_name === 'attribute_applicability');
    expect(spyResults.length).toBe(0);
  });

  it('aborts pipeline when a stage throws; downstream stage is not called, only one failed result recorded', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-THROW', snapId, snapHash);

    let downstreamCalled = false;

    const throwingStage: import('../../classification/types').StageDefinition = {
      name: 'name_consolidation',
      requires: [],
      evidenceFrom: [],
      execute: async () => {
        throw new Error('Kaboom from stage');
      },
    };

    const spyStage: import('../../classification/types').StageDefinition = {
      name: 'primary_product_type_proposal',
      requires: [],
      evidenceFrom: [],
      execute: async () => {
        downstreamCalled = true;
        return { status: 'succeeded' as const, output: { evidence: [], proposals: [], abstained: false } };
      },
    };

    await expect(
      runPipeline(
        [throwingStage, spyStage],
        { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
        { sku: 'TEST-SKU-THROW', evidence: [], acceptedProposals: [], allProposals: [] },
      ),
    ).rejects.toThrow('Kaboom from stage');

    expect(downstreamCalled).toBe(false);

    // Exactly one failed result for the throwing stage (no double-record)
    const stageResults = getStageResults(run.id);
    const failResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation' && sr.status === 'failed');
    expect(failResults.length).toBe(1);
    expect(failResults[0].error_message).toContain('Kaboom from stage');

    // Downstream stage has no result
    const spyResults = stageResults.filter((sr: any) => sr.stage_name === 'primary_product_type_proposal');
    expect(spyResults.length).toBe(0);
  });

  it('abstaining stage persists reviewable_abstention proposal and returns it in-memory', async () => {
    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-ABSTAIN', snapId, snapHash);

    const abstainingStage: import('../../classification/types').StageDefinition = {
      name: 'name_consolidation',
      requires: [],
      evidenceFrom: [],
      execute: async () => ({
        status: 'abstained' as const,
        reason: 'No evidence for name consolidation',
      }),
    };

    const result = await runPipeline(
      [abstainingStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-ABSTAIN', evidence: [], acceptedProposals: [], allProposals: [] },
    );

    // In-memory result includes the abstention proposal
    const abstentions = result.proposals.filter(p => p.proposalType === 'reviewable_abstention');
    expect(abstentions.length).toBe(1);
    expect(abstentions[0].targetId).toBe('name_consolidation');
    expect(abstentions[0].proposedValue).toEqual({ reason: 'No evidence for name consolidation' });

    // Stage result recorded as abstained
    const stageResults = getStageResults(run.id);
    const abstainedResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation');
    expect(abstainedResults.length).toBe(1);
    expect(abstainedResults[0].status).toBe('abstained');
    expect(abstainedResults[0].error_message).toContain('No evidence for name consolidation');

    // Abstention proposal is persisted to the database
    const persisted = getProposalsByRun(run.id);
    const persistedAbstentions = persisted.filter(p => p.proposalType === 'reviewable_abstention');
    expect(persistedAbstentions.length).toBe(1);
    expect(persistedAbstentions[0].targetId).toBe('name_consolidation');
  });

  it('rejects pipeline when evidence/proposal persistence fails due to PK conflict; downstream not called, one failed result', async () => {
    const CONFLICT_ID = '00000000-0000-0000-0000-0000000000cc';

    const config = loadClassificationConfig(workspacePath);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-PKCONF', snapId, snapHash);

    // Pre-insert a proposal with the hardcoded ID so the stage's persist attempt fails.
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, staleness_reason, config_snapshot_hash, evidence_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [CONFLICT_ID, run.id, 'TEST-SKU-PKCONF', 'field_assignment', 'flavor', '{}', 0.5, 'pending', 0, 0, null, null, '[]', now],
    );

    const producingStage: import('../../classification/types').StageDefinition = {
      name: 'name_consolidation',
      requires: [],
      evidenceFrom: [],
      execute: async () => ({
        status: 'succeeded' as const,
        output: {
          evidence: [{
            id: randomUUID(),
            runId: run.id,
            stageName: 'name_consolidation' as const,
            productSku: 'TEST-SKU-PKCONF',
            attributeId: null,
            source: 'spreadsheet' as const,
            reliability: 'medium' as const,
            sourceUrl: null,
            sourceField: 'name',
            snippet: 'Test',
            value: 'Test',
            metadata: {},
            capturedAt: new Date().toISOString(),
          }],
          proposals: [{
            id: CONFLICT_ID,
            runId: run.id,
            productSku: 'TEST-SKU-PKCONF',
            proposalType: 'field_assignment' as const,
            targetId: 'flavor',
            proposedValue: 'Chicken',
            confidence: 0.9,
            evidenceIds: [],
            status: 'pending' as const,
            isBulkAcceptable: true,
            isStale: false,
            stalenessReason: null,
            createdAt: new Date().toISOString(),
          }],
          abstained: false,
          metadata: {},
        },
      }),
    };

    let downstreamCalled = false;
    const spyStage: import('../../classification/types').StageDefinition = {
      name: 'primary_product_type_proposal',
      requires: [],
      evidenceFrom: [],
      execute: async () => {
        downstreamCalled = true;
        return { status: 'succeeded' as const, output: { evidence: [], proposals: [], abstained: false } };
      },
    };

    await expect(
      runPipeline(
        [producingStage, spyStage],
        { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() } },
        { sku: 'TEST-SKU-PKCONF', evidence: [], acceptedProposals: [], allProposals: [] },
      ),
    ).rejects.toThrow();

    expect(downstreamCalled).toBe(false);

    // One failed result recorded for the producing stage
    const stageResults = getStageResults(run.id);
    const failResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation' && sr.status === 'failed');
    expect(failResults.length).toBe(1);

    // No succeeded result or stage evidence survived the rolled-back transaction.
    const succeededResults = stageResults.filter((sr: any) => sr.stage_name === 'name_consolidation' && sr.status === 'succeeded');
    expect(succeededResults.length).toBe(0);
    const persistedEvidence = db.query(
      'SELECT COUNT(*) AS count FROM classification_evidence WHERE run_id = ? AND stage_name = ?',
    ).get(run.id, 'name_consolidation') as { count: number };
    expect(persistedEvidence.count).toBe(0);

    // The downstream spy was not called
    const spyResults = stageResults.filter((sr: any) => sr.stage_name === 'primary_product_type_proposal');
    expect(spyResults.length).toBe(0);
  });

  function createReviewGateItem(suffix: string) {
    const batch = createBatch({
      workspaceId,
      name: `Review Gate ${suffix}`,
      fileName: `${suffix}.xlsx`,
      totalItems: 1,
    });
    return insertItems(batch.id, [{
      upc: `GATE-${suffix}`,
      name: `Gate Product ${suffix}`,
      rowNumber: 1,
    }])[0];
  }

  function seedReviewProposal(runId: string, sku: string, status: string = 'pending'): string {
    const id = randomUUID();
    getDb().run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, is_bulk_acceptable, is_stale, created_at)
       VALUES (?, ?, ?, 'category_page', 'Dog Food', ?, 0.8, ?, 1, 0, ?)`,
      [id, runId, sku, JSON.stringify({ pageName: 'Dog Food' }), status, new Date().toISOString()],
    );
    return id;
  }

  const decide = (proposalId: string, decision: 'accepted' | 'rejected' | 'deferred') => {
    recordDecision({
      id: randomUUID(),
      proposalId,
      decision,
      revisedFromId: null,
      reviewerId: 'test-reviewer',
      reviewerNote: null,
      createdAt: new Date().toISOString(),
    });
  };

  it('does not let a decision from a historical run satisfy the active-run review gate', () => {
    const item = createReviewGateItem('HISTORY');
    const oldRun = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(oldRun.id, 'completed');
    decide(seedReviewProposal(oldRun.id, item.upc), 'accepted');

    const activeRun = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(activeRun.id, 'completed');
    seedReviewProposal(activeRun.id, item.upc, 'accepted');

    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: item.id,
      productSku: item.upc,
      activeRunId: activeRun.id,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('unresolved_proposals');
  });

  it('blocks review completion when one of two active-run proposals is pending', () => {
    const item = createReviewGateItem('PENDING');
    const run = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(run.id, 'completed');
    decide(seedReviewProposal(run.id, item.upc), 'accepted');
    seedReviewProposal(run.id, item.upc, 'pending');

    const gate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: run.id });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('unresolved_proposals');
  });

  it('blocks a proposal status changed without a durable decision row', () => {
    const item = createReviewGateItem('STATUSONLY');
    const run = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(run.id, 'completed');
    seedReviewProposal(run.id, item.upc, 'accepted');

    const gate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: run.id });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('unresolved_proposals');
  });

  it('allows an exact completed active run only after every proposal has a decision', () => {
    const item = createReviewGateItem('PASS');
    const run = createRun(workspaceId, item.upc, null, null, item.id);
    completeRun(run.id, 'completed_with_abstentions');
    decide(seedReviewProposal(run.id, item.upc), 'accepted');
    decide(seedReviewProposal(run.id, item.upc), 'deferred');

    expect(validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: item.id,
      productSku: item.upc,
      activeRunId: run.id,
    })).toEqual({ ok: true, proposalCount: 2 });
  });

  it('fails closed for null or wrong onboarding item ownership', () => {
    const item = createReviewGateItem('OWNERSHIP');
    const db = getDb();
    const nullRunId = randomUUID();
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at, completed_at)
       VALUES (?, ?, NULL, ?, 'completed', ?, ?)`,
      [nullRunId, workspaceId, item.upc, new Date().toISOString(), new Date().toISOString()],
    );
    const nullGate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: nullRunId });
    expect(nullGate.ok).toBe(false);
    if (!nullGate.ok) expect(nullGate.code).toBe('item_mismatch');

    const otherItem = createReviewGateItem('OTHEROWNER');
    const wrongRun = createRun(workspaceId, item.upc, null, null, otherItem.id);
    completeRun(wrongRun.id, 'completed');
    const wrongGate = validateReviewCompletionGate({ workspaceId, onboardingItemId: item.id, productSku: item.upc, activeRunId: wrongRun.id });
    expect(wrongGate.ok).toBe(false);
    if (!wrongGate.ok) expect(wrongGate.code).toBe('item_mismatch');
  });

  it('prevents concurrent running runs but allows a later run after terminal completion', () => {
    const item = createReviewGateItem('ACTIVEUNIQUE');
    const first = createRun(workspaceId, item.upc, null, null, item.id);
    expect(() => createRun(workspaceId, item.upc, null, null, item.id)).toThrow();

    completeRun(first.id, 'failed', 'test failure');
    const later = createRun(workspaceId, item.upc, null, null, item.id);
    expect(later.status).toBe('running');
    completeRun(later.id, 'completed');
  });

  it('enforces isBulkAcceptable: false on brand shortcut category page proposals', async () => {
    const { buildCategoryPageProposal } = await import('../../classification/curation-target-proposal');

    const brandProposal = buildCategoryPageProposal({
      runId: randomUUID(),
      sku: '12345',
      pageId: 'brand-acme',
      pageName: 'Brand - Acme',
      confidence: 0.95,
      evidenceIds: [],
      isBulkAcceptable: false,
    });
    expect(brandProposal.isBulkAcceptable).toBe(false);
  });

  it('inherits catalog_product source for catalog product description and bullet point evidence', async () => {
    const { extractProductEvidence } = await import('../../classification/product-evidence-extractor');
    const result = await extractProductEvidence(
      {
        title: 'Catalog Kibble',
        brand: 'Acme',
        weight: '5 lb',
        description: 'Rich in protein for adult dogs.',
        bulletPoints: ['High protein', 'Grain free'],
        searchKeywords: null,
        customFields: {},
        primaryImage: null,
        additionalImages: [],
        sourceUrl: null,
        workspacePath,
        existingPageNames: [],
      },
      {
        sku: 'CATALOG-SKU-1',
        sourceKind: 'catalog_product',
        evidence: [],
        acceptedProposals: [],
        allProposals: [],
      },
      {
        workspaceId,
        runId: randomUUID(),
        workspacePath,
        configSnapshotRef: { id: 'test-snapshot', hash: 'abc', sourceCommit: null, createdAt: new Date().toISOString() },
      },
    );

    const desc = result.evidence.find(e => e.sourceField === 'description');
    expect(desc).toBeDefined();
    expect(desc?.source).toBe('catalog_product');

    const bullet = result.evidence.find(e => e.sourceField === 'bullet_point');
    expect(bullet).toBeDefined();
    expect(bullet?.source).toBe('catalog_product');
  });

  it('tracks and persists ocrOutcome in evidence extraction stage', async () => {
    const { extractProductEvidence } = await import('../../classification/product-evidence-extractor');
    const result = await extractProductEvidence(
      {
        title: 'No Image Product',
        brand: 'Acme',
        weight: '1 lb',
        description: 'Product with no images.',
        bulletPoints: [],
        searchKeywords: null,
        customFields: {},
        primaryImage: null,
        additionalImages: [],
        sourceUrl: null,
        workspacePath,
        existingPageNames: [],
      },
      {
        sku: 'NO-IMAGE-SKU',
        sourceKind: 'onboarding',
        evidence: [],
        acceptedProposals: [],
        allProposals: [],
      },
      {
        workspaceId,
        runId: randomUUID(),
        workspacePath,
        configSnapshotRef: { id: 'test-snapshot', hash: 'abc', sourceCommit: null, createdAt: new Date().toISOString() },
      },
    );

    expect(result.ocrOutcome).toBeDefined();
    expect(['no_image', 'disabled', 'skipped']).toContain(result.ocrOutcome!.status);
  });
});
