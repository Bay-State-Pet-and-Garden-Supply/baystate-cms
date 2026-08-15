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
import { PI_EXECUTOR_NAME, ProductResearchContextSchema, ProductResearchInputSchema, type ProductResearchContext, type ProductResearchResult, type TerminalResultSubmission } from '../contracts';
import { terminalDisposition } from '../workflow/bundle';
import { defaultPolicyGateway, PolicyDeniedError } from '../policy';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../executor';
import { emitExecutionEvent } from '../executor';
import { buildResearchPrompt } from './pi-prompt-builder';
import type { PiSessionFactory, PiSessionHandle } from './pi-session-factory';
import { PiSdkSessionFactory, PiSessionError } from './pi-session-factory';

const PI_EXECUTOR_VERSION = '1.0.0';

/** Evidence relayed by the tool wrapper through SDK result.details. */
export interface RelayedToolEvidence {
  id: string;
  kind?: string;
  url?: string;
  domain?: string;
  method?: string;
  snippet?: string;
  contentHash?: string;
  retrievedAt?: string;
  /** P1-4 field-level entries: extracted field name + value + source path. */
  field?: string;
  value?: string | null;
  path?: string;
}

/** Best-effort extraction of tool evidence from the SDK result.details. */
function extractToolEvidence(result: unknown): RelayedToolEvidence[] {
  if (result === null || result === undefined || typeof result !== 'object') return [];
  const details = (result as { details?: unknown }).details;
  if (details === null || details === undefined || typeof details !== 'object') return [];
  const evidence = (details as { evidence?: unknown }).evidence;
  if (!Array.isArray(evidence)) return [];
  return evidence.filter(
    (entry): entry is RelayedToolEvidence =>
      !!entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string',
  );
}

/** Best-effort extraction of a tool-failure message from the SDK result. */
function extractToolError(result: unknown): string | undefined {
  if (result === null || result === undefined) return undefined;
  if (typeof result === 'string') return result.slice(0, 500);
  if (result instanceof Error) return result.message.slice(0, 500);
  if (Array.isArray(result)) {
    const text = result
      .map((item) => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : undefined))
      .filter((item): item is string => item !== undefined)
      .join('; ');
    return text.length > 0 ? text.slice(0, 500) : undefined;
  }
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? obj.text : typeof obj.message === 'string' ? obj.message : typeof obj.error === 'string' ? obj.error : undefined;
    if (typeof obj.content === 'string') return obj.content.slice(0, 500);
    if (Array.isArray(obj.content)) return extractToolError(obj.content);
    if (text) return text.slice(0, 500);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PI-10 lazy DB-backed budget enforcement
// ---------------------------------------------------------------------------
// The Pi executor is imported by vitest tests that have no bun:sqlite, so the
// DB-backed run lookup and workspace category-budget check are loaded lazily
// (createRequire). Real runs always execute under bun, where the loaded
// modules enforce authoritatively; in non-bun environments the check is a
// no-op rather than an import-time crash.
import { createRequire } from 'node:module';

const lazyRequire = createRequire(import.meta.url);

interface LazyRunRow {
  workspaceId: string;
}

function loadPiRunRow(runId: string): LazyRunRow | undefined {
  // Non-bun environments (vitest) cannot even load the driver module, so the
  // initialization probe is loaded lazily too; a missing DB is the no-op
  // signal. Genuine repo errors propagate (fail-closed).
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return undefined;
  } catch {
    return undefined; // bun:sqlite unavailable (vitest): no DB, no enforcement.
  }
  const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
    getPiRun?: (id: string) => LazyRunRow | undefined;
  };
  return repo.getPiRun?.(runId);
}

function checkWorkspaceToolCategoryBudget(workspaceId: string, toolName: string): void {
  try {
    const budgets = lazyRequire('../budgets') as {
      checkPiToolCategoryBudget?: (workspaceId: string, toolName: string) => void;
    };
    budgets.checkPiToolCategoryBudget?.(workspaceId, toolName);
  } catch (error) {
    // The budget module's own load can fail in non-bun environments (vitest);
    // a PolicyDeniedError from the check itself must NOT be swallowed — the
    // caller turns it into a fail-closed abort (review finding PI-10-MAJOR-1).
    if (error instanceof PolicyDeniedError) throw error;
  }
}

/** Round-8 (review P1): persist the session's effective tool versions/schema
 *  hashes on the run row. The tools are only known once the session exists,
 *  so this is a post-create UPDATE (not atomic with createPiRun); it is
 *  best-effort and never breaks the run. Non-bun environments (vitest) no-op. */
