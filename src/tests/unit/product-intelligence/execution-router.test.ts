/**
 * Execution router tests (PI-1). Includes the integration-style test: a run
 * through the router with a fake executor performs zero external calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionRouter } from '../../../product-intelligence/execution-router';
import { overrideProductIntelligenceFlags, resetProductIntelligenceFlagsOverride } from '../../../product-intelligence/flags';
import { LEGACY_EXECUTOR_NAME, PI_EXECUTOR_NAME, type ProductResearchResult } from '../../../product-intelligence/contracts';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../../product-intelligence/executor';
import { createExecutionEventSink } from '../../../product-intelligence/executor';
import { LegacyProductIntelligenceExecutor } from '../../../product-intelligence/legacy-executor';
import { asPi1Submission, TEST_INPUT, testContext, validSubmission } from './test-helpers';

function fakePiExecutor(name = 'pi'): ProductIntelligenceExecutor {
  const calls: Array<{ input: unknown; context: unknown }> = [];
  return {
    name,
    version: '1.0.0',
    async startResearch(input, context, _events: ExecutionEventSink): Promise<ProductResearchResult> {
      calls.push({ input, context });
      const ctx = context as { runId: string };
      return {
        runId: ctx.runId,
        outcome: 'submitted',
        executor: name,
        executorVersion: '1.0.0',
        piVersion: '0.83.0',
        extensionVersions: [],
        configId: 'config-test-0001',
        durationMs: 5,
        submission: validSubmission(),
        failure: null,
        events: [],
      };
    },
  };
}

describe('createExecutionRouter', () => {
  afterEach(() => resetProductIntelligenceFlagsOverride());

  it('selects the legacy executor when all flags are disabled (default)', async () => {
    const legacy = new LegacyProductIntelligenceExecutor();
    const router = createExecutionRouter({ legacy });
    const selection = await router.resolveExecutor();
    expect(selection.name).toBe(LEGACY_EXECUTOR_NAME);
    expect(selection.executor).toBe(legacy);
  });

  it('selects the legacy executor when Pi is disabled but PI is enabled', async () => {
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: false });
    const legacy = new LegacyProductIntelligenceExecutor();
    const pi = fakePiExecutor();
    const router = createExecutionRouter({ legacy, pi });
    const selection = await router.resolveExecutor();
    expect(selection.name).toBe(LEGACY_EXECUTOR_NAME);
  });

  it('selects the Pi executor when both flags are enabled and Pi is available', async () => {
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: true });
    const legacy = new LegacyProductIntelligenceExecutor();
    const pi = fakePiExecutor();
    const router = createExecutionRouter({ legacy, pi });
    const selection = await router.resolveExecutor();
    expect(selection.name).toBe(PI_EXECUTOR_NAME);
    expect(selection.executor).toBe(pi);
  });

  it('falls back to legacy when Pi is enabled but not installed/configured', async () => {
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: true });
    const legacy = new LegacyProductIntelligenceExecutor();
    const router = createExecutionRouter({ legacy, pi: null });
    const selection = await router.resolveExecutor();
    expect(selection.name).toBe(LEGACY_EXECUTOR_NAME);
    expect(selection.reason).toContain('not installed');
  });

  it('honors a custom flag provider', async () => {
    const legacy = new LegacyProductIntelligenceExecutor();
    const pi = fakePiExecutor();
    const router = createExecutionRouter({
      legacy,
      pi,
      flags: () => ({ productIntelligenceEnabled: true, piEnabled: true, shadowOnly: true, allowOnboardingImport: false, allowBatchRuns: false, killSwitch: false }),
    });
    expect((await router.resolveExecutor()).name).toBe(PI_EXECUTOR_NAME);
  });

  it('lists the active executor and available alternatives', async () => {
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: true });
    const legacy = new LegacyProductIntelligenceExecutor();
    const pi = fakePiExecutor();
    const router = createExecutionRouter({ legacy, pi });
    const executors = await router.listExecutors();
    expect(executors.map((e) => e.name).sort()).toEqual([LEGACY_EXECUTOR_NAME, PI_EXECUTOR_NAME]);
  });

  it('resolveExecutorPreferring does not override the kill switch (P0-4)', async () => {
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: true, killSwitch: true });
    const legacy = new LegacyProductIntelligenceExecutor();
    const pi = fakePiExecutor();
    const router = createExecutionRouter({ legacy, pi });
    const selection = await router.resolveExecutorPreferring(PI_EXECUTOR_NAME);
    expect(selection.name).toBe(LEGACY_EXECUTOR_NAME);
    expect(selection.executor).toBe(legacy);
  });

  it('resolveExecutorPreferring returns the diverted selection when Pi is disabled (P0-4)', async () => {
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: false });
    const legacy = new LegacyProductIntelligenceExecutor();
    const pi = fakePiExecutor();
    const router = createExecutionRouter({ legacy, pi });
    const selection = await router.resolveExecutorPreferring(PI_EXECUTOR_NAME);
    expect(selection.name).toBe(LEGACY_EXECUTOR_NAME);
    expect(selection.executor).toBe(legacy);
  });

  it('resolveExecutorPreferring returns the Pi executor when the flags select it (P0-4)', async () => {
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: true });
    const legacy = new LegacyProductIntelligenceExecutor();
    const pi = fakePiExecutor();
    const router = createExecutionRouter({ legacy, pi });
    const selection = await router.resolveExecutorPreferring(PI_EXECUTOR_NAME);
    expect(selection.name).toBe(PI_EXECUTOR_NAME);
    expect(selection.executor).toBe(pi);
  });
});

describe('router integration with a fake executor (no external calls)', () => {
  afterEach(() => resetProductIntelligenceFlagsOverride());

  it('runs a submitted research through the router end-to-end', async () => {
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true, piEnabled: true });
    const pi = fakePiExecutor();
    const router = createExecutionRouter({ legacy: new LegacyProductIntelligenceExecutor(), pi });

    const selection = await router.resolveExecutor();
    const events = createExecutionEventSink('run-integration-1');
    const result = await selection.executor.startResearch(TEST_INPUT, testContext({ runId: 'run-integration-1' }), events);

    expect(result.outcome).toBe('submitted');
    expect(result.executor).toBe('pi');
    const pi1 = asPi1Submission(result.submission);
    expect(pi1?.identity.gtinMatch).toBe('exact');
    expect(pi1?.evidenceSources.length).toBeGreaterThan(0);
    expect(events.snapshot().length).toBe(0); // fake executor emits no events; real executors do
  });

  it('dispatches to the legacy executor when Pi is off (defaults)', async () => {
    const legacy = new LegacyProductIntelligenceExecutor();
    const pi = fakePiExecutor();
    const router = createExecutionRouter({ legacy, pi });

    const selection = await router.resolveExecutor();
    const events = createExecutionEventSink('run-integration-2');
    const result = await selection.executor.startResearch(TEST_INPUT, testContext({ runId: 'run-integration-2' }), events);

    expect(result.executor).toBe('legacy');
    expect(result.outcome).toBe('unavailable');
    expect(result.submission).toBeNull();
  });

  it('resolves executors without any side effects or external calls', async () => {
    const spy = vi.fn();
    const legacy = {
      name: LEGACY_EXECUTOR_NAME,
      version: '1.0.0',
      startResearch: spy,
    } as unknown as ProductIntelligenceExecutor;
    const router = createExecutionRouter({ legacy });
    await router.resolveExecutor();
    await router.listExecutors();
    expect(spy).not.toHaveBeenCalled();
  });
});
