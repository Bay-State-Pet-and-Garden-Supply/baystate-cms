/**
 * Product Intelligence API routes (PI-2).
 *
 * Single-product run API: start/list/inspect runs, replay + live SSE event
 * streams, cancellation, comparisons, explicit run deletion, and the
 * retention policy. No onboarding import and no ShopSite publishing happen
 * here — this is the Phase 1 runtime surface.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/19
 */
import { Hono } from 'hono';
import { ProductIntelligencePolicySchema, ProductResearchInputSchema } from '../../product-intelligence/contracts';
import {
  buildDefaultPiPolicy,
  cancelPiRun,
  createPiComparison,
  deletePiRun,
  getPiRunProjection,
  globalRunEventBus,
  replayPiEvents,
  runRetentionCleanup,
  startProductIntelligenceRun,
  type PiLiveEvent,
} from '../../product-intelligence/run-service';
import { createExecutionRouter } from '../../product-intelligence/execution-router';
import { getProductIntelligenceFlags } from '../../product-intelligence/flags';
import { LegacyProductIntelligenceExecutor } from '../../product-intelligence/legacy-executor';
import { PiProductIntelligenceExecutor } from '../../product-intelligence/pi/pi-executor';
import { getCurrentWorkspace } from '../services/workspace-service';
import { getPiRun, listPiRuns } from '../../db/repositories/product-intelligence-repo';

const router = new Hono();

function requireWorkspace() {
  const ws = getCurrentWorkspace();
  if (!ws) return null;
  return ws;
}

function buildRouter() {
  return createExecutionRouter({
    pi: new PiProductIntelligenceExecutor(),
    legacy: new LegacyProductIntelligenceExecutor(),
  });
}

/**
 * POST /api/product-intelligence/runs
 * Start a single-product run. `await=true` resolves only after the run
 * reaches a terminal state (bounded by the policy deadline).
 */
