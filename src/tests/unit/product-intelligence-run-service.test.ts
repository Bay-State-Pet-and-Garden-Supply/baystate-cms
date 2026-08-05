/**
 * Product Intelligence run service tests (PI-2).
 *
 * DB-backed (bun test). Uses a fake executor (no Pi SDK, no network) to
 * verify the durable run lifecycle end-to-end: happy path, abstention,
 * unavailable (legacy), failure, cancellation, timeout, replay cursors,
 * comparisons, retention, and review-blocking signals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  getPiRun,
  getPiResult,
  listPiEvents,
  listPiEvidence,
  listPiSources,
} from '../../db/repositories/product-intelligence-repo';
import {
  buildDefaultPiPolicy,
  cancelPiRun,
  createPiComparison,
  getPiRunProjection,
  replayPiEvents,
  runRetentionCleanup,
  startProductIntelligenceRun,
} from '../../product-intelligence/run-service';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../product-intelligence/executor';
import type { ProductResearchContext, ProductResearchInput, ProductResearchResult } from '../../product-intelligence/contracts';
import { TEST_INPUT, validSubmission } from './product-intelligence/test-helpers';

const wsId = 'pi-service-test-workspace';

// ---------------------------------------------------------------------------
// Fake executor: scriptable terminal outcomes, no external calls
// ---------------------------------------------------------------------------

class FakePiExecutor implements ProductIntelligenceExecutor {
  readonly name = 'pi';
  readonly version = '1.0.0';
  outcome: ProductResearchResult['outcome'] = 'submitted';
  submission = validSubmission();
  failure: ProductResearchResult['failure'] = null;
  emitToolCalls = true;
  /** When true, research waits until the caller signal aborts. */
  hangUntilAborted = false;
  lastContext: ProductResearchContext | null = null;
  calls = 0;

  async startResearch(
    input: ProductResearchInput,
    context: ProductResearchContext,
    events: ExecutionEventSink,
  ): Promise<ProductResearchResult> {
    this.calls += 1;
    this.lastContext = context;
    if (this.hangUntilAborted) {
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          context.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        context.signal?.addEventListener('abort', onAbort, { once: true });
        // Safety: never hang the test forever.
        setTimeout(resolve, 5_000);
      });
    }
    // Honor the caller cancellation signal (deterministic cancel test).
    if (context.signal?.aborted) {
      events.emit('run_cancelled', { message: 'cancelled by caller signal' });
      return {
        runId: context.runId,
        outcome: 'cancelled',
        executor: this.name,
        executorVersion: this.version,
        extensionVersions: [],
        configId: context.policy.configId,
        durationMs: 1,
        submission: null,
        failure: null,
        events: events.snapshot(),
      };
    }
    events.emit('run_started', { message: `researching ${input.gtin}` });
    events.emit('session_created', { data: { piVersion: '0.83.0', tools: ['read', 'grep', 'find', 'ls', 'submit_product_research'] } });
    if (this.emitToolCalls) {
      events.emit('tool_call_started', { toolName: 'read' });
      events.emit('tool_call_finished', { toolName: 'read', isError: false });
    }
    const startedAt = Date.now();
    switch (this.outcome) {
      case 'submitted':
      case 'abstained':
        events.emit('submission_received', { data: { schemaVersion: this.submission.schemaVersion } });
        events.emit('run_completed', { data: { outcome: this.outcome } });
        return {
          runId: context.runId,
          outcome: this.outcome,
          executor: this.name,
          executorVersion: this.version,
          piVersion: '0.83.0',
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: Date.now() - startedAt,
          submission: this.submission,
          failure: null,
          events: events.snapshot(),
        };
      case 'unavailable':
        events.emit('run_completed', { data: { outcome: 'unavailable' } });
        return {
          runId: context.runId,
          outcome: 'unavailable',
          executor: 'legacy',
          executorVersion: '1.0.0',
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: 1,
          submission: null,
          failure: null,
          events: events.snapshot(),
        };
      case 'failed':
        events.emit('run_failed', { isError: true, message: this.failure?.message ?? 'no submission', data: { code: this.failure?.code ?? 'missing_submission' } });
        return {
          runId: context.runId,
          outcome: 'failed',
          executor: this.name,
          executorVersion: this.version,
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: 1,
          submission: null,
          failure: this.failure ?? { code: 'missing_submission', message: 'no submission' },
          events: events.snapshot(),
        };
      case 'cancelled':
        events.emit('run_cancelled', { message: 'cancelled' });
        return {
          runId: context.runId,
          outcome: 'cancelled',
          executor: this.name,
          executorVersion: this.version,
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: 1,
          submission: null,
          failure: null,
          events: events.snapshot(),
        };
      case 'timed_out':
        events.emit('run_timeout', { message: 'deadline' });
        return {
          runId: context.runId,
          outcome: 'timed_out',
          executor: this.name,
          executorVersion: this.version,
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: 1,
          submission: null,
          failure: { code: 'deadline_exceeded', message: 'deadline' },
          events: events.snapshot(),
        };
    }
  }
}

