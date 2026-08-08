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
import {
  ProductIntelligencePolicySchema,
  ProductResearchInputSchema,
  type ProductIntelligencePolicy,
} from '../../product-intelligence/contracts';
import {
  buildDefaultPiPolicy,
  cancelPiRun,
  createPiComparison,
  getPiRunProjection,
  globalRunEventBus,
  replayPiEvents,
  replayPiRun,
  startProductIntelligenceRun,
  type PiLiveEvent,
} from '../../product-intelligence/run-service';
import { createExecutionRouter } from '../../product-intelligence/execution-router';
import { assertReducingOverride, computePolicyConfigId } from '../../product-intelligence/policy';
import { getProductIntelligenceFlags } from '../../product-intelligence/flags';
import { getExamples } from '../../db/repositories/benchmark-repo';
import { PiGoldLabelsSchema, PiProductInputSchema } from '../../product-intelligence/evaluation/gold';
import { StubManagedProvider, type ManagedBrowserProvider } from '../../product-intelligence/extraction/managed-fallback';
import { LegacyProductIntelligenceExecutor } from '../../product-intelligence/legacy-executor';
import { PiProductIntelligenceExecutor } from '../../product-intelligence/pi/pi-executor';
import { PiSdkSessionFactory } from '../../product-intelligence/pi/pi-session-factory';
import { defaultToolRegistry } from '../../product-intelligence/tools';
import { getCurrentWorkspace } from '../services/workspace-service';
import { getDb } from '../../db/connection';
import { getPiRun, getPiResult, listPiRuns } from '../../db/repositories/product-intelligence-repo';
import {
  getActiveApprovedPolicy,
  getApprovedPolicyById,
  seedDefaultApprovedPolicy,
} from '../../db/repositories/pi-approved-policy-repo';
import { importRunToOnboarding } from '../../product-intelligence/onboarding-import';
import { assertRunApprovedForImport } from '../../product-intelligence/review-gate';
import {
  createReviewDecision,
  getLatestReviewDecision,
} from '../../db/repositories/pi-review-decision-repo';
import {
  PiBudgetPolicySchema,
  getPiBudgetPolicy,
  setPiBudgetPolicy,
} from '../../product-intelligence/budgets';
import {
  PiRetentionPolicySchema,
  applyPiRetention,
  getPiRetentionPolicy,
  olderThanDaysPolicy,
  setPiRetentionPolicy,
} from '../../product-intelligence/retention';
import {
  currentRolloutState,
  setRolloutConfig,
  type RolloutGateThreshold,
  type RolloutStage,
} from '../../product-intelligence/evaluation/rollout';
import { runPiEvaluation, seedPiGoldenDataset } from '../../product-intelligence/evaluation/runner';
import { runExtractionBenchmark } from '../../product-intelligence/evaluation/extraction-benchmark';
import {
  DatabaseSearchStub,
  MisleadingSearchStub,
  PerfectWebSearchStub,
  runSearchBenchmark,
  SitemapSearchStub,
  type SearchStrategyAdapter,
} from '../../product-intelligence/evaluation/search-benchmark';
import { aggregatePiComparisons } from '../../product-intelligence/evaluation/metrics';
import { PI_GOLDEN_DATASET_NAME } from '../../product-intelligence/evaluation/fixture-dataset';

const router = new Hono();

function requireWorkspace() {
  const ws = getCurrentWorkspace();
  if (!ws) return null;
  return ws;
}

/**
 * Load a run only if it belongs to the active workspace. Run ids are UUIDs,
 * but cross-workspace reads must still fail closed (acceptance: unauthorized
 * workspaces cannot access Agent Lab routes).
 */
function requireRunInWorkspace(runId: string) {
  const ws = requireWorkspace();
  if (!ws) return null;
  const run = getPiRun(runId);
  if (!run || run.workspaceId !== ws.id) return null;
  return run;
}

