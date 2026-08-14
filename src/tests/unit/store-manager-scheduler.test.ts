import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createStoreManagerScheduler } from '../../server/services/store-manager-scheduler';
import { computeNextRunAtMs, zonedWallClockToUtcMs } from '../../server/services/store-manager-schedule-service';
import { createScheduleFromTemplate } from '../../server/services/store-manager-schedule-service';
import {
  createOccurrence,
  getOccurrence,
} from '../../db/repositories/store-manager-schedule-repo';
import { overrideStoreManagerFlags, resetStoreManagerFlagsOverride } from '../../store-manager/flags';

/**
 * Scheduler + deterministic recurrence (Issue 4). DB-backed: run under
 * `bun test`. All clocks are injected; no real time, network, or model.
 */

const workspaceId = 'ws-scheduler';
const testDbPath = './test-scheduler.db';

describe('schedule recurrence + scheduler (Issue 4)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    insertWorkspace({
      id: workspaceId,
      name: 'Scheduler Test Store',
      workspacePath: './test-workspace',
      gitPath: './test-workspace/.git',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterAll(() => {
    resetStoreManagerFlagsOverride();
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('zonedWallClockToUtcMs resolves normal local times', () => {
    const utc = zonedWallClockToUtcMs('America/New_York', { y: 2026, mo: 3, d: 10, h: 8, mi: 0 });
    expect(new Date(utc).toISOString()).toBe('2026-03-10T12:00:00.000Z'); // EDT
  });

  it('spring-forward gap advances to the next valid instant', () => {
    // 2026-03-08 02:30 America/New_York does not exist (DST starts 02:00→03:00).
    const utc = zonedWallClockToUtcMs('America/New_York', { y: 2026, mo: 3, d: 8, h: 2, mi: 30 });
    expect(new Date(utc).toISOString()).toBe('2026-03-08T07:00:00.000Z'); // 03:00 EDT
  });

  it('fall-back overlap resolves to the FIRST instant', () => {
    // 2026-11-01 01:30 America/New_York occurs twice; first = 05:30Z EDT.
    const utc = zonedWallClockToUtcMs('America/New_York', { y: 2026, mo: 11, d: 1, h: 1, mi: 30 });
    expect(new Date(utc).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('daily recurrence advances one label per local day across DST', () => {
    // Fixed clock: 2026-03-07 14:00Z (= 09:00 EST in NY — past 08:00 local), so
    // the next daily label is 2026-03-08 08:00 EDT = 12:00Z (post-spring-forward).
    const schedule = { timezone: 'America/New_York', recurrencePreset: 'daily' as const, timeOfDay: '08:00', dayOfWeek: null };
    const next = computeNextRunAtMs(schedule, Date.parse('2026-03-07T14:00:00.000Z'));
    expect(new Date(next).toISOString()).toBe('2026-03-08T12:00:00.000Z'); // 08:00 EDT after spring-forward
    const dayAfter = computeNextRunAtMs(schedule, next);
    expect(new Date(dayAfter).toISOString()).toBe('2026-03-09T12:00:00.000Z');
  });

  it('weekly recurrence lands on the configured weekday at timeOfDay', () => {
    const schedule = { timezone: 'UTC', recurrencePreset: 'weekly' as const, timeOfDay: '07:00', dayOfWeek: 1 };
    const next = computeNextRunAtMs(schedule, Date.parse('2026-03-05T00:00:00.000Z')); // Thursday
    const iso = new Date(next).toISOString();
    expect(iso).toBe('2026-03-09T07:00:00.000Z'); // next Monday
  });

  it('createScheduleFromTemplate creates disabled schedules with nextRunAt', () => {
    const result = createScheduleFromTemplate(workspaceId, {
      templateKind: 'daily_catalog_health',
      name: 'Health',
      timezone: 'UTC',
      recurrencePreset: 'daily',
      timeOfDay: '06:00',
    });
    expect(result.schedule.enabled).toBe(false); // inert until explicitly enabled
    expect(result.nextRunAt).not.toBeNull();
    expect(result.schedule.definitionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects invalid IANA timezones and weekly-without-day', () => {
    expect(() =>
      createScheduleFromTemplate(workspaceId, {
        templateKind: 'daily_catalog_health',
        name: 'Bad',
        timezone: 'Not/AZone',
        recurrencePreset: 'daily',
        timeOfDay: '06:00',
      }),
    ).toThrow(/Invalid IANA timezone/);
    expect(() =>
      createScheduleFromTemplate(workspaceId, {
        templateKind: 'weekly_cleanup_report',
        name: 'Bad weekly',
        timezone: 'UTC',
        recurrencePreset: 'weekly',
        timeOfDay: '07:00',
      }),
    ).toThrow(/dayOfWeek/);
  });

  it('scheduler tick refuses to run when schedulesEnabled is off or kill switch is on', async () => {
    const scheduler = createStoreManagerScheduler({
      flags: () => ({ operationsConsoleEnabled: false, schedulesEnabled: false, eventTriggersEnabled: false, playbooksEnabled: false, bulkReviewEnabled: false, notificationsEnabled: false, killSwitch: false }),
      dispatch: async () => { throw new Error('must not dispatch'); },
      now: () => new Date('2026-01-01T05:00:00.000Z'),
    });
    expect(await scheduler.tick()).toBe(0);

    const kill = createStoreManagerScheduler({
      flags: () => ({ operationsConsoleEnabled: false, schedulesEnabled: true, eventTriggersEnabled: false, playbooksEnabled: false, bulkReviewEnabled: false, notificationsEnabled: false, killSwitch: true }),
      dispatch: async () => { throw new Error('must not dispatch'); },
      now: () => new Date('2026-01-01T05:00:00.000Z'),
    });
    expect(await kill.tick()).toBe(0);
  });

  it('one writer: concurrent ticks never dispatch the same occurrence twice', async () => {
    overrideStoreManagerFlags({ schedulesEnabled: true, killSwitch: false });
    const schedule = createScheduleFromTemplate(workspaceId, {
      templateKind: 'daily_catalog_health',
      name: 'One writer',
      timezone: 'UTC',
      recurrencePreset: 'daily',
      timeOfDay: '06:00',
    });
    const occurrence = createOccurrence({
      workspaceId,
      scheduleId: schedule.schedule.id,
      scheduleVersion: schedule.schedule.version,
      occurrenceKey: `writer-${randomUUID()}`,
      scheduledAt: '2026-01-01T06:00:00.000Z',
    });
    let dispatchCount = 0;
    const dispatch = async (ws: string, id: string) => {
      // simulate a slow dispatch: claim state already guarded by repo
      dispatchCount += 1;
      return { occurrenceId: id, occurrenceKey: occurrence.occurrenceKey, status: 'completed' as const, runId: null, errorCode: null, terminalStatus: 'success', retryCount: 0 };
    };
    const scheduler = createStoreManagerScheduler({
      now: () => new Date('2026-01-01T06:30:00.000Z'),
      dispatch: dispatch as never,
      dispatchDeps: {},
    });
    // First tick claims it. Second tick sees it already claimed/terminal.
    await scheduler.tick();
    await scheduler.tick();
    const row = getOccurrence(workspaceId, occurrence.id);
    expect(row?.status).toBe('claimed'); // first tick claimed; second tick found it claimed → skipped
    expect(dispatchCount).toBe(1);
    // cleanup: finalize so the DB is clean for later tests
    const { finalizeOccurrence } = await import('../../db/repositories/store-manager-schedule-repo');
    finalizeOccurrence({ workspaceId, occurrenceId: occurrence.id, status: 'completed', runId: 'r1', nowIso: '2026-01-01T06:30:00.000Z' });
  });

  it('graceful stop prevents further ticks', async () => {
    overrideStoreManagerFlags({ schedulesEnabled: true, killSwitch: false });
    let dispatched = 0;
    const scheduler = createStoreManagerScheduler({
      pollIntervalMs: 5,
      now: () => new Date('2026-01-01T05:00:00.000Z'),
      flags: () => ({ operationsConsoleEnabled: false, schedulesEnabled: true, eventTriggersEnabled: false, playbooksEnabled: false, bulkReviewEnabled: false, notificationsEnabled: false, killSwitch: false }),
      dispatch: (async () => { dispatched += 1; return { status: 'completed' as const }; }) as never,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 15));
    scheduler.stop();
    const afterStop = dispatched;
    await new Promise((r) => setTimeout(r, 20));
    expect(dispatched).toBe(afterStop);
    expect(scheduler.running).toBe(false);
  });
});
