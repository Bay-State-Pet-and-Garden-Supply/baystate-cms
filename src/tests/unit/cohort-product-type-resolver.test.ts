import { describe, it, expect } from 'bun:test';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  evidenceFromProjection,
  matchMemberDeterministically,
  resolveCohortProductType,
  validateCohortFamilyInvariants,
  KEYWORD_MATCH_MIN_CONFIDENCE,
} from '../../classification/cohort-product-type-resolver';
import type { CohortMemberInput, PerMemberProductTypeResult } from '../../classification/cohort-product-type-resolver';
import type {
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionV1,
} from '../../shared/schemas/cohorts';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import type { BrandConfig } from '../../shared/schemas/classification';

// ─── Fixtures (pure — no DB) ──────────────────────────────────────────────────

const TYPE_PRODUCT_TYPES = [
  { id: 'dry-dog-food', name: 'Dry Dog Food' },
  { id: 'dry-cat-food', name: 'Dry Cat Food' },
];

const PRODUCT_TYPE_TARGET = {
  id: 'test-product-type',
  kind: 'product_type' as const,
  label: 'Test Product Type',
  enabled: true,
  selectionMode: 'single' as const,
  attributeId: null,
  catalogField: null,
  optionSource: 'configured' as const,
  required: false,
  mandatory: false,
  sortOrder: 0,
};

/**
 * Minimal immutable runtime snapshot fixture carrying the fields the pure
 * `resolveTargetsFromSnapshot` path reads (config curationTargets,
 * snapshot.curationTargets, productTypes). Cast: the snapshot type has many
 * unrelated required fields this pure test never touches.
 */
