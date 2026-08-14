/**
 * Store Manager tool registry (epic #42, #40).
 *
 * Every agent tool dispatches exclusively through this registry. Dispatch
 * order is enforced outside the model:
 *
 *   1. session exists and belongs to the workspace
 *   2. session is active
 *   3. current phase allowlist (persistent calls only via a valid approval)
 *   4. tool/version allowlist (the adapter itself is the allowed version)
 *   5. remaining whole-turn deadline
 *   6. per-turn call budget
 *   7. strict input schema
 *   8. risk + valid signed approval (#34 gate — reused unchanged)
 *   9. fresh domain ownership/state (delegated to workspace-scoped services)
 *  10. composed AbortSignal + per-call timeout
 *  11. adapter execute
 *  12. output schema / byte bounds / redaction
 *  13. normalized structured outcome
 *
 * Every denial happens before adapter side effects.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type {
  StoreManagerToolAdapter,
  StoreManagerAdapterContext,
  StoreManagerToolResult,
  StoreManagerPhase,
} from './contracts';
import { policyDenied, errorResult } from './contracts';
import type { StoreManagerRuntimePolicy } from './policy';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  gateToolExecution,
  ApprovalGateError,
  type StoreManagerToolContext,
} from '../../server/services/store-manager-tools';
import { CATALOG_TOOL_ADAPTERS } from '../tools/catalog-tools';
import { PROPOSAL_TOOL_ADAPTERS } from '../tools/proposal-tools';
import { IMAGE_REPAIR_TOOL_ADAPTERS } from '../tools/image-repair-tool';
import { CHANGE_SET_READ_TOOL_ADAPTERS } from '../tools/change-set-read-tools';
import { REPORT_TOOL_ADAPTERS } from '../tools/report-tools';

// ---------------------------------------------------------------------------
// Mutable per-turn session state the registry enforces against
// ---------------------------------------------------------------------------

export interface StoreManagerRuntimeSessionState {
  sessionId: string;
  workspaceId: string;
  turnId: string;
  status: 'active' | 'terminal';
  phase: StoreManagerPhase;
  toolCalls: number;
}

export function createRuntimeSessionState(input: {
  sessionId: string;
  workspaceId: string;
  turnId: string;
}): StoreManagerRuntimeSessionState {
  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    turnId: input.turnId,
    status: 'active',
    phase: 'investigate',
    toolCalls: 0,
  };
}

// ---------------------------------------------------------------------------
// Output redaction + bounds
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set([
  'apiKey',
  'api_key',
  'authorization',
  'secret',
  'token',
  'password',
  'credential',
  'signature',
  'baseUrl',
  'base_url',
]);

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[redacted:depth]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) {
        out[k] = '[redacted]';
      } else if (k.toLowerCase().includes('path')) {
        out[k] = typeof v === 'string' ? '[redacted:path]' : redactValue(v, depth + 1);
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function serializeBounded(value: unknown, maxBytes: number): { data: unknown; bytes: number } | null {
  const redacted = redactValue(value);
  let text = JSON.stringify(redacted);
  if (text === undefined) text = JSON.stringify(null);
  if (text.length <= maxBytes) return { data: redacted, bytes: text.length };
  // Deterministic truncation: cut at the byte cap; if the cut does not re-parse
  // as JSON, the output is refused (size_exceeded) rather than silently
  // replaced.
  const truncated = text.slice(0, maxBytes);
  try {
    return { data: JSON.parse(truncated), bytes: truncated.length };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class StoreManagerToolRegistry {
  private readonly adapters = new Map<string, StoreManagerToolAdapter>();

  constructor(initial: readonly StoreManagerToolAdapter[] = DEFAULT_TOOL_ADAPTERS) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: StoreManagerToolAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Store Manager tool "${adapter.name}" is already registered.`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  get(name: string): StoreManagerToolAdapter | undefined {
    return this.adapters.get(name);
  }

  names(): string[] {
    return [...this.adapters.keys()];
  }

  all(): StoreManagerToolAdapter[] {
    return [...this.adapters.values()];
  }

  /** Tool names the policy allowlist is built from (server-owned). */
  allowlist(): readonly string[] {
    return this.names();
  }

  /** Tool name+version pairs the policy allowlist is built from (server-owned). */
  allowlistVersions(): readonly { name: string; version: number }[] {
    return this.all().map((adapter) => ({ name: adapter.name, version: adapter.version }));
  }

  /**
   * Build AI SDK tool definitions for one turn, wired to this registry's
   * dispatch gate. The `phase`/`budget`/`deadline` checks read the mutable
   * session state, so the same tool set serves investigate/approve/verify.
   */
  buildAiSdkTools(opts: {
    policy: StoreManagerRuntimePolicy;
    session: StoreManagerRuntimeSessionState;
    executionContext: StoreManagerToolContext;
    adapterContext: Omit<StoreManagerAdapterContext, 'emit' | 'signal'>;
    emit: StoreManagerAdapterContext['emit'];
    now?: () => number;
    deadlineAt?: number;
    callerSignal?: AbortSignal;
    maxOutputBytes?: number;
  }): Record<string, ReturnType<typeof tool>> {
    const {
      policy,
      session,
      executionContext,
      adapterContext,
      emit,
      maxOutputBytes = policy.maxOutputBytes,
      callerSignal,
    } = opts;
    const now = opts.now ?? Date.now;
    const deadlineAt = opts.deadlineAt ?? now() + policy.deadlineMs;

    const out: Record<string, ReturnType<typeof tool>> = {};
    for (const adapter of this.adapters.values()) {
      out[adapter.name] = (tool({
        description: adapter.description,
        inputSchema: adapter.inputSchema as never,
        outputSchema: adapter.outputSchema as never,
        execute: async (input: Record<string, unknown>, options) => {
          return this.dispatch(adapter, input, {
            policy,
            session,
            executionContext,
            adapterContext,
            emit,
            now,
            deadlineAt,
            maxOutputBytes,
            callerSignal,
            toolCallId: options.toolCallId,
            messages: options.messages,
          });
        },
      }) as unknown) as ReturnType<typeof tool>;
    }
    return out;
  }

  private async dispatch(
    adapter: StoreManagerToolAdapter,
    input: Record<string, unknown>,
    opts: {
      policy: StoreManagerRuntimePolicy;
      session: StoreManagerRuntimeSessionState;
      executionContext: StoreManagerToolContext;
      adapterContext: Omit<StoreManagerAdapterContext, 'emit' | 'signal'>;
      emit: StoreManagerAdapterContext['emit'];
      now: () => number;
      deadlineAt: number;
      maxOutputBytes: number;
      callerSignal?: AbortSignal;
      toolCallId: string;
      messages: unknown;
    },
  ): Promise<unknown> {
    const { policy, session, executionContext, emit, now, deadlineAt, maxOutputBytes, toolCallId } = opts;

    const deny = (reasonCode: Extract<StoreManagerToolResult, { status: 'policy_denied' }>['reasonCode'], message: string) => {
      emitToolResult(emit, adapter, policy, { status: 'policy_denied', reasonCode, message });
      return { status: 'policy_denied', reasonCode, message };
    };

    // 1. session exists and belongs to workspace
    if (session.sessionId.length === 0 || session.workspaceId !== policy.workspaceId) {
      return deny('not_in_workspace', 'Tool execution requires a valid runtime session in this workspace.');
    }
    // 2. active status
    if (session.status !== 'active') {
      return deny('not_in_workspace', 'The runtime session for this turn is no longer active.');
    }
    // 3. execution-mode persistent denial (operations console, Issue 1):
    //    unattended_read_only / preview refuse every non-read adapter BEFORE
    //    phase/approval handling, so forged/valid-looking approval parts can
    //    never reach the gate or any side effect.
    if (policy.denyPersistent && adapter.riskClass !== 'read') {
      return deny(
        'persistent_not_allowed',
        `Tool "${adapter.name}" is a ${adapter.riskClass} adapter and is not allowed in ${policy.executionMode} mode.`,
      );
    }
    // 3b. pinned-scope support: an adapter that DECLARES `supportedScopes`
    //     (including an empty list = catalog-wide, refuses any pinned scope)
    //     must honor the resolved scope or abstain (scope_unsupported) — it
    //     may not silently scan the whole catalog. Undefined keeps legacy
    //     behavior (executes regardless) for adapters that do not declare.
    if (policy.pinnedScope && adapter.supportedScopes !== undefined) {
      if (!adapter.supportedScopes.includes(policy.pinnedScope.kind)) {
        return deny(
          'unsupported',
          `Tool "${adapter.name}" does not support the pinned ${policy.pinnedScope.kind} scope.`,
        );
      }
    }
    // 4. phase allowlist (persistent calls allowed only via a valid approval)
    const approvalState = this.resolveApprovalState(opts);
    const phaseAllowed =
      adapter.allowedPhases.includes(session.phase) ||
      (adapter.requiresApproval && approvalState === 'approved');
    if (!phaseAllowed) {
      return deny(
        'phase_not_allowed',
        `Tool "${adapter.name}" is not allowed in the current ${session.phase} phase.`,
      );
    }
    // 5. tool/version allowlist: the adapter is the allowed version; unknown tools never reach here.
    const allowedPair = policy.allowedToolNameVersions.some(
      (p) => p.name === adapter.name && p.version === adapter.version,
    );
    if (!allowedPair) {
      return deny('not_in_workspace', `Tool "${adapter.name}" v${adapter.version} is not allowed by this run's policy.`);
    }
    // 5. remaining deadline
    if (now() > deadlineAt) {
      return deny('deadline_exceeded', 'The whole-turn deadline for this turn has passed.');
    }
    // 6. call budget
    if (session.toolCalls >= policy.maxToolCalls) {
      return deny('budget_exceeded', `The per-turn tool-call budget (${policy.maxToolCalls}) is exhausted.`);
    }
    // 7. strict input schema
    const parsed = adapter.inputSchema.safeParse(input);
    if (!parsed.success) {
      return deny('invalid_input', `Tool "${adapter.name}" received invalid input: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
    }
    const validInput = parsed.data as Record<string, unknown>;

    // 8. risk + valid signed approval (#34 gate: execution context, expiry,
    //    approval state, exact approved input). Errors normalize to structured
    //    denials so the model never sees raw exceptions.
    try {
      const gate = gateToolExecution(
        { name: adapter.name, version: adapter.version, riskClass: adapter.riskClass, sideEffects: adapter.sideEffects, requiresApproval: adapter.requiresApproval, stateTransition: adapter.stateTransition, scopeSummary: adapter.scopeSummary },
        executionContext,
        async (p: unknown) => p,
      );
      await gate(validInput, {
        toolCallId,
        messages: opts.messages as never,
      } as never);
    } catch (err) {
      if (err instanceof ApprovalGateError) {
        const code =
          err.code === 'approval_denied'
            ? 'approval_denied'
            : err.code === 'approval_session_expired' || err.code === 'execution_context_missing'
              ? 'deadline_exceeded'
              : 'approval_required';
        if (err.code === 'approval_denied' || err.code === 'approval_missing' || err.code === 'approval_replay_or_altered') {
          emitApproval(emit, adapter, policy, toolCallId, false, err.message);
        }
        return deny(code, err.message);
      }
      return errorResult('dispatch_error', 'Tool dispatch failed before execution.');
    }

    // 9. fresh domain ownership/state is enforced by the workspace-scoped
    //    services the adapters call (#35/#36); no duplication here.

    // 10. composed AbortSignal + per-call timeout
    const { signal, dispose } = composeSignal(opts.callerSignal, policy.perCallTimeoutMs);

    // 11. execute
    session.toolCalls += 1;
    const scope = adapter.scopeSummary(validInput);
    emitToolDispatched(emit, adapter, policy, validInput, scope);
    const adapterCtx: StoreManagerAdapterContext = {
      ...opts.adapterContext,
      signal,
      pinnedScope: policy.pinnedScope,
      entrypoint: policy.entrypoint,
      emit,
    };
    try {
      const result = await adapter.execute(validInput, adapterCtx);

      // Persistent success advances the session to verify (authoritative reads
      // become available for the affected resource).
      if (adapter.requiresApproval && result.status === 'ok' && session.phase !== 'verify') {
        const from = session.phase;
        session.phase = 'verify';
        emit({
          version: 1,
          type: 'phase_changed',
          from,
          to: 'verify',
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          turnId: session.turnId,
          createdAt: new Date().toISOString(),
        });
      }

      // 12. output schema / byte bounds / redaction
      const normalized = this.normalizeOutput(adapter, result, maxOutputBytes);
      emitToolResult(emit, adapter, policy, normalized);
      return normalized;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected tool error';
      const bounded = errorResult('adapter_failed', msg.slice(0, 500));
      emitToolResult(emit, adapter, policy, bounded);
      return bounded;
    } finally {
      dispose();
    }
  }

  /**
   * Derive the approval state for the exact tool call from the model messages
   * that initiated this step (reuses the #34 derivation contract).
   */
  private resolveApprovalState(opts: {
    toolCallId: string;
    messages: unknown;
  }): 'approved' | 'denied' | 'pending' | 'missing' {
    const messages = (opts.messages ?? []) as Array<{ content?: unknown }>;
    let approvalId: string | null = null;
    for (const message of messages) {
      if (!Array.isArray(message?.content)) continue;
      for (const part of message.content as Array<{ type?: string }>) {
        if (part.type === 'tool-approval-request' && (part as Record<string, unknown>).toolCallId === opts.toolCallId) {
          approvalId = String((part as Record<string, unknown>).approvalId);
        }
      }
    }
    if (!approvalId) return 'missing';
    for (const message of messages) {
      if (!Array.isArray(message?.content)) continue;
      for (const part of message.content as Array<{ type?: string }>) {
        if (part.type === 'tool-approval-response' && (part as Record<string, unknown>).approvalId === approvalId) {
          return (part as Record<string, unknown>).approved === true ? 'approved' : 'denied';
        }
      }
    }
    return 'pending';
  }

  private normalizeOutput(
    adapter: StoreManagerToolAdapter,
    result: StoreManagerToolResult,
    maxOutputBytes: number,
  ): StoreManagerToolResult {
    if (result.status !== 'ok') return result;
    if (adapter.outputSchema) {
      const check = adapter.outputSchema.safeParse(result.data);
      if (!check.success) {
        return policyDenied('invalid_input', `Tool "${adapter.name}" produced output that violates its output schema.`);
      }
    }
    const bounded = serializeBounded(result.data, maxOutputBytes);
    if (bounded === null) {
      return policyDenied('size_exceeded', `Tool "${adapter.name}" output exceeds the ${maxOutputBytes}-byte bound.`);
    }
    return { status: 'ok', data: bounded.data };
  }
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

function emitToolDispatched(
  emit: StoreManagerAdapterContext['emit'],
  adapter: StoreManagerToolAdapter,
  policy: StoreManagerRuntimePolicy,
  input: Record<string, unknown>,
  scope: string,
): void {
  emit({
    version: 1,
    type: 'tool_dispatched',
    sessionId: policy.sessionId,
    workspaceId: policy.workspaceId,
    turnId: policy.turnId,
    createdAt: new Date().toISOString(),
    toolName: adapter.name,
    toolVersion: adapter.version,
    toolRisk: adapter.riskClass,
    inputDigest: hashCanonicalJson(input),
    scope,
  });
}

function emitApproval(
  emit: StoreManagerAdapterContext['emit'],
  adapter: StoreManagerToolAdapter,
  policy: StoreManagerRuntimePolicy,
  toolCallId: string,
  approved: boolean,
  reason?: string,
): void {
  emit({
    version: 1,
    type: 'tool_approval',
    sessionId: policy.sessionId,
    workspaceId: policy.workspaceId,
    turnId: policy.turnId,
    createdAt: new Date().toISOString(),
    toolName: adapter.name,
    toolCallId,
    approved,
    reason,
  });
}

function emitToolResult(
  emit: StoreManagerAdapterContext['emit'],
  adapter: StoreManagerToolAdapter,
  policy: StoreManagerRuntimePolicy,
  result: StoreManagerToolResult,
): void {
  emit({
    version: 1,
    type: 'tool_result',
    sessionId: policy.sessionId,
    workspaceId: policy.workspaceId,
    turnId: policy.turnId,
    createdAt: new Date().toISOString(),
    toolName: adapter.name,
    status: result.status,
    errorCode: result.status === 'error' ? result.errorCode : undefined,
    reasonCode: result.status === 'policy_denied' ? result.reasonCode : undefined,
  });
}

// ---------------------------------------------------------------------------
// Signal composition
// ---------------------------------------------------------------------------

function composeSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal | undefined; dispose: () => void } {
  if (typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function') {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = parent ? AbortSignal.any([parent, timeoutSignal]) : timeoutSignal;
    return { signal: combined, dispose: () => undefined };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

// ---------------------------------------------------------------------------
// Default registry surface
// ---------------------------------------------------------------------------

export const DEFAULT_TOOL_ADAPTERS: readonly StoreManagerToolAdapter[] = [
  ...CATALOG_TOOL_ADAPTERS,
  ...PROPOSAL_TOOL_ADAPTERS,
  ...IMAGE_REPAIR_TOOL_ADAPTERS,
  ...CHANGE_SET_READ_TOOL_ADAPTERS,
  ...REPORT_TOOL_ADAPTERS,
];

export function createStoreManagerToolRegistry(): StoreManagerToolRegistry {
  return new StoreManagerToolRegistry(DEFAULT_TOOL_ADAPTERS);
}

/** Zod passthrough for adapters with optional output schemas. */
export const TOOL_OUTPUT_SCHEMA_NONE = z.unknown();

/**
 * Build the `streamText.toolApproval` config from ADAPTER metadata (the
 * runtime source of truth) so custom/injected registries work identically to
 * the default surface. Read tools are `not-applicable`, persistent classes are
 * `user-approval`. In unattended/preview modes pass `forceNotApplicable: true`
 * so the SDK never halts a background run waiting for an approval that can
 * never arrive — the registry denies persistent adapters at dispatch instead.
 */
export function buildRegistryApprovalConfig(
  adapters: readonly StoreManagerToolAdapter[],
  opts?: { forceNotApplicable?: boolean },
): Record<string, 'not-applicable' | 'user-approval'> {
  const config: Record<string, 'not-applicable' | 'user-approval'> = {};
  for (const adapter of adapters) {
    config[adapter.name] =
      opts?.forceNotApplicable || !adapter.requiresApproval ? 'not-applicable' : 'user-approval';
  }
  return config;
}