function buildRouter() {
  return createExecutionRouter({
    pi: new PiProductIntelligenceExecutor({
      sessionFactory: new PiSdkSessionFactory({ toolRegistry: defaultToolRegistry }),
    }),
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

    // P0-2 policy authority: caller-supplied policy objects are never
    // accepted. The caller selects an approved policy record by id (or the
    // workspace default, seeded lazily) and may only apply strictly-reducing
    // overrides validated by assertReducingOverride.
    if ((body as { policy?: unknown }).policy !== undefined) {
      return c.json({ error: 'Caller-supplied policy is not accepted; use policyId + policyOverrides' }, 400);
    }
    const policyId = (body as { policyId?: string }).policyId;
    const rawOverrides = (body as { policyOverrides?: unknown }).policyOverrides;
    const defaultPolicy = buildDefaultPiPolicy();
    seedDefaultApprovedPolicy(ws.id, JSON.stringify(defaultPolicy), defaultPolicy.configId);
    const approved = policyId ? getApprovedPolicyById(ws.id, policyId) : getActiveApprovedPolicy(ws.id);
    if (!approved || approved.active !== 1) {
      return c.json(
        { error: policyId ? `Approved policy ${policyId} not found or inactive for this workspace` : 'No active approved policy for this workspace' },
        400,
      );
    }
    let resolvedPolicy: ProductIntelligencePolicy;
    try {
      const base = ProductIntelligencePolicySchema.parse(JSON.parse(approved.policyJson));
      let merged: ProductIntelligencePolicy;
      if (rawOverrides !== undefined) {
        if (typeof rawOverrides !== 'object' || rawOverrides === null || Array.isArray(rawOverrides)) {
          return c.json({ error: 'policyOverrides must be an object' }, 400);
        }
        merged = assertReducingOverride(base, rawOverrides as Partial<ProductIntelligencePolicy>);
      } else {
        merged = base;
      }
      // Re-hash after merging so the configId still matches the content
      // (verifyPolicySnapshot refuses mismatched snapshots). The final parse
      // validates the merged shape and returns 400 for invalid overrides.
      resolvedPolicy = computePolicyConfigId(ProductIntelligencePolicySchema.parse(merged));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }

    const started = await startProductIntelligenceRun(
      selection.executor,
      {
        input: inputResult.data,
        mode: mode as 'shadow' | 'interactive' | 'onboarding',
        policy: resolvedPolicy,
        onboardingItemId:
          (body as { onboardingItemId?: string | null }).onboardingItemId ??
          inputResult.data.existingOnboardingItemId ??
          null,
        // Review finding 7: persist the approved-policy lineage so reruns
        // reauthorize the BASE record (never the resolved configId).
        basePolicyId: approved.id,
        basePolicyVersion: approved.version,
        policyOverridesJson: rawOverrides !== undefined ? JSON.stringify(rawOverrides) : null,
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
  const runId = c.req.param('id');
  if (!requireRunInWorkspace(runId)) return c.json({ error: 'Run not found' }, 404);
  const projection = getPiRunProjection(runId);
  if (!projection) return c.json({ error: 'Run not found' }, 404);
  return c.json(projection);
});

/** GET /api/product-intelligence/runs/:id/events?after= — replay cursor. */
router.get('/product-intelligence/runs/:id/events', (c) => {
  const runId = c.req.param('id');
  if (!requireRunInWorkspace(runId)) return c.json({ error: 'Run not found' }, 404);
  const after = Number(c.req.query('after') ?? '-1');
  return c.json({ events: replayPiEvents(runId, Number.isFinite(after) ? after : -1) });
});

/**
 * GET /api/product-intelligence/runs/:id/events/stream — live SSE.
 * Replays persisted events after the cursor (reconnect-safe), then tails the
 * live bus with a DB poll fallback until the run is terminal.
 */
router.get('/product-intelligence/runs/:id/events/stream', async (c) => {
  const runId = c.req.param('id');
  const run = requireRunInWorkspace(runId);
  if (!run) return c.json({ error: 'Run not found' }, 404);

  const after = Number(c.req.query('after') ?? '-1');
  const cursor = Number.isFinite(after) ? after : -1;
  // Fallback poll interval: configurable per stream (100-5000ms, default 500).
  const pollMsRaw = Number(c.req.query('pollMs') ?? '500');
  const pollMs = Number.isFinite(pollMsRaw) ? Math.min(5000, Math.max(100, pollMsRaw)) : 500;
  const encoder = new TextEncoder();

  // Per-stream cleanup: start() assigns it; cancel() invokes it. Defined in
  // the handler scope so concurrent streams never share cleanup state.
  let cleanup: (() => void) | null = null;

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

      cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        clearInterval(heartbeat);
        unsubscribe();
      };

      // Initial replay (reconnect) — advances the poll cursor so the poll
      // fallback never resends already-delivered events.
      let lastSequence = cursor;
      for (const event of replayPiEvents(runId, cursor)) {
        if (event.sequence > lastSequence) {
          lastSequence = event.sequence;
          send(event);
        }
      }

      // Fallback poll: covers missed bus events (e.g. events persisted by a
      // different process) and serves as the reconnect replay source.
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
          cleanup?.();
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }, pollMs);
    },
    cancel() {
      cleanup?.();
      cleanup = null;
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
  const run = requireRunInWorkspace(runId);
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (run.status !== 'running') return c.json({ error: `Run is not running (${run.status})` }, 409);
  const aborted = cancelPiRun(runId);
  if (!aborted) return c.json({ error: 'Run cannot be cancelled (no active execution)' }, 409);
  return c.json({ cancelled: true, runId });
});

