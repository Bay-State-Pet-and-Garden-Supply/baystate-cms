/**
 * Unit tests for `src/db/repositories/profile-generation-revision-repo.ts`.
 *
 * Runs under `bun test` (excluded from vitest) because the repo is
 * DB-dependent and vitest cannot load `bun:sqlite`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertProfileGeneration, findProfileGenerationById } from '../../db/repositories/profile-generation-repo';
import {
  insertProfileGenerationRevision,
  findProfileGenerationRevisionById,
  listRevisionsByGeneration,
  findLatestValidatedRevision,
  updateProfileGenerationRevisionStatus,
  insertRevisionValidationResult,
  insertRevisionValidationResults,
  listValidationResultsByRevision,
} from '../../db/repositories/profile-generation-revision-repo';

describe('Profile Generation Revision Repository', () => {
  const testDbPath = 'src/tests/unit/profile-generation-revision-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  // helper: create a parent generation row
  function makeGeneration(domain: string) {
    return insertProfileGeneration({
      domain,
      sourceUrl: `https://${domain}/p/1`,
      selectors: { titleSelector: 'h1' },
      status: 'proposed',
    });
  }

  test('inserts and finds a revision', () => {
    const gen = makeGeneration('revision-woof.com');
    const rev = insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: { titleSelector: 'h1.product-title' },
      status: 'validated',
      confidence: 0.8,
      llmTask: 'profile_generation',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-pro',
    });

    expect(rev.id).toBeDefined();
    expect(rev.generationId).toBe(gen.id);
    expect(rev.revisionNumber).toBe(1);
    expect(rev.parentRevisionId).toBeNull();
    expect(rev.source).toBe('initial_generation');
    expect(rev.status).toBe('validated');
    expect(rev.confidence).toBe(0.8);
    expect(rev.llmTask).toBe('profile_generation');
    expect(rev.selectors).toEqual({ titleSelector: 'h1.product-title' });

    const found = findProfileGenerationRevisionById(rev.id);
    expect(found?.id).toBe(rev.id);
  });

  test('chains parent revisions', () => {
    const gen = makeGeneration('chain-woof.com');
    const first = insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: { titleSelector: 'h1' },
      status: 'rejected',
    });
    const second = insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 2,
      parentRevisionId: first.id,
      source: 'manager_feedback',
      selectors: { titleSelector: 'h1.product-title' },
      status: 'validated',
    });
    expect(second.parentRevisionId).toBe(first.id);

    const all = listRevisionsByGeneration(gen.id);
    expect(all.length).toBe(2);
    expect(all[0].revisionNumber).toBe(2);
    expect(all[1].revisionNumber).toBe(1);
  });

  test('listRevisionsByGeneration can filter by status', () => {
    const gen = makeGeneration('filter-status.com');
    insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: { titleSelector: 'a' },
      status: 'draft',
    });
    insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 2,
      source: 'system_validation',
      selectors: { titleSelector: 'b' },
      status: 'validated',
    });

    const validated = listRevisionsByGeneration(gen.id, { status: 'validated' });
    expect(validated.length).toBe(1);
    expect(validated[0].revisionNumber).toBe(2);
  });

  test('findLatestValidatedRevision returns the most recent validated one', () => {
    const gen = makeGeneration('latest-validated.com');
    insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: { titleSelector: 'a' },
      status: 'validated',
    });
    const second = insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 2,
      source: 'manager_feedback',
      selectors: { titleSelector: 'b' },
      status: 'validated',
    });
    insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 3,
      source: 'system_validation',
      selectors: { titleSelector: 'c' },
      status: 'rejected',
    });

    const latest = findLatestValidatedRevision(gen.id);
    expect(latest?.id).toBe(second.id);
  });

  test('findLatestValidatedRevision returns null when none validated', () => {
    const gen = makeGeneration('no-validated.com');
    insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: { titleSelector: 'a' },
      status: 'rejected',
    });
    expect(findLatestValidatedRevision(gen.id)).toBeNull();
  });

  test('updateProfileGenerationRevisionStatus updates fields and bumps updated_at', async () => {
    const gen = makeGeneration('update-status.com');
    const rev = insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: { titleSelector: 'a' },
      status: 'draft',
    });
    const originalUpdatedAt = rev.updatedAt;

    // Force a timestamp difference.
    await new Promise((r) => setTimeout(r, 5));

    const updated = updateProfileGenerationRevisionStatus(rev.id, 'validated', {
      confidence: 0.95,
      validationSummary: { sources: 2 },
    });
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('validated');
    expect(updated?.confidence).toBe(0.95);
    expect(updated?.validationSummary).toEqual({ sources: 2 });
    expect(updated?.updatedAt).not.toBe(originalUpdatedAt);
  });

  test('insertRevisionValidationResult + listValidationResultsByRevision round-trip', () => {
    const gen = makeGeneration('validation-rw.com');
    const rev = insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: { titleSelector: 'h1' },
      status: 'validated',
    });

    const r1 = insertRevisionValidationResult({
      revisionId: rev.id,
      selectorField: 'titleSelector',
      sampleUrl: 'https://validation-rw.com/a',
      expectedName: 'Product A',
      extractedValue: { text: 'Product A' },
      status: 'pass',
    });
    const r2 = insertRevisionValidationResult({
      revisionId: rev.id,
      selectorField: 'titleSelector',
      sampleUrl: 'https://validation-rw.com/b',
      imagePreviews: ['https://cdn.example.com/img1.png'],
      warnings: ['looks like a recommendation'],
      status: 'warning',
    });

    expect(r1.status).toBe('pass');
    expect(r2.status).toBe('warning');
    expect(r2.warnings).toEqual(['looks like a recommendation']);

    const list = listValidationResultsByRevision(rev.id);
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(r1.id);
    expect(list[1].id).toBe(r2.id);
  });

  test('insertRevisionValidationResults accepts a batch and returns all rows', () => {
    const gen = makeGeneration('validation-batch.com');
    const rev = insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: { titleSelector: 'h1', imagesSelector: '.g img' },
      status: 'validated',
    });
    const batch = insertRevisionValidationResults(rev.id, [
      {
        selectorField: 'titleSelector',
        sampleUrl: 'https://validation-batch.com/a',
        status: 'pass',
      },
      {
        selectorField: 'titleSelector',
        sampleUrl: 'https://validation-batch.com/b',
        status: 'pass',
      },
      {
        selectorField: 'imagesSelector',
        sampleUrl: 'https://validation-batch.com/a',
        imagePreviews: ['https://cdn.example.com/img1.png', 'https://cdn.example.com/img2.png'],
        status: 'warning',
        warnings: ['repeated identical image across samples'],
      },
    ]);
    expect(batch.length).toBe(3);
    expect(listValidationResultsByRevision(rev.id).length).toBe(3);
  });

  test('revisions and validation results are deleted when the parent generation is deleted (FK CASCADE)', () => {
    const gen = makeGeneration('cascade-test.com');
    const rev = insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'initial_generation',
      selectors: { titleSelector: 'h1' },
      status: 'validated',
    });
    insertRevisionValidationResult({
      revisionId: rev.id,
      selectorField: 'titleSelector',
      sampleUrl: 'https://cascade-test.com/a',
      status: 'pass',
    });

    // Manually delete the parent generation. The FK should cascade.
    const { getDb } = require('../../db/connection');
    getDb().query('DELETE FROM profile_generations WHERE id = ?').run(gen.id);

    expect(findProfileGenerationRevisionById(rev.id)).toBeNull();
    expect(listValidationResultsByRevision(rev.id).length).toBe(0);
  });

  test('JSON round-trip preserves feedback and validation summary', () => {
    const gen = makeGeneration('json-roundtrip.com');
    const complex = {
      text: 'Value should mention "Lavender"',
      excludedImages: ['https://cdn.example.com/recommendation-1.png'],
      metadata: { reason: 'wrong field' },
    };
    const rev = insertProfileGenerationRevision({
      generationId: gen.id,
      revisionNumber: 1,
      source: 'manager_feedback',
      selectors: { titleSelector: 'h1' },
      feedback: complex,
      validationSummary: { sources: 3, samples: 3 },
      status: 'validated',
    });
    const found = findProfileGenerationRevisionById(rev.id);
    expect(found?.feedback).toEqual(complex);
    expect(found?.validationSummary).toEqual({ sources: 3, samples: 3 });
  });
});
