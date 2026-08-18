/**
 * Unit tests for Verifier specialist (#55, epic #47, ADR 0027).
 */

import { describe, it, expect } from 'vitest';
import {
  VerifierSpecialist,
  verifyCuratedDraft,
  VERIFIER_SPECIALIST_CAPABILITY,
  VERIFIER_INPUT_ARTIFACT_TYPE,
  VERIFIER_OUTPUT_ARTIFACT_TYPE,
  registerVerifierSchemas,
  type VerifierSpecialistInput,
} from '../../../product-intelligence/specialists/verifier';
import {
  SpecialistArtifactSchemaRegistry,
  type SpecialistArtifactEnvelope,
} from '../../../product-intelligence/specialists/artifacts';
import {
  validateSpecialistResult,
  type SpecialistContext,
} from '../../../product-intelligence/specialists/contracts';
import { ProductIntelligencePolicySchema } from '../../../product-intelligence/contracts';
import type { ResolvedFactSet } from '../../../product-intelligence/specialists/resolver';
import type { CuratedProductDraft } from '../../../product-intelligence/specialists/curator';

const FIXED_NOW = '2026-08-18T12:00:00.000Z';

function sampleFactSet(overrides: Partial<ResolvedFactSet> = {}): ResolvedFactSet {
  return {
    schemaVersion: '1.0.0',
    specialist: 'resolver',
    specialistVersion: '1.0.0',
    productSeed: { sku: 'SUP-55', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
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
          reasons: ['exact match'],
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
    ],
    fieldCompleteness: {
      total: 12,
      resolved: 2,
      conflicts: 0,
      needsMoreEvidence: 2,
      abstained: 8,
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

function sampleDraft(overrides: Partial<CuratedProductDraft> = {}): CuratedProductDraft {
  return {
    schemaVersion: '1.0.0',
    specialist: 'curator',
    specialistVersion: '1.0.0',
    productSeed: { sku: 'SUP-55', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
    catalogTitle: 'ACME Organic Chicken Broth 16 fl oz',
    sourceTitle: 'ACME Organic Chicken Broth 16 oz',
    resolvedIdentityName: 'Organic Chicken Broth',
    brand: 'ACME',
    gtin: '012345678901',
    upc: '012345678901',
    subtitle: 'ACME - 16 fl oz',
    description: '**ACME Organic Chicken Broth 16 fl oz**\n\n### Product Details\n- Brand: ACME\n- Net Weight: 16 fl oz',
    productTypeId: 'pt_broth',
    categoryIds: ['cat_canned_food'],
    attributes: {
      brand: 'ACME',
      weight: '16 fl oz',
    },
    images: [],
    grounding: [
      {
        field: 'brand',
        claim: 'Brand name: ACME',
        supportingFactFields: ['brand'],
        evidenceIds: ['ev:brand:1'],
      },
      {
        field: 'weight',
        claim: 'Product weight: 16 fl oz',
        supportingFactFields: ['weight'],
        evidenceIds: ['ev:weight:1'],
      },
    ],
    abstentions: [],
    curatedAt: FIXED_NOW,
    ...overrides,
  };
}

const context: SpecialistContext = {
  runId: 'run-55',
  workspaceId: 'ws-55',
  workspacePath: '/tmp/ws-55',
  seq: 1,
  policy: ProductIntelligencePolicySchema.parse({
    configId: 'test-policy-config',
    modelRoute: { provider: 'test', model: 'test', thinkingLevel: 'off' },
  }),
};

describe('Verifier specialist (#55)', () => {
  it('returns verdict pass with high score on valid grounded draft', () => {
    const input: VerifierSpecialistInput = {
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: sampleDraft(),
      classificationContext: {
        availableProductTypes: [{ id: 'pt_broth', name: 'Broth & Stock' }],
        availableCategories: [{ id: 'cat_canned_food', name: 'Wet Food & Broths' }],
        attributeProfiles: [],
      },
    };

    const report = verifyCuratedDraft(input, { now: () => FIXED_NOW });
    expect(report.verdict).toBe('pass');
    expect(report.identityStatus).toBe('verified');
    expect(report.blockingIssuesCount).toBe(0);
    expect(report.retryRequest).toBeNull();
    expect(report.score).toBe(1.0);
  });

  it('triggers retry_discovery when identity status is conflict or unresolved', () => {
    const factSet = sampleFactSet({
      identity: {
        status: 'conflict',
        confidence: 0.1,
        candidateId: null,
        candidateUrl: null,
        gtin: null,
        upc: null,
        decisions: [
          {
            candidateId: 'cand:mismatch',
            url: 'https://example.com/other',
            sourceKind: 'retailer',
            decision: 'conflict',
            gtin: '999999999999',
            reasons: ['mismatched GTIN'],
          },
        ],
        nextEvidence: 'exact_gtin_match',
      },
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: factSet,
      curatedDraft: sampleDraft(),
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_discovery');
    expect(report.identityStatus).toBe('mismatched');
    expect(report.retryRequest?.targetSpecialist).toBe('discovery');
    expect(report.blockingIssuesCount).toBeGreaterThanOrEqual(1);
  });

  it('triggers retry_curator when draft contains ungrounded claims', () => {
    const draft = sampleDraft({
      attributes: {
        brand: 'ACME',
        weight: '16 fl oz',
        flavor: 'Savory Turkey', // Not in resolvedFacts
      },
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.retryRequest?.targetSpecialist).toBe('curator');
    expect(report.retryRequest?.conflictingFields).toContain('flavor');
  });

  it('triggers retry_curator when draft promotes an unresolved conflicting fact', () => {
    const factSet = sampleFactSet({
      facts: [
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
          notes: 'sources disagree',
        },
      ],
    });

    const draft = sampleDraft({
      attributes: {
        weight: '16 fl oz', // promoted despite conflict
      },
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: factSet,
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'conflict_omission' && !c.passed)).toBe(true);
  });

  it('flags blocking issue when taxonomy IDs do not exist in active configuration', () => {
    const draft = sampleDraft({
      productTypeId: 'pt_hallucinated_id',
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: {
        availableProductTypes: [{ id: 'pt_broth', name: 'Broth & Stock' }],
        availableCategories: [],
        attributeProfiles: [],
      },
    });

    expect(report.checks.some((c) => c.checkName === 'taxonomy_bounds' && !c.passed)).toBe(true);
    expect(report.blockingIssuesCount).toBeGreaterThanOrEqual(1);
  });

  it('emits a typed artifact through the specialist boundary without writing catalog state', async () => {
    const specialist = new VerifierSpecialist({ codeCommit: 'commit-55', now: () => FIXED_NOW });

    const rawInput: VerifierSpecialistInput = {
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Organic Chicken Broth 16 oz', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: sampleDraft(),
      classificationContext: {
        availableProductTypes: [{ id: 'pt_broth', name: 'Broth & Stock' }],
        availableCategories: [{ id: 'cat_canned_food', name: 'Wet Food & Broths' }],
        attributeProfiles: [],
      },
    };

    const result = await specialist.execute(rawInput, context);
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error('expected succeeded outcome');

    const output = result.output as SpecialistArtifactEnvelope;
    expect(output.artifactType).toBe(VERIFIER_OUTPUT_ARTIFACT_TYPE);
    expect(output.schemaVersion).toBe('1.0.0');
    expect(output.provenance.specialist).toBe('verifier');
    expect(output.provenance.codeCommit).toBe('commit-55');
    expect(output.contentHash).toBeDefined();

    const registry = registerVerifierSchemas(new SpecialistArtifactSchemaRegistry());
    const validation = validateSpecialistResult({
      result,
      capability: VERIFIER_SPECIALIST_CAPABILITY,
      artifactSchemas: registry,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('fails closed on invalid input schema', async () => {
    const specialist = new VerifierSpecialist({ codeCommit: 'commit-55', now: () => FIXED_NOW });
    const result = await specialist.execute({ invalid: true }, context);
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed outcome');
    expect(result.failure?.code).toBe('invalid_input');
  });

  it('cancels when context signal is aborted', async () => {
    const specialist = new VerifierSpecialist({ codeCommit: 'commit-55', now: () => FIXED_NOW });
    const controller = new AbortController();
    controller.abort();

    const result = await specialist.execute(
      {
        schemaVersion: '1.0.0',
        productSeed: {},
        resolvedFacts: sampleFactSet(),
        curatedDraft: sampleDraft(),
        classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
      },
      { ...context, signal: controller.signal },
    );
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed outcome');
    expect(result.failure?.code).toBe('cancelled');
  });

  it('exposes a registered capability and artifact schemas', () => {
    expect(VERIFIER_SPECIALIST_CAPABILITY.name).toBe('verifier');
    expect(VERIFIER_SPECIALIST_CAPABILITY.kind).toBe('classification');
    expect(VERIFIER_SPECIALIST_CAPABILITY.input.schemaName).toBe(VERIFIER_INPUT_ARTIFACT_TYPE);
    expect(VERIFIER_SPECIALIST_CAPABILITY.output.schemaName).toBe(VERIFIER_OUTPUT_ARTIFACT_TYPE);
    const registry = registerVerifierSchemas(new SpecialistArtifactSchemaRegistry());
    expect(registry.has(VERIFIER_INPUT_ARTIFACT_TYPE)).toBe(true);
    expect(registry.has(VERIFIER_OUTPUT_ARTIFACT_TYPE)).toBe(true);
  });
});