function makeSnapshot(
  productTypes: Array<{ id: string; name: string }>,
  curationTargets: unknown[] = [PRODUCT_TYPE_TARGET],
): RuntimeClassificationSnapshot {
  const config = {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: '', updatedAt: '', fileVersions: {} },
    productTypes,
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    curationTargets,
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
  return {
    schemaVersion: 1,
    snapshotHash: 's'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceId: 'ws-test',
    workspacePath: '/tmp/ws-test',
    productSku: 'SKU-1',
    configAuthorityKind: 'v1',
    sourceCatalogCommit: null,
    config,
    configSnapshotRef: { id: 'cfg', hash: 's'.repeat(64), sourceCommit: null, createdAt: '2026-01-01T00:00:00.000Z' },
    focusedFileHashes: {},
    catalogEvidenceHash: null,
    productTypes,
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    guidance: [],
    brands: [],
    modelPolicy: config.modelPolicy,
    dataSharing: config.dataSharing,
    curationTargets,
    fieldOptions: {},
    reviewedFacts: [],
    pages: { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
    sourceProductHash: null,
    searchKeywords: null,
    productPageNames: [],
    pageImportId: null,
    pageImportHash: null,
    pageContextReliability: 'low',
  } as unknown as RuntimeClassificationSnapshot;
}

/** Frozen `execution-evidence-v1` member with the frozen evidence-stage inputs. */
function makeMemberProjection(opts: {
  itemId?: string;
  sku?: string | null;
  name?: string;
  expectedName?: string | null;
  brand?: string | null;
} = {}): ExecutionEvidenceProjectionMemberV1 {
  const name = opts.name ?? 'Purina Pro Plan Dry Dog Food Chicken 5 lb';
  const brand = opts.brand ?? 'Purina';
  const itemId = opts.itemId ?? 'item-1';
  const sku = opts.sku ?? itemId;
  return {
    onboardingItemId: itemId,
    ordinal: 1,
    productSku: sku,
    extractionComplete: true,
    sourceUrl: 'https://brand.example.com/p1',
    extractionSourceUrl: 'https://brand.example.com/p1',
    sourcingDecision: null,
    spreadsheetIdentity: {
      name,
      expectedName: opts.expectedName ?? null,
      brandHint: brand,
      departmentHint: null,
      price: null,
      quantity: null,
      rowNumber: 1,
      upc: sku ?? '',
    },
    extraction: {
      title: name,
      description: 'Complete and balanced nutrition for adult dogs.',
      brand,
      weight: '5 lb',
      bulletPoints: ['First ingredient chicken', 'Made in the USA'],
      searchKeywords: 'kibble dog food',
      primaryImage: 'https://img.example.com/p1.jpg',
      additionalImages: ['https://img.example.com/p1a.jpg'],
      customFields: { Flavor: 'Chicken' },
      fieldProvenance: { title: 'json-ld' },
      packagingTitle: null,
      ocr: {
        outcome: null,
        packagingOcrData: null,
        ocrInputHash: '0'.repeat(64),
        ocrExecutionDigest: null,
      },
      piEvidence: [],
      piImportComplete: true,
    },
    evidenceHash: 'e'.repeat(64),
  };
}

/** Recompute the ocrInputHash for the member's own frozen input set and attach settled OCR. */
function withSettledOcr(
  member: ExecutionEvidenceProjectionMemberV1,
  ocrData: Record<string, unknown>,
  opts: { ocrExecutionDigest?: string | null } = {},
): ExecutionEvidenceProjectionMemberV1 {
  const ocrInputHash = hashCanonicalJson({
    sourceUrl: member.sourceUrl,
    extractionSourceUrl: member.extractionSourceUrl,
    primaryImage: member.extraction.primaryImage,
    additionalImages: member.extraction.additionalImages,
  });
  return {
    ...member,
    extraction: {
      ...member.extraction,
      ocr: {
        outcome: { status: 'succeeded', localStatus: 'succeeded', model: 'test-vlm', imageCount: 1 },
        packagingOcrData: ocrData as never,
        ocrInputHash,
        ocrExecutionDigest: opts.ocrExecutionDigest === undefined ? 'd'.repeat(64) : opts.ocrExecutionDigest,
      },
    },
  };
}

function makeProjection(members: ExecutionEvidenceProjectionMemberV1[]): ExecutionEvidenceProjectionV1 {
  return {
    version: 'execution-evidence-v1',
    cohortId: 'cohort-1',
    batchId: 'batch-1',
    groupingVersion: 'product-family-v1',
    members,
  };
}

function memberInput(
  projection: ExecutionEvidenceProjectionMemberV1,
  productTypes: Array<{ id: string; name: string }>,
  curationTargets?: unknown[],
): CohortMemberInput {
  return { projection, memberSnapshot: makeSnapshot(productTypes, curationTargets) };
}

function coherentResults(typeIds: string[]): PerMemberProductTypeResult[] {
  return typeIds.map((typeId, index) => ({
    onboardingItemId: `item-${index + 1}`,
    productSku: `SKU-${index + 1}`,
    productTypeId: typeId,
    confidence: 0.8,
    source: 'keyword' as const,
    isAbstention: false,
    supportingEvidenceIds: [`ev-${index + 1}`],
    contradictingEvidenceIds: [],
  }));
}

// ─── C3a: evidenceFromProjection ──────────────────────────────────────────────

describe('evidenceFromProjection', () => {
  it('maps spreadsheet + extraction + OCR fields into evidence records with no DB/model side effects', () => {
    const base = makeMemberProjection({ itemId: 'item-shape', sku: 'SKU-SHAPE' });
    base.spreadsheetIdentity.expectedName = 'Purina Dry Dog Food (Expected)';
    const member = withSettledOcr(base, {
      productName: 'Package Dog Food',
      brand: 'Acme',
      species: ['dog'],
      flavorVariety: 'Chicken',
      weight: '5 lb',
      ingredientKeywords: ['kibble'],
      visibleTextLines: ['Line one', 'Line two', ''],
      confidenceByField: { productName: 0.95, weight: 0.5 },
      metadata: { modelCallIds: ['call-1'] },
    });

    const evidence = evidenceFromProjection(member);

    // Spreadsheet identity records.
    expect(evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'name' && e.value === 'Purina Pro Plan Dry Dog Food Chicken 5 lb')).toBe(true);
    expect(evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'expected_name' && e.value === 'Purina Dry Dog Food (Expected)')).toBe(true);
    expect(evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'brand' && e.value === 'Purina')).toBe(true);

    // Normalized extraction records (official product page).
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'name' && e.value === 'Purina Pro Plan Dry Dog Food Chicken 5 lb')).toBe(true);
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'brand' && e.value === 'Purina')).toBe(true);
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'weight' && e.value === '5 lb')).toBe(true);
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'description' && String(e.value).includes('balanced'))).toBe(true);
    expect(evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'bullet_point' && e.value === 'First ingredient chicken')).toBe(true);
    const keywordRecord = evidence.find(e => e.sourceField === 'search_keywords');
    expect(keywordRecord).toBeTruthy();
    expect(keywordRecord!.source).toBe('official_product_page');
    expect(keywordRecord!.reliability).toBe('low');
    expect(evidence.some(e => e.sourceField === 'Flavor' && e.value === 'Chicken' && e.source === 'official_product_page')).toBe(true);

    // Frozen packaging OCR records (mirrored packagingOcrDataToEvidence mapping).
    const ocrRecords = evidence.filter(e => e.metadata && (e.metadata as Record<string, unknown>).provenance === 'packaging_ocr');
    expect(ocrRecords.length).toBeGreaterThan(0);
    const nameRec = ocrRecords.find(e => e.sourceField === 'name');
    expect(nameRec).toBeTruthy();
    expect(nameRec!.source).toBe('visual_product_evidence');
    expect(nameRec!.value).toBe('Package Dog Food');
    expect(nameRec!.reliability).toBe('high'); // confidenceByField.productName 0.95
    expect(ocrRecords.find(e => e.sourceField === 'brand')!.value).toBe('Acme');
    const flavorRec = ocrRecords.find(e => e.sourceField === 'flavor');
    expect(flavorRec!.attributeId).toBe('flavor');
    expect(flavorRec!.value).toBe('Chicken');
    expect(ocrRecords.find(e => e.sourceField === 'weight')!.reliability).toBe('medium'); // confidence 0.5
    expect(ocrRecords.find(e => e.sourceField === 'ingredientKeyword')!.reliability).toBe('low');
    expect(ocrRecords.filter(e => e.sourceField === 'visible_text')).toHaveLength(2); // blank line skipped
    for (const rec of ocrRecords) {
      const metadata = rec.metadata as Record<string, unknown>;
      expect(metadata.modelCallIds).toEqual(['call-1']);
      expect(metadata.model).toBe('test-vlm');
    }

    // Record envelope: every record carries id/runId/stageName/productSku/capturedAt.
    for (const rec of evidence) {
      expect(rec.id.length).toBeGreaterThan(0);
      expect(rec.runId).toBe('');
      expect(rec.productSku).toBe('SKU-SHAPE');
      expect(rec.stageName).toBe('evidence_extraction');
      expect(rec.capturedAt.length).toBeGreaterThan(0);
    }

    // runId/productSku overrides stamp the produced records.
    const stamped = evidenceFromProjection(member, { runId: 'run-1', productSku: 'SKU-X' });
    expect(stamped.every(e => e.runId === 'run-1' && e.productSku === 'SKU-X')).toBe(true);
  });

  it('fails closed: OCR is never materialized on input-hash mismatch or a missing execution digest', () => {
    const member = withSettledOcr(makeMemberProjection(), { productName: 'Package Dog Food' });

    // primaryImage changed AFTER the input hash was computed — the stored OCR
    // belongs to different inputs and is never materialized.
    const tampered = {
      ...member,
      extraction: { ...member.extraction, primaryImage: 'https://img.example.com/changed.jpg' },
    };
    const tamperedEvidence = evidenceFromProjection(tampered);
    expect(tamperedEvidence.some(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr')).toBe(false);

    // Pre-hardening projection without an execution-authority digest
    // (ocrExecutionDigest null) is never materialized (fail-closed mirror).
    const unbound = withSettledOcr(makeMemberProjection(), { productName: 'Package Dog Food' }, { ocrExecutionDigest: null });
    const unboundEvidence = evidenceFromProjection(unbound);
    expect(unboundEvidence.some(e => (e.metadata as Record<string, unknown> | null)?.provenance === 'packaging_ocr')).toBe(false);
  });
});

