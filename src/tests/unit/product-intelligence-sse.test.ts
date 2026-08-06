/**
 * Product Intelligence SSE streaming tests (PI-2).
 *
 * DB-backed (bun test). Exercises the live event stream route through the
 * real Hono app (no HTTP server — `app.request`): persisted-event replay for
 * terminal runs, live event delivery for running runs, and the auto-close
 * behavior. No Pi SDK and no network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { appendPiEvent, createPiRun, deletePiRun, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
import app from '../../server/app';

const wsId = 'pi-sse-test-workspace';

function makeRun() {
  return createPiRun({
    workspaceId: wsId,
    mode: 'shadow',
    executor: 'pi',
    inputJson: JSON.stringify({ gtin: '085000079585', registerName: 'STELLA CHKN BROTH 16OZ' }),
    policyJson: JSON.stringify({ configId: 'cfg' }),
    configSnapshotId: 'cfg',
    configSnapshotHash: 'cfg',
  });
}

async function collectStream(
  response: Response,
  opts: { until?: string; timeoutMs?: number } = {},
): Promise<{ text: string; closedByTimeout: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let text = '';
  let closedByStream = false;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('read-timeout')), timeoutMs)),
    ]);
    if (done) {
      closedByStream = true;
      break;
    }
    text += decoder.decode(value, { stream: true });
    if (opts.until && text.includes(opts.until)) {
      await reader.cancel().catch(() => undefined);
      return { text, closedByTimeout: false };
    }
  }
  await reader.cancel().catch(() => undefined);
  return { text, closedByTimeout: !closedByStream };
}

describe('Product Intelligence SSE stream', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-sse-test.db');

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI SSE Test',
      workspacePath: '/tmp/pi-sse-workspace',
      gitPath: '/tmp/pi-sse-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('returns 404 for runs owned by another workspace (cross-workspace isolation)', async () => {
    // A second workspace exists; the active one (LIMIT 1) is the seeded wsId.
    insertWorkspace({
      id: 'other-workspace',
      name: 'Other Workspace',
      workspacePath: '/tmp/other-workspace',
      gitPath: '/tmp/other-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const run = createPiRun({
      workspaceId: 'other-workspace',
      mode: 'shadow',
      executor: 'pi',
      inputJson: '{}',
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    });
    const detail = await app.request(`http://localhost/api/product-intelligence/runs/${run.id}`);
    expect(detail.status).toBe(404);
    const events = await app.request(`http://localhost/api/product-intelligence/runs/${run.id}/events`);
    expect(events.status).toBe(404);
    const cancel = await app.request(`http://localhost/api/product-intelligence/runs/${run.id}/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(404);
    const stream = await app.request(`http://localhost/api/product-intelligence/runs/${run.id}/events/stream`);
    expect(stream.status).toBe(404);
  });

  it('returns 404 for unknown runs', async () => {
    const response = await app.request('http://localhost/api/product-intelligence/runs/nope/events/stream');
    expect(response.status).toBe(404);
  });

  it('replays persisted events for a terminal run and closes the stream', async () => {
    const run = makeRun();
    appendPiEvent(run.id, 0, 'run.started', { executor: 'pi' });
    appendPiEvent(run.id, 1, 'run.completed', { disposition: 'unavailable' });
    transitionPiRunStatus(run.id, 'completed', {});

    const response = await app.request(
      `http://localhost/api/product-intelligence/runs/${run.id}/events/stream?pollMs=100`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');

    const { text, closedByTimeout } = await collectStream(response, { timeoutMs: 2_000 });
    expect(closedByTimeout).toBe(false); // terminal run closes the stream itself
    expect(text).toContain('event: run.started');
    expect(text).toContain('event: run.completed');
    expect(text).toContain(`"runId":"${run.id}"`);
    // Domain mapping applies (normalized run_completed -> run.completed).
    expect(text).not.toContain('event: run_completed');

    expect(deletePiRun(run.id)).toBe(true);
  });

  it('respects the replay cursor (reconnect picks up only new events)', async () => {
    const run = makeRun();
    appendPiEvent(run.id, 0, 'run.started', {});
    appendPiEvent(run.id, 1, 'tool.started', { tool: 'read' });
    appendPiEvent(run.id, 2, 'run.completed', {});
    transitionPiRunStatus(run.id, 'completed', {});

    const response = await app.request(
      `http://localhost/api/product-intelligence/runs/${run.id}/events/stream?after=0&pollMs=100`,
    );
    const { text, closedByTimeout } = await collectStream(response, { timeoutMs: 2_000 });
    expect(closedByTimeout).toBe(false);
    expect(text).toContain('event: tool.started');
    expect(text).toContain('event: run.completed');
    expect(text).not.toContain('event: run.started');
    // Events are never duplicated across the initial replay and the poll.
    expect(text.split('event: tool.started')).toHaveLength(2);

    expect(deletePiRun(run.id)).toBe(true);
  });

  it('streams live events for a running run via the DB poll fallback', async () => {
    const run = makeRun();
    appendPiEvent(run.id, 0, 'run.started', {});
    const db = getDb();

    const response = await app.request(
      `http://localhost/api/product-intelligence/runs/${run.id}/events/stream?pollMs=100`,
    );
    const readPromise = collectStream(response, { until: 'event: tool.started', timeoutMs: 3_000 });

    // Wait for the stream to be live, then append an event from "another
    // process" (direct DB write, no bus publish) — the poll picks it up.
    await new Promise((resolve) => setTimeout(resolve, 250));
    db.run('INSERT INTO product_intelligence_events (id, run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'evt-live-1', run.id, 1, 'tool.started', JSON.stringify({ tool: 'read' }), new Date().toISOString(),
    ]);

    const { text, closedByTimeout } = await readPromise;
    expect(closedByTimeout).toBe(false);
    expect(text).toContain('event: run.started');
    expect(text).toContain('event: tool.started');

    // Cleanup: running runs cannot be deleted.
    transitionPiRunStatus(run.id, 'completed', {});
    expect(deletePiRun(run.id)).toBe(true);
  });
});
