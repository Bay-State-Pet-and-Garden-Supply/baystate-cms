import { describe, test, expect } from 'vitest';
import {
  buildDistributorRecordProjectionV1,
  buildDistributorRecordProjection,
  computeEvidenceHash,
  canonicalJson,
  PROJECTION_VERSION,
} from '../../onboarding/sourcing/distributor-record-projection';
import type { EvidenceAttempt } from '../../shared/schemas/distributor-evidence';

const GEN = 'gen-1';
const ITEM_UPC = '012345678905';

function stripNulls(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function makeFound(
  id: string,
  providerId: string,
  identity: Record<string, unknown> | null,
  opts: {
    lookupUpc?: string;
    generation?: string | null;
    malformed?: boolean;
    itemId?: string;
    observedAt?: string | null;
    catalogVersion?: string | null;
    connectionId?: string | null;
  } = {},
): EvidenceAttempt {
  return {
    id,
    itemId: opts.itemId ?? 'item-1',
    providerId,
    distributorConnectionId: opts.connectionId === undefined ? 'conn-1' : opts.connectionId,
    lookupUpc: opts.lookupUpc ?? ITEM_UPC,
    outcome: 'found',
    confidence: 0.9,
    evidenceUrl: null,
    matchedFields: ['upc'],
    identityJson: opts.malformed ? '{not json' : JSON.stringify(stripNulls(identity ?? {})),
    warningsJson: null,
    errorCode: null,
    errorMessage: null,
    catalogVersion: opts.catalogVersion === undefined ? 'v2026.3' : opts.catalogVersion,
    // EvidenceAttempt.observedAt is string | undefined (not nullable);
    // coerce a test-supplied null to undefined.
    observedAt: opts.observedAt == null ? '2026-08-13T00:00:00.000Z' : opts.observedAt,
    sourcingGenerationId: opts.generation === undefined ? GEN : opts.generation,
    createdAt: '2026-08-13T00:00:00.000Z',
  };
}

function makeError(id: string, providerId: string, code = 'timeout'): EvidenceAttempt {
  return {
    id,
    itemId: 'item-1',
    providerId,
    distributorConnectionId: 'conn-1',
    lookupUpc: ITEM_UPC,
    outcome: 'source_error',
    confidence: 0,
    evidenceUrl: null,
    matchedFields: [],
    identityJson: null,
    warningsJson: null,
    errorCode: code,
    errorMessage: 'timed out',
    catalogVersion: null,
    observedAt: '2026-08-13T00:00:00.000Z',
    sourcingGenerationId: GEN,
    createdAt: '2026-08-13T00:00:00.000Z',
  };
}

const baseInput = {
  itemId: 'item-1',
  itemUpc: ITEM_UPC,
  sourcingGenerationId: GEN,
};

describe('Distributor record projection (Amendment A) — qualification', () => {
  test('single provider qualifies with a complete deterministic projection', () => {
    const a1 = makeFound('a1', 'phillips', {
      upc: ITEM_UPC,
      gtin: null,
      name: 'Dog Food 12 lb',
      brand: 'Nutro',
      weight: '12 lb',
      attributes: { size: '12 lb', flavor: 'chicken' },
    });
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });

    expect(result.qualified).toBe(true);
    if (!result.qualified) return;
    expect(result.projection.version).toBe(PROJECTION_VERSION);
    expect(result.projection.upc).toBe(ITEM_UPC);
    expect(result.projection.name).toBe('Dog Food 12 lb');
    expect(result.projection.brand).toBe('Nutro');
    expect(result.projection.weight).toBe('12 lb');
    expect(result.projection.size).toBe('12 lb');
    expect(result.projection.flavor).toBe('chicken');
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.projection.provenance.providerIds).toEqual(['phillips']);
    expect(result.projection.provenance.acceptedAttemptIds).toEqual(['a1']);
    expect(result.projection.provenance.sourcingGenerationId).toBe(GEN);
  });

  test('projection is identity-only: copy/commerce/image fields never appear', () => {
    const a1 = makeFound('a1', 'phillips', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      description: 'Rich chicken recipe',
      attributes: { size: '12 lb' },
      images: ['https://distributor.example/img1.jpg'],
    });
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(true);
    if (!result.qualified) return;
    const keys = Object.keys(result.projection);
    expect(keys).not.toContain('description');
    expect(keys).not.toContain('price');
    expect(keys).not.toContain('images');
    expect(keys).not.toContain('imageUrls');
    expect('description' in result.projection).toBe(false);
    expect('price' in result.projection).toBe(false);
  });

  test('two agreeing providers qualify; provenance is sorted and unique', () => {
    const a1 = makeFound('a1', 'bci', { upc: ITEM_UPC, name: 'Dog Food 12 lb', brand: 'Nutro', weight: '12 lb' });
    const a2 = makeFound('a2', 'phillips', { upc: ITEM_UPC, name: 'Dog Food 12 lb', brand: 'Nutro', weight: '12 lb' });
    // Input order deliberately reversed from provider-sorted order.
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a2, a1],
      acceptedAttemptIds: ['a2', 'a1'],
    });

    expect(result.qualified).toBe(true);
    if (!result.qualified) return;
    expect(result.projection.name).toBe('Dog Food 12 lb');
    expect(result.projection.brand).toBe('Nutro');
    expect(result.projection.provenance.providerIds).toEqual(['bci', 'phillips']);
    expect(result.projection.provenance.acceptedAttemptIds).toEqual(['a1', 'a2']);
  });

  test('found record plus another provider source_error still qualifies (error attempt not accepted)', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' });
    const err = makeError('err1', 'bci');
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1, err],
      acceptedAttemptIds: ['a1'],
    });
    expect(result.qualified).toBe(true);
    if (!result.qualified) return;
    expect(result.projection.provenance.providerIds).toEqual(['phillips']);
  });

  test('missing product name fails with missing_name', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, brand: 'Nutro' });
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('missing_name');
  });

  test('stale generation fails with stale_generation', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' }, { generation: 'gen-old' });
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('stale_generation');
  });

  test('malformed identity fails with incomplete_provenance', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' }, { malformed: true });
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('incomplete_provenance');
  });

  test('cross-item attempt fails with identifier_mismatch', () => {
    const a1 = makeFound(
      'a1',
      'phillips',
      { upc: '999999999999', name: 'Other Product' },
      { lookupUpc: '999999999999' },
    );
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('identifier_mismatch');
  });

  test('identity with no record identifier fails with empty_identity', () => {
    const a1 = makeFound('a1', 'phillips', { name: 'Dog Food', brand: 'Nutro' });
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('empty_identity');
  });

  test('no accepted evidence fails with no_accepted_evidence', () => {
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [], acceptedAttemptIds: [] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('no_accepted_evidence');
  });

  test('unknown variant axis makes the record insufficient unless dismissed', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', attributes: { scent: 'peach' } });
    const blocked = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(blocked.qualified).toBe(false);
    if (blocked.qualified) return;
    expect(blocked.reasonCodes).toContain('unknown_variant_axis');

    // Declared axis → known → qualifies, and the custom axis IS preserved
    // in the projection (Amendment A: declared axes are projected with
    // per-field provenance, never silently dropped).
    const declared = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1],
      acceptedAttemptIds: ['a1'],
      declaredVariantAxes: ['scent'],
    });
    expect(declared.qualified).toBe(true);
    if (!declared.qualified) return;
    expect(declared.projection.customVariantAxes).toEqual({ scent: 'peach' });
    expect(declared.projection.provenance.fieldProvenance['scent']).toEqual([
      { attemptId: 'a1', providerId: 'phillips', catalogVersion: 'v2026.3', connectionId: 'conn-1' },
    ]);

    // Durable raw-field registry: a registry-only raw key (not normalizable
    // to a bare axis name) is declared, never unknown, and projects the
    // mapped axis value.
    const registryKey = makeFound('a3', 'phillips', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      attributes: { 'Scent Level': 'mild' },
    });
    const viaRegistry = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [registryKey],
      acceptedAttemptIds: ['a3'],
      variantAxisDeclarations: [{ rawField: 'Scent Level', normalizedAxis: 'scent' }],
    });
    expect(viaRegistry.qualified).toBe(true);
    if (!viaRegistry.qualified) return;
    expect(viaRegistry.projection.customVariantAxes).toEqual({ scent: 'mild' });
    expect(viaRegistry.projection.provenance.fieldProvenance['scent']).toEqual([
      { attemptId: 'a3', providerId: 'phillips', catalogVersion: 'v2026.3', connectionId: 'conn-1' },
    ]);
    // The same registry maps the raw field to a hard axis: disagreement on it
    // is auto-resolved with explainable warnings.
    const other = makeFound('a4', 'bci', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      attributes: { 'Scent Level': 'strong' },
    });
    const registryConflict = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [registryKey, other],
      acceptedAttemptIds: ['a3', 'a4'],
      variantAxisDeclarations: [{ rawField: 'Scent Level', normalizedAxis: 'scent' }],
    });
    expect(registryConflict.qualified).toBe(true);
    if (!registryConflict.qualified) return;
    expect(registryConflict.warnings.some((w) => w.includes('auto-resolved'))).toBe(true);

    // Declared-axis disagreement between providers auto-resolves to primary provider.
    const a2 = makeFound('a2', 'bci', { upc: ITEM_UPC, name: 'Dog Food', attributes: { scent: 'cedar' } });
    const disagree = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1, a2],
      acceptedAttemptIds: ['a1', 'a2'],
      declaredVariantAxes: ['scent'],
    });
    expect(disagree.qualified).toBe(true);
    if (!disagree.qualified) return;
    expect(disagree.warnings.some((w) => w.includes('auto-resolved'))).toBe(true);

    // Dismissed unknown axis → qualified (field removed from consideration).
    const dismissed = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1],
      acceptedAttemptIds: ['a1'],
      resolutions: [{ field: 'scent', kind: 'dismissed' }],
    });
    expect(dismissed.qualified).toBe(true);
  });

  test('a same-UPC attempt from another item can never qualify (cross_item_attempt)', () => {
    const foreign = makeFound('a9', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' }, { itemId: 'item-OTHER' });
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [foreign],
      acceptedAttemptIds: ['a9'],
    });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('cross_item_attempt');
  });

  test('a requested accepted id that does not resolve fails closed (incomplete_provenance)', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' });
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1],
      acceptedAttemptIds: ['a1', 'a-missing'],
    });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('incomplete_provenance');
  });

  test('an attempt without distributorConnectionId cannot qualify (incomplete_provenance)', () => {
    const noConn = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' }, { connectionId: null });
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [noConn],
      acceptedAttemptIds: ['a1'],
    });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('incomplete_provenance');
  });

  test('duplicate accepted attempt ids dedupe in provenance and the hash stays stable', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' });
    const unique = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1],
      acceptedAttemptIds: ['a1'],
    });
    const duplicated = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1],
      acceptedAttemptIds: ['a1', 'a1'],
    });
    expect(duplicated.qualified).toBe(true);
    if (!duplicated.qualified || !unique.qualified) return;
    expect(duplicated.projection.provenance.acceptedAttemptIds).toEqual(['a1']);
    expect(duplicated.evidenceHash).toBe(unique.evidenceHash);
  });

  test('connection provenance is retained (sorted-unique connectionIds + per-field connectionId)', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', weight: '10 lb' });
    const a2 = makeFound('a2', 'bci', { upc: ITEM_UPC, name: 'Dog Food', weight: '10 lb' }, { connectionId: 'conn-9' });
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1, a2],
      acceptedAttemptIds: ['a1', 'a2'],
    });
    expect(result.qualified).toBe(true);
    if (!result.qualified) return;
    expect(result.projection.provenance.connectionIds).toEqual(['conn-1', 'conn-9']);
    for (const entry of result.projection.provenance.fieldProvenance['name'] ?? []) {
      expect(typeof entry.connectionId).toBe('string');
      expect(entry.connectionId.length).toBeGreaterThan(0);
    }
  });

  test('observation provenance is a qualification floor (observedAt/catalogVersion required)', () => {
    // A missing observation timestamp fails qualification (undefined, not
    // null: EvidenceAttempt.observedAt is string | undefined).
    const noObservedAt = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' });
    const stripped = { ...noObservedAt, observedAt: undefined };
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [stripped],
      acceptedAttemptIds: ['a1'],
    });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('incomplete_provenance');
  });
});