describe('Product Intelligence run service', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-service-test.db');

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Service Test',
      workspacePath: '/tmp/pi-service-workspace',
      gitPath: '/tmp/pi-service-workspace/.git',
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

  const runOpts = { workspaceId: wsId, workspacePath: '/tmp/pi-service-workspace' };

  it('runs a submitted research end-to-end with durable artifacts', async () => {
    const executor = new FakePiExecutor();
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT, mode: 'shadow' }, runOpts);
    await started.completed;

    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('completed');
    expect(run?.mode).toBe('shadow');
    expect(run?.piVersion).toBe('0.83.0');
    expect(run?.configSnapshotId).toBe(buildDefaultPiPolicy().configId);
    expect(JSON.parse(run?.inputJson ?? '{}').gtin).toBe(TEST_INPUT.gtin);
    expect(run?.codeCommit).toBeTruthy();

    // Result with schema version + content hash.
    const result = getPiResult(started.run.id);
    expect(result?.disposition).toBe('submitted');
    expect(result?.schemaVersion).toBe(1);
    expect(result?.resultHash).toBeTruthy();

    // Normalized sources and evidence persisted from the submission.
    const sources = listPiSources(started.run.id);
    expect(sources.length).toBe(1);
    expect(sources[0].domain).toBe('supplier.example.com');
    const evidence = listPiEvidence(started.run.id);
    expect(evidence.length).toBe(1);
    expect(evidence[0].targetField).toBe('gtin');

    // Events persisted in order; tool call derived.
    const events = listPiEvents(started.run.id);
    expect(events.length).toBeGreaterThan(3);
    expect(events.map((e) => e.type)).toContain('submission_received');
    // The SSE-facing stream maps normalized types to domain events.
    const mapped = replayPiEvents(started.run.id).map((e) => e.type);
    expect(mapped).toContain('run.completed');
    expect(mapped).toContain('source.added');
    expect(mapped).toContain('evidence.added');
    // No duplicate run.started/run.completed (service emits only additive events).
    expect(mapped.filter((t) => t === 'run.completed')).toHaveLength(1);
    const toolCalls = getPiRunProjection(started.run.id)?.toolCalls as Array<{ toolName: string }>;
    expect(toolCalls[0].toolName).toBe('read');

    // Steps derived (session + submission).
    const steps = getPiRunProjection(started.run.id)?.steps as Array<{ stepType: string; status: string }>;
    expect(steps.map((s) => s.stepType).sort()).toEqual(['session', 'submission']);

    // Policy signal wired into the executor context.
    expect(executor.lastContext?.signal).toBeInstanceOf(AbortSignal);
    expect(executor.lastContext?.executionMode).toBe('shadow');
  });

  it('persists an abstained run and emits no needs_review for exact identity', async () => {
    const executor = new FakePiExecutor();
    executor.submission = { ...validSubmission(), abstention: { scope: 'full', reason: 'r', actionableNextStep: 'n', targets: [] }, productProposal: { fields: [] } };
    executor.outcome = 'abstained';
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT, mode: 'shadow' }, runOpts);
    await started.completed;
    expect(getPiResult(started.run.id)?.disposition).toBe('abstained');
    const types = replayPiEvents(started.run.id).map((e) => e.type);
    expect(types).not.toContain('run.needs_review');
  });

  it('flags needs_review when identity is not exact or images are unknown', async () => {
    const executor = new FakePiExecutor();
    executor.submission = {
      ...validSubmission(),
      identity: { ...validSubmission().identity, gtinMatch: 'unknown', gtinEvidenceIds: [] },
      images: [{ url: 'https://example.com/i.jpg', sourceId: 'src-1', rightsStatus: 'unknown', identityMatch: 'unknown', evidenceIds: [] }],
    };
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const types = listPiEvents(started.run.id).map((e) => e.type);
    expect(types).toContain('run.needs_review');
    const payload = JSON.parse(listPiEvents(started.run.id).find((e) => e.type === 'run.needs_review')!.payloadJson);
    expect(payload.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('marks unavailable runs completed with disposition unavailable (legacy path)', async () => {
    const executor = new FakePiExecutor();
    executor.outcome = 'unavailable';
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    expect(getPiRun(started.run.id)?.status).toBe('completed');
    expect(getPiResult(started.run.id)?.disposition).toBe('unavailable');
  });

  it('fails runs with the executor failure code', async () => {
    const executor = new FakePiExecutor();
    executor.outcome = 'failed';
    executor.failure = { code: 'missing_submission', message: 'session ended without submission' };
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('failed');
    expect(run?.errorCode).toBe('missing_submission');
    expect(run?.errorMessage).toContain('submission');
    const types = replayPiEvents(started.run.id).map((e) => e.type);
    expect(types).toContain('run.failed');
  });

  it('marks timed-out runs failed with deadline_exceeded', async () => {
    const executor = new FakePiExecutor();
    executor.outcome = 'timed_out';
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('failed');
    expect(run?.errorCode).toBe('deadline_exceeded');
  });

  it('marks cancelled runs cancelled when the caller aborts', async () => {
    const executor = new FakePiExecutor();
    executor.hangUntilAborted = true;
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    expect(cancelPiRun(started.run.id)).toBe(true);
    await started.completed;
    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.cancelledAt).toBeTruthy();
    expect(run?.completedAt).toBeNull();
    const types = replayPiEvents(started.run.id).map((e) => e.type);
    expect(types).toContain('run.cancelled');
  });

  it('propagates executor throws as failed runs', async () => {
    const executor = new FakePiExecutor();
    executor.startResearch = async () => {
      throw new Error('boom');
    };
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await expect(started.completed).rejects.toThrow('boom');
    expect(getPiRun(started.run.id)?.status).toBe('failed');
    expect(getPiRun(started.run.id)?.errorCode).toBe('unknown');
  });

  it('replays events after a cursor (SSE reconnect)', async () => {
    const executor = new FakePiExecutor();
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const all = replayPiEvents(started.run.id);
    expect(all.length).toBe(listPiEvents(started.run.id).length);
    // Replay from a mid-stream cursor returns only newer events, in order.
    const cursor = 1;
    const tail = replayPiEvents(started.run.id, cursor);
    expect(tail.every((e) => e.sequence > cursor)).toBe(true);
    const sequences = tail.map((e) => e.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });

  it('creates comparisons with metrics against a baseline', async () => {
    const executor = new FakePiExecutor();
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const comparison = createPiComparison({ runId: started.run.id, baselineType: 'legacy', baselineRef: 'legacy-run-xyz' });
    const metrics = JSON.parse((comparison as { metricsJson: string }).metricsJson);
    expect(metrics.executor).toBe('pi');
    expect(metrics.outcome).toBe('submitted');
    expect(metrics.fieldCount).toBe(1);
    expect(metrics.sourceCount).toBe(1);
  });

  it('enforces retention policy (terminal only, older than cutoff)', async () => {
    const executor = new FakePiExecutor();
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const db = getDb();
    db.run('UPDATE product_intelligence_runs SET started_at = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', started.run.id]);
    const deleted = runRetentionCleanup(wsId, 30);
    expect(deleted).toBe(1);
    expect(getPiRun(started.run.id)).toBeFalsy();
    expect(listPiEvents(started.run.id)).toHaveLength(0); // cascade
  });

  it('rejects runs when no workspace exists', async () => {
    const executor = new FakePiExecutor();
    // Force the workspace lookup off by passing a workspace that does not exist.
    await expect(
      startProductIntelligenceRun(executor, { input: TEST_INPUT }, { workspaceId: 'missing-ws', workspacePath: '/tmp/nope' }),
    ).rejects.toThrow(/workspace/i);
  });

  it('keeps the default policy immutable and self-hashed', () => {
    const a = buildDefaultPiPolicy();
    const b = buildDefaultPiPolicy();
    expect(a.configId).toMatch(/^[a-f0-9]{64}$/);
    expect(a.configId).toBe(b.configId);
    expect(a.modelRoute).toBeNull();
    expect(a.allowedTools).toEqual(['read', 'grep', 'find', 'ls']);
  });
});
