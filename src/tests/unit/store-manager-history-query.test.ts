import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { executeHistoryQuery, StoreManagerHistoryQueryError } from '../../server/services/store-manager-history-query-service';
import { describeHistoryQueries } from '../../store-manager/history/query-registry';
import { insertProposal } from '../../db/repositories/catalog-health-proposal-repo';
import { recordReviewDecision } from '../../db/repositories/store-manager-history-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createStoreManagerSession } from '../../db/repositories/store-manager-session-repo';
import { createStoreManagerArtifact } from '../../store-manager/runtime/artifacts';
import { createStoreManagerRunArtifact } from '../../db/repositories/store-manager-session-repo';

/**
 * Operations console Issue 7 — bounded NL history queries.
 * The model maps text to a query ID + typed params ONLY; the registry never
 * accepts SQL, and unknown queries return the supported set.
 * DB-backed: run under `bun test`.
 */

const workspaceId = 'ws-query';
const testDbPath = './test-history-query.db';

describe('Store Manager history queries (epic #42, Issue 7)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    insertWorkspace({
      id: workspaceId,
      name: 'qws',
      workspacePath: './ws',
      gitPath: './ws-git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'not_started',
      baselineCommit: null,
    } as never);

    // Seed proposals + review decisions for field_cleanup_work / rejected-more-than-once.
    insertProposal({
      workspaceId,
      field: 'ProductField24',
      oldValue: 'Old',
      newValue: 'New',
      affectedSkus: ['SKU-A'],
      reason: 'casing normalization',
      confidence: 0.95,
      source: 'deterministic',
      status: 'proposed',
    });
    insertProposal({
      workspaceId,
      field: 'ProductField9',
      oldValue: 'A',
      newValue: 'B',
      affectedSkus: ['SKU-B'],
      reason: 'typo correction',
      confidence: 0.85,
      source: 'deterministic',
      status: 'proposed',
    });
    for (let i = 0; i < 2; i += 1) {
      recordReviewDecision({
        workspaceId,
        proposalId: 'prop-rejected',
        field: 'ProductField24',
        decision: 'dismissed',
        actor: 'operator',
        runId: 'run-q-1',
      });
    }
    recordReviewDecision({
      workspaceId,
      proposalId: 'prop-single',
      field: 'ProductField9',
      decision: 'dismissed',
      actor: 'operator',
      runId: 'run-q-2',
    });

    // Source cursors for recurring_issues.
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO store_manager_source_cursors
        (id, workspace_id, source_kind, source_id, fingerprint, terminal_observed,
         last_observed_at, eval_count, created_at, updated_at)
       VALUES ('cur-a', ?, 'high_severity_catalog_issues', 'fp-7', 'fp-7', 1, ?, 3, ?, ?)`,
      [workspaceId, now, now, now],
    );

    // Report artifacts for what_got_worse (requires real run rows).
    createStoreManagerSession({
      id: 'run-q-1',
      workspaceId,
      threadId: null,
      turnId: 'turn-q-1',
      executionId: 'exec-q-1',
      policyHash: 'p'.repeat(64),
      policyVersion: 2,
      requestedModel: null,
      resolvedProvider: 'fake',
      resolvedModel: 'fake',
      resolvedLocality: 'cloud',
      resolutionReason: 'explicit',
      modelCallId: null,
      objective: 'Run q1.',
      entrypoint: 'command',
      executionMode: 'interactive',
      actorClass: 'operator',
    });
    createStoreManagerSession({
      id: 'run-q-2',
      workspaceId,
      threadId: null,
      turnId: 'turn-q-2',
      executionId: 'exec-q-2',
      policyHash: 'q'.repeat(64),
      policyVersion: 2,
      requestedModel: null,
      resolvedProvider: 'fake',
      resolvedModel: 'fake',
      resolvedLocality: 'cloud',
      resolutionReason: 'explicit',
      modelCallId: null,
      objective: 'Run q2.',
      entrypoint: 'command',
      executionMode: 'interactive',
      actorClass: 'operator',
    });
    const mkReport = (runId: string, issueCount: number) => {
      const artifact = createStoreManagerArtifact({
        runId,
        workspaceId,
        kind: 'report',
        schemaVersion: 1,
        content: { issueCount, criticalCount: 2 },
      });
      createStoreManagerRunArtifact({
        workspaceId,
        runId,
        kind: 'report',
        schemaVersion: 1,
        contentJson: JSON.stringify({ issueCount, criticalCount: 2 }),
        contentHash: artifact.contentHash,
        id: artifact.id,
        createdAt: artifact.createdAt,
      });
    };
    mkReport('run-q-1', 5);
    mkReport('run-q-2', 9);
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(`${testDbPath}${suffix}`); } catch { /* ok */ }
    }
  });

  it('the query surface is finite and server-owned', () => {
    const descriptors = describeHistoryQueries();
    expect(descriptors.map((d) => d.queryId).sort()).toEqual([
      'field_cleanup_work',
      'proposals_rejected_repeatedly',
      'recurring_issues',
      'what_got_worse',
    ]);
  });

  it('field_cleanup_work ranks fields by proposal + review-decision volume', () => {
    const result = executeHistoryQuery(workspaceId, 'field_cleanup_work', {});
    expect(result.queryId).toBe('field_cleanup_work');
    expect(result.columns).toContain('field');
    const row = result.rows.find((r) => r.field === 'ProductField24');
    expect(row).toBeDefined();
    expect(Number(row!.proposals)).toBeGreaterThanOrEqual(1);
    expect(Number(row!.review_decisions)).toBeGreaterThanOrEqual(2);
  });

  it('proposals_rejected_repeatedly returns only proposals rejected more than once with decision lineage', () => {
    const result = executeHistoryQuery(workspaceId, 'proposals_rejected_repeatedly', { minRejections: 2 });
    expect(result.matchedRows).toBe(1);
    expect(result.rows[0].proposal_id).toBe('prop-rejected');
    expect(result.rows[0].rejections).toBe(2);
    // The decision history traces to the source run id.
    expect(result.sourceRunIds).toContain('run-q-1');
  });

  it('recurring_issues reports the cursor-backed fingerprint recurrence count', () => {
    const result = executeHistoryQuery(workspaceId, 'recurring_issues', { minOccurrences: 2 });
    const row = result.rows.find((r) => r.kind === 'high_severity_catalog_issues');
    expect(row).toBeDefined();
    expect(Number(row!.occurrences)).toBe(3);
  });

  it('what_got_worse lists deterministic deltas where values grew between two reports', () => {
    const result = executeHistoryQuery(workspaceId, 'what_got_worse', { runIdA: 'run-q-1', runIdB: 'run-q-2' });
    expect(result.matchedRows).toBe(1);
    expect(result.rows[0].field).toBe('issueCount');
    expect(result.rows[0].worse).toBe('4');
  });

  it('unknown queries and invalid params are refused — the surface never widens to SQL', () => {
    expect(() => executeHistoryQuery(workspaceId, 'SELECT * FROM secrets', {})).toThrow(StoreManagerHistoryQueryError);
    expect(() => executeHistoryQuery(workspaceId, 'what_got_worse', { runIdA: 'a', runIdB: 42 })).toThrow(StoreManagerHistoryQueryError);
    expect(() => executeHistoryQuery('other-ws', 'field_cleanup_work', {})).not.toThrow(); // workspace-scoped (empty result)
    const empty = executeHistoryQuery('other-ws', 'field_cleanup_work', {});
    expect(empty.matchedRows).toBe(0);
  });
});
