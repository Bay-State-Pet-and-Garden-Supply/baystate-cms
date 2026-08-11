import { describe, it, expect } from 'bun:test';
import {
  computeCohortTitleInputHash,
  computeCohortTitleInputHashForFormatRules,
  titleAuthorityFromProjectionMember,
} from '../../onboarding/cohort-title-hash';
import { FORMAT_RULES } from '../../onboarding/title-prompt-template';
import { PROMPT_TEMPLATE_VERSIONS, RULE_VERSIONS } from '../../classification/model-operation-registry';
import type { ModelExecutionPlanEntry } from '../../classification/model-operation-registry';
import type {
  CohortRun,
  ExecutionEvidenceProjectionV1,
  ExecutionEvidenceProjectionMemberV1,
} from '../../shared/schemas/cohorts';

/**
 * PR6 C2 (issue #30): the canonical title input hash — PURE, over the frozen
 * title authority ONLY.
 *
 * Every frozen-title field must be significant; every excluded field must be
 * inert; membership + execution type (incl. NULL vs value) must participate;
 * the model-execution authority slice must participate with the registry
 * fallback being stable; the hash must be deterministic and
 * member-order-stable (sorted by onboardingItemId by construction).
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMember(overrides: Partial<ExecutionEvidenceProjectionMemberV1> = {}): ExecutionEvidenceProjectionMemberV1 {
  return {
    onboardingItemId: 'item-1',
    ordinal: 0,
    productSku: 'SKU-1',
    extractionComplete: true as const,
    sourceUrl: 'https://brand.example/p1',
    extractionSourceUrl: 'https://brand.example/p1',
    sourcingDecision: null,
    spreadsheetIdentity: {
      name: 'RAW CHKN 5LB',
      expectedName: 'Chicken 5 lb',
      brandHint: 'PawCo',
      departmentHint: 'Food',
      price: '19.99',
      quantity: 1,
      rowNumber: 2,
      upc: 'SKU-1',
    },
    extraction: {
      title: 'PawCo Chicken Recipe 5 lb',
      description: 'A long description that must never enter the title hash',
      brand: 'PawCo',
      weight: '5 lb',
      bulletPoints: ['Bullet 1'],
      searchKeywords: 'chicken',
      primaryImage: 'https://img.example/p1.jpg',
      additionalImages: ['https://img.example/p1b.jpg'],
      customFields: { flavor: 'chicken' },
      fieldProvenance: { flavor: 'web' },
      packagingTitle: 'PawCo Chicken 5 lb Pouch',
      ocr: {
        outcome: null,
        packagingOcrData: {
          productName: 'PawCo Chicken Recipe',
          brand: 'PawCo',
          species: [],
          upc: null,
          flavorVariety: 'Chicken',
          color: null,
          material: null,
          size: null,
          weight: '5 lb',
          count: null,
          lifeStage: null,
          breedSize: null,
          productForm: null,
          healthConcernFunction: [],
          dietaryLabels: [],
          ingredients: [],
          ingredientKeywords: [],
          claims: [],
          visibleTextLines: [],
          confidenceByField: {},
          metadata: {
            imageSourceUrl: null,
            imageLocalPath: null,
            model: null,
            extractedAt: null,
            parser: null,
            rawResponseExcerpt: null,
          },
        },
        ocrInputHash: 'ocr-input-hash-1',
        ocrExecutionDigest: 'ocr-exec-digest-1',
      },
      piEvidence: [],
      piImportComplete: true as const,
    },
    evidenceHash: 'member-evidence-hash-1',
    ...overrides,
  };
}

function makeRun(overrides: Partial<CohortRun> = {}): CohortRun {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    cohortId: 'cohort-1',
    candidateMembershipHash: 'candidate-membership-hash',
    finalMembershipHash: 'final-membership-hash',
    evidenceSnapshotHash: 'evidence-snapshot-hash',
    evidenceSnapshotId: null,
    configSnapshotId: null,
    configSnapshotHash: null,
    pageImportId: null,
    pageImportHash: null,
    modelPolicyDigest: 'model-policy-digest',
    executionProductTypeId: 'type-1',
    productTypeConfidence: 0.95,
    productTypeOutcome: 'coherent' as const,
    status: 'running' as const,
    claimedBy: 'worker-a',
    claimedAt: '2025-01-01T00:00:00.000Z',
    leaseExpiresAt: '2025-01-01T00:15:00.000Z',
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: null,
    errorMessage: null,
    supersededAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
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

function makeParams(
  overrides: Partial<Parameters<typeof computeCohortTitleInputHash>[0]> = {},
): Parameters<typeof computeCohortTitleInputHash>[0] {
  return {
    run: makeRun(),
    projection: makeProjection([makeMember()]),
    modelPolicyDigest: 'policy-digest-1',
    ...overrides,
  };
}

function makePlanEntry(overrides: Partial<ModelExecutionPlanEntry> = {}): ModelExecutionPlanEntry {
  return {
    operation: 'cohort_title_consolidation',
    stage: 'name_consolidation',
    provider: 'ollama',
    model: 'qwen2.5vl',
    locality: 'local',
    fromOverride: false,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.cohort_title_consolidation,
    ruleVersion: RULE_VERSIONS.cohort_title_consolidation,
    ...overrides,
  };
}

/** Deep-clone params so tests can mutate a single field. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const hash = (params: Parameters<typeof computeCohortTitleInputHash>[0]) => computeCohortTitleInputHash(params);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeCohortTitleInputHash — determinism (PR6 C2)', () => {
  it('is deterministic: identical inputs produce the identical hash', () => {
    const base = makeParams();
    expect(hash(base)).toBe(hash(base));
    expect(hash(base)).toBe(hash(clone(base)));
    expect(hash(base).length).toBe(64); // sha256 hex
  });

  it('is stable regardless of input member order (sorted by onboardingItemId)', () => {
    const m1 = makeMember({ onboardingItemId: 'item-a', productSku: 'SKU-A' });
    const m2 = makeMember({ onboardingItemId: 'item-b', productSku: 'SKU-B' });
    const forward = makeParams({ projection: makeProjection([m1, m2]) });
    const shuffled = makeParams({ projection: makeProjection([m2, m1]) });
    expect(hash(forward)).toBe(hash(shuffled));
  });
});

describe('computeCohortTitleInputHash — every frozen-title field is significant (PR6 C2 / DECISION-Q)', () => {
  it('spreadsheetName participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.name = 'RAW SALMON 10LB';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('expectedName participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.expectedName = 'Salmon 10 lb';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('brandHint participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.brandHint = 'OtherBrand';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('webTitle (extraction.title) participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.title = 'Different Web Title';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('webBrand (extraction.brand) participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.brand = 'OtherBrand';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('packagingOcrTitle participates via the packagingOcrData.productName path', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.productName = 'Different OCR Name';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('packagingOcrTitle participates via the packagingTitle fallback path (no packagingOcrData)', () => {
    const base = makeParams();
    const noOcr = clone(base);
    noOcr.projection.members[0].extraction.ocr.packagingOcrData = null;
    const changed = clone(noOcr);
    changed.projection.members[0].extraction.packagingTitle = 'Different Pouch Title';
    expect(hash(changed)).not.toBe(hash(noOcr));
  });

  it('packagingTitle is inert while packagingOcrData.productName wins (productName ?? packagingTitle)', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.packagingTitle = 'Ignored Pouch Title';
    expect(hash(changed)).toBe(hash(base));
  });

  it('ocrWeight participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.weight = '10 lb';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('ocrFlavor participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.flavorVariety = 'Salmon';
    expect(hash(changed)).not.toBe(hash(base));
  });
});

describe('computeCohortTitleInputHash — membership + execution type (PR6 C2)', () => {
  it('a different finalMembershipHash changes the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ finalMembershipHash: 'other-membership-hash' }) }))).not.toBe(hash(base));
  });

  it('NULL finalMembershipHash hashes differently from a value', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ finalMembershipHash: null }) }))).not.toBe(hash(base));
  });

  it('executionProductTypeId change changes the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ executionProductTypeId: 'type-2' }) }))).not.toBe(hash(base));
  });

  it('productTypeConfidence change changes the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ productTypeConfidence: 0.5 }) }))).not.toBe(hash(base));
  });

  it('productTypeOutcome change changes the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ productTypeOutcome: 'coherent_with_abstentions' }) }))).not.toBe(hash(base));
  });

  it('a NULL execution type (abstained/conflicted) hashes differently from a value', () => {
    const base = makeParams();
    const abstained = makeParams({
      run: makeRun({ executionProductTypeId: null, productTypeConfidence: null, productTypeOutcome: 'abstained' }),
    });
    expect(hash(abstained)).not.toBe(hash(base));
    expect(hash(makeParams({ run: makeRun({ executionProductTypeId: null }) }))).not.toBe(hash(base));
    expect(hash(makeParams({ run: makeRun({ productTypeOutcome: null }) }))).not.toBe(hash(base));
  });
});

describe('computeCohortTitleInputHash — format rules digest (PR6 C2)', () => {
  it('the FORMAT_RULES digest participates (parameterized internal)', () => {
    const base = makeParams();
    // The public entry point uses the module constant.
    expect(computeCohortTitleInputHashForFormatRules(base, FORMAT_RULES)).toBe(hash(base));
    // A simulated constant change alters the hash without mutating the module.
    expect(computeCohortTitleInputHashForFormatRules(base, `${FORMAT_RULES}\n- New rule line`)).not.toBe(hash(base));
    expect(computeCohortTitleInputHashForFormatRules(base, 'completely different rules')).not.toBe(hash(base));
  });
});

describe('computeCohortTitleInputHash — model execution authority slice (PR6 C2 / DECISION-P)', () => {
  it('policyDigest participates', () => {
    const base = makeParams();
    expect(hash(makeParams({ modelPolicyDigest: 'other-policy-digest' }))).not.toBe(hash(base));
  });

  it('the plan entry provider/model/promptTemplateVersion/ruleVersion each participate', () => {
    const base = makeParams();
    expect(hash(makeParams({ titlePlanEntry: makePlanEntry({ provider: 'openai' }) }))).not.toBe(hash(base));
    expect(hash(makeParams({ titlePlanEntry: makePlanEntry({ model: 'gpt-4o' }) }))).not.toBe(hash(base));
    expect(hash(makeParams({ titlePlanEntry: makePlanEntry({ promptTemplateVersion: 'cohort-title-consolidation-prompt-v2' }) }))).not.toBe(hash(base));
    expect(hash(makeParams({ titlePlanEntry: makePlanEntry({ ruleVersion: 'cohort-title-consolidation-rules-v2' }) }))).not.toBe(hash(base));
  });

  it('a titlePlanEntry present vs absent is stable when the entry carries no route (fallback consts)', () => {
    const absent = makeParams();
    // A present entry whose route fields are null (unrouted fallback state)
    // resolves identically to the absent fallback: the version fields come
    // from the registry consts and provider/model fall back to null via
    // `titlePlanEntry?.provider ?? null`.
    const unrouted = makeParams({
      titlePlanEntry: makePlanEntry({
        // The entry type requires string routes; the null-route state is a
        // synthetic edge case proving the `?? null` fallback is stable.
        provider: null as any,
        model: null as any,
      }),
    });
    expect(hash(unrouted)).toBe(hash(absent));
  });

  it('an unrelated plan-entry operation is never the authority (only the title slice fields are read)', () => {
    const titleOp = makeParams({ titlePlanEntry: makePlanEntry({ operation: 'cohort_title_consolidation' }) });
    const otherOp = makeParams({ titlePlanEntry: makePlanEntry({ operation: 'attribute_ranking' }) });
    // Same route + versions, different operation field → identical T-hash:
    // the operation is fixed ('cohort_title_consolidation') and the entry's
    // own operation value is never serialized.
    expect(hash(otherOp)).toBe(hash(titleOp));
  });
});

describe('computeCohortTitleInputHash — exclusions: hash ONLY frozen title authority (PR6 C2 / DECISION-P)', () => {
  it('description, primaryImage, and non-title extraction fields do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.description = 'A completely different description';
    changed.projection.members[0].extraction.primaryImage = 'https://img.example/other.jpg';
    changed.projection.members[0].extraction.bulletPoints = ['Changed', 'Bullets'];
    changed.projection.members[0].extraction.searchKeywords = 'different keywords';
    changed.projection.members[0].extraction.customFields = { flavor: 'salmon' };
    changed.projection.members[0].extraction.fieldProvenance = { flavor: 'ocr' };
    changed.projection.members[0].extraction.additionalImages = ['https://img.example/x.jpg'];
    expect(hash(changed)).toBe(hash(base));
  });

  it('evidenceHash (H2 member evidence identity) does NOT change the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ projection: makeProjection([makeMember({ evidenceHash: 'other-evidence-hash' })]) }))).toBe(hash(base));
  });

  it('ocrInputHash / ocrExecutionDigest (OCR provenance) do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.ocrInputHash = 'different-ocr-input-hash';
    changed.projection.members[0].extraction.ocr.ocrExecutionDigest = 'different-ocr-exec-digest';
    expect(hash(changed)).toBe(hash(base));
  });

  it('item id and rowNumber do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].onboardingItemId = 'item-999';
    changed.projection.members[0].spreadsheetIdentity.rowNumber = 12345;
    expect(hash(changed)).toBe(hash(base));
  });

  it('sourcing/ocr outcome and piEvidence do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].sourcingDecision = {
      route: 'bundle_to_curation',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: ['a'],
      providerIds: ['web'],
      conflicts: [],
      warnings: [],
      decidedAt: '2025-01-01T00:00:00.000Z',
    };
    changed.projection.members[0].extraction.ocr.outcome = { status: 'succeeded', model: 'qwen2.5vl', imageCount: 1 };
    changed.projection.members[0].extraction.piEvidence = [{ runId: 'r', resultHash: 'h', importRecordId: 'i' }];
    expect(hash(changed)).toBe(hash(base));
  });
});

describe('titleAuthorityFromProjectionMember — the pure builder (PR6 C2)', () => {
  it('returns the exact frozen title-relevant slice', () => {
    const member = makeMember();
    expect(titleAuthorityFromProjectionMember(member)).toEqual({
      productSku: 'SKU-1',
      spreadsheetName: 'RAW CHKN 5LB',
      expectedName: 'Chicken 5 lb',
      brandHint: 'PawCo',
      webTitle: 'PawCo Chicken Recipe 5 lb',
      webBrand: 'PawCo',
      packagingOcrTitle: 'PawCo Chicken Recipe',
      ocrWeight: '5 lb',
      ocrFlavor: 'Chicken',
    });
  });

  it('falls back to packagingTitle and nulls when OCR data is absent', () => {
    const member = makeMember();
    member.extraction.ocr.packagingOcrData = null;
    expect(titleAuthorityFromProjectionMember(member)).toEqual({
      productSku: 'SKU-1',
      spreadsheetName: 'RAW CHKN 5LB',
      expectedName: 'Chicken 5 lb',
      brandHint: 'PawCo',
      webTitle: 'PawCo Chicken Recipe 5 lb',
      webBrand: 'PawCo',
      packagingOcrTitle: 'PawCo Chicken 5 lb Pouch',
      ocrWeight: null,
      ocrFlavor: null,
    });
  });
});