// ─── C3a: matchMemberDeterministically ───────────────────────────────────────

describe('matchMemberDeterministically', () => {
  it('keyword hit: full token overlap returns the matched id with confidence >= floor', () => {
    const evidence = evidenceFromProjection(makeMemberProjection({ name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }));
    const result = matchMemberDeterministically(evidence, [
      { value: 'dry-dog-food', label: 'Dry Dog Food' },
      { value: 'dry-cat-food', label: 'Dry Cat Food' },
    ]);
    expect(result).toEqual({ productTypeId: 'dry-dog-food', confidence: 0.8, source: 'keyword' });
  });

  it('keyword miss: no token overlap returns a null result (no confident match)', () => {
    const evidence = evidenceFromProjection(makeMemberProjection({ name: 'Generic Pet Product 25 lb' }));
    const result = matchMemberDeterministically(evidence, [
      { value: 'dry-dog-food', label: 'Dry Dog Food' },
      { value: 'dry-cat-food', label: 'Dry Cat Food' },
    ]);
    expect(result).toEqual({ productTypeId: null, confidence: null, source: null });
  });

  it('confidence-floor boundary: partial token overlap below KEYWORD_MATCH_MIN_CONFIDENCE returns no match', () => {
    expect(KEYWORD_MATCH_MIN_CONFIDENCE).toBe(0.7);
    // 2/3 label tokens (dry, dog) — score 0.667 -> confidence ~0.683 < 0.7.
    const partial = evidenceFromProjection(makeMemberProjection({ name: 'Purina Dry Dog Biscuit' }));
    const partialResult = matchMemberDeterministically(partial, [{ value: 'dry-dog-food', label: 'Dry Dog Food' }]);
    expect(partialResult).toEqual({ productTypeId: null, confidence: null, source: null });

    // 3/4 label tokens — score 0.75 -> confidence ~0.7125 >= 0.7.
    const fullEnough = evidenceFromProjection(makeMemberProjection({ name: 'Purina Dry Dog Food' }));
    const fullEnoughResult = matchMemberDeterministically(fullEnough, [{ value: 'dry-dog-food', label: 'Dry Dog Food Kibble' }]);
    expect(fullEnoughResult.productTypeId).toBe('dry-dog-food');
    expect(fullEnoughResult.source).toBe('keyword');
    expect(fullEnoughResult.confidence).toBeCloseTo(0.7125, 4);
  });

  it('empty options -> null result (member abstains)', () => {
    const evidence = evidenceFromProjection(makeMemberProjection());
    expect(matchMemberDeterministically(evidence, [])).toEqual({ productTypeId: null, confidence: null, source: null });
  });
});

