/**
 * Legacy (deterministic) executor tests (PI-1): fail-closed unavailable
 * outcome, input validation, and normalized events.
 */
import { describe, expect, it } from 'vitest';
import { LegacyProductIntelligenceExecutor } from '../../../product-intelligence/legacy-executor';
import { createExecutionEventSink } from '../../../product-intelligence/executor';
import { TEST_INPUT, testContext } from './test-helpers';

describe('LegacyProductIntelligenceExecutor', () => {
  it('returns a fail-closed unavailable result with no submission', async () => {
    const executor = new LegacyProductIntelligenceExecutor();
    const events = createExecutionEventSink('run-legacy-1');
    const result = await executor.startResearch(TEST_INPUT, testContext({ runId: 'run-legacy-1' }), events);

    expect(result.executor).toBe('legacy');
    expect(result.outcome).toBe('unavailable');
    expect(result.submission).toBeNull();
    expect(result.failure).toBeNull();
    expect(result.configId).toBe('config-test-0001');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const types = events.snapshot().map((event) => event.type);
    expect(types).toContain('run_started');
    expect(types).toContain('executor_selected');
    expect(types).toContain('run_completed');
    expect(types).not.toContain('submission_received');
  });

  it('fails closed on invalid input', async () => {
    const executor = new LegacyProductIntelligenceExecutor();
    const events = createExecutionEventSink('run-legacy-2');
    const result = await executor.startResearch(
      { gtin: 'abc', registerName: 'x' },
      testContext({ runId: 'run-legacy-2' }),
      events,
    );

    expect(result.outcome).toBe('failed');
    expect(result.failure?.code).toBe('invalid_input');
    expect(result.submission).toBeNull();
    expect(events.snapshot().some((event) => event.type === 'run_failed')).toBe(true);
  });

  it('fails closed on invalid context', async () => {
    const executor = new LegacyProductIntelligenceExecutor();
    const result = await executor.startResearch(TEST_INPUT, { runId: 'r' }, createExecutionEventSink('run-legacy-3'));
    expect(result.outcome).toBe('failed');
    expect(result.failure?.code).toBe('invalid_input');
  });
});
