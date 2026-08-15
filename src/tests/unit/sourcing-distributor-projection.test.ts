import { describe, test, expect } from 'vitest';
import {
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
    const result = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });

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
    const result = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
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
    const result = buildDistributorRecordProjection({
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
    const result = buildDistributorRecordProjection({
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
    const result = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('missing_name');
  });

  test('stale generation fails with stale_generation', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' }, { generation: 'gen-old' });
    const result = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('stale_generation');
  });

  test('malformed identity fails with incomplete_provenance', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' }, { malformed: true });
    const result = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
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
    const result = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('identifier_mismatch');
  });

  test('identity with no record identifier fails with empty_identity', () => {
    const a1 = makeFound('a1', 'phillips', { name: 'Dog Food', brand: 'Nutro' });
    const result = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('empty_identity');
  });

  test('no accepted evidence fails with no_accepted_evidence', () => {
    const result = buildDistributorRecordProjection({ ...baseInput, attempts: [], acceptedAttemptIds: [] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('no_accepted_evidence');
  });

  test('unknown variant axis makes the record insufficient unless dismissed', () => {
    const a1 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Dog Food', attributes: { scent: 'peach' } });
    const blocked = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    expect(blocked.qualified).toBe(false);
    if (blocked.qualified) return;
    expect(blocked.reasonCodes).toContain('unknown_variant_axis');

    // Declared axis → known → qualifies, and the custom axis IS preserved
    // in the projection (Amendment A: declared axes are projected with
    // per-field provenance, never silently dropped).
    const declared = buildDistributorRecordProjection({
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
    const viaRegistry = buildDistributorRecordProjection({
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
    // is an open hard conflict.
    const other = makeFound('a4', 'bci', {
      upc: ITEM_UPC,
      name: 'Dog Food',
      attributes: { 'Scent Level': 'strong' },
    });
    const registryConflict = buildDistributorRecordProjection({
      ...baseInput,
      attempts: [registryKey, other],
      acceptedAttemptIds: ['a3', 'a4'],
      variantAxisDeclarations: [{ rawField: 'Scent Level', normalizedAxis: 'scent' }],
    });
    expect(registryConflict.qualified).toBe(false);
    if (registryConflict.qualified) return;
    expect(registryConflict.reasonCodes).toContain('open_hard_conflict');

    // Declared-axis disagreement between providers is a HARD conflict.
    const a2 = makeFound('a2', 'bci', { upc: ITEM_UPC, name: 'Dog Food', attributes: { scent: 'cedar' } });
    const disagree = buildDistributorRecordProjection({
      ...baseInput,
      attempts: [a1, a2],
      acceptedAttemptIds: ['a1', 'a2'],
      declaredVariantAxes: ['scent'],
    });
    expect(disagree.qualified).toBe(false);
    if (disagree.qualified) return;
    expect(disagree.reasonCodes).toContain('open_hard_conflict');

    // Dismissed unknown axis → qualified (field removed from consideration).
    const dismissed = buildDistributorRecordProjection({
      ...baseInput,
      attempts: [a1],
      acceptedAttemptIds: ['a1'],
      resolutions: [{ field: 'scent', kind: 'dismissed' }],
    });
    expect(dismissed.qualified).toBe(true);
  });

  test('a same-UPC attempt from another item can never qualify (cross_item_attempt)', () => {
    const foreign = makeFound('a9', 'phillips', { upc: ITEM_UPC, name: 'Dog Food' }, { itemId: 'item-OTHER' });
    const result = buildDistributorRecordProjection({
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
    const result = buildDistributorRecordProjection({
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
    const result = buildDistributorRecordProjection({
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
    const unique = buildDistributorRecordProjection({
      ...baseInput,
      attempts: [a1],
      acceptedAttemptIds: ['a1'],
    });
    const duplicated = buildDistributorRecordProjection({
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
    const result = buildDistributorRecordProjection({
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
    const result = buildDistributorRecordProjection({
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

  test('identity-critical disagreement blocks with open_hard_conflict', () => {
    const result = buildDistributorRecordProjection({ ...baseInput, attempts: [a1, a2], acceptedAttemptIds: ['a1', 'a2'] });
    expect(result.qualified).toBe(false);
    if (result.qualified) return;
    expect(result.reasonCodes).toContain('open_hard_conflict');
  });

  test('custom_override resolves the disputed field', () => {
    const result = buildDistributorRecordProjection({
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
    const result = buildDistributorRecordProjection({
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
    const result = buildDistributorRecordProjection({
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

    const r1 = buildDistributorRecordProjection({
      ...baseInput,
      attempts: [a1, a2],
      acceptedAttemptIds: ['a1', 'a2'],
    });
    const r2 = buildDistributorRecordProjection({
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
    const r1 = buildDistributorRecordProjection({ ...baseInput, attempts: [a1], acceptedAttemptIds: ['a1'] });
    const a2 = makeFound('a1', 'phillips', { upc: ITEM_UPC, name: 'Cat Food' });
    const r2 = buildDistributorRecordProjection({ ...baseInput, attempts: [a2], acceptedAttemptIds: ['a1'] });
    expect(r1.qualified).toBe(true);
    expect(r2.qualified).toBe(true);
    if (!r1.qualified || !r2.qualified) return;
    expect(r1.evidenceHash).not.toBe(r2.evidenceHash);
    expect(computeEvidenceHash(r1.projection)).toBe(r1.evidenceHash);
  });
});