function persistRunTools(runId: string, toolVersions: Array<{ name: string; version: string | null; schemaHash: string }>): void {
  try {
    const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
    if (!conn.isDbInitialized?.()) return;
    const repo = lazyRequire('../../db/repositories/product-intelligence-repo') as {
      setRunToolsJson?: (runId: string, tools: unknown) => void;
    };
    repo.setRunToolsJson?.(runId, toolVersions);
  } catch {
    // Best-effort capture — never fail the run because telemetry could not
    // be written.
  }
}

export interface PiExecutorOptions {
  /**
   * Session factory. Defaults to the real Pi SDK factory; tests inject a fake
   * so no external calls occur.
   */
  sessionFactory?: PiSessionFactory;
  /** Clock for deterministic duration accounting in tests. */
  now?: () => number;
}

export class PiProductIntelligenceExecutor implements ProductIntelligenceExecutor {
  readonly name = PI_EXECUTOR_NAME;
  readonly version = PI_EXECUTOR_VERSION;

  private readonly sessionFactory: PiSessionFactory;
  private readonly now: () => number;

  constructor(options: PiExecutorOptions = {}) {
    // PI-3 research tools are injected via the session factory (the routes
    // wire the default tool registry); the executor itself stays lean so it
    // never pulls onboarding/database modules into its own import graph.
    this.sessionFactory = options.sessionFactory ?? new PiSdkSessionFactory();
    this.now = options.now ?? Date.now;
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
    // PI-10: the workspace budget may cap the per-run runtime below the
    // policy deadline (maxRunRuntimeMinutes); lazy DB load, no-op outside bun.
    const runtimeCapRun = loadPiRunRow(runId);
    let effectiveDeadlineMs = policy.deadlineMs;
    if (runtimeCapRun) {
      try {
        const budgets = lazyRequire('../budgets') as {
          effectivePiRuntimeCapMs?: (workspaceId: string, defaultMs: number) => number;
        };
        effectiveDeadlineMs = budgets.effectivePiRuntimeCapMs?.(runtimeCapRun.workspaceId, policy.deadlineMs) ?? policy.deadlineMs;
      } catch {
        // Budget module unavailable: policy deadline stands.
      }
    }
    const deadlineAt = startedAt + effectiveDeadlineMs;

    // --- Cancellation before start -----------------------------------------
    if (signal?.aborted) {
      emitExecutionEvent(events, 'run_cancelled', { message: 'Run cancelled before session start' });
      return this.buildResult(events, runId, 'cancelled', startedAt, {
        costUsd: 0,
        session: null,
        configId,
      });
    }

    let handle: PiSessionHandle | null = null;
    // Holder object: TS strict CFA narrows closure-assigned `let` bindings to
    // `never`, so mutable run state lives in this object instead.
    const state: {
      submission: TerminalResultSubmission | null;
      toolCallCount: number;
      sessionEnded: boolean;
      budgetExceeded: boolean;
      modelCostUsd: number;
      inputTokens: number;
      outputTokens: number;
      sessionError: string | null;
      unknownToolNames: Set<string>;
    } = {
      submission: null,
      toolCallCount: 0,
      sessionEnded: false,
      budgetExceeded: false,
      modelCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      sessionError: null,
      unknownToolNames: new Set(),
    };

    // Hard deadline + caller cancellation composed into one abort signal
    // (AbortSignal.any). Created up front so the finally block can detach.
    const timeoutSignal = AbortSignal.timeout(Math.max(1, deadlineAt - this.now()));
    const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const onComposedAbort = (): void => {
      void handle?.session.abort().catch(() => undefined);
    };
    composed.addEventListener('abort', onComposedAbort, { once: true });

    const onSubmission = (value: TerminalResultSubmission): void => {
      state.submission = value;
      emitExecutionEvent(events, 'submission_received', {
        message: 'Terminal submission received and schema-validated',
        data: { schemaVersion: value.schemaVersion },
      });
    };

    try {
      // --- Session creation -------------------------------------------------
      try {
        handle = await this.sessionFactory.createSession(
          parsedInput.data,
          parsedContext.data,
          onSubmission,
          // Round-9/10 (review P1): the run's runtime-only execution bounds —
          // the COMPOSED AbortSignal (caller + workspace cap + policy deadline
          // in one signal) and the ABSOLUTE run deadline — must reach the
          // research-tool adapters. Round-10: we pass `composed`, not the raw
          // caller signal, so a tool starting near the end of the run aborts
          // from the run deadline; the registry recomputes remaining time PER
          // INVOCATION from deadlineAt (never a value frozen at session
          // creation).
          {
            signal: composed,
            deadlineAt,
          },
        );
      } catch (error) {
        const code = error instanceof PiSessionError ? error.code : 'session_error';
        state.sessionError = error instanceof Error ? error.message : String(error);
        emitExecutionEvent(events, 'run_failed', {
          isError: true,
          message: `Session creation failed: ${state.sessionError}`,
          data: { code },
        });
        return this.buildResult(events, runId, 'failed', startedAt, {
          tokenUsage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
          costUsd: state.modelCostUsd,
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
          toolVersions: handle.toolVersions ?? [],
        },
      });

      // Round-8 (review P1): capture the effective tool versions/schema
      // hashes on the run row now that the session exists (the tools are not
      // knowable at createPiRun time).
      persistRunTools(runId, handle.toolVersions ?? []);

      // --- Session event mapping (tool calls, agent lifecycle) --------------
      // Known-tool set for unknown-tool marking (smoke finding D): the SDK
      // relays events for hallucinated tool names too; those must show as
      // denied calls in the inspector, not allowed ones.
      const knownToolNames = new Set<string>(handle.effectiveTools ?? []);
      handle.session.subscribe((rawEvent) => {
        const event = rawEvent as {
          type?: string;
          toolName?: string;
          isError?: boolean;
          result?: unknown;
          message?: { usage?: { cost?: { total?: number }; input_tokens?: number; output_tokens?: number; input?: number; output?: number } };
        };
        if (!event || typeof event.type !== 'string') return;

        // Model-cost accounting (PI-5) + token accounting (PI-10): each
        // completed assistant message reports usage; the policy gateway
        // enforces maxCostUsd server-side, and the run row persists token
        // usage so workspace-level daily token budgets can be enforced
        // centrally (src/product-intelligence/budgets.ts).
        if (event.type === 'message_end' && event.message?.usage) {
          // Provider usage keys differ: OpenAI-style input_tokens/output_tokens
          // vs opencode-go's input/output (live-smoke finding).
          if (typeof event.message.usage.input_tokens === 'number') {
            state.inputTokens = Math.max(state.inputTokens, event.message.usage.input_tokens);
          } else if (typeof event.message.usage.input === 'number') {
            state.inputTokens = Math.max(state.inputTokens, event.message.usage.input);
          }
          if (typeof event.message.usage.output_tokens === 'number') {
            state.outputTokens = Math.max(state.outputTokens, event.message.usage.output_tokens);
          } else if (typeof event.message.usage.output === 'number') {
            state.outputTokens = Math.max(state.outputTokens, event.message.usage.output);
          }
          if (event.message.usage?.cost?.total !== undefined) {
          state.modelCostUsd = Math.max(state.modelCostUsd, event.message.usage.cost.total);
          const budget = defaultPolicyGateway.checkModelBudget(
            { runId, policy },
            state.modelCostUsd,
            policy.maxCostUsd,
          );
          if (!budget.allowed) {
            state.budgetExceeded = true;
            emitExecutionEvent(events, 'run_failed', {
              isError: true,
              message: budget.detail ?? 'Model cost budget exceeded',
              data: { code: 'policy_denied' },
            });
            void handle?.session.abort().catch(() => undefined);
            return;
          }
        }
        }
        if (event.type === 'tool_execution_start' && event.toolName) {
          if (!knownToolNames.has(event.toolName)) {
            state.unknownToolNames.add(event.toolName);
          }
          // PI-10: workspace-level category budgets (search/fetch/browser)
          // enforced centrally BEFORE the call is announced — the sink
          // persists the tool-call row synchronously on tool_call_started,
          // so checking first keeps the boundary at exactly `max` (review
          // finding PI-10-MINOR-3). The DB-backed check is loaded lazily so
          // the Pi executor stays importable in vitest (no bun:sqlite there);
          // real runs always execute under bun where enforcement is
          // authoritative.
          try {
            const runRow = loadPiRunRow(runId);
            if (runRow) checkWorkspaceToolCategoryBudget(runRow.workspaceId, event.toolName);
          } catch (error) {
            if (error instanceof PolicyDeniedError) {
              state.budgetExceeded = true;
              emitExecutionEvent(events, 'run_failed', {
                isError: true,
                message: error.message,
                data: { code: 'policy_denied' },
              });
              void handle?.session.abort().catch(() => undefined);
              return;
            }
            throw error;
          }
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
          const isUnknownTool = state.unknownToolNames.delete(event.toolName);
          emitExecutionEvent(events, 'tool_call_finished', {
            toolName: event.toolName,
            isError: (event.isError ?? false) || isUnknownTool,
            // Unknown tool names get a precise denial message; otherwise
            // surface the SDK's actual failure message (e.g. submission
            // schema rejections) instead of the generic fallback.
            ...(isUnknownTool
              ? { error: `unknown_tool: ${event.toolName}` }
              : event.isError
                ? { error: extractToolError(event.result) }
                : {}),
            // Tool-result evidence (id/url/domain/method/...) relays through
            // the SDK's result.details (verified live) for durable
            // persistence at the sink (smoke finding A).
            ...(extractToolEvidence(event.result).length > 0
              ? { evidence: extractToolEvidence(event.result) }
              : {}),
          });
        } else if (event.type === 'agent_end') {
          state.sessionEnded = true;
          emitExecutionEvent(events, 'agent_finished', {});
        }
      });

      // --- Deadline + cancellation: composed abort signal ---------------------
      // The composed signal (already set up above) aborts on the hard deadline
      // or the caller's cancellation. Cause is derived afterwards: caller
      // aborted wins over timeout.
      let promptSettled = false;
      const promptText =
        parsedContext.data.compiledPrompt ??
        buildResearchPrompt(parsedInput.data, parsedContext.data).text;
      const promptPromise = handle.session.prompt(promptText).then(
        () => undefined,
        (error: unknown) => {
          // Prompt rejection is normal after abort(); surfaced via flags below.
          state.sessionError = error instanceof Error ? error.message : String(error);
        },
      );

      let resolveAbortDone: () => void = () => undefined;
      const abortDone = new Promise<void>((resolve) => {
        resolveAbortDone = resolve;
      });
      if (composed.aborted) {
        // Signal aborted between composition and listener registration.
        resolveAbortDone();
      } else {
        composed.addEventListener('abort', () => resolveAbortDone(), { once: true });
      }

      const promptDone = promptPromise.finally(() => {
        promptSettled = true;
      });

      await Promise.race([promptDone, abortDone]);

      // Wait for the session to actually settle after abort so disposal is safe.
      if ((signal?.aborted || timeoutSignal.aborted) && !promptSettled) {
        try {
          await handle.session.agent.waitForIdle();
        } catch {
          // ignore — disposal below is authoritative
        }
      }

      // --- Terminal outcome ---------------------------------------------------
      if (signal?.aborted) {
        emitExecutionEvent(events, 'run_cancelled', { message: 'Run cancelled by caller signal' });
        return this.buildResult(events, runId, 'cancelled', startedAt, { session: handle, configId });
      }
      if (timeoutSignal.aborted) {
        emitExecutionEvent(events, 'run_timeout', {
          message: `Hard deadline exceeded (${policy.deadlineMs} ms)`,
        });
        return this.buildResult(events, runId, 'timed_out', startedAt, {
          tokenUsage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
          costUsd: state.modelCostUsd,
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
          tokenUsage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
          costUsd: state.modelCostUsd,
          session: handle,
          configId,
          failure: { code: 'policy_denied', message },
        });
      }
      if (state.submission) {
        // PI-4 bundle shapes classify via terminalDisposition; the PI-1
        // envelope abstains via its abstention field.
        const outcome =
          'disposition' in state.submission
            ? terminalDisposition(state.submission)
            : 'abstention' in state.submission && state.submission.abstention
              ? 'abstained'
              : 'submitted';
        emitExecutionEvent(events, 'run_completed', {
          message: 'Research submitted with a schema-validated terminal submission',
          data: { outcome },
        });
        return this.buildResult(
          events,
          runId,
          outcome,
          startedAt,
          {
            session: handle,
            configId,
            submission: state.submission,
            tokenUsage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
            costUsd: state.modelCostUsd,
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
        tokenUsage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
        costUsd: state.modelCostUsd,
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
        tokenUsage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
        costUsd: state.modelCostUsd,
        session: handle,
        configId,
        failure: { code: 'unknown', message },
      });
    } finally {
      // Detach the composed-signal listener so a late abort (or the timeout
      // timer firing) cannot touch the disposed session, then dispose.
      composed.removeEventListener('abort', onComposedAbort);
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
      submission?: TerminalResultSubmission | null;
      failure?: ProductResearchResult['failure'];
      tokenUsage?: { inputTokens: number; outputTokens: number } | null;
      costUsd?: number;
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
      tokenUsage:
        parts.tokenUsage && (parts.tokenUsage.inputTokens > 0 || parts.tokenUsage.outputTokens > 0)
          ? parts.tokenUsage
          : null,
      modelCostUsd: parts.costUsd && parts.costUsd > 0 ? parts.costUsd : null,
      events: events.snapshot(),
    };
  }
}
