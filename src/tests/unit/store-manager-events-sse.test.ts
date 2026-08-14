import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mock } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { insertNotification, getLatestNotificationSequence } from '../../db/repositories/store-manager-notification-repo';

// The events route is imported dynamically per-describe: the ownership-guard
// describe registers a process-wide bun mock.module and must import AFTER
// registration, while the stream describe runs against the real service.
type EventsRouteModule = typeof import('../../server/routes/store-manager-events-routes');
let eventsRouteRef: EventsRouteModule['default'] | null = null;

/**
 * Store Manager notifications SSE routes (operations console, Issue 3).
 * DB-backed: run under `bun test`. Verifies workspace ownership guards,
 * cursor replay, dedupe, heartbeat, bounded batches, malformed cursors, and
 * connection cleanup. No network.
 */

function seedWorkspace(id: string) {
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, 'SSE Test Store', `/tmp/ws-${id}`, `/tmp/ws-${id}/.git`, now, now, 'complete'],
  );
}

function seedNotifications(workspaceId: string, count: number) {
  for (let i = 1; i <= count; i++) {
    insertNotification({
      workspaceId,
      ruleId: 'rule-1',
      ruleKind: 'sync_failure_appeared',
      ruleVersion: 1,
      fingerprint: `f${i}`.padEnd(64, 'a'),
      severity: 'critical',
      title: `Sync failure ${i}`,
      message: `Sync job ${i} failed.`,
      inboxItemId: null,
      sourceRunId: null,
    });
  }
}

async function readUntil(res: Response, predicate: (chunk: string) => boolean, timeoutMs = 4000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    if (predicate(acc)) {
      await reader.cancel();
      return acc;
    }
  }
  await reader.cancel();
  return acc;
}

