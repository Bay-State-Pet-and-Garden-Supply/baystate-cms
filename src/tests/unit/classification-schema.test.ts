import { describe, it, expect } from 'vitest';
import {
  CurationDataSchema,
} from '../../shared/schemas/onboarding';
import {
  ClassificationConfigSchema,
  ClassificationEvidenceSchema,
  ClassificationProposalSchema,
  ClassificationProposalDecisionSchema,
  ProductTypeConfigSchema,
  ProductAttributeConfigSchema,
  AttributeProfileConfigSchema,
  AttributeMappingConfigSchema,
  GuidanceConfigSchema,
  ModelPolicyConfigSchema,
  DataSharingConfigSchema,
  ClassificationManifestSchema,
  ClassificationHistoryEventSchema,
  ClassificationConfigSnapshotRefSchema,
} from '../../shared/schemas/classification';

describe('Classification Schema – CurationData backward compatibility', () => {
  it('parses legacy curation data and provides empty classification defaults', () => {
    const legacy = {
      curatedTitle: 'Test Product',
      packagingOcrTitle: null,
      titleSource: 'web',
      suggestedPages: ['/dogs/food'],
      suggestedProductType: 'dog-food',
      curatedAt: '2026-06-01T00:00:00.000Z',
      curationMethod: 'auto',
    };

    const result = CurationDataSchema.parse(legacy);

    // Original fields preserved
    expect(result.curatedTitle).toBe('Test Product');
    expect(result.titleSource).toBe('web');

    // New classification fields have empty defaults
    expect(result.classificationRunId).toBeNull();
    expect(result.classificationConfigSnapshot).toBeNull();
    expect(result.classificationEvidence).toEqual([]);
    expect(result.classificationProposals).toEqual([]);
    expect(result.classificationDecisions).toEqual([]);
    expect(result.classificationHistory).toEqual([]);
  });
});

