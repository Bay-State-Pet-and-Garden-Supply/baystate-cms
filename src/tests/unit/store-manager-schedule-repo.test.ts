import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import {
  createSchedule,
  getSchedule,
  listSchedules,
  updateScheduleDefinition,
  setScheduleEnabled,
  createOccurrence,
  getOccurrence,
  listDueOccurrences,
  claimOccurrence,
  heartbeatOccurrence,
  finalizeOccurrence,
  requeueOccurrence,
  expireStaleLeases,
  cancelOverdueOccurrences,
  listOccurrencesBySchedule,
  type CreateScheduleInput,
} from '../../db/repositories/store-manager-schedule-repo';

/**
 * Schedule repository (Issue 4). DB-backed: run under `bun test`.
 */

const wsA = 'ws-schedule-a';
const wsB = 'ws-schedule-b';

function makeSchedule(workspaceId: string, overrides: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    workspaceId,
    name: 'Daily catalog health',
    templateKind: 'daily_catalog_health',
    timezone: 'UTC',
    recurrencePreset: 'daily',
    timeOfDay: '06:00',
    dayOfWeek: null,
    scopeJson: null,
    selectedModel: null,
    objective: 'Run a read-only catalog health scan.',
    definitionHash: 'a'.repeat(64),
    policyProfileJson: null,
    enabled: false,
    ...overrides,
  };
}

