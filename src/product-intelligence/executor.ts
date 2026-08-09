
import type { ProductIntelligenceExecutionEvent, ProductResearchContext, ProductResearchInput, ProductResearchResult } from './contracts';

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