// ─── C3b: resolveCohortProductType ───────────────────────────────────────────

describe('resolveCohortProductType', () => {
  it('coherent: all confident members agree on one id with min(confidences)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food Kibble 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Dry Dog Food 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
    // Member A: 4/4 tokens -> 0.8; Member B: 3/4 tokens -> 0.7125.
    expect(resolution.confidence).toBeCloseTo(0.7125, 4);
    expect(resolution.memberSupport).toEqual({ confidentCount: 2, memberCount: 2 });
    expect(resolution.contradictingEvidenceIds).toEqual([]);
    expect(resolution.supportingEvidenceIds.length).toBeGreaterThan(0);
    expect(resolution.perMember).toHaveLength(2);
    expect(resolution.perMember.every(m => !m.isAbstention && m.productTypeId === 'dry-dog-food')).toBe(true);
  });

  it('conflicted: >=2 confident distinct ids — never picks an id', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Pro Plan Dry Dog Food 5 lb' }), TYPE_PRODUCT_TYPES),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Pro Plan Dry Cat Food 5 lb' }), TYPE_PRODUCT_TYPES),
      ],
    });
    expect(resolution.outcome).toBe('conflicted');
    if (resolution.outcome !== 'conflicted') return;
    expect(resolution.productTypeId).toBeNull();
    expect(resolution.confidence).toBeNull();
    expect(resolution.memberSupport).toEqual({ confidentCount: 2, memberCount: 2 });
    // Each side's evidence contradicts the other's — the union is never empty.
    expect(resolution.contradictingEvidenceIds.length).toBeGreaterThan(0);
    const distinctIds = new Set(resolution.perMember.map(m => m.productTypeId));
    expect(distinctIds.size).toBe(2);
  });

  it('abstained: no confident match across members', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Generic Pet Product 25 lb' }), TYPE_PRODUCT_TYPES),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Generic Pet Product 30 lb' }), TYPE_PRODUCT_TYPES),
      ],
    });
    expect(resolution.outcome).toBe('abstained');
    if (resolution.outcome !== 'abstained') return;
    expect(resolution.productTypeId).toBeNull();
    expect(resolution.confidence).toBeNull();
    expect(resolution.supportingEvidenceIds).toEqual([]);
    expect(resolution.memberSupport).toEqual({ confidentCount: 0, memberCount: 2 });
    expect(resolution.perMember.every(m => m.isAbstention)).toBe(true);
  });

  it('coherent_with_abstentions: >=1 confident match + >=1 abstainer, no contradiction (DECISION-C)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Pro Plan Dry Dog Food 5 lb' }), TYPE_PRODUCT_TYPES),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Generic Pet Product 25 lb' }), TYPE_PRODUCT_TYPES),
      ],
    });
    expect(resolution.outcome).toBe('coherent_with_abstentions');
    if (resolution.outcome !== 'coherent_with_abstentions') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
    expect(resolution.confidence).toBe(0.8);
    expect(resolution.memberSupport).toEqual({ confidentCount: 1, memberCount: 2 });
    expect(resolution.contradictingEvidenceIds).toEqual([]);
    expect(resolution.perMember[0].isAbstention).toBe(false);
    expect(resolution.perMember[1].isAbstention).toBe(true);
  });

  it('below confidenceFloor counts as abstain (raw match stays visible)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.75,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food Kibble 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Dry Dog Food 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
      ],
    });
    // Member B matches at 0.7125 — above the matcher floor (0.7) but below the
    // caller floor (0.75) — so it counts as an abstention.
    expect(resolution.outcome).toBe('coherent_with_abstentions');
    if (resolution.outcome !== 'coherent_with_abstentions') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
    expect(resolution.confidence).toBeCloseTo(0.8, 4);
    expect(resolution.memberSupport).toEqual({ confidentCount: 1, memberCount: 2 });
    const memberB = resolution.perMember[1];
    expect(memberB.isAbstention).toBe(true);
    expect(memberB.productTypeId).toBe('dry-dog-food');
    expect(memberB.confidence).toBeCloseTo(0.7125, 4);
    expect(memberB.source).toBe('keyword');
    expect(memberB.supportingEvidenceIds).toEqual([]);
  });

  it('abstained when every confident match is below the floor', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.85,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food Kibble 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
        memberInput(makeMemberProjection({ itemId: 'item-b', name: 'Purina Dry Dog Food 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food Kibble' }]),
      ],
    });
    expect(resolution.outcome).toBe('abstained');
    expect(resolution.productTypeId).toBeNull();
    expect(resolution.memberSupport).toEqual({ confidentCount: 0, memberCount: 2 });
    expect(resolution.perMember.every(m => m.isAbstention)).toBe(true);
  });

  it('empty member list resolves to abstained', () => {
    const resolution = resolveCohortProductType({ confidenceFloor: 0.7, members: [] });
    expect(resolution.outcome).toBe('abstained');
    expect(resolution.memberSupport).toEqual({ confidentCount: 0, memberCount: 0 });
    expect(resolution.perMember).toEqual([]);
  });

  it('resolveTargetsFromSnapshot path: options come from the frozen member snapshot', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food 5 lb' }), [{ id: 'dry-dog-food', name: 'Dry Dog Food' }]),
      ],
    });
    expect(resolution.outcome).toBe('coherent');
    if (resolution.outcome !== 'coherent') return;
    expect(resolution.productTypeId).toBe('dry-dog-food');
  });

  it('member without an enabled product-type target abstains (no options resolved)', () => {
    const resolution = resolveCohortProductType({
      confidenceFloor: 0.7,
      members: [
        memberInput(makeMemberProjection({ itemId: 'item-a', name: 'Purina Dry Dog Food 5 lb' }), [], []),
      ],
    });
    expect(resolution.outcome).toBe('abstained');
    expect(resolution.perMember[0].isAbstention).toBe(true);
    expect(resolution.perMember[0].productTypeId).toBeNull();
  });
});

