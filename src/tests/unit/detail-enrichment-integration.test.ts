/**
 * Integration tests for detail enrichment within the curation target processor.
 *
 * Verifies that processProductFieldTarget() uses deterministic enrichment
 * (before LLM fallback) when alias/exact matching produces no results.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  saveClassificationConfig,
  loadClassificationConfig,
} from '../../classification/config-loader';
import {
  syncConfigToCache,
} from '../../db/repositories/classification-config-repo';
import { resolveEnabledTargets } from '../../classification/curation-target-resolver';
import { processProductFieldTarget } from '../../classification/curation-target-processor';
import type { ClassificationEvidence, ClassificationConfig } from '../../shared/schemas/classification';

describe('Detail Enrichment Integration', () => {
  let workspacePath: string;
  let workspaceId: string;

  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-detail-test-${workspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
    const dbPath = path.join(workspacePath, '.baystate-cms', 'app.db');
    initDb(dbPath);
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'test',
      workspacePath,
      gitPath: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    const now = new Date().toISOString();
    const config: ClassificationConfig = {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [],
      attributes: [
        {
          id: 'flavor',
          name: 'Flavor',
          description: null,
          valueMode: 'controlled' as const,
          canonicalUnit: null,
          allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'],
          valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }, { alias: 'beef', mapsTo: 'Beef' }],
          visualEvidenceEligibility: 'eligible' as const,
          isClaim: false,
          isCompositionAttribute: false,
          group: 'Food',
        },
        {
          id: 'species',
          name: 'Species',
          description: null,
          valueMode: 'controlled' as const,
          canonicalUnit: null,
          allowedValues: ['Dog', 'Cat', 'Dog & Cat'],
          valueAliases: [{ alias: 'dogs', mapsTo: 'Dog' }, { alias: 'cats', mapsTo: 'Cat' }],
          visualEvidenceEligibility: 'eligible' as const,
          isClaim: false,
          isCompositionAttribute: false,
          group: 'Pet',
        },
        {
          id: 'brand',
          name: 'Brand',
          description: null,
          valueMode: 'freeText' as const,
          canonicalUnit: null,
          allowedValues: [],
          valueAliases: [],
          visualEvidenceEligibility: 'ineligible' as const,
          isClaim: false,
          isCompositionAttribute: false,
          group: 'Identity',
        },
      ],
      attributeProfiles: [],
      attributeMappings: [
        { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
        { id: 'species-mapping', attributeId: 'species', catalogField: 'ProductField2', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        {
          id: 'target-flavor',
          kind: 'product_field' as const, mandatory: false,
          label: 'Flavor',
          enabled: true,
          selectionMode: 'single' as const,
          attributeId: 'flavor',
          catalogField: 'ProductField1',
          optionSource: 'configured' as const,
          required: false,
          sortOrder: 0,
        },
        {
          id: 'target-species',
          kind: 'product_field' as const, mandatory: false,
          label: 'Species',
          enabled: true,
          selectionMode: 'single' as const,
          attributeId: 'species',
          catalogField: 'ProductField2',
          optionSource: 'configured' as const,
          required: false,
          sortOrder: 1,
        },
        {
          id: 'target-brand',
          kind: 'product_field' as const, mandatory: false,
          label: 'Brand',
          enabled: true,
          selectionMode: 'single' as const,
          attributeId: 'brand',
          catalogField: 'ProductField3',
          optionSource: 'configured' as const,
          required: false,
          sortOrder: 2,
        },
      ],
      guidance: [],
      brands: [],
      modelPolicy: {
        defaultProvider: 'ollama' as const,
        defaultModel: '',
        stageOverrides: {},
        imageDataSharing: 'local_only' as const,
        textDataSharing: 'local_only' as const,
      },
      dataSharing: {
        imagePolicy: 'local_only' as const,
        textPolicy: 'local_only' as const,
        sensitiveDataFiltering: true,
        retentionDays: 90,
      },
    };
    saveClassificationConfig(workspacePath, config);
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));
  });

  it('uses detail enrichment for flavor match when evidence contains chicken', async () => {
    const config = loadClassificationConfig(workspacePath);
    const resolved = resolveEnabledTargets(config, workspaceId);
    expect(resolved.productFields.length).toBeGreaterThanOrEqual(1);

    const flavorTarget = resolved.productFields.find(t => t.config.attributeId === 'flavor');
    expect(flavorTarget).toBeDefined();

    if (!flavorTarget) return; // TypeScript narrowing

    const evidence: ClassificationEvidence[] = [
      {
        id: randomUUID(),
        runId: 'test-run',
        stageName: 'evidence_extraction',
        productSku: 'TEST-SKU-FLAVOR',
        attributeId: null,
        source: 'official_product_page',
        reliability: 'medium',
        sourceUrl: null,
        sourceField: 'title',
        snippet: 'Premium Chicken Recipe for Dogs',
        value: 'Premium Chicken Recipe for Dogs',
        metadata: {},
        capturedAt: new Date().toISOString(),
      },
    ];

    const runId = randomUUID();
    const result = await processProductFieldTarget(flavorTarget, {
      sku: 'TEST-SKU-FLAVOR',
      evidence,
      acceptedProposals: [],
      allProposals: [],
    }, {
      workspacePath,
      workspaceId,
      runId,
      configSnapshotRef: {
        id: 'test',
        hash: 'test',
        sourceCommit: null,
        createdAt: new Date().toISOString(),
      },
    });

    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    const proposal = result.proposals[0];
    expect(proposal.proposalType).toBe('field_assignment');
    expect(proposal.targetId).toBe('flavor');
    // Should match "Chicken" via detail enrichment
    expect(String(proposal.proposedValue)).toMatch(/chicken/i);
    expect(proposal.confidence).toBeGreaterThanOrEqual(0.55);
    expect(proposal.status).toBe('pending');
  });

  it('uses detail enrichment for species match', async () => {
    const config = loadClassificationConfig(workspacePath);
    const resolved = resolveEnabledTargets(config, workspaceId);
    const speciesTarget = resolved.productFields.find(t => t.config.attributeId === 'species');
    expect(speciesTarget).toBeDefined();
    if (!speciesTarget) return;

    const evidence: ClassificationEvidence[] = [
      {
        id: randomUUID(),
        runId: 'test-run',
        stageName: 'evidence_extraction',
        productSku: 'TEST-SKU-SPECIES',
        attributeId: null,
        source: 'official_product_page',
        reliability: 'medium',
        sourceUrl: null,
        sourceField: 'title',
        snippet: 'Premium Dog Food Chicken Recipe',
        value: 'Premium Dog Food Chicken Recipe',
        metadata: {},
        capturedAt: new Date().toISOString(),
      },
    ];

    const runId = randomUUID();
    const result = await processProductFieldTarget(speciesTarget, {
      sku: 'TEST-SKU-SPECIES',
      evidence,
      acceptedProposals: [],
      allProposals: [],
    }, {
      workspacePath,
      workspaceId,
      runId,
      configSnapshotRef: {
        id: 'test',
        hash: 'test',
        sourceCommit: null,
        createdAt: new Date().toISOString(),
      },
    });

    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    const proposal = result.proposals[0];
    expect(proposal.proposalType).toBe('field_assignment');
    expect(proposal.targetId).toBe('species');
    // Should match "Dog" via detail enrichment species keywords
    expect(String(proposal.proposedValue)).toMatch(/dog/i);
    expect(proposal.status).toBe('pending');
  });

  it('falls through to LLM fallback when enrichment finds no match', async () => {
    // With no LLM config, the processor should return empty proposals
    // for a target whose attribute doesn't match any enrichment extractor
    const config = loadClassificationConfig(workspacePath);
    const resolved = resolveEnabledTargets(config, workspaceId);
    const flavorTarget = resolved.productFields.find(t => t.config.attributeId === 'flavor');
    expect(flavorTarget).toBeDefined();
    if (!flavorTarget) return;

    // Evidence with no flavor keywords
    const evidence: ClassificationEvidence[] = [
      {
        id: randomUUID(),
        runId: 'test-run',
        stageName: 'evidence_extraction',
        productSku: 'TEST-SKU-NO-FLAVOR',
        attributeId: null,
        source: 'official_product_page',
        reliability: 'medium',
        sourceUrl: null,
        sourceField: 'title',
        snippet: 'Premium Dog Food Product for Pets',
        value: 'Premium Dog Food Product for Pets',
        metadata: {},
        capturedAt: new Date().toISOString(),
      },
    ];

    const runId = randomUUID();
    const result = await processProductFieldTarget(flavorTarget, {
      sku: 'TEST-SKU-NO-FLAVOR',
      evidence,
      acceptedProposals: [],
      allProposals: [],
    }, {
      workspacePath,
      workspaceId,
      runId,
      configSnapshotRef: {
        id: 'test',
        hash: 'test',
        sourceCommit: null,
        createdAt: new Date().toISOString(),
      },
    });

    // No LLM config means enrichment + LLM both fail → empty proposals
    expect(result.proposals.length).toBe(0);
    expect(result.message).toContain('No value match');
  });

  it('prefers alias/exact match over detail enrichment when both find results', async () => {
    const config = loadClassificationConfig(workspacePath);
    const resolved = resolveEnabledTargets(config, workspaceId);
    const flavorTarget = resolved.productFields.find(t => t.config.attributeId === 'flavor');
    expect(flavorTarget).toBeDefined();
    if (!flavorTarget) return;

    // Evidence with exact alias "beef" which matchAttributeOptions should catch
    const evidence: ClassificationEvidence[] = [
      {
        id: randomUUID(),
        runId: 'test-run',
        stageName: 'evidence_extraction',
        productSku: 'TEST-SKU-ALIAS',
        attributeId: null,
        source: 'official_product_page',
        reliability: 'medium',
        sourceUrl: null,
        sourceField: 'description',
        snippet: 'Made with real beef for adult dogs',
        value: 'Made with real beef for adult dogs',
        metadata: {},
        capturedAt: new Date().toISOString(),
      },
    ];

    const runId = randomUUID();
    const result = await processProductFieldTarget(flavorTarget, {
      sku: 'TEST-SKU-ALIAS',
      evidence,
      acceptedProposals: [],
      allProposals: [],
    }, {
      workspacePath,
      workspaceId,
      runId,
      configSnapshotRef: {
        id: 'test',
        hash: 'test',
        sourceCommit: null,
        createdAt: new Date().toISOString(),
      },
    });

    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    const proposal = result.proposals[0];
    // Alias matching should catch "beef" → "Beef" with 0.55 confidence
    expect(String(proposal.proposedValue)).toMatch(/beef/i);
    // Confidence should be from alias match (0.55) not enrichment (0.6)
    expect(proposal.confidence).toBeCloseTo(0.55, 1);
  });
});

describe('freeText attribute grounding (epic #46 review round)', () => {
  let workspacePath: string;
  let workspaceId: string;

  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-grounding-test-${workspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'test',
      workspacePath,
      gitPath: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    const now = new Date().toISOString();
    const config: ClassificationConfig = {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [],
      attributes: [
        {
          id: 'brand',
          name: 'Brand',
          description: null,
          valueMode: 'freeText' as const,
          canonicalUnit: null,
          allowedValues: [],
          valueAliases: [],
          visualEvidenceEligibility: 'ineligible' as const,
          isClaim: false,
          isCompositionAttribute: false,
          group: 'Identity',
        },
        {
          id: 'product-type',
          name: 'Product Type',
          description: null,
          valueMode: 'freeText' as const,
          canonicalUnit: null,
          allowedValues: [],
          valueAliases: [],
          visualEvidenceEligibility: 'ineligible' as const,
          isClaim: false,
          isCompositionAttribute: false,
          group: 'Identity',
        },
      ],
      attributeProfiles: [],
      attributeMappings: [
        { id: 'brand-map', attributeId: 'brand', catalogField: 'ProductField16', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
        { id: 'pt-map', attributeId: 'product-type', catalogField: 'ProductField25', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        {
          id: 'target-brand', kind: 'product_field' as const, mandatory: false,
          label: 'Brand', enabled: true, selectionMode: 'single' as const,
          attributeId: 'brand', catalogField: 'ProductField16',
          optionSource: 'configured' as const, required: false, sortOrder: 0,
        },
        {
          id: 'target-pt', kind: 'product_field' as const, mandatory: false,
          label: 'Product Type', enabled: true, selectionMode: 'single' as const,
          attributeId: 'product-type', catalogField: 'ProductField25',
          optionSource: 'configured' as const, required: false, sortOrder: 1,
        },
      ],
      guidance: [],
      brands: [],
      modelPolicy: {
        defaultProvider: 'ollama' as const,
        defaultModel: '',
        stageOverrides: {},
        imageDataSharing: 'local_only' as const,
        textDataSharing: 'local_only' as const,
      },
      dataSharing: {
        imagePolicy: 'local_only' as const,
        textPolicy: 'local_only' as const,
        sensitiveDataFiltering: true,
        retentionDays: 90,
      },
    };
    saveClassificationConfig(workspacePath, config);
    syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));
  });

  function runContext(runId: string) {
    return {
      workspacePath,
      workspaceId,
      runId,
      configSnapshotRef: {
        id: 'test',
        hash: 'test',
        sourceCommit: null,
        createdAt: new Date().toISOString(),
      },
    };
  }

  it('never uses unrelated title/description text as a freeText value (regression: beehive feeder)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const resolved = resolveEnabledTargets(config, workspaceId);
    const brandTarget = resolved.productFields.find(t => t.config.attributeId === 'brand');
    expect(brandTarget).toBeDefined();
    if (!brandTarget) return;

    // The exact live-batch failure shape: only name + description evidence.
    const evidence: ClassificationEvidence[] = [
      {
        id: randomUUID(), runId: 'g-run', stageName: 'evidence_extraction',
        productSku: 'SKU', attributeId: null, source: 'distributor_record',
        reliability: 'medium', sourceUrl: null, sourceField: 'name',
        snippet: 'LITTLE GIANT BEEHIVE FRAME FEEDER',
        value: 'LITTLE GIANT BEEHIVE FRAME FEEDER', metadata: {}, capturedAt: new Date().toISOString(),
      },
      {
        id: randomUUID(), runId: 'g-run', stageName: 'evidence_extraction',
        productSku: 'SKU', attributeId: null, source: 'distributor_record',
        reliability: 'medium', sourceUrl: null, sourceField: 'description',
        snippet: 'Feeds your bees when outside nectar sources are unavailable.',
        value: 'Feeds your bees when outside nectar sources are unavailable.',
        metadata: {}, capturedAt: new Date().toISOString(),
      },
    ];

    const result = await processProductFieldTarget(brandTarget, {
      sku: 'SKU', evidence, acceptedProposals: [], allProposals: [],
    }, runContext(randomUUID()));

    expect(result.proposals.length).toBe(0);
    expect(result.message).toMatch(/abstain/i);
  });

  it('uses the field-grounded evidence value for freeText (brand from distributor record)', async () => {
    const config = loadClassificationConfig(workspacePath);
    const resolved = resolveEnabledTargets(config, workspaceId);
    const brandTarget = resolved.productFields.find(t => t.config.attributeId === 'brand');
    expect(brandTarget).toBeDefined();
    if (!brandTarget) return;

    const evidence: ClassificationEvidence[] = [
      {
        id: randomUUID(), runId: 'g-run', stageName: 'evidence_extraction',
        productSku: 'SKU', attributeId: 'brand', source: 'distributor_record',
        reliability: 'medium', sourceUrl: null, sourceField: 'ProductField16',
        snippet: 'LITTLE GIANT', value: 'LITTLE GIANT', metadata: {}, capturedAt: new Date().toISOString(),
      },
      {
        id: randomUUID(), runId: 'g-run', stageName: 'evidence_extraction',
        productSku: 'SKU', attributeId: null, source: 'distributor_record',
        reliability: 'medium', sourceUrl: null, sourceField: 'description',
        snippet: 'Feeds your bees when outside nectar sources are unavailable.',
        value: 'Feeds your bees when outside nectar sources are unavailable.',
        metadata: {}, capturedAt: new Date().toISOString(),
      },
    ];

    const result = await processProductFieldTarget(brandTarget, {
      sku: 'SKU', evidence, acceptedProposals: [], allProposals: [],
    }, runContext(randomUUID()));

    expect(result.proposals.length).toBe(1);
    expect(result.proposals[0].proposedValue).toBe('LITTLE GIANT');
    expect(result.proposals[0].confidence).toBe(0.85);
  });
});
