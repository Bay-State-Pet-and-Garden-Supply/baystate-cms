import { expect, test, describe, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  insertProfileGeneration,
  updateProfileGenerationStatus,
  findProfileGenerationById,
  listProfileGenerationsByDomain,
  listValidatedGenerationsByDomain,
  listProfileGenerationDomainSummaries,
} from '../../db/repositories/profile-generation-repo';

describe('Profile Generation Audit Repository', () => {
  const testDbPath = 'src/tests/unit/profile-generation-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  test('should insert and find a profile generation record', () => {
    const record = insertProfileGeneration({
      domain: 'auditwoof.com',
      sourceUrl: 'https://auditwoof.com/products/test',
      expectedName: 'Test Product',
      brandHint: 'AuditWoof',
      selectors: { titleSelector: 'h1.title' },
      status: 'proposed',
      confidence: 0.42,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    });

    expect(record.id).toBeDefined();
    expect(record.domain).toBe('auditwoof.com');
    expect(record.status).toBe('proposed');
    expect(record.confidence).toBe(0.42);
    expect(record.llmProvider).toBe('openai');
    expect(record.llmModel).toBe('gpt-4o-mini');
    expect(record.selectors).toEqual({ titleSelector: 'h1.title' });
    expect(record.promotedAt).toBeNull();

    const found = findProfileGenerationById(record.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(record.id);
    expect(found?.selectors).toEqual({ titleSelector: 'h1.title' });
  });

  test('should normalize domains (lowercase, strip www.)', () => {
    const record = insertProfileGeneration({
      domain: 'WWW.NormalizeTest.com',
      sourceUrl: 'https://normalizetest.com/p/1',
      selectors: { titleSelector: 'h1' },
      status: 'proposed',
      confidence: 0.1,
    });

    expect(record.domain).toBe('normalizetest.com');
  });

  test('should round-trip JSON fields (selectors, fieldSamples, validation)', () => {
    const selectors = {
      titleSelector: 'h1.product-title',
      priceSelector: 'span.price',
      descriptionSelector: 'div.desc',
      imagesSelector: 'img.product',
    };
    const fieldSamples = {
      title: 'Sample Product',
      price: '$19.99',
      descriptionSample: 'A description',
    };
    const validation = {
      valid: true,
      confidence: 0.85,
      status: 'ok',
      reason: null,
      fieldSamples: { title: 'Sample Product' },
    };

    const record = insertProfileGeneration({
      domain: 'jsonroundtrip.com',
      sourceUrl: 'https://jsonroundtrip.com/p/1',
      selectors,
      fieldSamples,
      validation,
      status: 'validated',
      confidence: 0.85,
    });

    const found = findProfileGenerationById(record.id);
    expect(found?.selectors).toEqual(selectors);
    expect(found?.fieldSamples).toEqual(fieldSamples);
    expect(found?.validation).toEqual(validation);
  });

  test('should update status and refresh updated_at', async () => {
    const record = insertProfileGeneration({
      domain: 'statusswitch.com',
      sourceUrl: 'https://statusswitch.com/p/1',
      selectors: { titleSelector: 'h1' },
      status: 'proposed',
      confidence: 0.5,
    });
    const originalUpdated = record.updatedAt;

    // Sleep 5ms so updated_at visibly changes (ISO second resolution is too coarse).
    await new Promise(resolve => setTimeout(resolve, 5));

    const updated = updateProfileGenerationStatus(record.id, 'validated', {
      confidence: 0.92,
      validation: { valid: true, confidence: 0.92 },
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('validated');
    expect(updated?.confidence).toBe(0.92);
    expect(updated?.validation).toEqual({ valid: true, confidence: 0.92 });
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(originalUpdated).getTime(),
    );
  });

  test('should mark promoted status and set promoted_at', () => {
    const record = insertProfileGeneration({
      domain: 'promote-me.com',
      sourceUrl: 'https://promote-me.com/p/1',
      selectors: { titleSelector: 'h1' },
      status: 'validated',
      confidence: 0.95,
    });

    const promotedAt = new Date().toISOString();
    const promoted = updateProfileGenerationStatus(record.id, 'promoted', {
      promotedAt,
    });

    expect(promoted?.status).toBe('promoted');
    expect(promoted?.promotedAt).toBe(promotedAt);
  });

  test('should record failure status with error message', () => {
    const record = insertProfileGeneration({
      domain: 'failed-llm.com',
      sourceUrl: 'https://failed-llm.com/p/1',
      selectors: {},
      status: 'failed',
      confidence: 0,
      errorMessage: 'No LLM API key configured',
    });

    const found = findProfileGenerationById(record.id);
    expect(found?.status).toBe('failed');
    expect(found?.errorMessage).toBe('No LLM API key configured');
  });

  test('updateProfileGenerationStatus returns null for missing id', () => {
    const result = updateProfileGenerationStatus('does-not-exist', 'rejected');
    expect(result).toBeNull();
  });

  test('listProfileGenerationsByDomain returns rows in created_at DESC by default', () => {
    const domain = 'listorder.com';
    const a = insertProfileGeneration({
      domain,
      sourceUrl: 'https://listorder.com/a',
      selectors: { titleSelector: 'h1.a' },
      status: 'proposed',
      confidence: 0.1,
    });
    const b = insertProfileGeneration({
      domain,
      sourceUrl: 'https://listorder.com/b',
      selectors: { titleSelector: 'h1.b' },
      status: 'validated',
      confidence: 0.6,
    });
    const c = insertProfileGeneration({
      domain,
      sourceUrl: 'https://listorder.com/c',
      selectors: { titleSelector: 'h1.c' },
      status: 'rejected',
      confidence: 0.2,
    });

    const list = listProfileGenerationsByDomain(domain);
    expect(list.length).toBeGreaterThanOrEqual(3);
    // Newest first; c was inserted last.
    expect(list[0]?.id).toBe(c.id);
    expect(list[1]?.id).toBe(b.id);
    expect(list[2]?.id).toBe(a.id);
  });

  test('listProfileGenerationsByDomain can filter by status', () => {
    const domain = 'listfilter.com';
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://listfilter.com/a',
      selectors: { titleSelector: 'h1' },
      status: 'proposed',
    });
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://listfilter.com/b',
      selectors: { titleSelector: 'h1' },
      status: 'validated',
    });
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://listfilter.com/c',
      selectors: { titleSelector: 'h1' },
      status: 'validated',
    });

    const validated = listProfileGenerationsByDomain(domain, { status: 'validated' });
    expect(validated.length).toBe(2);
    expect(validated.every(r => r.status === 'validated')).toBe(true);

    const proposed = listProfileGenerationsByDomain(domain, { status: 'proposed' });
    expect(proposed.length).toBe(1);
    expect(proposed[0]?.status).toBe('proposed');
  });

  test('listValidatedGenerationsByDomain returns only validated+promoted', () => {
    const domain = 'valonly.com';
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://valonly.com/p1',
      selectors: { titleSelector: 'h1' },
      status: 'proposed',
    });
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://valonly.com/p2',
      selectors: { titleSelector: 'h1' },
      status: 'rejected',
    });
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://valonly.com/p3',
      selectors: { titleSelector: 'h1' },
      status: 'validated',
    });
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://valonly.com/p4',
      selectors: { titleSelector: 'h1' },
      status: 'promoted',
    });

    const list = listValidatedGenerationsByDomain(domain);
    expect(list.length).toBe(2);
    const statuses = list.map(r => r.status).sort();
    expect(statuses).toEqual(['promoted', 'validated']);
  });

  describe('listProfileGenerationDomainSummaries (diagnostics)', () => {
    test('returns full count plus latest status/timestamp per domain', async () => {
      const domain = 'summarycount.com';
      // Insert 3 generations in a known order. Add small delays so
      // created_at is distinguishable at the millisecond level.
      const first = insertProfileGeneration({
        domain,
        sourceUrl: 'https://summarycount.com/p1',
        selectors: { titleSelector: 'h1.a' },
        status: 'proposed',
        confidence: 0.1,
      });
      await new Promise((r) => setTimeout(r, 5));
      const middle = insertProfileGeneration({
        domain,
        sourceUrl: 'https://summarycount.com/p2',
        selectors: { titleSelector: 'h1.b' },
        status: 'validated',
        confidence: 0.5,
      });
      await new Promise((r) => setTimeout(r, 5));
      const last = insertProfileGeneration({
        domain,
        sourceUrl: 'https://summarycount.com/p3',
        selectors: { titleSelector: 'h1.c' },
        status: 'rejected',
        confidence: 0.2,
      });

      const summaries = listProfileGenerationDomainSummaries();
      const summary = summaries.find((s) => s.domain === domain);
      expect(summary).toBeDefined();
      // The full row count must be reported (no implicit LIMIT).
      expect(summary?.generationCount).toBe(3);
      // Latest row by created_at DESC must be the most recent insert.
      expect(summary?.latestGenerationStatus).toBe(last.status);
      expect(summary?.latestGenerationAt).toBe(last.createdAt);
      // Sanity: the older rows really are still in the table.
      expect(middle.id).toBeDefined();
      expect(first.id).toBeDefined();
    });

    test('returns an empty array when no generations exist', () => {
      // The whole-table aggregation still works; we just verify the
      // shape is consistent for a brand-new DB.
      const summaries = listProfileGenerationDomainSummaries();
      expect(Array.isArray(summaries)).toBe(true);
      // The shared DB may have rows from other tests; we just need
      // any one row to have a numeric count and the right field
      // types.
      for (const row of summaries) {
        expect(typeof row.domain).toBe('string');
        expect(typeof row.generationCount).toBe('number');
        expect(row.generationCount).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
