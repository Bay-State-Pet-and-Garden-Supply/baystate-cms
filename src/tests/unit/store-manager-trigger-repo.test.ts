import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import {
  createTrigger,
  getTrigger,
  listTriggers,
  listEnabledTriggers,
  updateTriggerDefinition,
  setTriggerEnabled,
  createTriggerOccurrence,
  getTriggerOccurrence,
  listDueTriggerOccurrences,
  claimTriggerOccurrence,
  heartbeatTriggerOccurrence,
  finalizeTriggerOccurrence,
  requeueTriggerOccurrence,
  expireStaleTriggerLeases,
  cancelOverdueTriggerOccurrences,
  listOccurrencesByTrigger,
  listRecentTerminalTriggerOccurrences,
  getSourceCursor,
  upsertSourceCursor,
  type CreateTriggerInput,
  type CreateTriggerOccurrenceInput,
} from '../../db/repositories/store-manager-trigger-repo';

/**
 * Trigger repository (Issue 5). DB-backed: run under `bun test`.
 */

const wsA = 'ws-trigger-a';
const wsB = 'ws-trigger-b';
const wsC = 'ws-trigger-c';

function makeTrigger(workspaceId: string, overrides: Partial<CreateTriggerInput> = {}): CreateTriggerInput {
  return {
    workspaceId,
    name: 'Import finished audit',
    kind: 'import_finished',
    config: { kind: 'import_finished', batchId: null },
    scopeJson: null,
    selectedModel: null,
    objective: 'Audit the Product SKUs that finished importing (read-only).',
    definitionHash: 'b'.repeat(64),
    enabled: false,
    ...overrides,
  };
}

