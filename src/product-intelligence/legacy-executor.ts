/**
 * Legacy (deterministic, no-agent) Product Intelligence executor (PI-1).
 *
 * When Pi is disabled or unavailable, the router selects this executor. It is
 * fail-closed: it performs no research and returns outcome `unavailable`
 * instead of producing ungrounded proposals. This keeps normal onboarding
 * fully functional when Pi is not installed or configured, while guaranteeing
 * that no result can be mistaken for agent research.
 *
 * Future phases may extend this executor with deterministic search/sitemap
 * lookups — any such output must still carry evidence provenance.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 */
import {
  LEGACY_EXECUTOR_NAME,
  ProductResearchContextSchema,
  ProductResearchInputSchema,
  type ProductResearchResult,
} from './contracts';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from './executor';
import { emitExecutionEvent } from './executor';

export const LEGACY_EXECUTOR_VERSION = '1.0.0';

export class LegacyProductIntelligenceExecutor implements ProductIntelligenceExecutor {
  readonly name = LEGACY_EXECUTOR_NAME;
  readonly version = LEGACY_EXECUTOR_VERSION;

  async startResearch(
    input: unknown,
    context: unknown,
    events: ExecutionEventSink,
  ): Promise<ProductResearchResult> {
    const startedAt = Date.now();
    const parsedInput = ProductResearchInputSchema.safeParse(input);
    const parsedContext = ProductResearchContextSchema.safeParse(context);

    emitExecutionEvent(events, 'run_started', {
      message: `Legacy executor started for ${parsedInput.success ? parsedInput.data.gtin : 'invalid input'}`,
    });
    emitExecutionEvent(events, 'executor_selected', {
      data: { executor: this.name, reason: 'legacy executor is the deterministic fallback' },
    });

    if (!parsedInput.success) {
      const failure = {
        code: 'invalid_input' as const,
        message: `Product research input failed validation: ${parsedInput.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      };
      emitExecutionEvent(events, 'run_failed', { isError: true, message: failure.message });
      return {
        runId: typeof context === 'object' && context !== null && 'runId' in context
          ? String(context.runId)
          : 'unknown',
        outcome: 'failed',
        executor: this.name,
        executorVersion: this.version,
        extensionVersions: [],
        configId: 'unavailable',
        durationMs: Date.now() - startedAt,
        submission: null,
        failure,
        events: events.snapshot(),
      };
    }

    if (!parsedContext.success) {
      const failure = {
        code: 'invalid_input' as const,
        message: 'Product research context failed validation',
      };
      emitExecutionEvent(events, 'run_failed', { isError: true, message: failure.message });
      return {
        runId: 'unknown',
        outcome: 'failed',
        executor: this.name,
        executorVersion: this.version,
        extensionVersions: [],
        configId: 'unavailable',
        durationMs: Date.now() - startedAt,
        submission: null,
        failure,
        events: events.snapshot(),
      };
    }

    const { runId, policy } = parsedContext.data;

    // Fail closed: no research is performed by the deterministic path in this
    // release. The caller (review/onboarding) must treat 'unavailable' as
    // "no agent evidence available" — never as an empty approval.
    emitExecutionEvent(events, 'run_completed', {
      message:
        'Legacy executor completed without research: deterministic research is unavailable in this release; enable Pi for evidence-backed runs.',
      data: { outcome: 'unavailable' },
    });

    return {
      runId,
      outcome: 'unavailable',
      executor: this.name,
      executorVersion: this.version,
      extensionVersions: [],
      configId: policy.configId,
      durationMs: Date.now() - startedAt,
      submission: null,
      failure: null,
      events: events.snapshot(),
    };
  }
}
