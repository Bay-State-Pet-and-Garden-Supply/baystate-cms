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
import { createRun, getProposalsByRun, recordDecision, getAcceptedProposals } from '../../db/repositories/classification-run-repo';
import { runPipeline } from '../../classification/pipeline-runner';
import { evidenceExtractionStage, nameConsolidationStage, categoryPageProposalsStage, productAttributeProposalsStage, attributeApplicabilityStage, primaryProductTypeStage } from '../../classification';
import { upsertPage } from '../../db/repositories/page-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { migrateLegacyToClassificationConfig } from '../../classification/legacy-migration';
import { listCurationTargetCandidates } from '../../classification/curation-targets';
import { getDb } from '../../db/connection';

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

  it('name consolidation stage returns metadata without field_assignment proposals', async () => {
    const config = loadClassificationConfig(workspacePath);
    const snapId = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-NAME', snapId, snapId);
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
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapId, sourceCommit: null, createdAt: new Date().toISOString() } },
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
    const snapId = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-PROV', snapId, snapId);
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
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapId, sourceCommit: null, createdAt: new Date().toISOString() } },
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
    const snapId = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-24', snapId, snapId);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-24', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Premium Cat Toys assortment', value: 'Premium Cat Toys assortment', metadata: {}, capturedAt: now },
    ];

    const result = await runPipeline(
      [productAttributeProposalsStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapId, sourceCommit: null, createdAt: now } },
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
    const snapId = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-NOPT', snapId, snapId);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-NOPT', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Dry Dog Food Chicken Recipe', value: 'Dry Dog Food Chicken Recipe', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const result = await runPipeline(
      [evidenceExtractionStage, primaryProductTypeStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapId, sourceCommit: null, createdAt: new Date().toISOString() } },
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
    const snapId = createConfigSnapshot(workspaceId, config);
    const run = createRun(workspaceId, 'TEST-SKU-FIELDONLY', snapId, snapId);
    const evidence = [
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-FIELDONLY', attributeId: null, source: 'spreadsheet' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'name', snippet: 'Chicken Recipe Dry Dog Food', value: 'Chicken Recipe Dry Dog Food', metadata: {}, capturedAt: new Date().toISOString() },
      { id: randomUUID(), runId: run.id, stageName: 'evidence_extraction' as const, productSku: 'TEST-SKU-FIELDONLY', attributeId: null, source: 'official_product_page' as const, reliability: 'medium' as const, sourceUrl: null, sourceField: 'description', snippet: 'Made with real Chicken', value: 'Made with real Chicken', metadata: {}, capturedAt: new Date().toISOString() },
    ];
    const result = await runPipeline(
      [productAttributeProposalsStage],
      { workspacePath, workspaceId, runId: run.id, configSnapshotRef: { id: snapId, hash: snapId, sourceCommit: null, createdAt: new Date().toISOString() } },
      { sku: 'TEST-SKU-FIELDONLY', evidence: evidence, acceptedProposals: [], allProposals: [] },
    );

    const fieldProposals = result.proposals.filter(p => p.proposalType === 'field_assignment');
    expect(fieldProposals.length).toBeGreaterThanOrEqual(1);
  });
});