/** POST /api/product-intelligence/runs/:id/compare — Pi vs baseline. */
router.post('/product-intelligence/runs/:id/compare', async (c) => {
  const runId = c.req.param('id');
  if (!requireRunInWorkspace(runId)) return c.json({ error: 'Run not found' }, 404);
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

// Physical deletion is retention/maintenance-only (P2-1); there is no
// user-facing delete route. Rejection is a durable review decision (POST
// /runs/:id/review) and run rows stay immutable for audit.

/**
 * POST /api/product-intelligence/runs/:id/import — import a reviewed Agent
 * Lab result into onboarding (create or augment an item). Fails closed when
 * the feature is disabled or shadow mode is on; idempotent per (run, item).
 */
router.post('/product-intelligence/runs/:id/import', async (c) => {
  const runId = c.req.param('id');
  if (!requireRunInWorkspace(runId)) return c.json({ error: 'Run not found' }, 404);

  const flags = getProductIntelligenceFlags();
  if (!flags.productIntelligenceEnabled) {
    return c.json({ error: 'Product Intelligence is disabled' }, 403);
  }
  if (!flags.allowOnboardingImport) {
    return c.json({ error: 'Agent Lab import is disabled (productIntelligence.allowOnboardingImport is false)' }, 403);
  }
  if (flags.shadowOnly) {
    return c.json({ error: 'shadowOnly mode is enabled: Agent Lab results cannot be imported' }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const mode = (body as { mode?: string }).mode;
  if (mode !== 'create' && mode !== 'augment') {
    return c.json({ error: "mode must be 'create' or 'augment'" }, 400);
  }

  try {
    // P1-2 review gate: import requires a durable human approval bound to
    // the EXACT stored result (decision.result_hash === stored hash).
    assertRunApprovedForImport(runId);
    const result = importRunToOnboarding(runId, {
      mode,
      onboardingItemId: (body as { onboardingItemId?: string | null }).onboardingItemId ?? null,
      fieldSelection: (body as { fieldSelection?: string[] }).fieldSelection,
      price: (body as { price?: string | null }).price ?? null,
      quantity: (body as { quantity?: number | null }).quantity ?? null,
      importingUser: (body as { importingUser?: string | null }).importingUser ?? null,
    });
    return c.json(
      { import: result.importRecord, itemId: result.item.id, batchId: result.batchId, created: result.created },
      result.created ? 201 : 200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The review gate fails closed with a 409; everything else stays 400.
    const status = message.includes('approval') || message.includes('stored result') ? 409 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * POST /api/product-intelligence/runs/:id/review — record a durable human
 * approve/reject decision bound to the run's exact stored result (P1-2).
 * Append-only; the latest decision is authoritative (supersedes chain).
 */
router.post('/product-intelligence/runs/:id/review', async (c) => {
  const runId = c.req.param('id');
  if (!requireRunInWorkspace(runId)) return c.json({ error: 'Run not found' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const decision = (body as { decision?: unknown }).decision;
  const displayLabel = (body as { reviewer?: unknown }).reviewer;
  if (decision !== 'approve' && decision !== 'reject') {
    return c.json({ error: "decision must be 'approve' or 'reject'" }, 400);
  }
  // Review finding 8: reviewer identity is NEVER client-asserted. The only
  // auth boundary is the optional shared API token on mutating routes — a
  // caller-typed string is a display label, not an authenticated identity.
  const authHeader = c.req.header('Authorization');
  const authentication = authHeader !== undefined && authHeader.startsWith('Bearer ') ? 'shared_api_token' : 'local_ui';
  const reviewerJson = JSON.stringify({
    actorType: 'local_operator',
    actorId: null,
    authentication,
    displayLabel: typeof displayLabel === 'string' && displayLabel.trim() !== '' ? displayLabel.trim() : null,
  });
  const note = (body as { note?: unknown }).note;
  if (note !== undefined && typeof note !== 'string') {
    return c.json({ error: 'note must be a string' }, 400);
  }

  const stored = getPiResult(runId);
  if (!stored) {
    return c.json({ error: 'Run has no stored result to review' }, 409);
  }
  const row = createReviewDecision({
    runId,
    decision,
    resultHash: stored.resultHash,
    reviewer: reviewerJson,
    note: note !== undefined ? String(note) : null,
  });
  return c.json({ decision: row }, 201);
});

/** GET /api/product-intelligence/runs/:id/review — latest decision + approval state. */
router.get('/product-intelligence/runs/:id/review', (c) => {
  const runId = c.req.param('id');
  if (!requireRunInWorkspace(runId)) return c.json({ error: 'Run not found' }, 404);
  const latest = getLatestReviewDecision(runId);
  const stored = getPiResult(runId);
  const approved = !!(stored && latest && latest.decision === 'approve' && latest.resultHash === stored.resultHash);
  return c.json({ decision: latest ?? null, approved });
});

/** POST /api/product-intelligence/runs/:id/replay — PI-10 replay modes. */
router.post('/product-intelligence/runs/:id/replay', async (c) => {
  const runId = c.req.param('id');
  if (!requireRunInWorkspace(runId)) return c.json({ error: 'Run not found' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const mode = (body as { mode?: string }).mode;
  if (mode !== 'deterministic' && mode !== 'rerun') {
    return c.json({ error: "mode must be 'deterministic' or 'rerun'" }, 400);
  }
  const compare = (body as { compare?: boolean }).compare === true;
  const flags = getProductIntelligenceFlags();
  if (mode === 'rerun' && !flags.productIntelligenceEnabled) {
    return c.json({ error: 'Product Intelligence is disabled' }, 403);
  }

  try {
    let executor;
    if (mode === 'rerun') {
      const original = getPiRun(runId);
      const selection = await buildRouter().resolveExecutorPreferring(original?.executor ?? '');
      executor = selection.executor;
    }
    const result = await replayPiRun(runId, { mode, compare, executor });
    return c.json({ runId: result.run.id, mode: result.mode, status: result.run.status, compare }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('still running') ? 409 : 400;
    return c.json({ error: message }, status);
  }
});

/** POST /api/product-intelligence/retention — PI-10 per-category retention. */
router.post('/product-intelligence/retention', async (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  // Legacy shape: { olderThanDays } applies one age to every category.
  if ((body as { olderThanDays?: number }).olderThanDays !== undefined) {
    const olderThanDays = Number((body as { olderThanDays?: number }).olderThanDays);
    if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
      return c.json({ error: 'olderThanDays must be a positive number' }, 400);
    }
    const policy = olderThanDaysPolicy(olderThanDays);
    const result = applyPiRetention(ws.id, policy);
    return c.json({ result, policy });
  }
  try {
    const policy = setPiRetentionPolicy(ws.id, PiRetentionPolicySchema.parse((body as { policy?: unknown }).policy ?? {}));
    const result = applyPiRetention(ws.id, policy);
    return c.json({ result, policy });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

/** GET /api/product-intelligence/retention — current per-category policy. */
router.get('/product-intelligence/retention', (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  return c.json({ policy: getPiRetentionPolicy(ws.id) });
});

/** GET /api/product-intelligence/budgets — current workspace budget policy. */
router.get('/product-intelligence/budgets', (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  return c.json({ policy: getPiBudgetPolicy(ws.id) });
});

/** POST /api/product-intelligence/budgets — set the workspace budget policy. */
router.post('/product-intelligence/budgets', async (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  try {
    const body = await c.req.json();
    const policy = setPiBudgetPolicy(ws.id, PiBudgetPolicySchema.parse((body as { policy?: unknown }).policy ?? {}));
    return c.json({ policy });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

/** GET /api/product-intelligence/flags — effective runtime flags. */
router.get('/product-intelligence/flags', (c) => {
  return c.json({ flags: getProductIntelligenceFlags() });
});

/**
 * POST /api/product-intelligence/evaluation/dataset/fixture
 * Seed the built-in versioned golden dataset (PI-9). Refuses duplicates.
 */
router.post('/product-intelligence/evaluation/dataset/fixture', (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  try {
    const result = seedPiGoldenDataset();
    return c.json({ ...result, name: PI_GOLDEN_DATASET_NAME }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('already exists')) return c.json({ error: message }, 409);
    return c.json({ error: message }, 400);
  }
});

/** POST /api/product-intelligence/evaluation/run — evaluate runs against a frozen dataset. */
router.post('/product-intelligence/evaluation/run', async (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const datasetId = String((body as { datasetId?: unknown }).datasetId ?? '');
  if (!datasetId) return c.json({ error: 'datasetId is required' }, 400);
  const runIds = Array.isArray((body as { runIds?: unknown }).runIds)
    ? ((body as { runIds?: unknown[] }).runIds as string[])
    : undefined;
  try {
    const result = runPiEvaluation({ datasetId, runIds });
    return c.json(result, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

/** GET /api/product-intelligence/evaluation/reports — aggregate report for a dataset version. */
router.get('/product-intelligence/evaluation/reports', (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  const datasetHash = c.req.query('datasetVersion');
  const db = getDb();
  let rows: Array<{ comparison_json: string }>;
  if (datasetHash) {
    rows = db
      .query('SELECT comparison_json FROM pi_evaluation_runs WHERE dataset_hash = ? ORDER BY created_at DESC')
      .all(datasetHash) as Array<{ comparison_json: string }>;
  } else {
    rows = db
      .query('SELECT comparison_json FROM pi_evaluation_runs ORDER BY created_at DESC LIMIT 500')
      .all() as Array<{ comparison_json: string }>;
  }
  const comparisons = rows
    .map((r) => {
      try {
        return JSON.parse(r.comparison_json) as Parameters<typeof aggregatePiComparisons>[0][number];
      } catch {
        return null;
      }
    })
    .filter((c): c is Parameters<typeof aggregatePiComparisons>[0][number] => c != null);
  const report = comparisons.length > 0 ? aggregatePiComparisons(comparisons) : null;
  return c.json({ datasetHash: datasetHash ?? null, sampleSize: comparisons.length, report });
});

/** POST /api/product-intelligence/evaluation/benchmark — extraction-provider benchmark. */
router.post('/product-intelligence/evaluation/benchmark', async (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const datasetId = String((body as { datasetId?: unknown }).datasetId ?? '');
  if (!datasetId) return c.json({ error: 'datasetId is required' }, 400);
  const providersRaw = (body as { providers?: unknown }).providers;
  const providers: Array<'stub' | 'http' | 'managed'> = Array.isArray(providersRaw)
    ? (providersRaw as string[]).filter((p): p is 'stub' | 'http' | 'managed' => p === 'stub' || p === 'http' || p === 'managed')
    : ['stub'];
  const network = (body as { network?: unknown }).network === true;
  // Managed-browser providers for the benchmark. Real vendor implementations
  // plug in programmatically; the API accepts deterministic stub pages so the
  // layer-7 seam can be scored end-to-end before any provider is adopted
  // (benchmark first — no provider ships adopted).
  let managed: { providers: ManagedBrowserProvider[] } | undefined;
  const managedRaw = (body as { managed?: unknown }).managed;
  if (Array.isArray(managedRaw)) {
    managed = {
      providers: managedRaw.map((entry) => {
        const entryObj = entry as { pages?: Array<{ url?: unknown; html?: unknown }> } | null;
        const pages = new Map<string, string>();
        if (Array.isArray(entryObj?.pages)) {
          for (const page of entryObj.pages) {
            if (page && typeof page.url === 'string' && typeof page.html === 'string') pages.set(page.url, page.html);
          }
        }
        return new StubManagedProvider(pages);
      }),
    };
  }
  try {
    const report = await runExtractionBenchmark({ datasetId, providers, network, managed });
    return c.json({ report }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

/**
 * POST /api/product-intelligence/evaluation/search-benchmark
 * Score product-page SEARCH strategies (the page-finding stage) against the
 * golden dataset: page-found rate, rank@1, precision@5, misleading-source
 * rejection, blocked-official recovery. Deterministic stubs model the real
 * discovery strategies; real vendors plug in programmatically.
 */
router.post('/product-intelligence/evaluation/search-benchmark', async (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const datasetId = String((body as { datasetId?: unknown }).datasetId ?? '');
  if (!datasetId) return c.json({ error: 'datasetId is required' }, 400);

  const strategiesRaw = (body as { strategies?: unknown }).strategies;
  const strategyNames: string[] = Array.isArray(strategiesRaw)
    ? (strategiesRaw as string[]).filter((s): s is string => typeof s === 'string')
    : ['web_search_perfect', 'sitemap', 'structured_database'];

  // Deterministic stub strategies modeled on the real discovery tools,
  // built from THIS dataset's gold labels (oracle upper bounds for the
  // scoring pipeline — real vendors plug in programmatically). The sitemap
  // stub cannot crawl blocked_official domains and the misleading stub
  // ranks noise above the truth, so the relative comparison is meaningful.
  const golden = getSearchFixtures(datasetId);
  const strategyRegistry: Record<string, SearchStrategyAdapter | undefined> = {
    web_search_perfect: new PerfectWebSearchStub(golden.pagesByGtin),
    sitemap: new SitemapSearchStub(golden.pagesByDomain),
    structured_database: new DatabaseSearchStub(golden.pagesByGtin),
    web_search_misleading: new MisleadingSearchStub(golden.pagesByGtin, golden.misleadingByGtin),
  };
  const strategies: Array<SearchStrategyAdapter | { name: string; version?: string }> = strategyNames.map(
    (name) => strategyRegistry[name] ?? { name, version: 'n/a' },
  );

  try {
    const report = await runSearchBenchmark({ datasetId, strategies });
    return c.json({ report }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

/** Search fixtures derived from the dataset's own gold labels. */
function getSearchFixtures(datasetId: string): {
  pagesByGtin: Map<string, string>;
  pagesByDomain: Map<string, Map<string, string>>;
  misleadingByGtin: Map<string, string>;
} {
  const pagesByGtin = new Map<string, string>();
  const pagesByDomain = new Map<string, Map<string, string>>();
  const misleadingByGtin = new Map<string, string>();
  const examples = getExamples(datasetId, 'test');
  for (const example of examples) {
    const input = PiProductInputSchema.safeParse(JSON.parse(example.input_snapshot_json));
    const gold = PiGoldLabelsSchema.safeParse(JSON.parse(example.gold_labels_json));
    if (!input.success || !gold.success || !input.data.expectedPageUrl) continue;
    pagesByGtin.set(input.data.gtin, input.data.expectedPageUrl);
    const domain = (() => {
      try {
        return new URL(input.data.expectedPageUrl).hostname.toLowerCase();
      } catch {
        return null;
      }
    })();
    // A sitemap crawl cannot reach blocked official domains.
    if (domain && !gold.data.difficultyTags.includes('blocked_official')) {
      const existing = pagesByDomain.get(domain) ?? new Map<string, string>();
      existing.set(input.data.gtin, input.data.expectedPageUrl);
      pagesByDomain.set(domain, existing);
    }
    const misleading = gold.data.misleadingSources[0];
    if (misleading) {
      misleadingByGtin.set(input.data.gtin, `https://${misleading.domain}/misleading`);
    }
  }
  return { pagesByGtin, pagesByDomain, misleadingByGtin };
}

/** GET /api/product-intelligence/rollout — rollout state + gates + kill switch. */
router.get('/product-intelligence/rollout', (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  return c.json({ state: currentRolloutState() });
});

/** POST /api/product-intelligence/rollout — set the documented rollout stage. */
router.post('/product-intelligence/rollout', async (c) => {
  const ws = requireWorkspace();
  if (!ws) return c.json({ error: 'No active workspace' }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  try {
    const config = setRolloutConfig({
      stage: (body as { stage?: unknown }).stage as RolloutStage,
      documentedBy: String((body as { documentedBy?: unknown }).documentedBy ?? ''),
      thresholds: Array.isArray((body as { thresholds?: unknown }).thresholds)
        ? ((body as { thresholds?: unknown[] }).thresholds as RolloutGateThreshold[])
        : undefined,
    });
    return c.json({ config }, 200);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

export default router;
