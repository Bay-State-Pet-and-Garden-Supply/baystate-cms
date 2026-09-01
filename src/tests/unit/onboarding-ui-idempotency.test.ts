import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { approveItems, createExportDrafts } from '../../client/onboarding-work-api';

/**
 * M4 UI integration — Idempotency-Key header and authoritative endpoint.
 * Verifies that first-party UI paths engage the scoped receipt replay
 * (DB receipt is authority) and that ReadyToExport no longer bypasses
 * via legacy /promote.
 */

describe('onboarding UI idempotency — client operation paths (M4)', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis as any, 'fetch').mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            results: [],
            approvedCount: 0,
            rejectedCount: 0,
            rejected: [],
            audited: true,
            receiptId: 'test-receipt',
            // createExportDrafts shape
            createdCount: 0,
            created: [],
            changeSetId: null,
            principal: 'test',
          }),
        }) as any,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('approveItems POSTs to /approve with Idempotency-Key header', async () => {
    await approveItems('batch-1', ['a', 'b'], { idempotencyKey: 'test-key-123' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/onboarding/batches/batch-1/approve');
    expect(opts.method).toBe('POST');
    const headers = (opts.headers ?? {}) as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('test-key-123');
    // Body is JSON with itemIds
    const body = JSON.parse(opts.body as string);
    expect(body.itemIds).toEqual(['a', 'b']);
  });

  it('approveItems generates an Idempotency-Key when not provided (UUID-ish)', async () => {
    await approveItems('batch-2', ['x']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = (opts.headers ?? {}) as Record<string, string>;
    const key = headers['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(8);
    // Should be UUID or fallback format — at least contains hyphen or alphanum
    expect(key).toMatch(/[a-z0-9-]{8,}/i);
  });

  it('createExportDrafts POSTs to /create-export-drafts with Idempotency-Key, not /promote', async () => {
    await createExportDrafts('batch-3', ['id1'], { idempotencyKey: 'export-key-xyz' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/onboarding/batches/batch-3/create-export-drafts');
    expect(url).not.toContain('/promote');
    expect(opts.method).toBe('POST');
    const headers = (opts.headers ?? {}) as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('export-key-xyz');
    const body = JSON.parse(opts.body as string);
    expect(body.itemIds).toEqual(['id1']);
  });

  it('createExportDrafts generates Idempotency-Key when not provided', async () => {
    await createExportDrafts('batch-9', ['p1', 'p2']);
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = (opts.headers ?? {}) as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeDefined();
    expect(typeof headers['Idempotency-Key']).toBe('string');
  });

  it('approveItems and createExportDrafts use distinct operation endpoints', async () => {
    await approveItems('batch-a', ['i1'], { idempotencyKey: 'k1' });
    await createExportDrafts('batch-a', ['i1'], { idempotencyKey: 'k2' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url1] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [url2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url1).toContain('/approve');
    expect(url2).toContain('/create-export-drafts');
    expect(url1).not.toBe(url2);
  });

  it('ReadyToExportView does not import promoteBatchItems (static check)', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync('src/client/components/onboarding/approved/ReadyToExportView.tsx', 'utf8');
    expect(content).not.toContain('promoteBatchItems');
    expect(content).toContain('createExportDrafts');
    expect(content.toLowerCase()).toContain('idempotency');
    expect(content).toContain('exportIdempotencyKeyRef');
  });

  it('ApprovedView retains Idempotency-Key per logical operation (static check)', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync('src/client/components/onboarding/approved/ApprovedView.tsx', 'utf8');
    expect(content).toContain('idempotencyKeyRef');
    expect(content).toContain('approveItems');
    expect(content.toLowerCase()).toContain('idempotency');
  });
});
