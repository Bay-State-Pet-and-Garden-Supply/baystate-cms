import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import {
  computeCohortPageInputHash,
  pageAuthorityFromProjectionMember,
  pageModelAuthorityFromConfig,
  PAGE_AUTHORITY_TRUNCATION,
  normalizePageAuthorityString,
} from '../../onboarding/cohort-page-hash';
import { titleExecutionTypeAuthorityFromRun } from '../../onboarding/cohort-title-hash';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import type {
  CohortRun,
  ExecutionEvidenceProjectionV1,
  ExecutionEvidenceProjectionMemberV1,
} from '../../shared/schemas/cohorts';

/**
 * PR7 C2 (issue #30): the canonical Page input hash — PURE, over the frozen
 * Page authority ONLY.
 *
 * Every frozen-page field must be significant; every excluded field must be
 * inert; membership + execution type (incl. NULL vs value) + the
 * operation-specific model authority must participate; the hash must be
 * deterministic and member-order-stable (sorted by sku); page and
 * species/healthConcern order must be normalized; truncation parity
 * (hardening-D) must hold against the rendered authority slice.
 */

const mocks = {
  getLlmConfigForTask: () => null as Record<string, string> | null,
};

// Scoped to THIS file; auto-restored after it completes (PR6 review round 2
// pattern) so co-running with llm-client suites never leaks.
mock.module('../../onboarding/llm-client', () => ({
  getLlmConfigForTask: () => mocks.getLlmConfigForTask(),
}));

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
      name: 'Acme Pate Chicken',
      expectedName: 'Chicken Pate',
      brandHint: 'Acme',
      departmentHint: 'Food',
      price: '19.99',
      quantity: 1,
      rowNumber: 2,
      upc: 'SKU-1',
    },
    extraction: {
      title: 'Acme Pate Chicken 5.5oz',
      description: 'Grain-free wet food for adult cats.',
      brand: 'Acme',
      weight: '5.5 oz',
      bulletPoints: ['Bullet 1'],
      searchKeywords: 'cat food',
      primaryImage: 'https://img.example/p1.jpg',
      additionalImages: [],
      customFields: {},
      fieldProvenance: {},
      packagingTitle: 'Acme Pate Chicken Pouch',
      ocr: {
        outcome: null,
        packagingOcrData: {
          productName: 'Acme Pate Chicken',
          brand: 'Acme',
          species: ['Cat'],
          upc: null,
          flavorVariety: 'Chicken',
          color: null,
          material: null,
          size: null,
          weight: '5.5 oz',
          count: null,
          lifeStage: 'Adult',
          breedSize: null,
          productForm: 'Pate',
          healthConcernFunction: ['Hairball'],
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

const PAGE_PLAN = {
  pages: [
    { id: 'cat-wet', name: 'Cat Food Wet', parentName: 'Cat Food Shop All' },
    { id: 'cat-shop', name: 'Cat Food Shop All', parentName: null },
  ],
  selectionMode: 'multiple' as const,
  maxPages: 5,
};

function makeParams(
  overrides: Partial<Parameters<typeof computeCohortPageInputHash>[0]> = {},
): Parameters<typeof computeCohortPageInputHash>[0] {
  return {
    run: makeRun(),
    projection: makeProjection([makeMember()]),
    pagePlan: PAGE_PLAN,
    executionTypeAuthority: titleExecutionTypeAuthorityFromRun(makeRun(), LABEL_SOURCE),
    pageModelAuthority: { provider: 'ollama', model: 'qwen2.5vl' },
    ...overrides,
  };
}

/** Deep-clone params so tests can mutate a single field. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The frozen snapshot-shaped label source the parent op would read the
 *  Execution Product Type label from. The run's executionProductTypeId
 *  'type-1' resolves to 'Dry Dog Food'. */
const LABEL_SOURCE = {
  productTypes: [
    { id: 'type-1', name: 'Dry Dog Food' },
    { id: 'type-2', name: 'Wet Dog Food' },
  ],
};

const hash = (params: Parameters<typeof computeCohortPageInputHash>[0]): string =>
  computeCohortPageInputHash(params);

/**
 * The rendered authority slice the v2 prompt will produce for ONE member —
 * built through the SAME shared normalization the hash claims, so the parity
 * tests prove hashed authority == rendered authority (hardening-D
 * construction rule).
 */
function renderAuthoritySlice(member: ExecutionEvidenceProjectionMemberV1): string {
  const a = pageAuthorityFromProjectionMember(member);
  return [
    a.sku,
    a.name,
    a.webTitle ?? 'none',
    a.brand ?? 'unknown',
    a.description,
    a.species.join(', '),
    a.flavor ?? 'none',
    a.lifeStage ?? 'none',
    a.productForm ?? 'none',
    a.healthConcern.join(', '),
  ].join('\n');
}

let workspacePath: string;

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-page-hash-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeCohortPageInputHash — determinism (PR7 C2)', () => {
  it('is deterministic: identical inputs produce the identical hash', () => {
    const base = makeParams();
    expect(hash(base)).toBe(hash(base));
    expect(hash(base)).toBe(hash(clone(base)));
    expect(hash(base).length).toBe(64); // sha256 hex
  });

  it('is stable regardless of input member order (sorted by sku)', () => {
    const m1 = makeMember({ productSku: 'SKU-A' });
    const m2 = makeMember({ productSku: 'SKU-B' });
    const forward = makeParams({ projection: makeProjection([m1, m2]) });
    const shuffled = makeParams({ projection: makeProjection([m2, m1]) });
    expect(hash(forward)).toBe(hash(shuffled));
  });

  it('normalizes species, healthConcern, and page order', () => {
    const base = makeParams();
    // Species content identical, array ORDER flipped.
    const speciesOrdered = clone(base);
    speciesOrdered.projection.members[0].extraction.ocr.packagingOcrData!.species = ['Cat', 'Dog'];
    const speciesReversed = clone(speciesOrdered);
    speciesReversed.projection.members[0].extraction.ocr.packagingOcrData!.species = ['Dog', 'Cat'];
    expect(hash(speciesReversed)).toBe(hash(speciesOrdered));
    // healthConcern content identical, array ORDER flipped.
    const healthOrdered = clone(base);
    healthOrdered.projection.members[0].extraction.ocr.packagingOcrData!.healthConcernFunction = ['Hairball', 'Skin'];
    const healthReversed = clone(healthOrdered);
    healthReversed.projection.members[0].extraction.ocr.packagingOcrData!.healthConcernFunction = ['Skin', 'Hairball'];
    expect(hash(healthReversed)).toBe(hash(healthOrdered));
    // Page list content identical, ORDER flipped (sorted by id by construction).
    const pagesReversed = makeParams({
      pagePlan: { ...PAGE_PLAN, pages: [...PAGE_PLAN.pages].reverse() },
    });
    expect(hash(pagesReversed)).toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — every frozen-page field is significant (PR7 C2)', () => {
  it('spreadsheet name participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.name = 'Acme Pate Salmon';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('webTitle (extraction.title) participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.title = 'Different Web Title';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('brand (spreadsheet brandHint) participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.brandHint = 'OtherBrand';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('description participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.description = 'A different description';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR species participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.species = ['Dog'];
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR flavor participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.flavorVariety = 'Salmon';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR life stage participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.lifeStage = 'Kitten';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR product form participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.productForm = 'Gravy';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR health concern participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.healthConcernFunction = ['Skin'];
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('a NULL OCR signal hashes differently from a value', () => {
    const base = makeParams();
    const noOcr = clone(base);
    noOcr.projection.members[0].extraction.ocr.packagingOcrData = null;
    expect(hash(noOcr)).not.toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — membership + page plan + execution type (PR7 C2)', () => {
  it('a different member SKU set changes the hash', () => {
    const base = makeParams();
    const otherMember = makeParams({ projection: makeProjection([makeMember({ productSku: 'SKU-OTHER' })]) });
    expect(hash(otherMember)).not.toBe(hash(base));
  });

  it('a NULL productSku member (empty-sku) changes the hash', () => {
    const base = makeParams();
    const nullSku = makeParams({ projection: makeProjection([makeMember({ productSku: null })]) });
    expect(hash(nullSku)).not.toBe(hash(base));
  });

  it('page list membership and parentName participate', () => {
    const base = makeParams();
    expect(hash(makeParams({
      pagePlan: { ...PAGE_PLAN, pages: [...PAGE_PLAN.pages, { id: 'cat-treats', name: 'Cat Treats', parentName: null }] },
    }))).not.toBe(hash(base));
    expect(hash(makeParams({
      pagePlan: { ...PAGE_PLAN, pages: PAGE_PLAN.pages.map(p => p.id === 'cat-wet' ? { ...p, parentName: 'Renamed Parent' } : p) },
    }))).not.toBe(hash(base));
  });

  it('selectionMode and maxPages participate', () => {
    const base = makeParams();
    expect(hash(makeParams({ pagePlan: { ...PAGE_PLAN, selectionMode: 'single' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ pagePlan: { ...PAGE_PLAN, maxPages: 3 } }))).not.toBe(hash(base));
  });

  it('executionProductTypeId / confidence / outcome changes change the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ executionTypeAuthority: { id: 'type-2', label: 'Wet Dog Food', confidence: 0.9, outcome: 'coherent' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ executionTypeAuthority: { id: 'type-1', label: 'Dry Dog Food', confidence: 0.5, outcome: 'coherent' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ executionTypeAuthority: { id: 'type-1', label: 'Dry Dog Food', confidence: 0.95, outcome: 'coherent_with_abstentions' } }))).not.toBe(hash(base));
  });

  it('a NULL execution type (abstained/conflicted) hashes differently from a value', () => {
    const base = makeParams();
    expect(hash(makeParams({ executionTypeAuthority: null }))).not.toBe(hash(base));
    // The run-fallback path (absent authority → run fields) matches the
    // explicit null authority for an abstained run.
    const abstainedRun = makeRun({ executionProductTypeId: null, productTypeConfidence: null, productTypeOutcome: 'abstained' });
    const viaRun = makeParams({ run: abstainedRun, executionTypeAuthority: undefined });
    const viaNull = makeParams({ run: abstainedRun, executionTypeAuthority: null });
    expect(hash(viaRun)).toBe(hash(viaNull));
  });

  it('execution type label participates (the label is part of the hashed authority)', () => {
    const base = makeParams();
    expect(hash(makeParams({
      executionTypeAuthority: { id: 'type-1', label: 'Renamed Dry Dog Food', confidence: 0.95, outcome: 'coherent' },
    }))).not.toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — model authority participation (PR7 C2 / DECISION-B)', () => {
  it('pageModelAuthority provider/model each participate; null hashes differently from a value', () => {
    const base = makeParams();
    expect(hash(makeParams({ pageModelAuthority: { provider: 'openai', model: 'gpt-4o-mini' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ pageModelAuthority: { provider: 'ollama', model: 'gemma4:12b-mlx' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ pageModelAuthority: null }))).not.toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — exclusions: hash ONLY frozen page authority (PR7 C2)', () => {
  it('non-page projection fields do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.bulletPoints = ['Changed'];
    changed.projection.members[0].extraction.searchKeywords = 'different';
    changed.projection.members[0].extraction.customFields = { flavor: 'salmon' };
    changed.projection.members[0].extraction.fieldProvenance = { flavor: 'ocr' };
    changed.projection.members[0].extraction.primaryImage = 'https://img.example/other.jpg';
    changed.projection.members[0].extraction.weight = '10 lb';
    changed.projection.members[0].extraction.ocr.packagingOcrData!.dietaryLabels = ['Grain Free'];
    expect(hash(changed)).toBe(hash(base));
  });

  it('evidenceHash / ocrInputHash / ocrExecutionDigest / item id / rowNumber do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].evidenceHash = 'other-evidence-hash';
    changed.projection.members[0].extraction.ocr.ocrInputHash = 'different-ocr-input-hash';
    changed.projection.members[0].extraction.ocr.ocrExecutionDigest = 'different-ocr-exec-digest';
    changed.projection.members[0].onboardingItemId = 'item-999';
    changed.projection.members[0].spreadsheetIdentity.rowNumber = 12345;
    expect(hash(changed)).toBe(hash(base));
  });

  it('modelPolicyDigest is NOT part of the hash (operation-specific authority only)', () => {
    const base = makeParams();
    const changed = makeParams({ run: makeRun({ modelPolicyDigest: 'different-policy-digest' }) });
    expect(hash(changed)).toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — PARITY: hash authority == rendered authority (PR7 C2 / hardening-D)', () => {
  it('truncation parity: a suffix-only mutation BEYOND the 200/500/1500 cutoffs changes NEITHER the P-hash NOR the rendered slice', () => {
    const base = makeParams();

    // Brand cut at 200 chars.
    const longBrand = `Brand-${'x'.repeat(250)}`;
    const b1 = clone(base);
    b1.projection.members[0].spreadsheetIdentity.brandHint = longBrand;
    const b2 = clone(b1);
    b2.projection.members[0].spreadsheetIdentity.brandHint = `${longBrand.slice(0, 200)}-DIFFERENT-SUFFIX`;
    expect(hash(b2)).toBe(hash(b1));
    expect(renderAuthoritySlice(b2.projection.members[0])).toBe(renderAuthoritySlice(b1.projection.members[0]));

    // Name cut at 500 chars.
    const longName = `Name-${'y'.repeat(550)}`;
    const n1 = clone(base);
    n1.projection.members[0].spreadsheetIdentity.name = longName;
    const n2 = clone(n1);
    n2.projection.members[0].spreadsheetIdentity.name = `${longName.slice(0, 500)}-DIFFERENT-SUFFIX`;
    expect(hash(n2)).toBe(hash(n1));
    expect(renderAuthoritySlice(n2.projection.members[0])).toBe(renderAuthoritySlice(n1.projection.members[0]));

    // Web title cut at 500 chars.
    const longWebTitle = `Web-${'z'.repeat(550)}`;
    const w1 = clone(base);
    w1.projection.members[0].extraction.title = longWebTitle;
    const w2 = clone(w1);
    w2.projection.members[0].extraction.title = `${longWebTitle.slice(0, 500)}-DIFFERENT-SUFFIX`;
    expect(hash(w2)).toBe(hash(w1));
    expect(renderAuthoritySlice(w2.projection.members[0])).toBe(renderAuthoritySlice(w1.projection.members[0]));

    // Description cut at 1500 chars.
    const longDescription = `Description-${'d'.repeat(1600)}`;
    const d1 = clone(base);
    d1.projection.members[0].extraction.description = longDescription;
    const d2 = clone(d1);
    d2.projection.members[0].extraction.description = `${longDescription.slice(0, 1500)}-DIFFERENT-SUFFIX`;
    expect(hash(d2)).toBe(hash(d1));
    expect(renderAuthoritySlice(d2.projection.members[0])).toBe(renderAuthoritySlice(d1.projection.members[0]));
  });

  it('a within-cutoff mutation changes BOTH the P-hash AND the rendered slice', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.brandHint = 'OtherBrand';
    expect(hash(changed)).not.toBe(hash(base));
    expect(renderAuthoritySlice(changed.projection.members[0])).not.toBe(renderAuthoritySlice(base.projection.members[0]));
  });

  it('the shared truncation constants mirror the prompt cutoffs exactly', () => {
    expect(PAGE_AUTHORITY_TRUNCATION).toEqual({ name: 500, webTitle: 500, brand: 200, description: 1500 });
    expect(normalizePageAuthorityString(null, 500)).toBeNull();
    expect(normalizePageAuthorityString('short', 200)).toBe('short');
    expect(normalizePageAuthorityString('x'.repeat(201), 200)).toBe('x'.repeat(200));
  });
});

describe('pageAuthorityFromProjectionMember — the pure builder (PR7 C2)', () => {
  it('returns the exact frozen page-relevant slice (same derivation as the frozen ProductLineItemSnapshot)', () => {
    const member = makeMember();
    expect(pageAuthorityFromProjectionMember(member)).toEqual({
      sku: 'SKU-1',
      name: 'Acme Pate Chicken',
      webTitle: 'Acme Pate Chicken 5.5oz',
      brand: 'Acme',
      description: 'Grain-free wet food for adult cats.',
      species: ['Cat'],
      flavor: 'Chicken',
      lifeStage: 'Adult',
      productForm: 'Pate',
      healthConcern: ['Hairball'],
    });
  });

  it('nulls OCR signals and falls back to the empty string for sku/description when absent', () => {
    const member = makeMember();
    member.extraction.ocr.packagingOcrData = null;
    member.productSku = null;
    member.extraction.description = null;
    expect(pageAuthorityFromProjectionMember(member)).toEqual({
      sku: '',
      name: 'Acme Pate Chicken',
      webTitle: 'Acme Pate Chicken 5.5oz',
      brand: 'Acme',
      description: '',
      species: [],
      flavor: null,
      lifeStage: null,
      productForm: null,
      healthConcern: [],
    });
  });
});

describe('pageModelAuthorityFromConfig — operation-specific resolution (PR7 C2 / DECISION-B)', () => {
  it('returns the frozen {provider, model} when a config resolves', () => {
    mocks.getLlmConfigForTask = () => ({ provider: 'ollama', model: 'qwen2.5vl', apiKey: 'k', baseUrl: 'http://127.0.0.1:11434' });
    expect(pageModelAuthorityFromConfig('/tmp/ws', {} as never, 'snap-hash')).toEqual({ provider: 'ollama', model: 'qwen2.5vl' });
  });

  it('returns null when the policy explicitly disables the model', () => {
    mocks.getLlmConfigForTask = () => null;
    expect(pageModelAuthorityFromConfig('/tmp/ws', null, null)).toBeNull();
  });

  it('returns null when resolution is unavailable (policy absent / denied — never throws)', () => {
    mocks.getLlmConfigForTask = () => {
      throw new Error('policy_absent');
    };
    expect(pageModelAuthorityFromConfig('/tmp/ws', undefined, null)).toBeNull();
  });
});