describe('Distributor record projection — conflicts and operator resolutions', () => {
  const a1 = makeFound('a1', 'phillips', {
    upc: ITEM_UPC,
    name: 'Dog Food',
    weight: '10 lb',
    attributes: { flavor: 'chicken' },
  });
  const a2 = makeFound('a2', 'bci', {
    upc: ITEM_UPC,
    name: 'Dog Food',
    weight: '20 lb',
    attributes: { flavor: 'beef' },
  });

  test('identity-critical disagreement auto-resolves with warning and qualifies', () => {
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1, a2], acceptedAttemptIds: ['a1', 'a2'] });
    expect(result.qualified).toBe(true);
    if (!result.qualified) return;
    expect(result.warnings.some((w) => w.includes('auto-resolved'))).toBe(true);
  });

  // Epic #46 follow-up (operator weight rule): the projection is the
  // qualification authority — equivalent weight formats must NOT resurrect
  // a raw-format conflict after the reconciler suppresses it.
  test('equivalent weight formats (16 oz vs 1.0000 lb) do NOT block qualification', () => {
    const eq1 = makeFound('e1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', weight: '16 oz' });
    const eq2 = makeFound('e2', 'bci', { upc: ITEM_UPC, name: 'Dog Food', weight: '1.0000 lb' });
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [eq1, eq2], acceptedAttemptIds: ['e1', 'e2'] });
    expect(result.qualified).toBe(true);
    if (result.qualified) {
      expect(result.warnings.some((w) => w.includes('weight'))).toBe(false);
    }
  });

  test('true weight mismatch (0.25 lb vs 0.50 lb) auto-resolves to primary provider', () => {
    const m1 = makeFound('m1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', weight: '0.25 lb' });
    const m2 = makeFound('m2', 'bci', { upc: ITEM_UPC, name: 'Dog Food', weight: '0.50 lb' });
    const result = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [m1, m2], acceptedAttemptIds: ['m1', 'm2'] });
    expect(result.qualified).toBe(true);
    if (result.qualified) {
      expect(result.projection.weight).toBe('0.50 lb');
    }
  });

  test('custom_override resolves the disputed field', () => {
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1, a2],
      acceptedAttemptIds: ['a1', 'a2'],
      resolutions: [
        { field: 'weight', kind: 'custom_override', value: '25 lb' },
        { field: 'flavor', kind: 'dismissed' },
      ],
    });
    expect(result.qualified).toBe(true);
    if (!result.qualified) return;
    expect(result.projection.weight).toBe('25 lb');
    expect(result.projection.flavor).toBeNull();
  });

  test('candidate_selected adopts the named attempt candidate', () => {
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1, a2],
      acceptedAttemptIds: ['a1', 'a2'],
      resolutions: [
        { field: 'weight', kind: 'candidate_selected', attemptId: 'a2' },
        { field: 'flavor', kind: 'dismissed' },
      ],
    });
    expect(result.qualified).toBe(true);
    if (!result.qualified) return;
    expect(result.projection.weight).toBe('20 lb');
    // Real attempt provenance: candidate_selected records the ACTUAL attempt
    // that supplied the value, never an operator placeholder (BLOCKER fix).
    expect(result.projection.provenance.fieldProvenance['weight']).toEqual([
      { attemptId: 'a2', providerId: 'bci', catalogVersion: 'v2026.3', connectionId: 'conn-1' },
    ]);
  });

  test('dismiss removes the field; remaining evidence must still qualify', () => {
    // Dismissing name removes the only name → still fails (missing_name).
    const result = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1],
      acceptedAttemptIds: ['a1'],
      resolutions: [{ field: 'name', kind: 'dismissed' }],
    });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('missing_name');
  });
});

