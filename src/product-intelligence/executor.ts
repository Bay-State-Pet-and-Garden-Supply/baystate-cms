/**
 * Provider-neutral Product Intelligence executor interface (PI-1).
 *
 * Any agent runtime (Pi today, fakes in tests, others later) implements
 * `ProductIntelligenceExecutor`. The CMS workflow depends only on this
 * interface, so a runtime can be added, shadowed, disabled, or replaced
 * without rewriting onboarding, classification, review, or promotion.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 */
import { randomUUID } from 'node:crypto';
import type {
  ProductIntelligenceExecutionEvent,
  ProductIntelligencePolicy,
  ProductResearchContext,
  ProductResearchInput,
  ProductResearchResult,
} from './contracts';
import { ExecutionEventTypeSchema } from './contracts';

export interface ProductIntelligenceExecutor {
  /** Stable executor name recorded on results and events. */
  readonly name: string;
  /** Executor implementation version (code-level, bumped on behavior change). */
  readonly version: string;

  /**
   * Start a research run.
   *
   * Implementations must:
   * - honor `context.signal` (abort -> cancelled) and `context.policy.deadlineMs` (hard deadline);
   * - emit normalized execution events through the returned sink;
   * - never resolve with a `submitted` result without a schema-valid terminal submission;
   * - treat `input` and all fetched content as untrusted data;
   * - dispose any agent session after every terminal outcome.
   */
  startResearch(
    input: ProductResearchInput,
    context: ProductResearchContext,
    events: ExecutionEventSink,
  ): Promise<ProductResearchResult>;
}

/**
 * Normalized event sink. PI-2 persists events durably; PI-7 renders them live.
 * Executors must never throw through this interface — emission failures are
 * swallowed and surfaced as a warning event when possible.
 */
export interface ExecutionEventSink {
  readonly runId: string;
  emit(
    type: ProductIntelligenceExecutionEvent['type'],
    fields?: Omit<
      Partial<ProductIntelligenceExecutionEvent>,
      'type' | 'runId' | 'sequence' | 'timestamp'
    >,
  ): void;
  /** All events emitted so far (for in-memory results). */
  snapshot(): ProductIntelligenceExecutionEvent[];
}

export function createExecutionEventSink(runId: string): ExecutionEventSink {
  const events: ProductIntelligenceExecutionEvent[] = [];
  let sequence = 0;
  return {
    runId,
    emit(type, fields = {}) {
      const event: ProductIntelligenceExecutionEvent = {
        type,
        runId,
        sequence: sequence++,
        timestamp: new Date().toISOString(),
        ...fields,
      };
      events.push(event);
      // Executors keep working if an observer throws; events stay in-memory
      // and are returned with the result.
    },
    snapshot() {
      return events.slice();
    },
  };
}

export function emitExecutionEvent(
  events: ExecutionEventSink,
  type: ProductIntelligenceExecutionEvent['type'],
  fields?: Omit<Partial<ProductIntelligenceExecutionEvent>, 'type' | 'runId' | 'sequence' | 'timestamp'>,
): void {
  events.emit(type, fields);
}

export { ExecutionEventTypeSchema };

/** Policy helper: hash a policy into an immutable config id. */
export function buildPolicyWithConfigId(policy: Omit<ProductIntelligencePolicy, 'configId'>, configId: string): ProductIntelligencePolicy {
  return { ...policy, configId };
}

/** Generate a run id (PI-2 will assign ids durably). */
export function newRunId(): string {
  return randomUUID();
}