describe('events routes — stream behavior', () => {
  const testDbPath = './test-events-sse.db';
  const workspaceId = 'ws-events-sse';

  beforeAll(async () => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    seedWorkspace(workspaceId);
    seedNotifications(workspaceId, 3);
    eventsRouteRef = (await import('../../server/routes/store-manager-events-routes')).default;
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('streams the bounded initial batch + welcome with heartbeat metadata, then closes on cancel', async () => {
    const res = await eventsRouteRef!.request('/notifications/stream?after=0&pollMs=60000&scanMs=60000&heartbeatMs=60000');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const acc = await readUntil(res, (chunk) => chunk.includes('event: welcome'));
    const notificationFrames = (acc.match(/event: notification/g) ?? []).length;
    expect(notificationFrames).toBe(3); // all seeded notifications
    expect(acc).toContain('event: welcome');
    expect(acc).toContain('"latest":3');
  });

  it('replays only rows after the cursor (Last-Event-ID / after semantics)', async () => {
    const latest = getLatestNotificationSequence(workspaceId);
    expect(latest).toBe(3);
    const res = await eventsRouteRef!.request(`/notifications/stream?after=${latest}&pollMs=60000&scanMs=60000&heartbeatMs=60000`);
    const acc = await readUntil(res, (chunk) => chunk.includes('event: welcome'));
    expect(acc.match(/event: notification/g) ?? []).toHaveLength(0);
  });

  it('treats a malformed cursor as 0 (no crash, full replay)', async () => {
    const res = await eventsRouteRef!.request('/notifications/stream?after=abc&pollMs=60000&scanMs=60000&heartbeatMs=60000');
    const acc = await readUntil(res, (chunk) => chunk.includes('event: welcome'));
    expect(acc.match(/event: notification/g) ?? []).toHaveLength(3);
  });

  it('sends a heartbeat ping when heartbeatMs elapses', async () => {
    const res = await eventsRouteRef!.request('/notifications/stream?after=1000&pollMs=250&scanMs=60000&heartbeatMs=250');
    const acc = await readUntil(res, (chunk) => chunk.includes('event: ping'));
    expect(acc).toContain('event: ping');
  });

  it('dedupes by fingerprint at the repo level (no repeat chatter)', async () => {
    const before = getLatestNotificationSequence(workspaceId);
    const dup = insertNotification({
      workspaceId,
      ruleId: 'rule-1',
      ruleKind: 'sync_failure_appeared',
      ruleVersion: 1,
      fingerprint: 'f1'.padEnd(64, 'a'), // same as seeded notification 1
      severity: 'critical',
      title: 'Duplicate',
      message: 'Duplicate sync failure.',
      inboxItemId: null,
      sourceRunId: null,
    });
    expect(dup).toBeNull();
    expect(getLatestNotificationSequence(workspaceId)).toBe(before);
  });

  it('bounds list responses and honors afterSequence on the plain GET', async () => {
    const listRes = await eventsRouteRef!.request('/notifications?afterSequence=1&limit=200');
    expect(listRes.status).toBe(200);
    const data = (await listRes.json()) as { notifications: Array<{ sequence: number }>; unread: number };
    expect(data.notifications.length).toBeLessThanOrEqual(200);
    for (const n of data.notifications) expect(n.sequence).toBeGreaterThan(1);
    expect(data.unread).toBeGreaterThanOrEqual(0);
  });

  it('foreign workspace rows are invisible (workspace isolation on notifications)', async () => {
    // Insert a notification for a different workspace; it must never appear
    // in the seeded workspace list/stream.
    const foreignId = 'ws-events-sse-foreign';
    seedWorkspace(foreignId);
    insertNotification({
      workspaceId: foreignId,
      ruleId: 'rule-x',
      ruleKind: 'critical_issue_count_increased',
      ruleVersion: 1,
      fingerprint: 'zz'.padEnd(64, 'z'),
      severity: 'critical',
      title: 'Foreign',
      message: 'Foreign notification.',
      inboxItemId: null,
      sourceRunId: null,
    });
    const res = await eventsRouteRef!.request('/notifications');
    const data = (await res.json()) as { notifications: Array<{ title: string }> };
    expect(data.notifications.some((n) => n.title === 'Foreign')).toBe(false);
  });

  it('a cursor-advanced reconnect receives only the delta (workspace-swap guard)', async () => {
    const before = getLatestNotificationSequence(workspaceId);
    // A NEW finding (distinct fingerprint) appears after the cursor.
    insertNotification({
      workspaceId,
      ruleId: 'rule-1',
      ruleKind: 'sync_failure_appeared',
      ruleVersion: 1,
      fingerprint: 'delta'.padEnd(64, 'a'),
      severity: 'critical',
      title: 'Delta notification',
      message: 'A new sync failure appeared after the cursor.',
      inboxItemId: null,
      sourceRunId: null,
    });
    const res = await eventsRouteRef!.request(`/notifications/stream?after=${before}&pollMs=60000&scanMs=60000&heartbeatMs=60000`);
    const acc = await readUntil(res, (chunk) => chunk.includes('event: welcome'));
    const notificationFrames = acc.match(/event: notification/g) ?? [];
    expect(notificationFrames).toHaveLength(1);
    const seq = Number((acc.match(/"sequence":(\d+)/) ?? [])[1] ?? -1);
    expect(seq).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Ownership guard: the route must fail closed (400) when no workspace is
// loaded. getCurrentWorkspace() bootstraps a workspace when one is missing
// (migrateLegacyWorkspaceIfNeeded), so the guard is exercised here by
// mocking the workspace service to return null. bun:test mock.module replaces
// module resolution for the whole process, so this describe intentionally
// runs LAST — the stream tests above already ran against the real service.
// ---------------------------------------------------------------------------
describe('events routes — ownership guard (no workspace)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    mock.module('/Users/nickborrello/Desktop/Projects/shopsite-cms/src/server/services/workspace-service', () => ({
      getCurrentWorkspace: () => null,
    }));
  });

  afterAll(() => {
    closeDb();
  });

  it('stream and list refuse with 400 when no workspace is loaded', async () => {
    const { default: guardedRoute } = await import('../../server/routes/store-manager-events-routes');
    const streamRes = await guardedRoute.request('/notifications/stream?after=0');
    expect(streamRes.status).toBe(400);
    const body = (await streamRes.json()) as { error: string };
    expect(body.error).toContain('No workspace');
    const listRes = await guardedRoute.request('/notifications');
    expect(listRes.status).toBe(400);
    const readRes = await guardedRoute.request('/notifications/stream?after=abc');
    expect(readRes.status).toBe(400);
  });
});
