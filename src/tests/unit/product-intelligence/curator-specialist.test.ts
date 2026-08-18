/**
 * Unit tests for Curator specialist (#54, epic #47, ADR 0026).
 */

import { describe, it, expect } from 'vitest';
import {
  CuratorSpecialist,
  curateProductDraft,
  CURATOR_SPECIALIST_CAPABILITY,
  CURATOR_INPUT_ARTIFACT_TYPE,
  CURATOR_OUTPUT_ARTIFACT_TYPE,
  registerCuratorSchemas,
  type CuratorSpecialistInput,
} from '../../../product-intelligence/specialists/curator';
import {
  SpecialistArtifactSchemaRegistry,
  type SpecialistArtifactEnvelope,
} from '../../../product-intelligence/specialists/artifacts';
import {
  validateSpecialistResult,
  type SpecialistContext,
} from '../../../product-intelligence/specialists/contracts';
import type { ResolvedFactSet } from '../../../product-intelligence/specialists/resolver';

const FIXED_NOW = '2026-08-18T12:00:00.000Z';

function sampleFactSet(overrides: Partial<ResolvedFactSet> = {}): ResolvedFactSet {
  return {
    schemaVersion: '1.0.0',
    specialist: 'resolver',
    specialistVersion: '1.0.0',
    productSeed: { sku: 'SUP-54', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
    expectedIdentity: { gtin: '012345678901', gtinScope: 'consumer_unit' },
    identity: {
      status: 'resolved',
      confidence: 0.95,
      candidateId: 'cand:acme',
      candidateUrl: 'https://acme.example/products/chicken-broth-16oz',
      gtin: '012345678901',
      upc: '012345678901',
      decisions: [
        {
          candidateId: 'cand:acme',
          url: 'https://acme.example/products/chicken-broth-16oz',
          sourceKind: 'manufacturer',
          decision: 'exact_match',
          gtin: '012345678901',
          reasons: ['fixture exact match'],
        },
      ],
      nextEvidence: null,
    },
    facts: [
      {
        field: 'brand',
        status: 'resolved',
        value: 'ACME',
        canonicalQuantity: null,
        identifierScope: null,
        dimensionScope: null,
        confidence: 0.9,
        supportingEvidence: [
          {
            id: 'ev:brand:1',
            sourceKind: 'manufacturer',
            candidateId: 'cand:acme',
            url: 'https://acme.example/products/chicken-broth-16oz',
            field: 'brand',
            rawValue: 'ACME',
            contentHash: null,
            scope: null,
            method: 'json_ld',
            sourcePath: 'product.brand',
          },
        ],
        contradictingEvidence: [],
        notes: null,
      },
      {
        field: 'title',
        status: 'resolved',
        value: 'Organic Chicken Broth',
        canonicalQuantity: null,
        identifierScope: null,
        dimensionScope: null,
        confidence: 0.9,
        supportingEvidence: [
          {
            id: 'ev:title:1',
            sourceKind: 'manufacturer',
            candidateId: 'cand:acme',
            url: 'https://acme.example/products/chicken-broth-16oz',
            field: 'title',
            rawValue: 'Organic Chicken Broth',
            contentHash: null,
            scope: null,
            method: 'json_ld',
            sourcePath: 'product.name',
          },
        ],
        contradictingEvidence: [],
        notes: null,
      },
      {
        field: 'weight',
        status: 'resolved',
        value: '16 fl oz',
        canonicalQuantity: { value: 16, unit: 'fl oz', kind: 'volume', rawValue: '16 fl oz' },
        identifierScope: null,
        dimensionScope: null,
        confidence: 0.85,
        supportingEvidence: [
          {
            id: 'ev:weight:1',
            sourceKind: 'manufacturer',
            candidateId: 'cand:acme',
            url: 'https://acme.example/products/chicken-broth-16oz',
            field: 'weight',
            rawValue: '16 fl oz',
            contentHash: null,
            scope: null,
            method: 'json_ld',
            sourcePath: 'product.weight',
          },
        ],
        contradictingEvidence: [],
        notes: null,
      },
      {
        field: 'size',
        status: 'resolved',
        value: '16 fl oz',
        canonicalQuantity: { value: 16, unit: 'fl oz', kind: 'volume', rawValue: '16 fl oz' },
        identifierScope: null,
        dimensionScope: null,
        confidence: 0.85,
        supportingEvidence: [],
        contradictingEvidence: [],
        notes: null,
      },
      {
        field: 'dimensions',
        status: 'needs_more_evidence',
        value: null,
        canonicalQuantity: null,
        identifierScope: null,
        dimensionScope: 'product',
        confidence: 0,
        supportingEvidence: [],
        contradictingEvidence: [],
        notes: 'no evidence observed',
      },
    ],
    fieldCompleteness: {
      total: 12,
      resolved: 4,
      conflicts: 0,
      needsMoreEvidence: 1,
      abstained: 7,
    },
    conflicts: [],
    evidenceRegistry: {},
    abstentions: [],
    sourceAuthority: {
      configVersion: '1.0.0',
      configId: 'test-authority-id',
      ranking: ['catalog', 'manufacturer', 'distributor', 'supplier', 'retailer', 'marketplace', 'other'],
    },
    resolvedAt: FIXED_NOW,
    ...overrides,
  };
}

import { ProductIntelligencePolicySchema } from '../../../product-intelligence/contracts';

const context: SpecialistContext = {
  runId: 'run-54',
  workspaceId: 'ws-54',
  workspacePath: '/tmp/ws-54',
  seq: 1,
  policy: ProductIntelligencePolicySchema.parse({
    configId: 'test-policy-config',
    modelRoute: { provider: 'test', model: 'test', thinkingLevel: 'off' },
  }),
};

describe('Curator specialist (#54)', () => {
  it('synthesizes clean catalog title without duplicating brand prefix', () => {
    const input: CuratorSpecialistInput = {
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-54', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      classificationContext: {
        availableProductTypes: [],
        availableCategories: [],
        attributeProfiles: [],
      },
    };

    const draft = curateProductDraft(input, { now: () => FIXED_NOW });
    expect(draft.catalogTitle).toBe('ACME Organic Chicken Broth 16 fl oz');
    expect(draft.brand).toBe('ACME');
    expect(draft.sourceTitle).toBe('ACME Organic Chicken Broth 16 oz');
    expect(draft.resolvedIdentityName).toBe('Organic Chicken Broth');
    expect(draft.gtin).toBe('012345678901');
    expect(draft.upc).toBe('012345678901');
  });

  it('keeps source title, resolved identity name, and catalog title distinct', () => {
    const factSet = sampleFactSet({
      facts: [
        {
          field: 'brand',
          status: 'resolved',
          value: 'Fromm',
          canonicalQuantity: null,
          identifierScope: null,
          dimensionScope: null,
          confidence: 0.9,
          supportingEvidence: [],
          contradictingEvidence: [],
          notes: null,
        },
        {
          field: 'title',
          status: 'resolved',
          value: 'Gold Adult Dog Food',
          canonicalQuantity: null,
          identifierScope: null,
          dimensionScope: null,
          confidence: 0.9,
          supportingEvidence: [],
          contradictingEvidence: [],
          notes: null,
        },
        {
          field: 'weight',
          status: 'resolved',
          value: '15 lb',
          canonicalQuantity: { value: 15, unit: 'lb', kind: 'weight', rawValue: '15 lb' },
          identifierScope: null,
          dimensionScope: null,
          confidence: 0.9,
          supportingEvidence: [],
          contradictingEvidence: [],
          notes: null,
        },
      ],
    });

    const draft = curateProductDraft(
      {
        schemaVersion: '1.0.0',
        productSeed: { sku: 'FRM-100', name: 'FRM GOLD ADULT 15#', price: '45.99' },
        resolvedFacts: factSet,
        classificationContext: {
          availableProductTypes: [],
          availableCategories: [],
          attributeProfiles: [],
        },
      },
      { now: () => FIXED_NOW },
    );

    expect(draft.sourceTitle).toBe('FRM GOLD ADULT 15#');
    expect(draft.resolvedIdentityName).toBe('Gold Adult Dog Food');
    expect(draft.catalogTitle).toBe('Fromm Gold Adult Dog Food 15 lb');
  });

  it('grounds generated claims in supporting resolved facts and evidence refs', () => {
    const input: CuratorSpecialistInput = {
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-54', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      classificationContext: {
        availableProductTypes: [],
        availableCategories: [],
        attributeProfiles: [],
      },
    };

    const draft = curateProductDraft(input, { now: () => FIXED_NOW });
    expect(draft.grounding.length).toBeGreaterThanOrEqual(2);

    const brandGrounding = draft.grounding.find((g) => g.field === 'brand');
    expect(brandGrounding).toBeDefined();
    expect(brandGrounding?.supportingFactFields).toContain('brand');
    expect(brandGrounding?.evidenceIds).toContain('ev:brand:1');

    const weightGrounding = draft.grounding.find((g) => g.field === 'weight');
    expect(weightGrounding).toBeDefined();
    expect(weightGrounding?.supportingFactFields).toContain('weight');
    expect(weightGrounding?.evidenceIds).toContain('ev:weight:1');

    expect(draft.description).toContain('### Product Details');
    expect(draft.description).toContain('Net Weight: 16 fl oz');
  });

  it('selects taxonomy and category strictly from provided CMS configuration options', () => {
    const input: CuratorSpecialistInput = {
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-54', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      classificationContext: {
        availableProductTypes: [
          { id: 'pt_broth', name: 'Broth & Stock' },
          { id: 'pt_kibble', name: 'Dry Kibble' },
        ],
        availableCategories: [
          { id: 'cat_canned_food', name: 'Wet Food & Broths', path: 'Dog > Wet Food & Broths' },
          { id: 'cat_treats', name: 'Dog Treats', path: 'Dog > Treats' },
        ],
        attributeProfiles: [],
      },
    };

    const draft = curateProductDraft(input, { now: () => FIXED_NOW });
    expect(draft.productTypeId).toBe('pt_broth');
    expect(draft.categoryIds).toContain('cat_canned_food');
    expect(draft.categoryIds).not.toContain('cat_treats');
  });

  it('abstains from classification rather than inventing taxonomy terms when none match', () => {
    const input: CuratorSpecialistInput = {
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-54', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      classificationContext: {
        availableProductTypes: [
          { id: 'pt_aquarium', name: 'Aquarium Filters' },
        ],
        availableCategories: [
          { id: 'cat_reptile', name: 'Reptile Supplies' },
        ],
        attributeProfiles: [],
      },
    };

    const draft = curateProductDraft(input, { now: () => FIXED_NOW });
    expect(draft.productTypeId).toBeNull();
    expect(draft.categoryIds).toEqual([]);
    expect(draft.abstentions.some((a) => a.field === 'productTypeId')).toBe(true);
    expect(draft.abstentions.some((a) => a.field === 'categoryIds')).toBe(true);
  });

  it('omits conflicting facts and records structured abstentions', () => {
    const factSet = sampleFactSet({
      facts: [
        {
          field: 'brand',
          status: 'resolved',
          value: 'ACME',
          canonicalQuantity: null,
          identifierScope: null,
          dimensionScope: null,
          confidence: 0.9,
          supportingEvidence: [],
          contradictingEvidence: [],
          notes: null,
        },
        {
          field: 'weight',
          status: 'conflict',
          value: null,
          canonicalQuantity: null,
          identifierScope: null,
          dimensionScope: null,
          confidence: 0,
          supportingEvidence: [],
          contradictingEvidence: [],
          notes: 'sources disagree: 5 lb vs 10 lb',
        },
      ],
    });

    const draft = curateProductDraft(
      {
        schemaVersion: '1.0.0',
        productSeed: { sku: 'SUP-54', name: 'ACME Product', price: '9.99' },
        resolvedFacts: factSet,
        classificationContext: {
          availableProductTypes: [],
          availableCategories: [],
          attributeProfiles: [],
        },
      },
      { now: () => FIXED_NOW },
    );

    expect(draft.attributes.weight).toBeUndefined();
    expect(draft.abstentions.some((a) => a.field === 'weight' && /conflict/i.test(a.reason))).toBe(true);
  });

  it('emits a typed artifact through the specialist boundary without writing catalog state', async () => {
    const specialist = new CuratorSpecialist({
      codeCommit: 'commit-54',
      now: () => FIXED_NOW,
    });

    const rawInput: CuratorSpecialistInput = {
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-54', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      classificationContext: {
        availableProductTypes: [],
        availableCategories: [],
        attributeProfiles: [],
      },
    };

    const result = await specialist.execute(rawInput, context);
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error('expected succeeded outcome');

    const output = result.output as SpecialistArtifactEnvelope;
    expect(output.artifactType).toBe(CURATOR_OUTPUT_ARTIFACT_TYPE);
    expect(output.schemaVersion).toBe('1.0.0');
    expect(output.provenance.specialist).toBe('curator');
    expect(output.provenance.codeCommit).toBe('commit-54');
    expect(output.contentHash).toBeDefined();

    const registry = registerCuratorSchemas(new SpecialistArtifactSchemaRegistry());
    const validation = validateSpecialistResult({
      result,
      capability: CURATOR_SPECIALIST_CAPABILITY,
      artifactSchemas: registry,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('fails closed on invalid input schema', async () => {
    const specialist = new CuratorSpecialist({ codeCommit: 'commit-54', now: () => FIXED_NOW });
    const result = await specialist.execute({ invalid: true }, context);
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed');
    expect(result.failure?.code).toBe('invalid_input');
  });

  it('cancels when context signal is aborted', async () => {
    const specialist = new CuratorSpecialist({ codeCommit: 'commit-54', now: () => FIXED_NOW });
    const controller = new AbortController();
    controller.abort();
    const result = await specialist.execute(
      {
        schemaVersion: '1.0.0',
        productSeed: {},
        resolvedFacts: sampleFactSet(),
        classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
      },
      { ...context, signal: controller.signal },
    );
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed');
    expect(result.failure?.code).toBe('cancelled');
  });

  it('exposes a registered capability and artifact schemas', () => {
    expect(CURATOR_SPECIALIST_CAPABILITY.name).toBe('curator');
    expect(CURATOR_SPECIALIST_CAPABILITY.kind).toBe('classification');
    expect(CURATOR_SPECIALIST_CAPABILITY.input.schemaName).toBe(CURATOR_INPUT_ARTIFACT_TYPE);
    expect(CURATOR_SPECIALIST_CAPABILITY.output.schemaName).toBe(CURATOR_OUTPUT_ARTIFACT_TYPE);
    const registry = registerCuratorSchemas(new SpecialistArtifactSchemaRegistry());
    expect(registry.has(CURATOR_INPUT_ARTIFACT_TYPE)).toBe(true);
    expect(registry.has(CURATOR_OUTPUT_ARTIFACT_TYPE)).toBe(true);
  });
});