describe('store_manager_schedules repository (Issue 4)', () => {
  const testDbPath = './test-schedule-repo.db';

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

  it('creates schedules with version 1 and immutable version rows', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Repo test A' }));
    expect(schedule.version).toBe(1);
    expect(schedule.enabled).toBe(false);
    expect(schedule.definitionHash).toBe('a'.repeat(64));
    const fetched = getSchedule(wsA, schedule.id);
    expect(fetched?.name).toBe('Repo test A');
    expect(getSchedule(wsB, schedule.id)).toBeNull(); // workspace isolation
  });

  it('updateScheduleDefinition bumps the version and persists a new immutable version', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Version test' }));
    const updated = updateScheduleDefinition(wsA, schedule.id, {
      timezone: 'America/New_York',
      definitionHash: 'b'.repeat(64),
    });
    expect(updated.version).toBe(2);
    expect(updated.timezone).toBe('America/New_York');
    const refetched = getSchedule(wsA, schedule.id);
    expect(refetched?.definitionHash).toBe('b'.repeat(64));
    expect(() => updateScheduleDefinition(wsB, schedule.id, { name: 'x', definitionHash: 'c'.repeat(64) })).toThrow(
      /not found/i,
    );
  });

  it('setScheduleEnabled records enable audit and toggles', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Toggle test' }));
    const enabled = setScheduleEnabled(wsA, schedule.id, true, JSON.stringify({ actor: 'operator', at: '2026-01-01T00:00:00.000Z', enabled: true }));
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.enableAuditJson).toContain('operator');
    const disabled = setScheduleEnabled(wsA, schedule.id, false, JSON.stringify({ actor: 'operator', at: '2026-01-02T00:00:00.000Z', enabled: false }));
    expect(disabled?.enabled).toBe(false);
    // foreign workspace cannot toggle
    expect(setScheduleEnabled(wsB, schedule.id, true, '{}')).toBeNull();
  });

  it('creates occurrences with a unique per-workspace occurrence key (idempotent)', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Occurrence test' }));
    const key = `occ-${randomUUID()}`;
    const first = createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: key, scheduledAt: '2026-01-01T06:00:00.000Z' });
    const again = createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: key, scheduledAt: '2026-01-01T06:00:00.000Z' });
    expect(again.id).toBe(first.id); // dedupe, never double-run
    // same key in another workspace is a separate row
    const foreign = createOccurrence({ workspaceId: wsB, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: key, scheduledAt: '2026-01-01T06:00:00.000Z' });
    expect(foreign.id).not.toBe(first.id);
  });

  it('claimOccurrence is atomic: a competing claim is refused', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Claim test' }));
    const occurrence = createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: `claim-${randomUUID()}`, scheduledAt: '2026-01-01T06:00:00.000Z' });
    const now = '2026-01-01T05:00:00.000Z';
    expect(claimOccurrence(wsA, occurrence.id, 'worker-1', 60_000, now)).toBe(true);
    expect(claimOccurrence(wsA, occurrence.id, 'worker-2', 60_000, now)).toBe(false);
    const row = getOccurrence(wsA, occurrence.id);
    expect(row?.status).toBe('claimed');
    expect(row?.claimedAt).toBe(now);
  });

  it('heartbeat extends the lease', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Heartbeat test' }));
    const occurrence = createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: `hb-${randomUUID()}`, scheduledAt: '2026-01-01T06:00:00.000Z' });
    const t0 = '2026-01-01T05:00:00.000Z';
    claimOccurrence(wsA, occurrence.id, 'worker', 60_000, t0);
    const t1 = '2026-01-01T05:01:00.000Z';
    expect(heartbeatOccurrence(wsA, occurrence.id, 60_000, t1)).toBe(true);
    const row = getOccurrence(wsA, occurrence.id);
    expect(row?.leaseExpiresAt).toBe('2026-01-01T05:02:00.000Z');
    expect(row?.heartbeatAt).toBe(t1);
  });

  it('finalizeOccurrence completes a claimed occurrence and clears the lease', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Finalize test' }));
    const occurrence = createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: `fin-${randomUUID()}`, scheduledAt: '2026-01-01T06:00:00.000Z' });
    claimOccurrence(wsA, occurrence.id, 'worker', 60_000, '2026-01-01T05:00:00.000Z');
    const done = finalizeOccurrence({ workspaceId: wsA, occurrenceId: occurrence.id, status: 'completed', runId: 'run-1', nowIso: '2026-01-01T06:00:00.000Z' });
    expect(done?.status).toBe('completed');
    expect(done?.runId).toBe('run-1');
    expect(done?.completedAt).toBe('2026-01-01T06:00:00.000Z');
    // cannot finalize a non-claimed occurrence twice
    expect(finalizeOccurrence({ workspaceId: wsA, occurrenceId: occurrence.id, status: 'failed', nowIso: '2026-01-01T06:01:00.000Z' })).toBeNull();
  });

  it('requeueOccurrence moves a claimed failure back to pending with retry_count+1', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Requeue test' }));
    const occurrence = createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: `rq-${randomUUID()}`, scheduledAt: '2026-01-01T06:00:00.000Z' });
    claimOccurrence(wsA, occurrence.id, 'worker', 60_000, '2026-01-01T05:00:00.000Z');
    const requeued = requeueOccurrence(wsA, occurrence.id, '2026-01-01T05:05:00.000Z', 'model_unavailable');
    expect(requeued?.status).toBe('pending');
    expect(requeued?.retryCount).toBe(1);
    expect(requeued?.scheduledAt).toBe('2026-01-01T05:05:00.000Z');
    expect(requeued?.errorCode).toBe('model_unavailable');
  });

  it('expireStaleLeases returns crashed claims to pending (restart recovery)', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Lease expiry test' }));
    const occurrence = createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: `exp-${randomUUID()}`, scheduledAt: '2026-01-01T06:00:00.000Z' });
    claimOccurrence(wsA, occurrence.id, 'crashed-worker', 60_000, '2026-01-01T05:00:00.000Z');
    const released = expireStaleLeases(wsA, '2026-01-01T05:02:00.000Z');
    // At least OUR crashed claim is released (earlier tests may leave stale
    // leases in the shared test DB; each is also released — never double-run).
    expect(released).toBeGreaterThanOrEqual(1);
    const row = getOccurrence(wsA, occurrence.id);
    expect(row?.status).toBe('pending');
    expect(row?.errorCode).toBe('lease_expired');
  });

  it('cancelOverdueOccurrences marks stale pending occurrences as cancelled', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Cancel test' }));
    const occurrence = createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: `canc-${randomUUID()}`, scheduledAt: '2026-01-01T06:00:00.000Z' });
    const cancelled = cancelOverdueOccurrences(wsA, '2026-01-02T00:00:00.000Z');
    expect(cancelled).toBeGreaterThanOrEqual(1);
    const row = getOccurrence(wsA, occurrence.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.errorCode).toBe('catch_up_window_exceeded');
  });

  it('listDueOccurrences returns only pending occurrences at or before now', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'Due test' }));
    createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: `due-${randomUUID()}`, scheduledAt: '2026-01-01T06:00:00.000Z' });
    createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: `future-${randomUUID()}`, scheduledAt: '2026-02-01T06:00:00.000Z' });
    const due = listDueOccurrences(wsA, '2026-01-01T12:00:00.000Z', { limit: 50 });
    expect(due.length).toBeGreaterThanOrEqual(1);
    for (const occ of due) {
      expect(occ.status).toBe('pending');
      expect(occ.scheduledAt <= '2026-01-01T12:00:00.000Z').toBe(true);
    }
  });

  it('listOccurrencesBySchedule is bounded and workspace-scoped', () => {
    const schedule = createSchedule(makeSchedule(wsA, { name: 'List test' }));
    createOccurrence({ workspaceId: wsA, scheduleId: schedule.id, scheduleVersion: 1, occurrenceKey: `ls-${randomUUID()}`, scheduledAt: '2026-01-01T06:00:00.000Z' });
    const rows = listOccurrencesBySchedule(wsA, schedule.id, { limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(listOccurrencesBySchedule(wsB, schedule.id, { limit: 10 })).toHaveLength(0);
  });

  it('listSchedules returns only the workspace rows', () => {
    const schedule = createSchedule(makeSchedule(wsB, { name: 'WS B list' }));
    const a = listSchedules(wsA, 200);
    const b = listSchedules(wsB, 200);
    for (const row of a) expect(row.workspaceId).toBe(wsA);
    expect(b.some((s) => s.id === schedule.id)).toBe(true);
  });
});
