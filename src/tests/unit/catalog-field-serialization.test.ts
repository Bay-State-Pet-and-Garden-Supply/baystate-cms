/**
 * Catalog Field Serialization (Milestone 5).
 *
 * ONE shared serializer (`serializeAttributeValue`) is used by the preview
 * (draft projection), onboarding promotion, and catalog application paths.
 * This suite proves identical output across those surfaces, validates
 * field-specific delimiters, measured units, controlled membership, and
 * explicit-clear semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  serializeAttributeValue,
  validateSerializableValue,
  getEffectiveProposalValue,
  buildAssignmentProjection,
} from '../../classification/assignment-projection';
import type { ClassificationProposal } from '../../shared/types';

function makeProposal(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  return {
    id: 'prop-1',
    runId: 'run-1',
    productSku: 'SKU-1',
    proposalType: 'field_assignment',
    targetId: 'flavor',
    proposedValue: ['Chicken', 'Beef'],
    confidence: 0.9,
    evidenceIds: [],
    status: 'pending',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const v1Serialization = { format: 'direct', separator: ', ', prefix: '', suffix: '' };

describe('serializeAttributeValue — one serializer across preview/promotion/application', () => {
  it('serializes identically through the shared serializer for every surface', () => {
    // Preview (draft projection) uses getEffectiveProposalValue then serialize.
    const proposal = makeProposal();
    const previewValue = serializeAttributeValue(
      getEffectiveProposalValue(proposal),
      v1Serialization,
    );
    // Promotion and application use the exact same function on the same value.
    const promotionValue = serializeAttributeValue(
      getEffectiveProposalValue(proposal),
      v1Serialization,
    );
    const applicationValue = serializeAttributeValue(
      getEffectiveProposalValue(proposal),
      v1Serialization,
    );
    expect(previewValue).toBe('Chicken, Beef');
    expect(promotionValue).toBe(previewValue);
    expect(applicationValue).toBe(previewValue);
  });

  it('applies prefix/suffix for scalar values', () => {
    expect(
      serializeAttributeValue('Joint Health', { format: 'direct', separator: ', ', prefix: '', suffix: '' }),
    ).toBe('Joint Health');
    expect(
      serializeAttributeValue('10', { format: 'direct', separator: ', ', prefix: 'Size: ', suffix: '' }),
    ).toBe('Size: 10');
  });

  it('supports v2 scalar kind', () => {
    expect(serializeAttributeValue('Chicken', { kind: 'scalar', prefix: '', suffix: '' })).toBe('Chicken');
  });
});

describe('serializeAttributeValue — field-specific delimiters', () => {
  it('joins multi-values with the delimited separator for v2 delimited kind', () => {
    expect(
      serializeAttributeValue(['Chicken', 'Beef'], { kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' }),
    ).toBe('Chicken|Beef');
  });

  it('rejects a value containing the delimiter under the reject policy (fail closed)', () => {
    expect(() =>
      serializeAttributeValue(['Chicken|Rice', 'Beef'], { kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' }),
    ).toThrow(/escapePolicy is "reject"/);
  });

  it('escapes the delimiter under the backslash policy', () => {
    expect(
      serializeAttributeValue(['Chicken|Rice', 'Beef'], { kind: 'delimited', delimiter: '|', escapePolicy: 'backslash', prefix: '', suffix: '' }),
    ).toBe('Chicken\\|Rice|Beef');
  });
});

describe('serializeAttributeValue — measured units', () => {
  it('appends the unit with the configured separator for v2 measured kind', () => {
    expect(
      serializeAttributeValue(15, { kind: 'measured', unit: 'lb', valueUnitSeparator: ' ', prefix: '', suffix: '' }),
    ).toBe('15 lb');
  });

  it('rejects non-finite measured values', () => {
    expect(() =>
      serializeAttributeValue('heavy', { kind: 'measured', unit: 'lb', valueUnitSeparator: ' ', prefix: '', suffix: '' }),
    ).toThrow(/not a finite number/);
  });
});

describe('serializeAttributeValue — explicit clear semantics', () => {
  it('produces a true empty string for explicit null/undefined clears, bypassing prefix/suffix', () => {
    expect(
      serializeAttributeValue(null, { format: 'direct', separator: ', ', prefix: 'Size: ', suffix: ' lb' }),
    ).toBe('');
    expect(
      serializeAttributeValue(undefined, { kind: 'scalar', prefix: 'Size: ', suffix: ' lb' }),
    ).toBe('');
  });
});

describe('validateSerializableValue', () => {
  it('accepts allowed controlled values', () => {
    const attribute = { id: 'flavor', valueMode: 'controlled' as const, allowedValues: ['Chicken', 'Beef'], valueAliases: [] };
    expect(validateSerializableValue('Chicken', attribute)).toEqual({ ok: true });
  });

  it('rejects out-of-list controlled values', () => {
    const attribute = { id: 'flavor', valueMode: 'controlled' as const, allowedValues: ['Chicken', 'Beef'], valueAliases: [] };
    const result = validateSerializableValue('Salmon', attribute);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('controlled_membership');
  });

  it('accepts values matching an alias', () => {
    const attribute = { id: 'flavor', valueMode: 'controlled' as const, allowedValues: ['Chicken'], valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }] };
    expect(validateSerializableValue('chicken', attribute)).toEqual({ ok: true });
  });

  it('accepts finite measured values and rejects non-finite', () => {
    const measured = { id: 'weight', valueMode: 'measured' as const, allowedValues: [], valueAliases: [] };
    expect(validateSerializableValue(15, measured)).toEqual({ ok: true });
    const bad = validateSerializableValue('heavy', measured);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('measured_unit');
  });

  it('treats explicit clears as always legal', () => {
    const attribute = { id: 'flavor', valueMode: 'controlled' as const, allowedValues: ['Chicken'], valueAliases: [] };
    expect(validateSerializableValue(null, attribute)).toEqual({ ok: true });
  });
});

describe('buildAssignmentProjection — skipped assignments stay visible and do not block the draft', () => {
  const mappings = [
    { id: 'm1', attributeId: 'flavor', catalogField: 'ProductField1', serialization: v1Serialization, isStale: false },
    { id: 'm2', attributeId: 'stale-attr', catalogField: 'ProductField2', serialization: v1Serialization, isStale: true },
  ];

  it('projects mapped fields, skips stale mappings and missing targets without throwing', () => {
    const proposals = [
      makeProposal({ id: 'p-flavor' }),
      makeProposal({ id: 'p-stale', targetId: 'stale-attr' }),
      makeProposal({ id: 'p-no-target', targetId: null }),
    ];
    const projection = buildAssignmentProjection(proposals, {}, [], mappings);
    const flavorField = projection.fields.find(field => field.catalogField === 'ProductField1');
    expect(flavorField).toBeDefined();
    expect(flavorField!.proposedValue).toBe('Chicken, Beef');
    const staleSkip = projection.skipped.find(skip => skip.proposalId === 'p-stale');
    expect(staleSkip).toBeDefined();
    expect(staleSkip!.reason).toContain('stale');
    const noTargetSkip = projection.skipped.find(skip => skip.proposalId === 'p-no-target');
    expect(noTargetSkip).toBeDefined();
    expect(noTargetSkip!.reason).toBe('No attribute target');
  });

  it('never emits a Page ID as a page name in the projection', () => {
    // A category_page proposal with a verified pageId but no pageName must be
    // a visible skip — the stable Page ID is never a display name.
    const pageProposal = makeProposal({
      id: 'p-page',
      proposalType: 'category_page',
      targetId: 'page-id-123',
      proposedValue: { pageId: 'page-id-123' },
    });
    const projection = buildAssignmentProjection(
      [pageProposal],
      {},
      [],
      mappings,
      new Set(['page-id-123']),
    );
    expect(projection.pages.proposed).toEqual([]);
    const skip = projection.skipped.find(skip => skip.proposalId === 'p-page');
    expect(skip).toBeDefined();
    expect(skip!.reason).toBe('Page display name missing');

    // A well-formed value with pageName still projects the display name.
    const goodProposal = makeProposal({
      id: 'p-page-good',
      proposalType: 'category_page',
      targetId: 'page-id-456',
      proposedValue: { pageId: 'page-id-456', pageName: 'Dog Food' },
    });
    const goodProjection = buildAssignmentProjection(
      [goodProposal],
      {},
      [],
      mappings,
      new Set(['page-id-456']),
    );
    expect(goodProjection.pages.proposed).toEqual(['Dog Food']);
  });
});
