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
import { sha256Hex } from '../../../shared/stable-id';

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
        supportingEvidence: [
          {
            id: 'ev:size:1',
            sourceKind: 'manufacturer',
            candidateId: 'cand:acme',
            url: 'https://acme.example/products/chicken-broth-16oz',
            field: 'size',
            rawValue: '16 fl oz',
            contentHash: null,
            scope: null,
            method: 'json_ld',
            sourcePath: 'product.size',
          },
        ],
        contradictingEvidence: [],
        notes: null,
      },
      {
        field: 'packCount',
        status: 'resolved',
        value: '1',
        canonicalQuantity: { value: 1, unit: 'count', kind: 'count', rawValue: '1' },
        identifierScope: null,
        dimensionScope: null,
        confidence: 0.9,
        supportingEvidence: [
          {
            id: 'ev:pack:1',
            sourceKind: 'manufacturer',
            candidateId: 'cand:acme',
            url: 'https://acme.example/products/chicken-broth-16oz',
            field: 'packCount',
            rawValue: '1',
            contentHash: null,
            scope: null,
            method: 'json_ld',
            sourcePath: 'product.packCount',
          },
        ],
        contradictingEvidence: [],
        notes: null,
      },
      {
        field: 'dimensions',
        status: 'resolved',
        value: '3 x 3 x 7 in',
        canonicalQuantity: { value: 3, unit: 'in', kind: 'length', rawValue: '3 x 3 x 7 in' },
        identifierScope: null,
        dimensionScope: 'product',
        confidence: 0.8,
        supportingEvidence: [
          {
            id: 'ev:dim:1',
            sourceKind: 'manufacturer',
            candidateId: 'cand:acme',
            url: 'https://acme.example/products/chicken-broth-16oz',
            field: 'dimensions',
            rawValue: '3 x 3 x 7 in',
            contentHash: null,
            scope: null,
            method: 'json_ld',
            sourcePath: 'product.dimensions',
          },
        ],
        contradictingEvidence: [],
        notes: null,
      },
    ],
    fieldCompleteness: {
      total: 12,
      resolved: 6,
      conflicts: 0,
      needsMoreEvidence: 2,
      abstained: 4,
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
    description: '**ACME Organic Chicken Broth 16 fl oz**\n\n### Product Details\n- Brand: ACME\n- Net Weight: 16 fl oz\n- Size: 16 fl oz\n- Package Count: 1\n- Dimensions: 3 x 3 x 7 in',
    productTypeId: 'pt_broth',
    categoryIds: ['cat_canned_food'],
    attributes: {
      brand: 'ACME',
      weight: '16 fl oz',
      size: '16 fl oz',
      packCount: '1',
      dimensions: '3 x 3 x 7 in',
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
      {
        field: 'size',
        claim: 'Product size: 16 fl oz',
        supportingFactFields: ['size'],
        evidenceIds: ['ev:size:1'],
      },
      {
        field: 'packCount',
        claim: 'Pack count: 1',
        supportingFactFields: ['packCount'],
        evidenceIds: ['ev:pack:1'],
      },
      {
        field: 'dimensions',
        claim: 'Dimensions: 3 x 3 x 7 in',
        supportingFactFields: ['dimensions'],
        evidenceIds: ['ev:dim:1'],
      },
      {
        field: 'catalogTitle',
        claim: 'Synthesized catalog title: ACME Organic Chicken Broth 16 fl oz',
        supportingFactFields: ['brand', 'title', 'weight'],
        evidenceIds: ['ev:brand:1', 'ev:title:1', 'ev:weight:1'],
      },
      {
        field: 'description',
        claim: 'Structured product description bullets',
        supportingFactFields: ['brand', 'title', 'weight', 'size', 'packCount', 'dimensions'],
        evidenceIds: ['ev:brand:1', 'ev:title:1', 'ev:weight:1', 'ev:size:1', 'ev:pack:1', 'ev:dim:1'],
      },
      {
        field: 'subtitle',
        claim: 'Product subtitle: ACME - 16 fl oz',
        supportingFactFields: ['brand', 'weight'],
        evidenceIds: ['ev:brand:1', 'ev:weight:1'],
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
    expect(report.identityDecision).toBe('pass');
    expect(report.productDataDecision).toBe('pass');
    expect(report.identityScore).toBe(1.0);
    expect(report.productDataScore).toBe(1.0);
    expect(report.blockingIssuesCount).toBe(0);
    expect(report.retryRequest).toBeNull();
    expect(report.score).toBe(1.0);
  });

  it('catches 14-digit case GTIN promoted as consumer unit GTIN and triggers retry_discovery', () => {
    const draft = sampleDraft({
      gtin: '10012345678908', // 14-digit case barcode
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet({ expectedIdentity: { gtin: '012345678901', gtinScope: 'consumer_unit' } }),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.checks.some((c) => c.checkName === 'case_gtin_assigned_to_consumer_unit' && !c.passed)).toBe(true);
    expect(report.identityDecision).toBe('fail');
  });

  it('catches 14-digit GTIN on draft even when expectedIdentity is explicitly case-scoped', () => {
    const draft = sampleDraft({
      gtin: '10012345678908', // Corrupted draft containing case GTIN in consumer gtin field
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet({ expectedIdentity: { gtin: '10012345678908', gtinScope: 'case' } }),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.checks.some((c) => c.checkName === 'case_gtin_assigned_to_consumer_unit' && !c.passed)).toBe(true);
    expect(report.identityDecision).toBe('fail');
  });

  it('catches unapproved image or unknown rights status with fail-closed QA', () => {
    const sampleBundle = (imageUrl: string) => ({
      schemaVersion: 1 as const,
      runnerVersion: '1.0.0',
      requestedUrl: 'https://acme.example/products/broth',
      finalUrl: 'https://acme.example/products/broth',
      retrievedAt: FIXED_NOW,
      contentHash: sha256Hex(imageUrl),
      artifactRefs: ['art-1'],
      profile: null,
      extractionPath: [],
      observations: [],
      images: [
        {
          url: imageUrl,
          variantRef: null,
          sourcePath: 'img.primary',
          method: 'selector',
          artifactId: 'art-1',
          contentHash: sha256Hex(imageUrl),
        },
      ],
      variant: null,
      identityStatus: 'exact_match' as const,
      identityReasons: [],
      failures: [],
      deterministicOnly: true as const,
    });

    const draftUnknownRights = sampleDraft({
      images: [
        {
          url: 'https://acme.example/images/unapproved.jpg',
          role: 'primary',
          rightsStatus: 'unknown',
          commerceApproved: true,
          identityMatch: 'exact',
          sourceUrl: null,
        },
      ],
    });

    const reportUnknown = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draftUnknownRights,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
      extractionBundles: [sampleBundle('https://acme.example/images/unapproved.jpg')],
    });

    expect(reportUnknown.verdict).toBe('retry_curator');
    expect(reportUnknown.checks.some((c) => c.checkName === 'image_rights_compliance' && !c.passed)).toBe(true);

    const draftUnverifiedIdentity = sampleDraft({
      images: [
        {
          url: 'https://acme.example/images/test.jpg',
          role: 'primary',
          rightsStatus: 'approved',
          commerceApproved: true,
          identityMatch: 'unverified',
          sourceUrl: null,
        },
      ],
    });

    const reportUnverified = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draftUnverifiedIdentity,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
      extractionBundles: [sampleBundle('https://acme.example/images/test.jpg')],
    });

    expect(reportUnverified.verdict).toBe('retry_curator');
    expect(reportUnverified.checks.some((c) => c.checkName === 'image_variant_compliance' && !c.passed)).toBe(true);

    const draftSecondaryUnapproved = sampleDraft({
      images: [
        {
          url: 'https://acme.example/images/primary.jpg',
          role: 'primary',
          rightsStatus: 'approved',
          commerceApproved: true,
          identityMatch: 'exact',
          sourceUrl: null,
        },
        {
          url: 'https://acme.example/images/secondary.jpg',
          role: 'gallery',
          rightsStatus: 'approved',
          commerceApproved: false, // Secondary image not commerce approved
          identityMatch: 'exact',
          sourceUrl: null,
        },
      ],
    });

    const secondaryBundle = {
      ...sampleBundle('https://acme.example/images/primary.jpg'),
      images: [
        {
          url: 'https://acme.example/images/primary.jpg',
          variantRef: null,
          sourcePath: 'img.primary',
          method: 'selector',
          artifactId: 'art-1',
          contentHash: sha256Hex('primary'),
        },
        {
          url: 'https://acme.example/images/secondary.jpg',
          variantRef: null,
          sourcePath: 'img.secondary',
          method: 'selector',
          artifactId: 'art-1',
          contentHash: sha256Hex('secondary'),
        },
      ],
    };

    const reportSecondary = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draftSecondaryUnapproved,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
      extractionBundles: [secondaryBundle],
    });

    expect(reportSecondary.verdict).toBe('retry_curator');
    expect(reportSecondary.checks.some((c) => c.checkName === 'image_commerce_approval' && !c.passed)).toBe(true);
  });

  it('catches wrong-flavor catalog title (e.g. Beef Broth instead of Chicken Broth) and triggers retry_curator', () => {
    const draft = sampleDraft({
      catalogTitle: 'ACME Organic Beef Broth 16 fl oz', // Contradictory flavor token "Beef" vs resolved "Chicken"
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'catalog_title_variant_alignment' && !c.passed)).toBe(true);
    expect(report.retryRequest?.conflictingFields).toContain('catalogTitle');
  });

  it('catches image missing from extraction bundles provenance', () => {
    const draft = sampleDraft({
      images: [
        {
          url: 'https://unverified.example/fabricated.jpg',
          role: 'primary',
          rightsStatus: 'approved',
          commerceApproved: true,
          identityMatch: 'exact',
          sourceUrl: null,
        },
      ],
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
      extractionBundles: [
        {
          schemaVersion: 1,
          runnerVersion: '1.0.0',
          requestedUrl: 'https://acme.example/products/broth',
          finalUrl: 'https://acme.example/products/broth',
          retrievedAt: FIXED_NOW,
          contentHash: sha256Hex('hash-1'),
          artifactRefs: [],
          profile: null,
          extractionPath: [],
          observations: [],
          images: [
            {
              url: 'https://acme.example/images/real.jpg',
              variantRef: null,
              sourcePath: 'img.real',
              method: 'selector',
              artifactId: 'art-real',
              contentHash: sha256Hex('real-img'),
            },
          ],
          variant: null,
          identityStatus: 'exact_match',
          identityReasons: [],
          failures: [],
          deterministicOnly: true as const,
        },
      ],
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'image_evidence_provenance' && !c.passed)).toBe(true);
  });

  it('fails closed when draft contains images but extractionBundles is empty', () => {
    const draft = sampleDraft({
      images: [
        {
          url: 'https://acme.example/images/unproven.jpg',
          role: 'primary',
          rightsStatus: 'approved',
          commerceApproved: true,
          identityMatch: 'exact',
          sourceUrl: null,
        },
      ],
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
      extractionBundles: [], // Empty extraction evidence
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'image_evidence_provenance' && !c.passed)).toBe(true);
  });

  it('catches fail-closed arbitrary non-bullet free prose and triggers retry_curator', () => {
    const draft = sampleDraft({
      description: '**ACME Organic Chicken Broth 16 fl oz**\n\nSupports healthy digestion and promotes vibrant energy.\n\n### Product Details\n- Brand: ACME\n- Net Weight: 16 fl oz',
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'unsupported_description_claim' && !c.passed)).toBe(true);
  });

  it('catches invented synthetic fact in supportingFactFields and triggers retry_curator', () => {
    const draft = sampleDraft({
      grounding: [
        {
          field: 'brand',
          claim: 'Brand name: ACME',
          supportingFactFields: ['inventedFactField'],
          evidenceIds: ['resolved_fact:inventedFactField'],
        },
      ],
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'grounding_unresolved_fact_reference' && !c.passed)).toBe(true);
  });

  it('catches subtitle quantity mismatch and triggers retry_curator', () => {
    const draft = sampleDraft({
      subtitle: 'ACME - 50 lb',
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'subtitle_quantity_mismatch' && !c.passed)).toBe(true);
  });

  it('catches catalog title weight mismatch and triggers retry_curator', () => {
    const draft = sampleDraft({
      catalogTitle: 'ACME Organic Chicken Broth 64 fl oz',
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'catalog_title_weight_alignment' && !c.passed)).toBe(true);
  });

  it('rejects draft with deleted grounding (grounding: []) and triggers retry_curator', () => {
    const draft = sampleDraft({
      grounding: [],
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'missing_attribute_grounding' && !c.passed)).toBe(true);
    expect(report.checks.some((c) => c.checkName === 'missing_title_grounding' && !c.passed)).toBe(true);
    expect(report.checks.some((c) => c.checkName === 'missing_description_grounding' && !c.passed)).toBe(true);
  });

  it('catches wrong attribute value and triggers retry_curator', () => {
    const draft = sampleDraft({
      attributes: {
        brand: 'ACME',
        weight: '50 lb',
        size: '16 fl oz',
        packCount: '1',
        dimensions: '3 x 3 x 7 in',
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
    expect(report.checks.some((c) => c.checkName === 'attribute_value_fidelity' && !c.passed)).toBe(true);
    expect(report.retryRequest?.conflictingFields).toContain('weight');
  });

  it('catches arbitrary unsupported description claims and triggers retry_curator', () => {
    const draft = sampleDraft({
      description: '**ACME Broth**\n\n### Product Details\n- Brand: ACME\n- Net Weight: 16 fl oz\n- Flavor: Savory Turkey',
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'unsupported_description_claim' && !c.passed)).toBe(true);
  });

  it('catches catalog title missing resolved brand and triggers retry_curator', () => {
    const draft = sampleDraft({
      catalogTitle: 'Organic Chicken Broth 16 fl oz',
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'catalog_title_brand_alignment' && !c.passed)).toBe(true);
  });

  it('catches cross-fact evidence misassociation and triggers retry_curator', () => {
    const draft = sampleDraft({
      grounding: [
        {
          field: 'brand',
          claim: 'Brand name: ACME',
          supportingFactFields: ['brand'],
          evidenceIds: ['ev:weight:1'],
        },
      ],
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'grounding_evidence_misassociation' && !c.passed)).toBe(true);
  });

  it('catches synthetic fact reference misassociation and triggers retry_curator', () => {
    const draft = sampleDraft({
      grounding: [
        {
          field: 'brand',
          claim: 'Brand name: ACME',
          supportingFactFields: ['brand'],
          evidenceIds: ['resolved_fact:weight'],
        },
      ],
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'grounding_evidence_misassociation' && !c.passed)).toBe(true);
  });

  it('catches draft brand mismatching resolved brand fact and triggers retry_curator', () => {
    const draft = sampleDraft({
      brand: 'WrongBrand',
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_curator');
    expect(report.checks.some((c) => c.checkName === 'brand_fidelity' && !c.passed)).toBe(true);
  });

  it('catches structured bullet description mismatches and triggers retry_curator', () => {
    const draftBrand = sampleDraft({
      description: '**ACME Organic Chicken Broth 16 fl oz**\n\n### Product Details\n- Brand: CompetitorBrand\n- Net Weight: 16 fl oz\n- Size: 16 fl oz\n- Package Count: 1\n- Dimensions: 3 x 3 x 7 in',
    });
    const reportBrand = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draftBrand,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });
    expect(reportBrand.verdict).toBe('retry_curator');
    expect(reportBrand.checks.some((c) => c.checkName === 'description_claim_mismatch' && !c.passed)).toBe(true);
  });

  it('catches draft GTIN mismatching resolved identity GTIN and triggers retry_discovery', () => {
    const draft = sampleDraft({
      gtin: '999999999999',
    });

    const report = verifyCuratedDraft({
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-55', name: 'ACME Broth', price: '9.99' },
      resolvedFacts: sampleFactSet(),
      curatedDraft: draft,
      classificationContext: { availableProductTypes: [], availableCategories: [], attributeProfiles: [] },
    });

    expect(report.verdict).toBe('retry_discovery');
    expect(report.checks.some((c) => c.checkName === 'identity_gtin_fidelity' && !c.passed)).toBe(true);
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
        size: '16 fl oz',
        packCount: '1',
        dimensions: '3 x 3 x 7 in',
        flavor: 'Savory Turkey',
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
        weight: '16 fl oz',
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