function makeOccurrence(
  workspaceId: string,
  triggerId: string,
  occurrenceKey: string,
  overrides: Partial<CreateTriggerOccurrenceInput> = {},
): CreateTriggerOccurrenceInput {
  return {
    workspaceId,
    triggerId,
    triggerVersion: 1,
    occurrenceKey,
    sourceRef: { kind: 'change_set', id: 'cs-1' },
    scopeJson: null,
    scheduledAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('store_manager_triggers repository (Issue 5)', () => {
  const testDbPath = './test-trigger-repo.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('creates a disabled trigger with an immutable version row', () => {
    const trigger = createTrigger(makeTrigger(wsA, { name: 'Repo trigger A' }));
    expect(trigger.id).toBeTruthy();
    expect(trigger.version).toBe(1);
    expect(trigger.enabled).toBe(false);
    expect(getTrigger(wsA, trigger.id)?.id).toBe(trigger.id);
    // Foreign workspace lookup is indistinguishable from missing.
    expect(getTrigger(wsB, trigger.id)).toBeNull();
    expect(listTriggers(wsA).some((t) => t.id === trigger.id)).toBe(true);
    expect(listEnabledTriggers(wsA).some((t) => t.id === trigger.id)).toBe(false);
  });

  it('bumps the definition version immutably and keeps enabled state', () => {
    const trigger = createTrigger(makeTrigger(wsA, { name: 'Versioned trigger' }));
    const updated = updateTriggerDefinition(wsA, trigger.id, {
      name: 'Versioned trigger v2',
      config: { kind: 'product_field_drift', threshold: 9 },
      scopeJson: null,
      selectedModel: null,
      objective: trigger.objective,
      definitionHash: 'c'.repeat(64),
    });
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('Versioned trigger v2');
    expect(updated.config.kind).toBe('product_field_drift');
    // Kind is immutable through the definition path (enforced in service; the
    // repo stores whatever the service validated).
    const reloaded = getTrigger(wsA, trigger.id);
    expect(reloaded?.config).toMatchObject({ kind: 'product_field_drift', threshold: 9 });
    // A second bump produces version 3.
    const v3 = updateTriggerDefinition(wsA, trigger.id, {
      name: 'Versioned trigger v3',
      config: { kind: 'product_field_drift', threshold: 9 },
      scopeJson: null,
      selectedModel: null,
      objective: trigger.objective,
      definitionHash: 'd'.repeat(64),
    });
    expect(v3.version).toBe(3);
  });

  it('setTriggerEnabled records an audit hash and only mutates the workspace row', () => {
    const trigger = createTrigger(makeTrigger(wsA));
    const enabled = setTriggerEnabled(wsA, trigger.id, true, 'audit-hash-1');
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.enableAuditJson).toBe('audit-hash-1');
    expect(setTriggerEnabled(wsB, trigger.id, true, 'audit-foreign')).toBeNull();
    // Back to disabled.
    expect(setTriggerEnabled(wsA, trigger.id, false, 'audit-hash-2')?.enabled).toBe(false);
  });

  it('occurrences dedupe on the unique per-workspace occurrence key', () => {
    const trigger = createTrigger(makeTrigger(wsA));
    const first = createTriggerOccurrence(makeOccurrence(wsA, trigger.id, 'key-1'));
    const second = createTriggerOccurrence(makeOccurrence(wsA, trigger.id, 'key-1'));
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('pending');
    // Same key in another workspace is a different row (workspace-isolated).
    const foreign = createTriggerOccurrence(makeOccurrence(wsB, trigger.id, 'key-1'));
    expect(foreign.id).not.toBe(first.id);
  });

  it('atomic claim refuses a competing worker and finalize only succeeds once', () => {
    const trigger = createTrigger(makeTrigger(wsA));
    const occurrence = createTriggerOccurrence(makeOccurrence(wsA, trigger.id, 'claim-1', { scheduledAt: '2026-01-01T00:00:00.000Z' }));
    expect(claimTriggerOccurrence(wsA, occurrence.id, 'worker-1', 60_000, '2026-01-01T00:01:00.000Z')).toBe(true);
    // Competing claim is refused (atomic WHERE status='pending').
    expect(claimTriggerOccurrence(wsA, occurrence.id, 'worker-2', 60_000, '2026-01-01T00:01:01.000Z')).toBe(false);
    expect(heartbeatTriggerOccurrence(wsA, occurrence.id, 60_000, '2026-01-01T00:02:00.000Z')).toBe(true);
    const finalized = finalizeTriggerOccurrence({ workspaceId: wsA, occurrenceId: occurrence.id, status: 'completed', runId: 'run-1' });
    expect(finalized?.status).toBe('completed');
    // Finalizing a second time has no effect (not claimed anymore).
    const second = finalizeTriggerOccurrence({ workspaceId: wsA, occurrenceId: occurrence.id, status: 'failed', errorCode: 'x' });
    expect(second).toBeNull();
    expect(getTriggerOccurrence(wsA, occurrence.id)?.status).toBe('completed');
  });

  it('requeue bumps retry_count and only applies to claimed rows', () => {
    const trigger = createTrigger(makeTrigger(wsA));
    const occurrence = createTriggerOccurrence(makeOccurrence(wsA, trigger.id, 'requeue-1', { scheduledAt: '2026-01-01T00:00:00.000Z' }));
    // Not claimed → requeue refused.
    expect(requeueTriggerOccurrence(wsA, occurrence.id, '2026-01-01T00:10:00.000Z', 'err')).toBeNull();
    claimTriggerOccurrence(wsA, occurrence.id, 'worker-1', 60_000, '2026-01-01T00:01:00.000Z');
    const requeued = requeueTriggerOccurrence(wsA, occurrence.id, '2026-01-01T00:10:00.000Z', 'model_unavailable');
    expect(requeued?.status).toBe('pending');
    expect(requeued?.retryCount).toBe(1);
    expect(requeued?.scheduledAt).toBe('2026-01-01T00:10:00.000Z');
    expect(requeued?.errorCode).toBe('model_unavailable');
  });

  it('listDueTriggerOccurrences only returns pending rows at or before now', () => {
    const trigger = createTrigger(makeTrigger(wsB));
    createTriggerOccurrence(makeOccurrence(wsB, trigger.id, 'due-1', { scheduledAt: '2026-01-01T00:00:00.000Z' }));
    createTriggerOccurrence(makeOccurrence(wsB, trigger.id, 'due-2', { scheduledAt: '2026-01-01T00:30:00.000Z' }));
    createTriggerOccurrence(makeOccurrence(wsB, trigger.id, 'due-3', { scheduledAt: '2026-01-01T00:00:00.000Z', status: 'completed' }));
    const due = listDueTriggerOccurrences(wsB, '2026-01-01T01:00:00.000Z', { limit: 50 });
    const keys = due.map((o) => o.occurrenceKey).filter((k) => k.startsWith('due-')).sort();
    expect(keys).toEqual(['due-1', 'due-2'].sort());
  });

  it('expireStaleTriggerLeases returns crashed claims to pending', () => {
    const trigger = createTrigger(makeTrigger(wsA));
    const occurrence = createTriggerOccurrence(makeOccurrence(wsA, trigger.id, 'lease-1', { scheduledAt: '2026-01-01T00:00:00.000Z' }));
    claimTriggerOccurrence(wsA, occurrence.id, 'worker-crashed', 60_000, '2026-01-01T00:01:00.000Z');
    // Lease expired at 00:02; at 00:03 it must be released back to pending.
    const released = expireStaleTriggerLeases(wsA, '2026-01-01T00:03:00.000Z');
    expect(released).toBeGreaterThanOrEqual(1);
    expect(getTriggerOccurrence(wsA, occurrence.id)?.status).toBe('pending');
    expect(getTriggerOccurrence(wsA, occurrence.id)?.errorCode).toBe('lease_expired');
  });

  it('cancelOverdueTriggerOccurrences cancels pending rows beyond the cutoff', () => {
    const trigger = createTrigger(makeTrigger(wsC));
    createTriggerOccurrence(makeOccurrence(wsC, trigger.id, 'overdue-1', { scheduledAt: '2026-01-01T00:00:00.000Z' }));
    createTriggerOccurrence(makeOccurrence(wsC, trigger.id, 'fresh-1', { scheduledAt: '2026-01-05T00:00:00.000Z' }));
    const cancelled = cancelOverdueTriggerOccurrences(wsC, '2026-01-02T00:00:00.000Z');
    expect(cancelled).toBe(1);
    const all = listOccurrencesByTrigger(wsC, trigger.id, { limit: 50 });
    expect(all.find((o) => o.occurrenceKey === 'overdue-1')?.status).toBe('cancelled');
    expect(all.find((o) => o.occurrenceKey === 'fresh-1')?.status).toBe('pending');
  });

  it('diagnostic occurrences are durable and listable like any status', () => {
    const trigger = createTrigger(makeTrigger(wsA));
    const diagnostic = createTriggerOccurrence(makeOccurrence(wsA, trigger.id, 'diag-1', {
      status: 'diagnostic',
      errorCode: 'import_not_terminal',
      sourceRef: { kind: 'onboarding_batch', id: 'batch-1' },
    }));
    expect(diagnostic.status).toBe('diagnostic');
    expect(diagnostic.errorCode).toBe('import_not_terminal');
    const listed = listOccurrencesByTrigger(wsA, trigger.id, { status: 'diagnostic', limit: 50 });
    expect(listed.some((o) => o.id === diagnostic.id)).toBe(true);
  });

  it('source cursors upsert atomically per (workspace, source_kind, source_id) with fingerprint + baseline', () => {
    const first = upsertSourceCursor({
      workspaceId: wsA,
      sourceKind: 'onboarding_batch',
      sourceId: 'batch-1',
      fingerprint: 'fp-1',
      baselineJson: JSON.stringify({ f1: 1 }),
      terminalObserved: false,
      lastObservedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(first.fingerprint).toBe('fp-1');
    expect(first.evalCount).toBe(1);
    const second = upsertSourceCursor({
      workspaceId: wsA,
      sourceKind: 'onboarding_batch',
      sourceId: 'batch-1',
      fingerprint: 'fp-2',
      baselineJson: JSON.stringify({ f1: 3 }),
      terminalObserved: true,
      lastObservedAt: '2026-01-01T00:05:00.000Z',
    });
    expect(second.fingerprint).toBe('fp-2');
    expect(second.evalCount).toBe(2);
    expect(second.terminalObserved).toBe(true);
    // Foreign workspace cursor is independent.
    const foreign = getSourceCursor(wsB, 'onboarding_batch', 'batch-1');
    expect(foreign).toBeNull();
  });

  it('listRecentTerminalTriggerOccurrences is bounded and workspace-scoped', () => {
    const trigger = createTrigger(makeTrigger(wsA));
    const failed = createTriggerOccurrence(makeOccurrence(wsA, trigger.id, 'recent-1', { scheduledAt: '2026-01-01T00:00:00.000Z' }));
    claimTriggerOccurrence(wsA, failed.id, 'worker-1', 60_000, '2026-01-01T00:01:00.000Z');
    finalizeTriggerOccurrence({ workspaceId: wsA, occurrenceId: failed.id, status: 'failed', errorCode: 'deadline_exceeded', nowIso: '2026-01-01T00:02:00.000Z' });
    const recent = listRecentTerminalTriggerOccurrences(wsA, '2026-01-01T00:00:00.000Z');
    expect(recent.some((o) => o.id === failed.id)).toBe(true);
    expect(recent[0]?.errorCode).toBe('deadline_exceeded');
    // Foreign workspace is invisible.
    expect(listRecentTerminalTriggerOccurrences(wsB, '2026-01-01T00:00:00.000Z')).toHaveLength(0);
  });
});
