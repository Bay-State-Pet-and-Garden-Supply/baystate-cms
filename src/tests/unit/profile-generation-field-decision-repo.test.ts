/**
 * Unit tests for `src/db/repositories/profile-generation-field-decision-repo.ts`.
 *
 * Runs under `bun test` (excluded from vitest) because the repo is
 * DB-dependent and vitest cannot load `bun:sqlite`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertProfileGeneration } from '../../db/repositories/profile-generation-repo';
import {
  insertProfileFieldDecision,
  findProfileFieldDecisionById,
  listFieldDecisionsByDomain,
  listFieldDecisionsByGeneration,
  findLatestApprovedFieldDecision,
} from '../../db/repositories/profile-generation-field-decision-repo';

describe('Profile Generation Field Decision Repository', () => {
  const testDbPath = 'src/tests/unit/profile-generation-field-decision-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  function makeGeneration(domain: string) {
    return insertProfileGeneration({
      domain,
      sourceUrl: `https://${domain}/p/1`,
      selectors: { titleSelector: 'h1' },
      status: 'validated',
    });
  }

  test('inserts and finds a field decision', () => {
    const gen = makeGeneration('dec-woof.com');
    const decision = insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-woof.com',
      selectorField: 'titleSelector',
      decision: 'approved',
      previousSelector: 'h1.old',
      proposedSelector: 'h1.new',
      approvedSelector: 'h1.new',
    });
    expect(decision.id).toBeDefined();
    expect(decision.generationId).toBe(gen.id);
    expect(decision.domain).toBe('dec-woof.com');
    expect(decision.selectorField).toBe('titleSelector');
    expect(decision.decision).toBe('approved');
    expect(decision.previousSelector).toBe('h1.old');
    expect(decision.approvedSelector).toBe('h1.new');

    const found = findProfileFieldDecisionById(decision.id);
    expect(found?.id).toBe(decision.id);
  });

  test('normalizes domains (lowercase, strip www.)', () => {
    const gen = makeGeneration('dec-norm.com');
    const decision = insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'WWW.DecNorm.com',
      selectorField: 'titleSelector',
      decision: 'approved',
    });
    expect(decision.domain).toBe('decnorm.com');

    const list = listFieldDecisionsByDomain('www.decnorm.com');
    expect(list.length).toBe(1);
  });

  test('round-trips JSON feedback and validation_result_ids', () => {
    const gen = makeGeneration('dec-json.com');
    const feedback = { note: 'Title looks good', reviewer: 'sam' };
    const decision = insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-json.com',
      selectorField: 'titleSelector',
      decision: 'approved',
      feedback,
      validationResultIds: ['vr-1', 'vr-2', 'vr-3'],
    });
    const found = findProfileFieldDecisionById(decision.id);
    expect(found?.feedback).toEqual(feedback);
    expect(found?.validationResultIds).toEqual(['vr-1', 'vr-2', 'vr-3']);
  });

  test('listFieldDecisionsByDomain returns the full set', () => {
    const gen = makeGeneration('dec-list.com');
    insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-list.com',
      selectorField: 'titleSelector',
      decision: 'approved',
    });
    insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-list.com',
      selectorField: 'descriptionSelector',
      decision: 'rejected',
    });
    insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-list.com',
      selectorField: 'imagesSelector',
      decision: 'rejected',
    });
    const list = listFieldDecisionsByDomain('dec-list.com');
    expect(list.length).toBe(3);
    expect(new Set(list.map((d) => d.selectorField))).toEqual(
      new Set(['titleSelector', 'descriptionSelector', 'imagesSelector']),
    );
  });

  test('listFieldDecisionsByDomain can filter by selectorField and decision', () => {
    const gen = makeGeneration('dec-filter.com');
    insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-filter.com',
      selectorField: 'titleSelector',
      decision: 'approved',
    });
    insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-filter.com',
      selectorField: 'titleSelector',
      decision: 'rejected',
    });
    insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-filter.com',
      selectorField: 'imagesSelector',
      decision: 'rejected',
    });

    const titleApproved = listFieldDecisionsByDomain('dec-filter.com', {
      selectorField: 'titleSelector',
      decision: 'approved',
    });
    expect(titleApproved.length).toBe(1);

    const rejected = listFieldDecisionsByDomain('dec-filter.com', {
      decision: 'rejected',
    });
    expect(rejected.length).toBe(2);
  });

  test('listFieldDecisionsByGeneration returns all decisions for a generation', () => {
    const gen = makeGeneration('dec-by-gen.com');
    insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-by-gen.com',
      selectorField: 'titleSelector',
      decision: 'approved',
    });
    insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-by-gen.com',
      selectorField: 'descriptionSelector',
      decision: 'rejected',
    });
    const list = listFieldDecisionsByGeneration(gen.id);
    expect(list.length).toBe(2);
    expect(list[0].decidedAt <= list[1].decidedAt).toBe(true);
  });

  test('findLatestApprovedFieldDecision returns the most recent approved', async () => {
    const gen = makeGeneration('dec-latest.com');
    // Force a timestamp difference between two decisions.
    const first = insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-latest.com',
      selectorField: 'titleSelector',
      decision: 'approved',
      approvedSelector: 'h1.first',
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-latest.com',
      selectorField: 'titleSelector',
      decision: 'approved',
      approvedSelector: 'h1.second',
    });

    const latest = findLatestApprovedFieldDecision('dec-latest.com', 'titleSelector');
    expect(latest?.id).toBe(second.id);
    expect(latest?.approvedSelector).toBe('h1.second');
  });

  test('findLatestApprovedFieldDecision excludes approvals that have been rolled back', async () => {
    const gen = makeGeneration('dec-rolled.com');
    // Original approval for selector X.
    const approval = insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-rolled.com',
      selectorField: 'titleSelector',
      decision: 'approved',
      approvedSelector: 'h1.first-revision',
    });
    // Rollback targeting the same approved selector.
    insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-rolled.com',
      selectorField: 'titleSelector',
      decision: 'rolled_back',
      previousSelector: 'h1.first-revision',
    });
    // Different selector on the same field; not rolled back.
    await new Promise((r) => setTimeout(r, 5));
    const fresh = insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-rolled.com',
      selectorField: 'titleSelector',
      decision: 'approved',
      approvedSelector: 'h1.second-revision',
    });

    const latest = findLatestApprovedFieldDecision('dec-rolled.com', 'titleSelector');
    expect(latest?.id).toBe(fresh.id);
    expect(latest?.approvedSelector).toBe('h1.second-revision');
    // Sanity: the rolled-back approval is still in the table for audit.
    const all = listFieldDecisionsByDomain('dec-rolled.com', {
      selectorField: 'titleSelector',
    });
    expect(all.length).toBe(3);
    expect(all.some((d) => d.id === approval.id)).toBe(true);
  });

  test('findLatestApprovedFieldDecision returns null when there are no approvals', () => {
    makeGeneration('dec-empty.com');
    expect(findLatestApprovedFieldDecision('dec-empty.com', 'titleSelector')).toBeNull();
  });

  test('decided_by and notes round-trip', () => {
    const gen = makeGeneration('dec-meta.com');
    const decision = insertProfileFieldDecision({
      generationId: gen.id,
      domain: 'dec-meta.com',
      selectorField: 'imagesSelector',
      decision: 'rejected',
      decidedBy: 'reviewer@example.com',
      notes: 'Looks like recommendation carousel; do not approve.',
    });
    const found = findProfileFieldDecisionById(decision.id);
    expect(found?.decidedBy).toBe('reviewer@example.com');
    expect(found?.notes).toMatch(/recommendation carousel/i);
  });
});