router.post('/product-intelligence/runs', async (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = (body as { input?: unknown }).input;
  const inputResult = ProductResearchInputSchema.safeParse(parsed);
  if (!inputResult.success) {
    return c.json(
      { error: `Invalid product research input: ${inputResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` },
      400,
    );
  }

  const mode = (body as { mode?: string }).mode ?? 'shadow';
  if (!['shadow', 'interactive', 'onboarding'].includes(mode)) {
    return c.json({ error: `Invalid mode: ${mode}` }, 400);
  }
  const flags = getProductIntelligenceFlags();
  if (mode === 'onboarding' && !flags.allowOnboardingImport) {
    return c.json({ error: 'Onboarding mode is disabled (productIntelligence.allowOnboardingImport is false)' }, 403);
  }
  if (!flags.productIntelligenceEnabled) {
    return c.json({ error: 'Product Intelligence is disabled (productIntelligence.enabled is false)' }, 403);
  }

  try {
    const selection = await buildRouter().resolveExecutor();
    const started = await startProductIntelligenceRun(
      selection.executor,
      {
        input: inputResult.data,
        mode: mode as 'shadow' | 'interactive' | 'onboarding',
        policy: (body as { policy?: unknown }).policy
          ? ProductIntelligencePolicySchema.parse((body as { policy?: unknown }).policy)
          : buildDefaultPiPolicy(),
        onboardingItemId: (body as { onboardingItemId?: string | null }).onboardingItemId ?? null,
      },
      { workspaceId: ws.id, workspacePath: ws.workspacePath },
    );

    if ((body as { await?: boolean }).await === true) {
      await started.completed;
    }
    return c.json({ runId: started.run.id, executor: selection.name, status: started.run.status }, 202);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

/** GET /api/product-intelligence/runs?status=&limit=&offset= */
router.get('/product-intelligence/runs', (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  const status = c.req.query('status');
  const limit = Number(c.req.query('limit') ?? '50');
  const offset = Number(c.req.query('offset') ?? '0');
  const runs = listPiRuns({
    workspaceId: ws.id,
    status: status as 'running' | 'completed' | 'failed' | 'cancelled' | undefined,
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  return c.json({ runs });
});

/** GET /api/product-intelligence/runs/:id — full normalized projection. */
router.get('/product-intelligence/runs/:id', (c) => {
  const projection = getPiRunProjection(c.req.param('id'));
  if (!projection) return c.json({ error: 'Run not found' }, 404);
  return c.json(projection);
});

/** GET /api/product-intelligence/runs/:id/events?after= — replay cursor. */
router.get('/product-intelligence/runs/:id/events', (c) => {
  const runId = c.req.param('id');
  if (!getPiRun(runId)) return c.json({ error: 'Run not found' }, 404);
  const after = Number(c.req.query('after') ?? '-1');
  return c.json({ events: replayPiEvents(runId, Number.isFinite(after) ? after : -1) });
});

// Per-stream cleanup registry (the underlying source has no self-reference).
const streamCleanup = new WeakMap<ReadableStream<Uint8Array>, () => void>();

/**
 * GET /api/product-intelligence/runs/:id/events/stream — live SSE.
 * Replays persisted events after the cursor (reconnect-safe), then tails the
 * live bus with a DB poll fallback until the run is terminal.
 */
router.get('/product-intelligence/runs/:id/events/stream', async (c) => {
  const runId = c.req.param('id');
  const run = getPiRun(runId);
  if (!run) return c.json({ error: 'Run not found' }, 404);

  const after = Number(c.req.query('after') ?? '-1');
  const cursor = Number.isFinite(after) ? after : -1;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      const send = (event: PiLiveEvent): void => {
        if (closed) return;
        const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Client gone; cleanup happens via the stream's cancel().
        }
      };

      const unsubscribe = globalRunEventBus.subscribe(runId, (event) => {
        if (event.sequence > cursor) send(event);
      });

      // Heartbeat keeps the connection alive.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // ignore
        }
      }, 15_000);

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        clearInterval(heartbeat);
        unsubscribe();
      };

      // Fallback poll: covers missed bus events (e.g. events persisted by a
      // different process) and serves as the reconnect replay source.
      let lastSequence = cursor;
      pollTimer = setInterval(() => {
        const events = replayPiEvents(runId, lastSequence);
        for (const event of events) {
          if (event.sequence > lastSequence) {
            lastSequence = event.sequence;
            send(event);
          }
        }
        const current = getPiRun(runId);
        if (current && current.status !== 'running' && globalRunEventBus.subscriberCount(runId) <= 1) {
          // Terminal run with no live listeners left: close after draining.
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }, 500);

      // Initial replay (reconnect).
      for (const event of replayPiEvents(runId, cursor)) {
        send(event);
      }

      streamCleanup.set(stream, cleanup);
    },
    cancel() {
      streamCleanup.get(stream)?.();
      streamCleanup.delete(stream);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

/** POST /api/product-intelligence/runs/:id/cancel */
router.post('/product-intelligence/runs/:id/cancel', (c) => {
  const runId = c.req.param('id');
  const run = getPiRun(runId);
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (run.status !== 'running') return c.json({ error: `Run is not running (${run.status})` }, 409);
  const aborted = cancelPiRun(runId);
  if (!aborted) return c.json({ error: 'Run cannot be cancelled (no active execution)' }, 409);
  return c.json({ cancelled: true, runId });
});

/** POST /api/product-intelligence/runs/:id/compare — Pi vs baseline. */
router.post('/product-intelligence/runs/:id/compare', async (c) => {
  const runId = c.req.param('id');
  if (!getPiRun(runId)) return c.json({ error: 'Run not found' }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const baselineType = (body as { baselineType?: string }).baselineType;
  const baselineRef = (body as { baselineRef?: string }).baselineRef;
  if (!baselineType || !baselineRef) {
    return c.json({ error: 'baselineType and baselineRef are required' }, 400);
  }
  try {
    const comparison = createPiComparison({
      runId,
      baselineType: baselineType as 'legacy' | 'classification_run' | 'manual',
      baselineRef,
    });
    return c.json({ comparison }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

/** DELETE /api/product-intelligence/runs/:id — explicit deletion. */
router.delete('/product-intelligence/runs/:id', (c) => {
  const runId = c.req.param('id');
  const run = getPiRun(runId);
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (run.status === 'running') return c.json({ error: 'Running runs cannot be deleted; cancel first' }, 409);
  const deleted = deletePiRun(runId);
  return c.json({ deleted, runId });
});

/** POST /api/product-intelligence/retention — explicit retention policy. */
router.post('/product-intelligence/retention', async (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const olderThanDays = Number((body as { olderThanDays?: number }).olderThanDays);
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    return c.json({ error: 'olderThanDays must be a positive number' }, 400);
  }
  const deleted = runRetentionCleanup(ws.id, olderThanDays);
  return c.json({ deleted, olderThanDays });
});

/** GET /api/product-intelligence/flags — effective runtime flags. */
router.get('/product-intelligence/flags', (c) => {
  return c.json({ flags: getProductIntelligenceFlags() });
});

export default router;
