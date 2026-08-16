/**
 * Cohort shadow observations (epic #46 review round, Package B).
 *
 * Durable PR4 C5 shadow artifact: one `cohort_shadow_observations` row per
 * cohort per state CHANGE so a shadow-enabled live batch is measurable.
 * Proves insert+list round-trip, restart-safe dedupe (unchanged state never
 * duplicates), change detection (a changed outcome DOES insert), and
 * migration idempotency.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  insertCohortShadowObservationIfChanged,
  listCohortShadowObservations,
  type CohortShadowObservationInput,
} from '../../db/repositories/curation-cohort-repo';
import type { Workspace } from '../../shared/types';

const WORKSPACE_ID = 'ws-shadow-test';
const COHORT_ID = 'cohort-betterbone-vnsn';

function observationInput(overrides: Partial<CohortShadowObservationInput> = {}): CohortShadowObservationInput {
  return {
    workspaceId: WORKSPACE_ID,
    cohortId: COHORT_ID,
    groupKey: 'betterbone::better bone vnsn',
    groupLabel: 'BETTER BONE MD VNSNLG',
    status: 'ready',
    memberCount: 2,
    readyCount: 2,
    executionTypeId: 'dog-toys',
    productTypeConfidence: null,
    outcome: 'coherent',
    membersJson: JSON.stringify([
      { onboardingItemId: 'i1', productSku: '100000000001', productTypeId: 'dog-toys', source: 'keyword' },
      { onboardingItemId: 'i2', productSku: '100000000002', productTypeId: 'dog-toys', source: 'keyword' },
    ]),
    groupingVersion: 'product-family-v1',
    observedAt: '2026-08-16T09:00:00.000Z',
    ...overrides,
  };
}

describe('cohort shadow observations', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohort-shadow-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    const ws: Workspace = {
      id: WORKSPACE_ID,
      name: 'Shadow Test',
      workspacePath: tempDir + '/ws',
      gitPath: tempDir + '/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('insert + list round-trip: newest first, limit works', () => {
    const first = insertCohortShadowObservationIfChanged(
      observationInput({ observedAt: '2026-08-16T09:00:00.000Z' }),
    );
    // Changed outcome + later timestamp → second row.
    const second = insertCohortShadowObservationIfChanged(
      observationInput({ outcome: 'abstained', executionTypeId: null, observedAt: '2026-08-16T10:00:00.000Z' }),
    );
    expect(first).toBe(true);
    expect(second).toBe(true);

    const all = listCohortShadowObservations(WORKSPACE_ID, 50);
    expect(all.length).toBe(2);
    expect(all[0].observedAt).toBe('2026-08-16T10:00:00.000Z');
    expect(all[1].observedAt).toBe('2026-08-16T09:00:00.000Z');
    expect(all[0].outcome).toBe('abstained');
    expect(all[0].groupKey).toBe('betterbone::better bone vnsn');
    expect(all[0].memberCount).toBe(2);

    const limited = listCohortShadowObservations(WORKSPACE_ID, 1);
    expect(limited.length).toBe(1);
    expect(limited[0].outcome).toBe('abstained');
  });

  test('dedupe: an unchanged state never inserts a duplicate row', () => {
    expect(insertCohortShadowObservationIfChanged(observationInput())).toBe(true);
    // Exact same state (same outcome/type/members/count) → no row.
    expect(insertCohortShadowObservationIfChanged(observationInput())).toBe(false);
    expect(listCohortShadowObservations(WORKSPACE_ID, 50).length).toBe(1);
  });

  test('change detection: a changed outcome DOES produce a new row', () => {
    insertCohortShadowObservationIfChanged(observationInput());
    const inserted = insertCohortShadowObservationIfChanged(
      observationInput({ outcome: 'conflicted', executionTypeId: null }),
    );
    expect(inserted).toBe(true);
    const rows = listCohortShadowObservations(WORKSPACE_ID, 50);
    expect(rows.length).toBe(2);
    expect(rows[0].outcome).toBe('conflicted');
  });

  test('change detection: member-count change produces a new row', () => {
    insertCohortShadowObservationIfChanged(observationInput());
    const inserted = insertCohortShadowObservationIfChanged(
      observationInput({ memberCount: 1, readyCount: 1, membersJson: JSON.stringify([{ onboardingItemId: 'i1', productSku: '100000000001', productTypeId: 'dog-toys', source: 'keyword' }]) }),
    );
    expect(inserted).toBe(true);
    expect(listCohortShadowObservations(WORKSPACE_ID, 50).length).toBe(2);
  });

  test('different cohorts never interfere (dedupe is per cohort)', () => {
    insertCohortShadowObservationIfChanged(observationInput());
    const other = insertCohortShadowObservationIfChanged(
      observationInput({ cohortId: 'cohort-other', groupKey: 'no-brand::better bone vnsn' }),
    );
    expect(other).toBe(true);
    const rows = listCohortShadowObservations(WORKSPACE_ID, 50);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map(r => r.cohortId)).size).toBe(2);
  });

  test('migration idempotency: runMigrations() twice does not fail', () => {
    expect(() => runMigrations()).not.toThrow();
    // Table still writable after the second pass.
    expect(insertCohortShadowObservationIfChanged(observationInput())).toBe(true);
    expect(listCohortShadowObservations(WORKSPACE_ID, 50).length).toBe(1);
  });
});