describe('Classification Schema – Config payload', () => {
  it('parses a minimal complete config', () => {
    const config = {
      manifest: {
        schemaVersion: 1,
        compatibilityVersion: 1,
        createdAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      },
      productTypes: [
        {
          id: 'dog_food',
          name: 'Dog Food',
          description: 'Complete and balanced nutrition for dogs',
          attributeProfileId: 'dog_food_profile',
          oldIdAliases: ['canine-food'],
        },
      ],
      attributes: [
        {
          id: 'flavor',
          name: 'Flavor',
          valueMode: 'controlled',
          allowedValues: ['Chicken', 'Beef', 'Salmon'],
          isClaim: false,
          isCompositionAttribute: false,
        },
      ],
      attributeProfiles: [
        {
          id: 'dog_food_profile',
          productTypeId: 'dog_food',
          name: 'Dog Food Profile',
          attributes: [
            {
              attributeId: 'flavor',
              required: true,
              cardinality: 'single',
            },
          ],
        },
      ],
      attributeMappings: [
        {
          id: 'flavor_map',
          attributeId: 'flavor',
          catalogField: 'ProductField1',
        },
      ],
      guidance: [
        {
          id: 'general_guidance',
          scope: 'workspace',
          structured: { preferManufacturerName: true },
        },
      ],
      modelPolicy: {
        defaultProvider: 'ollama',
        defaultModel: 'qwen2.5vl:latest',
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

    const result = ClassificationConfigSchema.parse(config);
    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.productTypes).toHaveLength(1);
    expect(result.productTypes[0].id).toBe('dog_food');
    expect(result.attributes).toHaveLength(1);
    expect(result.attributeProfiles).toHaveLength(1);
    expect(result.attributeMappings).toHaveLength(1);
    expect(result.guidance).toHaveLength(1);
    expect(result.modelPolicy.imageDataSharing).toBe('local_only');
    expect(result.dataSharing.imagePolicy).toBe('local_only');
  });

  it('parses config with all-defaulted fields', () => {
    const minimal = {
      manifest: {
        schemaVersion: 1,
        compatibilityVersion: 1,
        createdAt: '2026-06-15T00:00:00Z',
        updatedAt: '2026-06-15T00:00:00Z',
      },
      productTypes: [
        { id: 'simple', name: 'Simple' },
      ],
      attributes: [
        { id: 'color', name: 'Color', valueMode: 'freeText' },
      ],
      attributeProfiles: [
        {
          id: 'simple_profile',
          productTypeId: 'simple',
          name: 'Simple Profile',
        },
      ],
      attributeMappings: [
        { id: 'color_map', attributeId: 'color', catalogField: 'Field1' },
      ],
      guidance: [
        { id: 'g1', scope: 'workspace' },
      ],
    };

    const result = ClassificationConfigSchema.parse(minimal);
    expect(result.productTypes[0].oldIdAliases).toEqual([]);
    expect(result.attributes[0].allowedValues).toEqual([]);
    expect(result.attributes[0].isClaim).toBe(false);
    expect(result.attributeProfiles[0].attributes).toEqual([]);
    expect(result.modelPolicy.imageDataSharing).toBe('local_only');
    expect(result.dataSharing.retentionDays).toBe(90);
  });

  it('rejects unknown valueMode', () => {
    const bad = {
      id: 'test',
      name: 'Test',
      valueMode: 'unknown_mode',
    };
    const result = ProductAttributeConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join('; ');
      expect(msg).toContain('expected one of');
    }
  });

  it('rejects unknown guidance scope', () => {
    const bad = {
      id: 'g1',
      scope: 'invalid_scope',
    };
    const result = GuidanceConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects negative confidence', () => {
    const bad = {
      id: 'prop-1',
      runId: 'run-1',
      productSku: 'SKU001',
      proposalType: 'field_assignment',
      proposedValue: 'Some value',
      confidence: -0.1,
      createdAt: '2026-06-01T00:00:00Z',
    };
    const result = ClassificationProposalSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects confidence > 1', () => {
    const bad = {
      id: 'prop-2',
      runId: 'run-1',
      productSku: 'SKU001',
      proposalType: 'field_assignment',
      proposedValue: 'Some value',
      confidence: 1.5,
      createdAt: '2026-06-01T00:00:00Z',
    };
    const result = ClassificationProposalSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects unknown decision string', () => {
    const bad = {
      id: 'dec-1',
      proposalId: 'prop-1',
      decision: 'maybe',
      createdAt: '2026-06-01T00:00:00Z',
    };
    const result = ClassificationProposalDecisionSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects unknown proposal status', () => {
    const bad = {
      id: 'prop-3',
      runId: 'run-1',
      productSku: 'SKU001',
      proposalType: 'field_assignment',
      proposedValue: 'x',
      confidence: 0.5,
      status: 'unknown_status',
      createdAt: '2026-06-01T00:00:00Z',
    };
    const result = ClassificationProposalSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('Classification Schema – Runtime types', () => {
  it('parses valid evidence, proposal, and decision payload', () => {
    const evidence = {
      id: 'ev-1',
      runId: 'run-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU001',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/product',
      sourceField: 'description',
      snippet: 'High-quality chicken formula',
      value: 'Chicken',
      metadata: { extractionMethod: 'json-ld' },
      capturedAt: '2026-06-01T00:00:00Z',
    };
    const evResult = ClassificationEvidenceSchema.parse(evidence);
    expect(evResult.source).toBe('official_product_page');
    expect(evResult.value).toBe('Chicken');

    const proposal = {
      id: 'prop-1',
      runId: 'run-1',
      productSku: 'SKU001',
      proposalType: 'field_assignment',
      targetId: 'flavor',
      proposedValue: 'Chicken',
      confidence: 0.95,
      evidenceIds: ['ev-1'],
      status: 'pending',
      isBulkAcceptable: true,
      createdAt: '2026-06-01T00:00:00Z',
    };
    const propResult = ClassificationProposalSchema.parse(proposal);
    expect(propResult.status).toBe('pending');
    expect(propResult.confidence).toBe(0.95);

    const decision = {
      id: 'dec-1',
      proposalId: 'prop-1',
      decision: 'accepted',
      reviewerNote: 'Looks correct',
      createdAt: '2026-06-01T00:00:00Z',
    };
    const decResult = ClassificationProposalDecisionSchema.parse(decision);
    expect(decResult.decision).toBe('accepted');
    expect(decResult.reviewerNote).toBe('Looks correct');
  });

  it('parses a minimal history event', () => {
    const event = {
      id: 'hist-1',
      runId: 'run-1',
      eventType: 'run_started',
      createdAt: '2026-06-01T00:00:00Z',
    };
    const result = ClassificationHistoryEventSchema.parse(event);
    expect(result.eventType).toBe('run_started');
    expect(result.eventJson).toEqual({});
    expect(result.proposalId).toBeNull();
  });
});

describe('Classification Schema – Individual config schemas', () => {
  it('parses a manifest', () => {
    const manifest = {
      schemaVersion: 2,
      compatibilityVersion: 1,
      createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-15T00:00:00Z',
      fileVersions: { 'product-types.json': 'abc123' },
    };
    const result = ClassificationManifestSchema.parse(manifest);
    expect(result.schemaVersion).toBe(2);
    expect(result.fileVersions['product-types.json']).toBe('abc123');
  });

  it('parses a config snapshot ref', () => {
    const ref = {
      id: 'snap-1',
      hash: 'abc123def456',
      sourceCommit: 'deadbeef',
      createdAt: '2026-06-01T00:00:00Z',
    };
    const result = ClassificationConfigSnapshotRefSchema.parse(ref);
    expect(result.hash).toBe('abc123def456');
    expect(result.sourceCommit).toBe('deadbeef');
  });

  it('parses model policy with defaults', () => {
    const result = ModelPolicyConfigSchema.parse({});
    expect(result.defaultProvider).toBe('ollama');
    expect(result.imageDataSharing).toBe('local_only');
    expect(result.stageOverrides).toEqual({});
  });

  it('parses data sharing with defaults', () => {
    const result = DataSharingConfigSchema.parse({});
    expect(result.imagePolicy).toBe('local_only');
    expect(result.sensitiveDataFiltering).toBe(true);
  });
});
