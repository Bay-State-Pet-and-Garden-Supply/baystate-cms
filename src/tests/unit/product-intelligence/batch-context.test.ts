import { describe, expect, it } from 'vitest';
import {
  BATCH_CONTEXT_ARTIFACT_SCHEMA,
  BATCH_CONTEXT_ARTIFACT_TYPE,
  BatchContextArtifactPayloadSchema,
  contextForBatchRow,
  deriveBatchIntelligence,
  parseBatchContextArtifact,
} from '../../../product-intelligence/batch-context';
import { SpecialistArtifactSchemaRegistry } from '../../../product-intelligence/specialists/artifacts';

function row(rowId: string, sku: string, name: string, price: string | number) {
  return { rowId, productSeed: { sku, name, price } };
}

describe('deterministic batch intelligence (#57)', () => {
  it('derives repeated brand and family/size hypotheses without making them facts', () => {
    const result = deriveBatchIntelligence({
      batchId: 'supplier-1',
      batchVersion: 'upload-3',
      rows: [
        row('a', 'AC-100', 'Acme Wild Salmon 12 oz', '9.99'),
        row('b', 'AC-101', 'Acme Wild Salmon 24 oz', '9.99'),
        row('c', 'AC-102', 'Acme WS 36 oz', '12.99'),
        row('unrelated', 'ZZ-1', 'Garden Hose 50 ft', '9.99'),
      ],
    });

    expect(result.artifact.artifactType).toBe(BATCH_CONTEXT_ARTIFACT_TYPE);
    expect(result.payload.authoritative).toBe(false);
    expect(result.payload.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'repeated_brand_token', value: 'acme' }),
      expect.objectContaining({ kind: 'size_variant_group' }),
      expect.objectContaining({ kind: 'misleading_price_pattern' }),
    ]));
    expect(result.payload.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowId: 'a', relatedRowId: 'b', kind: 'likely_variant' }),
    ]));
    expect(result.payload.signals.some((signal) => signal.kind === 'abbreviated_family')).toBe(true);
    expect(result.payload.relationships.some((relation) => relation.rowId === 'a' && relation.relatedRowId === 'unrelated')).toBe(false);

    const context = contextForBatchRow(result, 'a');
    expect(context).toMatchObject({ authoritative: false, contextVersion: '1.0.0', contextHash: result.batchContextHash });
    expect(context?.siblingSkus).toContain('AC-101');
    expect(context?.siblingSkus).not.toContain('ZZ-1');
    expect(context?.hints).not.toHaveProperty('product_identity');
    expect(context?.hints).toEqual(expect.objectContaining({ repeated_brand_token_1: 'acme' }));
  });

  it('detects duplicate and near-duplicate rows as inspectable relationships', () => {
    const result = deriveBatchIntelligence({
      batchId: 'dupes',
      batchVersion: '1',
      rows: [
        row('one', 'X-1', 'Bright Paws Chicken Treats', 3.5),
        row('two', 'X-2', 'Bright Paws Chicken Treats', 4.5),
        row('three', 'X-3', 'Bright Paws Chicken Treats Soft', 4.5),
      ],
    });
    expect(result.payload.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowId: 'one', relatedRowId: 'two', kind: 'duplicate' }),
      expect.objectContaining({ rowId: 'one', relatedRowId: 'three', kind: 'near_duplicate' }),
    ]));
    expect(result.payload.signals.some((signal) => signal.kind === 'duplicate_rows')).toBe(true);
    expect(result.payload.signals.some((signal) => signal.kind === 'near_duplicate_rows')).toBe(true);
  });

  it('recognizes SKU sequences but never promotes a numeric-looking SKU to identity', () => {
    const result = deriveBatchIntelligence({
      batchId: 'sequence',
      batchVersion: '1',
      rows: [
        row('one', 'SUP-100', 'Unrelated Item A', 1),
        row('two', 'SUP-101', 'Unrelated Item B', 2),
        row('three', 'SUP-102', 'Unrelated Item C', 3),
      ],
    });
    expect(result.payload.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'sku_sequence', rowIds: ['one', 'three', 'two'] }),
    ]));
    expect(JSON.stringify(result)).not.toContain('gtin');
    expect(JSON.stringify(result)).not.toContain('mpn');
  });

  it('keeps unrelated mixed batches out of row context and bounds the projection', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(`row-${index}`, `SKU-${index}`, `Brand${index} Unique Product ${index} oz`, index + 1));
    const result = deriveBatchIntelligence({ batchId: 'mixed', batchVersion: '1', rows });
    for (const context of result.rowContexts.values()) {
      expect(context.siblingSkus.length).toBeLessThanOrEqual(8);
      expect(Object.keys(context.hints).length).toBeLessThanOrEqual(12);
      expect(context.authoritative).toBe(false);
    }
    expect(contextForBatchRow(result, 'does-not-exist')).toBeNull();
  });

  it('is replayable/content-addressed and preserves batch version/hash provenance', () => {
    const input = {
      batchId: 'stable',
      batchVersion: 'v7',
      rows: [row('b', 'B-2', 'Acme Two 12 oz', 2), row('a', 'A-1', 'Acme One 12 oz', 2)],
    };
    const first = deriveBatchIntelligence(input, { createdAt: '2026-01-01T00:00:00.000Z' });
    const second = deriveBatchIntelligence({ ...input, rows: [...input.rows].reverse() }, { createdAt: '2027-01-01T00:00:00.000Z' });
    expect(first.payload.inputHash).toBe(second.payload.inputHash);
    expect(first.batchContextHash).toBe(second.batchContextHash);
    expect(first.batchContextVersion).toBe('1.0.0');
    expect(first.payload.batchVersion).toBe('v7');
    expect(BatchContextArtifactPayloadSchema.safeParse(first.payload).success).toBe(true);
    const registry = new SpecialistArtifactSchemaRegistry().register(BATCH_CONTEXT_ARTIFACT_SCHEMA);
    expect(registry.validatePayload(BATCH_CONTEXT_ARTIFACT_TYPE, '1.0.0', first.payload).valid).toBe(true);
    expect(parseBatchContextArtifact(first.artifact)).toEqual(first.payload);
    const tampered = {
      ...first.artifact,
      payload: { ...(first.artifact.payload as Record<string, unknown>), authoritative: true },
    };
    expect(() => parseBatchContextArtifact(tampered)).toThrow(/failed validation|mismatch/);
  });
});