describe('Distributor record projection — deterministic hashing', () => {
  test('shuffled attempt/provider input order yields an identical hash', () => {
    const a1 = makeFound('a1', 'bci', { upc: ITEM_UPC, name: 'Dog Food 12 lb', brand: 'Nutro', weight: '12 lb' });
    const a2 = makeFound('a2', 'phillips', { upc: ITEM_UPC, name: 'Dog Food 12 lb', brand: 'Nutro', weight: '12 lb' });

    const r1 = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a1, a2],
      acceptedAttemptIds: ['a1', 'a2'],
    });
    const r2 = buildDistributorRecordProjectionV1({
      ...baseInput,
      attempts: [a2, a1],
      acceptedAttemptIds: ['a2', 'a1'],
    });

    expect(r1.qualified).toBe(true);
    expect(r2.qualified).toBe(true);
    if (!r1.qualified || !r2.qualified) return;
    expect(r1.evidenceHash).toBe(r2.evidenceHash);
    expect(r1.projection).toEqual(r2.projection);
  });

  test('canonicalJson sorts object keys and is stable', () => {
    const a = canonicalJson({ b: 1, a: [2, 1], nested: { z: 'v', y: null } });
    const b = canonicalJson({ nested: { y: null, z: 'v' }, a: [2, 1], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[2,1],"b":1,"nested":{"y":null,"z":"v"}}');
  });

  test('computeEvidenceHash changes when identity fields change', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' });
    const r1 = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    const a2 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Cat Food' });
    const r2 = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a2], acceptedAttemptIds: ['a1'] });
    expect(r1.qualified).toBe(true);
    expect(r2.qualified).toBe(true);
    if (!r1.qualified || !r2.qualified) return;
    expect(r1.evidenceHash).not.toBe(r2.evidenceHash);
    expect(computeEvidenceHash(r1.projection)).toBe(r1.evidenceHash);
  });
});

