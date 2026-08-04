/**
 * Pi-backed Product Intelligence executor (PI-1).
 *
 * Orchestrates a bounded Pi research session:
 * - resolves the model from the immutable policy (fail closed otherwise);
 * - exposes only the allowlisted tools plus the terminal submission tool;
 * - streams normalized execution events (never chain-of-thought);
 * - enforces the hard deadline and cancellation signal;
 * - rejects sessions that end without a valid terminal submission;
 * - disposes the session after every terminal outcome;
 * - records exact Pi and extension versions on the result.
 *
 * The agent researches and proposes; deterministic CMS code validates,
 * reviews, promotes, and publishes. Model-reported confidence is recorded but
 * never treated as approval.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 */
import { PI_EXECUTOR_NAME, ProductResearchContextSchema, ProductResearchInputSchema, type ProductResearchContext, type ProductResearchResult, type StructuredSubmission } from '../contracts';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../executor';
import { emitExecutionEvent } from '../executor';
import { buildResearchPrompt } from './pi-prompt-builder';
import type { PiSessionFactory, PiSessionHandle } from './pi-session-factory';
import { PiSdkSessionFactory, PiSessionError } from './pi-session-factory';

export const PI_EXECUTOR_VERSION = '1.0.0';

export interface PiExecutorOptions {
  /**
   * Session factory. Defaults to the real Pi SDK factory; tests inject a fake
   * so no external calls occur.
   */
  sessionFactory?: PiSessionFactory;
  /** Clock for deterministic deadline tests. */
  now?: () => number;
  /** Delay helper for tests (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export class PiProductIntelligenceExecutor implements ProductIntelligenceExecutor {
  readonly name = PI_EXECUTOR_NAME;
  readonly version = PI_EXECUTOR_VERSION;

  private readonly sessionFactory: PiSessionFactory;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PiExecutorOptions = {}) {
    this.sessionFactory = options.sessionFactory ?? new PiSdkSessionFactory();
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async startResearch(
    input: unknown,
    context: unknown,
    events: ExecutionEventSink,
  ): Promise<ProductResearchResult> {
    const startedAt = this.now();
    const parsedInput = ProductResearchInputSchema.safeParse(input);
    const parsedContext = ProductResearchContextSchema.safeParse(context);

    emitExecutionEvent(events, 'run_started', {
      message: `Pi executor started for ${parsedInput.success ? parsedInput.data.gtin : 'invalid input'}`,
    });
    emitExecutionEvent(events, 'executor_selected', {
      data: { executor: this.name, reason: 'pi executor selected by configuration' },
    });

    const contextConfigId = parsedContext.success ? parsedContext.data.policy.configId : 'unknown';

    if (!parsedInput.success) {
      return this.fail(
        events,
        parsedContext.success ? parsedContext.data.runId : 'unknown',
        'invalid_input',
        `Product research input failed validation: ${parsedInput.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        startedAt,
        contextConfigId,
      );
    }
    if (!parsedContext.success) {
      return this.fail(
        events,
        'unknown',
        'invalid_input',
        'Product research context failed validation',
        startedAt,
        'unknown',
      );
    }

    const { runId, policy } = parsedContext.data;
    // `signal` is runtime-only and deliberately absent from the Zod schema —
    // read it from the raw context, never from the parsed (stripped) output.
    const signal = (context as ProductResearchContext).signal;
    const configId = policy.configId;
    const deadlineAt = startedAt + policy.deadlineMs;

    // --- Cancellation before start -----------------------------------------
    if (signal?.aborted) {
      emitExecutionEvent(events, 'run_cancelled', { message: 'Run cancelled before session start' });
      return this.buildResult(events, runId, 'cancelled', startedAt, {
        session: null,
        configId,
      });
    }

    let handle: PiSessionHandle | null = null;
    // Holder object: TS strict CFA narrows closure-assigned `let` bindings to
    // `never`, so mutable run state lives in this object instead.
    const state: {
      submission: StructuredSubmission | null;
      toolCallCount: number;
      sessionEnded: boolean;
      timedOut: boolean;
      cancelled: boolean;
      budgetExceeded: boolean;
      sessionError: string | null;
    } = {
      submission: null,
      toolCallCount: 0,
      sessionEnded: false,
      timedOut: false,
      cancelled: false,
      budgetExceeded: false,
      sessionError: null,
    };

    const onSubmission = (value: StructuredSubmission): void => {
      state.submission = value;
      emitExecutionEvent(events, 'submission_received', {
        message: 'Terminal submission received and schema-validated',
        data: { schemaVersion: value.schemaVersion },
      });
    };

    try {
      // --- Session creation -------------------------------------------------
      try {
        handle = await this.sessionFactory.createSession(parsedInput.data, parsedContext.data, onSubmission);
      } catch (error) {
        const code = error instanceof PiSessionError ? error.code : 'session_error';
        state.sessionError = error instanceof Error ? error.message : String(error);
        emitExecutionEvent(events, 'run_failed', {
          isError: true,
          message: `Session creation failed: ${state.sessionError}`,
          data: { code },
        });
        return this.buildResult(events, runId, 'failed', startedAt, {
          session: null,
          configId,
          failure: {
            code: code === 'model_unavailable' || code === 'policy_denied' ? code : 'session_error',
            message: state.sessionError,
          },
        });
      }

      emitExecutionEvent(events, 'session_created', {
        message: `Pi session created (${handle.session.sessionId})`,
        data: {
          piVersion: handle.piVersion,
          extensionVersions: handle.extensionVersions,
          tools: handle.effectiveTools,
        },
      });

      // --- Session event mapping (tool calls, agent lifecycle) --------------
      handle.session.subscribe((rawEvent) => {
        const event = rawEvent as {
          type?: string;
          toolName?: string;
          isError?: boolean;
        };
        if (!event || typeof event.type !== 'string') return;
        if (event.type === 'tool_execution_start' && event.toolName) {
          state.toolCallCount += 1;
          emitExecutionEvent(events, 'tool_call_started', {
            toolName: event.toolName,
            data: { callIndex: state.toolCallCount },
          });
          if (state.toolCallCount > policy.maxToolCalls) {
            state.budgetExceeded = true;
            emitExecutionEvent(events, 'run_failed', {
              isError: true,
              message: `Tool call budget exhausted (max ${policy.maxToolCalls})`,
              data: { code: 'policy_denied' },
            });
            void handle?.session.abort().catch(() => undefined);
          }
        } else if (event.type === 'tool_execution_end' && event.toolName) {
          emitExecutionEvent(events, 'tool_call_finished', {
            toolName: event.toolName,
            isError: event.isError ?? false,
          });
        } else if (event.type === 'agent_end') {
          state.sessionEnded = true;
          emitExecutionEvent(events, 'agent_finished', {});
        }
      });

      // --- Deadline + cancellation watchers ----------------------------------
      let promptSettled = false;
      const promptPromise = handle.session.prompt(buildResearchPrompt(parsedInput.data, parsedContext.data).text).then(
        () => undefined,
        (error: unknown) => {
          // Prompt rejection is normal after abort(); surfaced via flags below.
          state.sessionError = error instanceof Error ? error.message : String(error);
        },
      );

      const deadlinePromise = this.sleep(Math.max(0, deadlineAt - this.now())).then(async () => {
        if (promptSettled) return;
        state.timedOut = true;
        await handle?.session.abort().catch(() => undefined);
      });

      const cancelPromise = new Promise<void>((resolve) => {
        if (!signal) {
          // No caller signal: never settle — the hard deadline (or prompt
          // completion) terminates the run.
          return;
        }
        if (signal.aborted) {
          state.cancelled = true;
          resolve();
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            state.cancelled = true;
            void handle?.session.abort().catch(() => undefined);
            resolve();
          },
          { once: true },
        );
      });

      const promptDone = promptPromise.finally(() => {
        promptSettled = true;
      });

      await Promise.race([promptDone, deadlinePromise, cancelPromise]);

      // Wait for the session to actually settle after abort so disposal is safe.
      if ((state.timedOut || state.cancelled) && !promptSettled) {
        try {
          await handle.session.agent.waitForIdle();
        } catch {
          // ignore — disposal below is authoritative
        }
      }

      // --- Terminal outcome ---------------------------------------------------
      if (state.cancelled) {
        emitExecutionEvent(events, 'run_cancelled', { message: 'Run cancelled by caller signal' });
        return this.buildResult(events, runId, 'cancelled', startedAt, { session: handle, configId });
      }
      if (state.timedOut) {
        emitExecutionEvent(events, 'run_timeout', {
          message: `Hard deadline exceeded (${policy.deadlineMs} ms)`,
        });
        return this.buildResult(events, runId, 'timed_out', startedAt, {
          session: handle,
          configId,
          failure: {
            code: 'deadline_exceeded',
            message: `Run exceeded the ${policy.deadlineMs} ms hard deadline`,
          },
        });
      }
      if (state.budgetExceeded) {
        const message = `Tool call budget exhausted (max ${policy.maxToolCalls})`;
        return this.buildResult(events, runId, 'failed', startedAt, {
          session: handle,
          configId,
          failure: { code: 'policy_denied', message },
        });
      }
      if (state.submission) {
        emitExecutionEvent(events, 'run_completed', {
          message: 'Research submitted with a schema-validated evidence bundle',
          data: { outcome: state.submission.abstention ? 'abstained' : 'submitted' },
        });
        return this.buildResult(
          events,
          runId,
          state.submission.abstention ? 'abstained' : 'submitted',
          startedAt,
          {
            session: handle,
            configId,
            submission: state.submission,
          },
        );
      }
      // Session ended without a terminal submission -> fail closed.
      const message =
        state.sessionError && !state.sessionEnded
          ? `Session ended with an error and no submission: ${state.sessionError}`
          : 'Session ended without a valid terminal submission';
      emitExecutionEvent(events, 'run_failed', {
        isError: true,
        message,
        data: { code: 'missing_submission' },
      });
      return this.buildResult(events, runId, 'failed', startedAt, {
        session: handle,
        configId,
        failure: { code: 'missing_submission', message },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitExecutionEvent(events, 'run_failed', {
        isError: true,
        message,
        data: { code: 'unknown' },
      });
      return this.buildResult(events, runId, 'failed', startedAt, {
        session: handle,
        configId,
        failure: { code: 'unknown', message },
      });
    } finally {
      handle?.dispose();
    }
  }

  private fail(
    events: ExecutionEventSink,
    runId: string,
    code: 'invalid_input',
    message: string,
    startedAt: number,
    configId: string,
  ): ProductResearchResult {
    emitExecutionEvent(events, 'run_failed', { isError: true, message });
    return this.buildResult(events, runId, 'failed', startedAt, {
      session: null,
      configId,
      failure: { code, message },
    });
  }

  private buildResult(
    events: ExecutionEventSink,
    runId: string,
    outcome: ProductResearchResult['outcome'],
    startedAt: number,
    parts: {
      session: PiSessionHandle | null;
      configId: string;
      submission?: StructuredSubmission | null;
      failure?: ProductResearchResult['failure'];
    },
  ): ProductResearchResult {
    return {
      runId,
      outcome,
      executor: this.name,
      executorVersion: this.version,
      piVersion: parts.session?.piVersion ?? null,
      extensionVersions: parts.session?.extensionVersions ?? [],
      configId: parts.configId,
      durationMs: this.now() - startedAt,
      submission: parts.submission ?? null,
      failure: parts.failure ?? null,
      events: events.snapshot(),
    };
  }
}
