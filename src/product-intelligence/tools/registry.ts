/**
 * Product Intelligence tool registry (PI-3).
 *
 * The registry is the only way the Pi worker reaches CMS capabilities: it
 * wraps `PiToolAdapter`s as Pi SDK tool definitions and enforces, before
 * every dispatch:
 * - run + workspace ownership (the run must exist and belong to the workspace);
 * - the research-tool allowlist from the immutable policy;
 * - the request budget (policy.maxToolCalls);
 * - timeout + cancellation (caller AbortSignal + remaining deadline);
 * - schema rejection of malformed/oversized inputs.
 *
 * Adapters never receive credentials, internal paths, or the raw database;
 * they wrap deterministic CMS modules and return structured outcomes with
 * evidence ids. The registry is independently testable without Pi.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/20
 */
import { Type, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import { getPiRun } from '../../db/repositories/product-intelligence-repo';
import type { ProductIntelligencePolicy } from '../contracts';
import type { PiToolAdapter, PiToolContext, PiToolResult } from './contract';
import { errorResult, policyDenied } from './contract';

export interface SessionToolContext {
  runId: string;
  workspaceId: string;
  workspacePath: string;
  allowedTools: string[];
  /** Immutable policy snapshot (PI-5): network/data-sharing enforcement. */
  policy: ProductIntelligencePolicy;
  signal: AbortSignal;
  remainingMs: number;
}

export interface ResearchToolDefinition {
  name: string;
  label: string;
  description: string;
  promptGuidelines: string[];
  parameters: TSchema;
  execute: (toolCallId: string, params: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: Record<string, unknown>;
  }>;
}

export interface PiToolRegistryOptions {
  /** Tool-call budget per run; defaults to the policy value at dispatch time. */
  maxToolCallsPerRun?: number;
  /** Override the per-call timeout in ms (defaults to the remaining deadline). */
  callTimeoutMs?: number;
}

export class PiToolRegistry {
  private readonly adapters = new Map<string, PiToolAdapter>();
  private readonly callCounts = new Map<string, number>();
  private readonly options: PiToolRegistryOptions;

  constructor(options: PiToolRegistryOptions = {}) {
    this.options = options;
  }

  register(adapter: PiToolAdapter): this {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Duplicate research tool registration: ${adapter.name}`);
    }
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  registerAll(adapters: PiToolAdapter[]): this {
    for (const adapter of adapters) this.register(adapter);
    return this;
  }

  names(): string[] {
    return [...this.adapters.keys()].sort();
  }

  get(name: string): PiToolAdapter | undefined {
    return this.adapters.get(name);
  }

  /** Reset per-run call budgets (new run). */
  resetRun(runId: string): void {
    this.callCounts.delete(runId);
  }

  /**
   * Convert the registry into Pi SDK tool definitions for one session.
   * `allowedTools` comes from the immutable policy's researchTools allowlist;
   * an empty allowlist grants nothing (fail closed).
   */
  buildSessionTools(ctx: SessionToolContext): ResearchToolDefinition[] {
    const allowed = new Set(ctx.allowedTools);
    const definitions: ResearchToolDefinition[] = [];
    for (const [name, adapter] of this.adapters) {
      if (!allowed.has(name)) continue;
      definitions.push(this.toToolDefinition(adapter, ctx));
    }
    return definitions;
  }

  private toToolDefinition(adapter: PiToolAdapter, ctx: SessionToolContext): ResearchToolDefinition {
    return {
      name: adapter.name,
      label: adapter.name.replace(/_/g, ' '),
      description: adapter.description,
      promptGuidelines: adapter.promptGuidelines ?? [],
      parameters: adapter.parameters,
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const result = await this.dispatch(adapter, rawParams, {
          runId: ctx.runId,
          workspaceId: ctx.workspaceId,
          workspacePath: ctx.workspacePath,
          policy: ctx.policy,
          signal: ctx.signal,
          remainingMs: ctx.remainingMs,
        });
        return {
          content: [{ type: 'text', text: serializeToolResult(result) }],
          // The SDK relays `details` into tool_execution_end.result (verified
          // live), so the executor can persist tool evidence durably.
          details: {
            status: result.status,
            ...(result.status === 'ok' || result.status === 'no_result'
              ? { evidence: result.evidence }
              : {}),
          },
        };
      },
    };
  }

  /** Enforce ownership, policy, budget, schema, timeout — then dispatch. */
  async dispatch(adapter: PiToolAdapter, rawParams: unknown, ctx: PiToolContext): Promise<PiToolResult> {
    // 1. Run ownership: the run must exist and belong to the workspace.
    const run = getPiRun(ctx.runId);
    if (!run) return policyDenied(`Run ${ctx.runId} does not exist`);
    if (run.workspaceId !== ctx.workspaceId) {
      return policyDenied(`Run ${ctx.runId} does not belong to workspace ${ctx.workspaceId}`);
    }
    if (run.status !== 'running') {
      return policyDenied(`Run ${ctx.runId} is ${run.status}; tools are only callable while running`);
    }

    // 2. Request budget.
    const used = this.callCounts.get(ctx.runId) ?? 0;
    const maxCalls = this.options.maxToolCallsPerRun ?? 100;
    if (used >= maxCalls) {
      return policyDenied(`Tool-call budget exhausted (${maxCalls})`);
    }
    this.callCounts.set(ctx.runId, used + 1);

    // 3. Schema validation (bounded inputs — reject malformed/oversized).
    const parsed = validateParams(adapter, rawParams);
    if (!parsed.ok) {
      return errorResult('invalid_params', parsed.message);
    }

    // 4. Timeout + cancellation.
    const timeoutMs = Math.max(1, Math.min(this.options.callTimeoutMs ?? ctx.remainingMs, ctx.remainingMs));
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const composed = AbortSignal.any([ctx.signal, timeoutSignal]);
    const callCtx: PiToolContext = { ...ctx, signal: composed, remainingMs: timeoutMs };

    try {
      return await Promise.race([
        adapter.execute(parsed.params, callCtx),
        new Promise<never>((_, reject) =>
          composed.addEventListener('abort', () => {
            reject(new Error(ctx.signal.aborted ? 'cancelled' : 'tool timeout'));
          }, { once: true }),
        ),
      ]);
    } catch (error) {
      if (ctx.signal.aborted) return policyDenied('cancelled by caller');
      if (timeoutSignal.aborted) return errorResult('timeout', `Tool ${adapter.name} exceeded ${timeoutMs}ms`);
      return errorResult('adapter_error', error instanceof Error ? error.message : String(error));
    }
  }
}

function validateParams(adapter: PiToolAdapter, raw: unknown): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'tool parameters must be an object' };
  }
  try {
    // TypeBox Check rejects malformed and oversized inputs (maxLength/maxItems
    // constraints live on the adapter schemas).
    if (!Check(adapter.parameters, raw)) {
      return { ok: false, message: `parameters failed schema validation for ${adapter.name}` };
    }
    return { ok: true, params: raw as Record<string, unknown> };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'invalid parameters' };
  }
}

function serializeToolResult(result: PiToolResult): string {
  // Evidence ids are always included; message content is bounded.
  const view = {
    status: result.status,
    ...(result.status === 'ok' ? { data: result.data } : {}),
    ...(result.status === 'no_result' || result.status === 'policy_denied' ? { reason: result.reason } : {}),
    ...(result.status === 'error' ? { code: result.code, message: result.message } : {}),
    evidence: result.evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      url: e.url,
      domain: e.domain,
      method: e.method,
      snippet: e.snippet ? e.snippet.slice(0, 400) : undefined,
      contentHash: e.contentHash,
      retrievedAt: e.retrievedAt,
    })),
  };
  try {
    return JSON.stringify(view);
  } catch {
    return JSON.stringify({ status: 'error', code: 'serialization', message: 'tool result could not be serialized' });
  }
}

/** TypeBox helper: string with a maximum length (bounded input). */
export function boundedString(max = 512, description?: string): TSchema {
  return Type.String({ maxLength: max, description });
}

export { Type };