// ─── C3b: validateCohortFamilyInvariants ─────────────────────────────────────

describe('validateCohortFamilyInvariants', () => {
  const BRANDS: BrandConfig[] = [
    { id: 'acme', name: 'Acme', aliases: ['Acme Pet'], oldIdAliases: [] },
    { id: 'blue-buffalo', name: 'Blue Buffalo', aliases: [], oldIdAliases: [] },
  ];

  it('brand disagreement finding via shared canonical brand resolution', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Blue Buffalo' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-dog-food']),
      BRANDS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].invariant).toBe('brand');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].kind).toBe('disagreement');
    expect(findings[0].values).toEqual(['acme', 'blue-buffalo']);
    expect(findings[0].memberIds).toEqual(['item-1', 'item-2']);
  });

  it('brand aliases canonicalize to the same brand — no finding', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme Pet' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Acme' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-dog-food']),
      BRANDS,
    );
    expect(findings).toEqual([]);
  });

  it('product type agreement finding (distinct confident ids)', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Acme' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-cat-food']),
      BRANDS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].invariant).toBe('product_type');
    expect(findings[0].severity).toBe('error');
    expect(findings[0].values).toEqual(['dry-dog-food', 'dry-cat-food']);
    expect(findings[0].memberIds).toEqual(['item-1', 'item-2']);
  });

  it('empty findings when the family is coherent (same type, same canonical brand)', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Acme' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-dog-food']),
      BRANDS,
    );
    expect(findings).toEqual([]);
  });

  it('without configured canonical brands, raw normalized brand strings keep the mismatch visible', () => {
    const projection = makeProjection([
      makeMemberProjection({ itemId: 'item-1', brand: 'Acme' }),
      makeMemberProjection({ itemId: 'item-2', brand: 'Blue Buffalo' }),
    ]);
    const findings = validateCohortFamilyInvariants(
      projection,
      coherentResults(['dry-dog-food', 'dry-dog-food']),
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].invariant).toBe('brand');
    expect(findings[0].values).toEqual(['unresolved:acme', 'unresolved:blue buffalo']);
  });
});
