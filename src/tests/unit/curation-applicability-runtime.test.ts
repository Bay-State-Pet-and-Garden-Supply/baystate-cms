import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { evaluateAttributeApplicability } from '../../classification/applicability-evaluator';
import { buildRuntimeSnapshot } from '../../classification/runtime-snapshot';
import type { ClassificationConfig, AttributeProfileConfig } from '../../shared/schemas/classification';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';

describe('curation-applicability-runtime', () => {
  beforeAll(() => {
    initDb(':memory:');
    runMigrations();
  });

  afterAll(() => {
    try { closeDb(); } catch {}
  });

  const baseConfig: ClassificationConfig = {
    manifest: {
      schemaVersion: 2,
      compatibilityVersion: 1,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
      fileVersions: {},
    },
    productTypes: [
      { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
      { id: 'garden-hose', name: 'Garden Hose', description: null, attributeProfileId: 'garden-hose-profile', oldIdAliases: [] },
    ],
    attributes: [
      { id: 'ingredients', name: 'Ingredients', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: true, group: null },
      { id: 'material', name: 'Material', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Rubber', 'Vinyl'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
    ],
    attributeProfiles: [
      {
        id: 'dry-dog-food-profile',
        productTypeId: 'dry-dog-food',
        name: 'Dry Dog Food Profile',
        attributes: [
          { attributeId: 'ingredients', required: true, cardinality: 'multiple', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
        ],
      },
      {
        id: 'garden-hose-profile',
        productTypeId: 'garden-hose',
        name: 'Garden Hose Profile',
        attributes: [
          { attributeId: 'material', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
        ],
      },
    ],
    attributeMappings: [
      { id: 'm-24', attributeId: 'ingredients', catalogField: 'ProductField24', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'm-7', attributeId: 'material', catalogField: 'ProductField7', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'target-24', kind: 'product_field', label: 'Ingredients', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'ingredients', catalogField: 'ProductField24', optionSource: 'configured', required: false, sortOrder: 0 },
      { id: 'target-7', kind: 'product_field', label: 'Material', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'material', catalogField: 'ProductField7', optionSource: 'configured', required: false, sortOrder: 1 },
      { id: 'target-pt', kind: 'product_type', label: 'Product Type', enabled: true, mandatory: false, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, sortOrder: 2 },
    ],
    brands: [],
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: 'llama3',
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
    },
    dataSharing: {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 30,
    },
  };

  test('proves profile-gated applicability for Dry Dog Food vs Garden Hose', () => {
    const ingredientsAttr = baseConfig.attributes.find(a => a.id === 'ingredients')!;
    const materialAttr = baseConfig.attributes.find(a => a.id === 'material')!;

    // Dry Dog Food
    const dryDogProfileAttrIds = new Set<string>(['ingredients']);
    const dryDogIngredientsEval = evaluateAttributeApplicability({
      attribute: ingredientsAttr,
      profileAttributeIds: dryDogProfileAttrIds,
      conditions: [],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(dryDogIngredientsEval.state).toBe('applicable');

    const dryDogMaterialEval = evaluateAttributeApplicability({
      attribute: materialAttr,
      profileAttributeIds: dryDogProfileAttrIds,
      conditions: [],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(dryDogMaterialEval.state).toBe('not_applicable');

    // Garden Hose
    const gardenHoseProfileAttrIds = new Set<string>(['material']);
    const gardenHoseIngredientsEval = evaluateAttributeApplicability({
      attribute: ingredientsAttr,
      profileAttributeIds: gardenHoseProfileAttrIds,
      conditions: [],
      acceptedTypeId: 'garden-hose',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(gardenHoseIngredientsEval.state).toBe('not_applicable');

    const gardenHoseMaterialEval = evaluateAttributeApplicability({
      attribute: materialAttr,
      profileAttributeIds: gardenHoseProfileAttrIds,
      conditions: [],
      acceptedTypeId: 'garden-hose',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(gardenHoseMaterialEval.state).toBe('applicable');
  });

  test('proves frozen snapshot authority invariant', () => {
    const ingredientsAttr = baseConfig.attributes.find(a => a.id === 'ingredients')!;

    // 1. Freeze snapshot from initial baseConfig
    const snapshot1 = buildRuntimeSnapshot({
      config: baseConfig,
      workspaceId: 'ws-test',
      workspacePath: '/tmp',
      productSku: '',
      sourceProductHash: null,
      configSnapshotRef: { id: 'snap-1', hash: 'hash-1', sourceCommit: null, createdAt: '2026-08-13T00:00:00.000Z' },
    });
    const gardenHoseProfile1 = snapshot1.attributeProfiles.find((p: AttributeProfileConfig) => p.productTypeId === 'garden-hose')!;
    const profileAttrIds1 = new Set<string>(gardenHoseProfile1.attributes.map((a: { attributeId: string }) => a.attributeId));

    // Evaluate against frozen snapshot 1
    const evalSnapshot1 = evaluateAttributeApplicability({
      attribute: ingredientsAttr,
      profileAttributeIds: profileAttrIds1,
      conditions: [],
      acceptedTypeId: 'garden-hose',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(evalSnapshot1.state).toBe('not_applicable');

    // 2. Mutate live config to add ingredients to Garden Hose profile
    const mutatedConfig: ClassificationConfig = {
      ...baseConfig,
      attributeProfiles: baseConfig.attributeProfiles.map(p => {
        if (p.productTypeId === 'garden-hose') {
          return {
            ...p,
            attributes: [
              ...p.attributes,
              { attributeId: 'ingredients', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
            ],
          };
        }
        return p;
      }),
    };

    // 3. Re-evaluate against original frozen snapshot 1 -> ingredients MUST STILL BE not_applicable
    const evalSnapshot1Again = evaluateAttributeApplicability({
      attribute: ingredientsAttr,
      profileAttributeIds: profileAttrIds1, // Still using snapshot1!
      conditions: [],
      acceptedTypeId: 'garden-hose',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(evalSnapshot1Again.state).toBe('not_applicable');

    // 4. Create fresh snapshot 2 from mutatedConfig -> fresh revision sees new profile
    const snapshot2 = buildRuntimeSnapshot({
      config: mutatedConfig,
      workspaceId: 'ws-test',
      workspacePath: '/tmp',
      productSku: '',
      sourceProductHash: null,
      configSnapshotRef: { id: 'snap-2', hash: 'hash-2', sourceCommit: null, createdAt: '2026-08-13T00:00:01.000Z' },
    });
    const gardenHoseProfile2 = snapshot2.attributeProfiles.find((p: AttributeProfileConfig) => p.productTypeId === 'garden-hose')!;
    const profileAttrIds2 = new Set<string>(gardenHoseProfile2.attributes.map((a: { attributeId: string }) => a.attributeId));

    const evalSnapshot2 = evaluateAttributeApplicability({
      attribute: ingredientsAttr,
      profileAttributeIds: profileAttrIds2,
      conditions: [],
      acceptedTypeId: 'garden-hose',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(evalSnapshot2.state).toBe('applicable');
  });

  test('proves valueMode enforcement suppresses option lists for measured and freeText attributes', () => {
    const { resolveAttributeAllowedValues } = require('../../classification/curation-targets');

    const measuredAttr = {
      id: 'weight',
      name: 'Weight',
      valueMode: 'measured' as const,
      canonicalUnit: 'lb',
      allowedValues: ['10', '20'], // Even if allowedValues were populated in dirty config
      valueAliases: [],
      visualEvidenceEligibility: 'eligible' as const,
      isClaim: false,
      isCompositionAttribute: false,
      group: null,
    };

    const freeTextAttr = {
      id: 'ingredients',
      name: 'Ingredients',
      valueMode: 'freeText' as const,
      canonicalUnit: null,
      allowedValues: ['Sugar', 'Salt'],
      valueAliases: [],
      visualEvidenceEligibility: 'eligible' as const,
      isClaim: false,
      isCompositionAttribute: false,
      group: null,
    };

    const controlledAttr = {
      id: 'material',
      name: 'Material',
      valueMode: 'controlled' as const,
      canonicalUnit: null,
      allowedValues: ['Rubber', 'Vinyl'],
      valueAliases: [],
      visualEvidenceEligibility: 'eligible' as const,
      isClaim: false,
      isCompositionAttribute: false,
      group: null,
    };

    const target = {
      id: 'target-weight',
      kind: 'product_field' as const,
      label: 'Weight',
      enabled: true,
      mandatory: false,
      selectionMode: 'single' as const,
      attributeId: 'weight',
      catalogField: 'ProductField26',
      optionSource: 'live_store' as const,
      required: false,
      sortOrder: 0,
    };

    expect(resolveAttributeAllowedValues(baseConfig, measuredAttr, target)).toEqual([]);
    expect(resolveAttributeAllowedValues(baseConfig, freeTextAttr, target)).toEqual([]);
    expect(resolveAttributeAllowedValues(baseConfig, controlledAttr, target)).toEqual(['Rubber', 'Vinyl']);
  });

  test('proves fail-closed validation for optionSource live_store on non-controlled attributes', () => {
    const { validateClassificationConfigBundle } = require('../../classification/config-validation');
    const { migrateClassificationConfigV1 } = require('../../classification/config-migrate-v1');

    const v1Config: ClassificationConfig = {
      ...baseConfig,
      manifest: { ...baseConfig.manifest, schemaVersion: 1 },
      attributes: [
        ...baseConfig.attributes,
        { id: 'weight', name: 'Weight', description: null, valueMode: 'measured', canonicalUnit: 'lb', allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
      ],
      attributeMappings: [
        ...baseConfig.attributeMappings,
        { id: 'm-26', attributeId: 'weight', catalogField: 'ProductField26', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        ...baseConfig.curationTargets,
        { id: 'target-26', kind: 'product_field', label: 'Weight', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'weight', catalogField: 'ProductField26', optionSource: 'live_store', required: false, sortOrder: 3 },
      ],
    };

    const migratedResult = migrateClassificationConfigV1(v1Config);
    const result = validateClassificationConfigBundle(migratedResult.bundle);

    const invalidFinding = result.findings.find((f: { code: string }) => f.code === 'invalid_option_source_for_value_mode');
    expect(invalidFinding).toBeDefined();
    expect(invalidFinding?.severity).toBe('error');
    expect(invalidFinding?.message).toContain("cannot use optionSource 'live_store'");
  });
});
