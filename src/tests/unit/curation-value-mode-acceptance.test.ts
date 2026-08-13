import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  resolveAttributeAllowedValues,
  applyCurationTargetsToConfig,
} from '../../classification/curation-targets';
import { processProductFieldTarget } from '../../classification/curation-target-processor';
import { deriveCurationApplicability } from '../../classification/curation-applicability';
import type { ClassificationConfig, ProductAttributeConfig, CurationTargetConfig } from '../../shared/schemas/classification';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';

describe('Curation Input Mode & ValueMode Enforcement Acceptance Tests', () => {
  beforeAll(() => {
    initDb(':memory:');
    runMigrations();
  });

  afterAll(() => {
    try { closeDb(); } catch {}
  });

  const measuredWeightAttribute: ProductAttributeConfig = {
    id: 'weight',
    name: 'Weight',
    description: 'Product weight',
    valueMode: 'measured',
    canonicalUnit: 'lb',
    allowedValues: [],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Physical Characteristics',
  };

  const freeTextIngredientsAttribute: ProductAttributeConfig = {
    id: 'ingredients',
    name: 'Ingredients',
    description: 'Product ingredients list',
    valueMode: 'freeText',
    canonicalUnit: null,
    allowedValues: [],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Composition',
  };

  const controlledFlavorAttribute: ProductAttributeConfig = {
    id: 'flavor',
    name: 'Flavor',
    description: 'Product flavor',
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['Chicken', 'Beef', 'Salmon'],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Product Details',
  };

  const mockConfig: ClassificationConfig = {
    manifest: {
      schemaVersion: 1,
      compatibilityVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fileVersions: {},
    },
    productTypes: [
      { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] },
    ],
    attributes: [measuredWeightAttribute, freeTextIngredientsAttribute, controlledFlavorAttribute],
    attributeProfiles: [],
    attributeMappings: [
      { id: 'mapping-weight', attributeId: 'weight', catalogField: 'ProductField26', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'mapping-ingredients', attributeId: 'ingredients', catalogField: 'ProductField25', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'mapping-flavor', attributeId: 'flavor', catalogField: 'ProductField24', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      {
        id: 'target-weight',
        kind: 'product_field',
        label: 'Weight',
        enabled: true,
        mandatory: false,
        selectionMode: 'single',
        attributeId: 'weight',
        catalogField: 'ProductField26',
        optionSource: 'configured',
        required: false,
        sortOrder: 0,
      },
      {
        id: 'target-flavor',
        kind: 'product_field',
        label: 'Flavor',
        enabled: true,
        mandatory: false,
        selectionMode: 'single',
        attributeId: 'flavor',
        catalogField: 'ProductField24',
        optionSource: 'live_store',
        required: false,
        sortOrder: 1,
      },
    ],
    brands: [],
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5vl:latest',
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
    },
    dataSharing: {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 90,
    },
  };

  it('1. resolveAttributeAllowedValues returns empty array for measured and freeText attributes even with optionSource live_store', () => {
    const liveStoreWeightTarget: CurationTargetConfig = {
      id: 'target-weight',
      kind: 'product_field',
      label: 'Weight',
      enabled: true,
      mandatory: false,
      selectionMode: 'single',
      attributeId: 'weight',
      catalogField: 'ProductField26',
      optionSource: 'live_store',
      required: false,
      sortOrder: 0,
    };

    const measuredAllowed = resolveAttributeAllowedValues(mockConfig, measuredWeightAttribute, liveStoreWeightTarget);
    expect(measuredAllowed).toEqual([]);

    const freeTextAllowed = resolveAttributeAllowedValues(mockConfig, freeTextIngredientsAttribute, liveStoreWeightTarget);
    expect(freeTextAllowed).toEqual([]);
  });

  it('2. applyCurationTargetsToConfig normalizes non-controlled target optionSource to configured', () => {
    const rawTargets = [
      {
        id: 'target-weight',
        kind: 'product_field',
        label: 'Weight',
        enabled: true,
        catalogField: 'ProductField26',
        attributeId: 'weight',
        optionSource: 'configured',
      },
      {
        id: 'target-flavor',
        kind: 'product_field',
        label: 'Flavor',
        enabled: true,
        catalogField: 'ProductField24',
        attributeId: 'flavor',
        optionSource: 'live_store',
      },
    ];

    const updatedConfig = applyCurationTargetsToConfig(mockConfig, rawTargets, 'test-workspace');
    const weightTarget = updatedConfig.curationTargets.find(t => t.id === 'target-weight');
    const flavorTarget = updatedConfig.curationTargets.find(t => t.id === 'target-flavor');

    expect(weightTarget?.optionSource).toBe('configured');
    expect(flavorTarget?.optionSource).toBe('live_store');
  });

  it('3. applyCurationTargetsToConfig throws error if live_store is explicitly forced on non-controlled attribute', () => {
    const rawTargets = [
      {
        id: 'target-weight',
        kind: 'product_field',
        label: 'Weight',
        enabled: true,
        catalogField: 'ProductField26',
        attributeId: 'weight',
        optionSource: 'live_store',
      },
    ];

    expect(() => applyCurationTargetsToConfig(mockConfig, rawTargets, 'test-workspace')).toThrowError(
      /cannot use optionSource 'live_store' because attribute "Weight" has valueMode 'measured'/
    );
  });

  it('4. processProductFieldTarget generates proposals for measured and freeText attributes with empty options', async () => {
    const targetMeasured = {
      config: mockConfig.curationTargets[0],
      options: [],
      attribute: measuredWeightAttribute,
    };

    const targetFreeText = {
      config: {
        id: 'target-ingredients',
        kind: 'product_field' as const,
        label: 'Ingredients',
        enabled: true,
        mandatory: false,
        selectionMode: 'single' as const,
        attributeId: 'ingredients',
        catalogField: 'ProductField25',
        optionSource: 'configured' as const,
        required: false,
        sortOrder: 2,
      },
      options: [],
      attribute: freeTextIngredientsAttribute,
    };

    const mockInput = {
      sku: 'SKU123',
      evidence: [
        { id: 'ev1', sourceField: 'ProductField26', value: '12.5 lb', attributeId: 'weight' },
        { id: 'ev2', sourceField: 'ProductField25', value: 'Chicken, Rice, Corn', attributeId: 'ingredients' },
      ],
      allProposals: [],
    };

    const mockContext = {
      runId: 'run-1',
      workspacePath: '/tmp',
      workspaceId: 'ws-1',
    };

    const weightRes = await processProductFieldTarget(targetMeasured, mockInput as any, mockContext as any);
    expect(weightRes.proposals.length).toBe(1);
    expect(weightRes.proposals[0].proposedValue).toBe('12.5 lb');

    const ingRes = await processProductFieldTarget(targetFreeText, mockInput as any, mockContext as any);
    expect(ingRes.proposals.length).toBe(1);
    expect(ingRes.proposals[0].proposedValue).toBe('Chicken, Rice, Corn');
  });

  it('5. deriveCurationApplicability requires exact attributeProfileId and emits product_type_profile_missing when profile is missing', () => {
    const configWithMissingProfile: ClassificationConfig = {
      ...mockConfig,
      productTypes: [
        {
          id: 'garden-hose',
          name: 'Garden Hose',
          description: null,
          attributeProfileId: 'garden-hose-v2-missing',
          oldIdAliases: [],
        },
      ],
      attributeProfiles: [
        {
          id: 'old-garden-hose-profile',
          productTypeId: 'garden-hose',
          name: 'Old Hose Profile',
          attributes: [{ attributeId: 'weight', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }],
        },
      ],
    };

    const report = deriveCurationApplicability(configWithMissingProfile);
    const missingFinding = report.findings.find(f => f.code === 'product_type_profile_missing');
    expect(missingFinding).toBeDefined();
    expect(missingFinding?.message).toContain('garden-hose-v2-missing');

    const weightApplicability = report.applicability.find(a => a.catalogField === 'ProductField26');
    expect(weightApplicability?.productTypes.length).toBe(0);
  });
});
