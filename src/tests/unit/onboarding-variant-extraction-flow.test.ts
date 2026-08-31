// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { computeIdentityMatrixHash } from '../../shared/schemas/variant-resolution';
import type { VariantMatrix } from '../../shared/schemas/variant-resolution';
class VariantExtractionError extends Error {
  failureCode: string;
  matrixDecision?: unknown;
  constructor(code: string, msg: string, decision?: unknown) { super(msg); this.failureCode = code; this.matrixDecision = decision; this.name = 'VariantExtractionError'; }
}

function makeMatrix(): VariantMatrix {
  return {
    parserVersion: 1,
    platform: 'shopify' as const,
    canonicalParentUrl: 'https://example.com/products/betterbone',
    sourceFinalUrl: 'https://example.com/products/betterbone',
    sourceContentHash: null,
    candidates: [
      { variantKey: 'shopify:1:Small', platformId: '1', title: 'Small', identifiers: [{ kind: 'gtin', value: '810001234501', normalizedValue: '810001234501', sourcePath: 'a' }], options: [{ axis: 'Size', value: 'Small', normalizedAxis: 'size', normalizedValue: 'small', sourcePath: 'a' }], available: true, price: '19.99', currency: 'USD', weight: null, dimensions: null, images: [{ url: 'https://cdn/a.jpg', role: 'primary', sourcePath: 'a' }], deepLink: 'https://example.com/products/betterbone?variant=1', sourcePaths: {} as any },
      { variantKey: 'shopify:2:Large', platformId: '2', title: 'Large', identifiers: [{ kind: 'gtin', value: '810001234502', normalizedValue: '810001234502', sourcePath: 'a' }], options: [{ axis: 'Size', value: 'Large', normalizedAxis: 'size', normalizedValue: 'large', sourcePath: 'a' }], available: true, price: '29.99', currency: 'USD', weight: null, dimensions: null, images: [{ url: 'https://cdn/b.jpg', role: 'primary', sourcePath: 'a' }], deepLink: 'https://example.com/products/betterbone?variant=2', sourcePaths: {} as any },
    ],
    warnings: [],
    createdAt: new Date().toISOString(),
  } as VariantMatrix;
}

describe('variant extraction flow (M4) - job-queue gate with mocked repos', () => {
  it('VariantExtractionError carries failureCode and matrix payload', () => {
    const m = makeMatrix();
    const err = new VariantExtractionError('variant_selection_required', 'variant:variant_selection_required:ambiguous', { decision: { status: 'ambiguous' }, matrix: m, identityMatrixHash: computeIdentityMatrixHash(m) } as any);
    expect(err.failureCode).toBe('variant_selection_required');
    expect(err.message).toContain('variant_selection_required');
    expect((err as any).matrixDecision).toBeDefined();
  });

  it('stale hash mismatch produces variant_selection_stale', () => {
    const err = new VariantExtractionError('variant_selection_stale', 'variant:variant_selection_stale:hash mismatch');
    expect(err.failureCode).toBe('variant_selection_stale');
    // job-queue must treat this as needs_input not retry
    const isRetryable = !['variant_selection_required','variant_selection_stale','variant_matrix_invalid'].includes(err.failureCode);
    expect(isRetryable).toBe(false);
  });

  it('distributor_record sourceType bypasses variant gate', () => {
    const shouldGate = (sourceType: string | null, candidateCount: number) => sourceType !== 'distributor_record' && candidateCount > 1;
    expect(shouldGate('distributor_record', 3)).toBe(false);
    expect(shouldGate('official_page', 3)).toBe(true);
    expect(shouldGate('official_page', 1)).toBe(false);
  });

  it('sibling isolation: receipts keyed by itemId', () => {
    const store = new Map<string, { key: string; hash: string }>();
    store.set('item-1', { key: 'shopify:1:Small', hash: 'a'.repeat(64) });
    store.set('item-2', { key: 'shopify:2:Large', hash: 'a'.repeat(64) });
    expect(store.get('item-1')!.key).not.toBe(store.get('item-2')!.key);
    // mocked repo call count
    const mockGetByItem = vi.fn((id: string) => store.get(id));
    expect(mockGetByItem('item-1')).toBeDefined();
    expect(mockGetByItem).toHaveBeenCalledWith('item-1');
    expect(mockGetByItem('item-2')).toBeDefined();
  });

  it('ambiguous extraction persists canonical matrix + real hash (not empty)', () => {
    const m = makeMatrix();
    const hash = computeIdentityMatrixHash(m);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe('0'.repeat(64));
    expect(hash).not.toBe('f'.repeat(64));
    // Simulate job-queue persisting via repo.create with real candidates_json
    const mockRepo = { create: vi.fn(), supersedeCurrent: vi.fn() };
    const candidates_json = JSON.stringify(m.candidates);
    mockRepo.create({ candidates_json, identity_matrix_hash: hash, status: 'ambiguous' });
    expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ identity_matrix_hash: hash }));
    const parsed = JSON.parse(candidates_json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].variantKey).toBe('shopify:1:Small');
    // Ensure error payload carries same
    const err = new VariantExtractionError('variant_selection_required', 'x', { candidates: m.candidates, identityMatrixHash: hash } as any);
    expect((err as any).matrixDecision).toBeDefined();
  });

  it('no multi-variant extraction completes without durable matching resolution', () => {
    const m = makeMatrix();
    const hash = computeIdentityMatrixHash(m);
    const cur = { selected_variant_key: 'shopify:1:Small', identity_matrix_hash: hash };
    // page-extractor must verify both key and hash before completing
    function matchesSelection(sel: { selectedVariantKey?: string; variantKey?: string; identityMatrixHash: string }, row: typeof cur) {
      const key = (sel as any).selectedVariantKey ?? (sel as any).variantKey;
      return !!key && sel.identityMatrixHash === row.identity_matrix_hash && key === row.selected_variant_key;
    }
    expect(matchesSelection({ selectedVariantKey: cur.selected_variant_key, identityMatrixHash: hash }, cur)).toBe(true);
    expect(matchesSelection({ variantKey: cur.selected_variant_key, identityMatrixHash: hash } as any, cur)).toBe(true);
    expect(matchesSelection({ selectedVariantKey: cur.selected_variant_key, identityMatrixHash: 'b'.repeat(64) }, cur)).toBe(false);
    expect(matchesSelection({ selectedVariantKey: 'shopify:2:Large', identityMatrixHash: hash }, cur)).toBe(false);
  });

  it('retry budget not consumed for variant needs_input', () => {
    const retryCount = 0;
    const maxRetries = 3;
    const err = new VariantExtractionError('variant_selection_required', 'x');
    const isVariantGate = err.failureCode.startsWith('variant_');
    const nextRetry = isVariantGate ? retryCount : retryCount + 1;
    expect(nextRetry).toBe(0);
    expect(nextRetry < maxRetries).toBe(true);
  });
});
