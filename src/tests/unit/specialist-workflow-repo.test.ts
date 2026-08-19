/**
 * Unit tests for SqliteSpecialistWorkflowRepository (#56).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { SqliteSpecialistWorkflowRepository } from '../../db/repositories/specialist-workflow-repo';
import type { SpecialistWorkflowRecord } from '../../product-intelligence/workflow/orchestrator';

const dbPath = 'src/tests/unit/specialist-workflow-test.db';

describe('SqliteSpecialistWorkflowRepository (#56)', () => {
  beforeAll(() => {
    resetDb();
    try { unlinkSync(dbPath); } catch { /* fresh test database */ }
    initDb(dbPath);
    runMigrations();
  });
  afterAll(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch { /* already removed */ }
  });

  it('persists, updates, and rehydrates specialist workflow state with persistence warnings', () => {
    const repo = new SqliteSpecialistWorkflowRepository();
    const runId = `run-test-sqlite-${Date.now()}`;

    const record: SpecialistWorkflowRecord = {
      workflowId: `wf:${runId}`,
      runId,
      workspaceId: 'ws-test',
      workflowVersion: '1.0.0',
      productSeed: { sku: 'SKU-1', name: 'Test Product', price: '10.00' },
      status: 'in_progress',
      currentPhase: 'extraction',
      retriesCount: 0,
      totalDispatches: 2,
      invocations: { discovery: 1, extraction: 1, profile: 0, resolver: 0, curator: 0, verifier: 0 },
      capabilityInvocationIds: { discovery: ['inv:discovery:1'], extraction: ['inv:extraction:1'], profile_engineer: [], resolver: [], curator: [], verifier: [] },
      extractionArtifactRefs: ['art-1'],
      routeRecords: [{ fromPhase: 'discovery', toPhase: 'extraction', reason: 'found candidate', timestamp: new Date().toISOString() }],
      usage: {
        totalDispatches: 2,
        totalToolCalls: 2,
        totalModelCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.01,
        bySpecialist: {
          discovery: { dispatches: 1, toolCalls: 1, modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0.005, durationMs: 50 },
          extraction: { dispatches: 1, toolCalls: 1, modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0.005, durationMs: 100 },
        },
      },
      stepEvents: [
        { step: 1, specialist: 'discovery', action: 'discover_candidates', status: 'succeeded', durationMs: 50, timestamp: new Date().toISOString() },
      ],
      artifactIds: ['disc:1'],
      persistenceWarnings: ['warning_db_lag: 15ms'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    repo.save(record);

    const loaded = repo.get(runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe(runId);
    expect(loaded?.status).toBe('in_progress');
    expect(loaded?.currentPhase).toBe('extraction');
    expect(loaded?.persistenceWarnings).toEqual(['warning_db_lag: 15ms']);
    expect(loaded?.capabilityInvocationIds.discovery).toEqual(['inv:discovery:1']);
    expect(loaded?.extractionArtifactRefs).toEqual(['art-1']);

    // Update to completed with additional warning (showing warnings durability across state transitions)
    const updatedRecord: SpecialistWorkflowRecord = {
      ...record,
      status: 'completed',
      currentPhase: 'completed',
      persistenceWarnings: ['warning_db_lag: 15ms', 'warning_network_retry: 1'],
      updatedAt: new Date().toISOString(),
    };

    repo.save(updatedRecord);

    const reloaded = repo.get(runId);
    expect(reloaded?.status).toBe('completed');
    expect(reloaded?.persistenceWarnings).toEqual(['warning_db_lag: 15ms', 'warning_network_retry: 1']);
  });
});
