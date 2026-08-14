// ---------------------------------------------------------------------------
// Store Manager notifications + SSE routes (operations console, Issue 3)
//
// Durable in-app notifications with cursor-based SSE (Last-Event-ID / after),
// heartbeat, workspace guard, capped batches, and polling fallback via the
// plain GET list. The stream reconciles the inbox + evaluates rules on
// connect and periodically, then pushes persisted notification rows. Wire
// types are Store Manager-local; nothing from Product Intelligence is
// imported or reused.
//
// Mounted inside store-manager-routes.ts under `/store-manager`, so the full
// paths are /api/store-manager/notifications[...]. Mutating routes are
// covered by the app-level BAYSTATE_CMS_API_TOKEN middleware.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getCurrentWorkspace } from '../services/workspace-service';
import { reconcileInbox } from '../services/store-manager-inbox-service';
import {
  evaluateNotificationRules,
  listNotificationsForWorkspace,
  markNotificationReadForWorkspace,
  countUnreadNotificationsForWorkspace,
} from '../services/store-manager-notification-service';
import { getLatestNotificationSequence } from '../../db/repositories/store-manager-notification-repo';

const route = new Hono();

function parseNonNegativeInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  return Math.min(Math.max(Number(raw), 0), max);
}

/** GET /api/store-manager/notifications — bounded list + unread count. */
route.get('/notifications', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const afterSeq = parseNonNegativeInt(c.req.query('afterSequence'), 0, Number.MAX_SAFE_INTEGER);
  const limit = parseNonNegativeInt(c.req.query('limit'), 100, 200);
  try {
    const notifications = listNotificationsForWorkspace(workspace.id, { afterSequence: afterSeq, limit });
    return c.json({
      notifications,
      unread: countUnreadNotificationsForWorkspace(workspace.id),
      latestSequence: getLatestNotificationSequence(workspace.id),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** POST /api/store-manager/notifications/:id/read — mark one notification read. */
route.post('/notifications/:id/read', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid notification id.' }, 400);
  const changed = markNotificationReadForWorkspace(workspace.id, id);
  return c.json({ ok: true, changed });
});

/**
 * GET /api/store-manager/notifications/stream?after=<seq>&pollMs=<n>
 *
 * Cursor-based SSE: reconciles the inbox and evaluates notification rules on
 * connect (and periodically), pushes persisted notification rows with
 * sequence > `after` (also honoring the Last-Event-ID header), sends a
 * heartbeat ping, and terminates on disconnect. A bounded polling fallback is
 * the plain GET list above.
 */
route.get('/notifications/stream', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  c.header('Content-Encoding', 'identity');
  c.header('X-Content-Type-Options', 'nosniff');

  const lastEventId = c.req.header('Last-Event-ID');
  const afterSeq = parseNonNegativeInt(
    c.req.query('after') ?? (lastEventId ?? undefined),
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const pollMs = parseNonNegativeInt(c.req.query('pollMs'), 3000, 30_000);
  // Tunables are bounded server-side; tests use small values to exercise
  // periodic scans and heartbeats deterministically.
  const scanMs = parseNonNegativeInt(c.req.query('scanMs'), 15_000, 120_000);
  const heartbeatMs = parseNonNegativeInt(c.req.query('heartbeatMs'), 15_000, 120_000);

  return streamSSE(c, async (stream) => {
    let cursor = afterSeq;
    let lastScanAt = 0;
    let lastHeartbeatAt = 0;
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });

    const scanOnce = () => {
      reconcileInbox(workspace.id);
      evaluateNotificationRules(workspace.id);
      lastScanAt = Date.now();
    };

    const pushBatch = async () => {
      const rows = listNotificationsForWorkspace(workspace.id, { afterSequence: cursor, limit: 100 });
      for (const row of rows) {
        if (closed) return;
        await stream.writeSSE({ event: 'notification', data: JSON.stringify(row) });
        if (row.sequence > cursor) cursor = row.sequence;
      }
    };

    // Fresh authority before the first push.
    scanOnce();
    await pushBatch();
    if (closed) return;
    await stream.writeSSE({
      event: 'welcome',
      data: JSON.stringify({ latest: getLatestNotificationSequence(workspace.id), heartbeatMs, scanMs }),
    });
    lastHeartbeatAt = Date.now();

    while (!closed) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (closed) break;
      await pushBatch();
      const now = Date.now();
      if (now - lastScanAt >= scanMs) scanOnce();
      if (now - lastHeartbeatAt >= heartbeatMs) {
        await stream.writeSSE({ event: 'ping', data: JSON.stringify({ time: new Date().toISOString() }) });
        lastHeartbeatAt = now;
      }
    }
  });
});

export default route;