describe('Distributor record projection v2 (Amendment B) — merchandising depth', () => {
  test('v2 includes merchandising fields, dedicated provenance, and the v2 version', () => {
    const a1 = makeFound('a1', 'phillips', {
      upc: ITEM_UPC,
      name: 'Dog Food 12 lb',
      description: 'Balanced recipe',
      features: ['Chicken first', 'Grain free'],
      category: 'Dog Food',
      dimensions: '12x8x4 in',
      casePack: '6',
      unitOfMeasure: 'EA',
      ingredients: 'Chicken, rice',
      images: ['https://cdn.example.com/a.jpg'],
    });
    const r = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(r.qualified).toBe(true);
    if (!r.qualified) return;
    expect(r.projection.version).toBe('distributor-record-projection-v2');
    expect(r.projection.description).toBe('Balanced recipe');
    expect(r.projection.features).toEqual(['Chicken first', 'Grain free']);
    expect(r.projection.category).toBe('Dog Food');
    expect(r.projection.dimensions).toBe('12x8x4 in');
    expect(r.projection.casePack).toBe('6');
    expect(r.projection.unitOfMeasure).toBe('EA');
    expect(r.projection.ingredients).toBe('Chicken, rice');
    expect(r.projection.imageUrls).toEqual(['https://cdn.example.com/a.jpg']);
    expect(r.projection.merchandisingProvenance.description).toHaveLength(1);
    expect(r.projection.merchandisingProvenance.description[0].attemptId).toBe('a1');
    expect(r.projection.merchandisingProvenance.features[0].values).toEqual(['Chicken first', 'Grain free']);
    // Price/inventory/arbitrary fields never enter the projection.
    expect((r.projection as unknown as Record<string, unknown>).price).toBeUndefined();
    expect((r.projection as unknown as Record<string, unknown>).inStock).toBeUndefined();
  });

  test('merchandising disagreement warns but qualifies; identity disagreement still blocks', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', description: 'Copy A' });
    const a2 = makeFound('a2', 'unfi', { upc: ITEM_UPC, name: 'Dog Food', description: 'Copy B' });
    const r = buildDistributorRecordProjection({ ...baseInput, attempts: [a1, a2], acceptedAttemptIds: ['a1', 'a2'] });
    expect(r.qualified).toBe(true);
    if (!r.qualified) return;
    expect(r.warnings).toContain('merchandising_disagreement:description');
    // Deterministic lexical selection.
    expect(r.projection.description).toBe('Copy A');

    // Identity disagreement on the same inputs auto-resolves and qualifies with warning.
    const a3 = makeFound('a3', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', weight: '10 lb' });
    const a4 = makeFound('a4', 'unfi', { upc: ITEM_UPC, name: 'Dog Food', weight: '20 lb' });
    const conflict = buildDistributorRecordProjection({ ...baseInput, attempts: [a3, a4], acceptedAttemptIds: ['a3', 'a4'] });
    expect(conflict.qualified).toBe(true);
    if (!conflict.qualified) return;
    expect(conflict.projection.weight).toBe('10 lb');
  });

  test('features merge as a case-insensitive sorted-unique union preserving first-seen spelling', () => {
    const a1 = makeFound('a1', 'phillips', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      features: ['Chicken First', 'Grain Free'],
    });
    const a2 = makeFound('a2', 'unfi', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      features: ['grain free', 'All Natural'],
    });
    const r = buildDistributorRecordProjection({ ...baseInput, attempts: [a1, a2], acceptedAttemptIds: ['a1', 'a2'] });
    expect(r.qualified).toBe(true);
    if (!r.qualified) return;
    // 'Grain Free' (a1, first-seen spelling) wins over 'grain free' (a2);
    // union is sorted by lowercase.
    expect(r.projection.features).toEqual(['All Natural', 'Chicken First', 'Grain Free']);
  });

  test('imageUrls is a sorted-unique HTTPS-only union', () => {
    const a1 = makeFound('a1', 'phillips', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      images: ['https://cdn.example.com/b.jpg', 'http://insecure.example.com/x.jpg', 'https://cdn.example.com/a.jpg'],
    });
    const a2 = makeFound('a2', 'unfi', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      images: ['https://cdn.example.com/b.jpg'],
    });
    const r = buildDistributorRecordProjection({ ...baseInput, attempts: [a1, a2], acceptedAttemptIds: ['a1', 'a2'] });
    expect(r.qualified).toBe(true);
    if (!r.qualified) return;
    // http URL dropped; union sorted-unique.
    expect(r.projection.imageUrls).toEqual(['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg']);
  });

  test('numeric casePack seeds packCount when no direct packCount evidence exists', () => {
    const a1 = makeFound('a1', 'phillips', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      casePack: '6',
    });
    const r = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(r.qualified).toBe(true);
    if (!r.qualified) return;
    expect(r.projection.packCount).toBe('6');

    // Non-numeric casePack never seeds the identity axis.
    const a2 = makeFound('a2', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', casePack: '6 EA' });
    const r2 = buildDistributorRecordProjection({ ...baseInput, attempts: [a2], acceptedAttemptIds: ['a2'] });
    expect(r2.qualified).toBe(true);
    if (!r2.qualified) return;
    expect(r2.projection.packCount).toBeNull();
    expect(r2.projection.casePack).toBe('6 EA');
  });

  test('v2 hash drifts on merchandising change but not on input ordering', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', description: 'Copy A' });
    const a2 = makeFound('a2', 'unfi', { upc: ITEM_UPC, name: 'Dog Food', description: 'Copy A' });
    const r1 = buildDistributorRecordProjection({ ...baseInput, attempts: [a1, a2], acceptedAttemptIds: ['a1', 'a2'] });
    const r2 = buildDistributorRecordProjection({ ...baseInput, attempts: [a2, a1], acceptedAttemptIds: ['a2', 'a1'] });
    expect(r1.qualified).toBe(true);
    expect(r2.qualified).toBe(true);
    if (!r1.qualified || !r2.qualified) return;
    expect(r1.evidenceHash).toBe(r2.evidenceHash);

    const a3 = makeFound('a3', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', description: 'Copy B' });
    const r3 = buildDistributorRecordProjection({ ...baseInput, attempts: [a3, a2], acceptedAttemptIds: ['a3', 'a2'] });
    expect(r3.qualified).toBe(true);
    if (!r3.qualified) return;
    expect(r3.evidenceHash).not.toBe(r1.evidenceHash);
  });

  test('v1 builder remains byte-for-byte identity-only with the v1 version', () => {
    const a1 = makeFound('a1', 'phillips', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      description: 'Copy A',
      features: ['F'],
    });
    const r = buildDistributorRecordProjectionV1({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(r.qualified).toBe(true);
    if (!r.qualified) return;
    expect(r.projection.version).toBe('distributor-record-projection-v1');
    expect((r.projection as unknown as Record<string, unknown>).description).toBeUndefined();
    expect((r.projection as unknown as Record<string, unknown>).features).toBeUndefined();
  });
});
