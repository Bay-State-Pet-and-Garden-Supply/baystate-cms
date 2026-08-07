/**
 * Pi SDK session factory (PI-1).
 *
 * Creates in-memory Pi agent sessions for Product Intelligence runs with:
 * - in-memory session state (no durable conversation files);
 * - approved-extension-only resources (no project/global discovery);
 * - an explicit built-in tool allowlist from the immutable policy;
 * - the terminal submission tool registered as a custom tool;
 * - exact Pi runtime version capture;
 * - disposal after every terminal outcome.
 *
 * The Pi SDK is imported lazily so the rest of the CMS never loads Pi code
 * unless a Pi run actually starts — onboarding works without Pi installed or
 * configured.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 */
import type {
  ProductIntelligencePolicy,
  ProductResearchContext,
  ProductResearchInput,
  TerminalResultSubmission,
} from '../contracts';
import { buildWorkflowTerminalTools } from '../workflow/terminal-tools';
import { KNOWN_BUILTIN_TOOLS, TERMINAL_TOOLS } from '../contracts';
import { buildApprovedResourceLoader } from './pi-resource-loader';
import type { PiToolRegistry } from '../tools/registry';

// ---------------------------------------------------------------------------
// Minimal session surface (SDK session cast to this in the real factory;
// fakes implement it in unit tests without any external calls).
// ---------------------------------------------------------------------------

export interface PiSessionLike {
  readonly sessionId: string;
  /** Send the research prompt and resolve when the agent finishes. */
  prompt(text: string): Promise<void>;
  /** Abort the current operation. */
  abort(): Promise<void>;
  /** Subscribe to normalized session events (opaque; executor maps them). */
  subscribe(listener: (event: unknown) => void): () => void;
  readonly agent: {
    /** Resolves once the agent finishes the current operation. */
    waitForIdle(): Promise<void>;
  };
  /** Dispose the session (sync in the SDK; fakes may be async). */
  dispose(): void;
}

export interface PiSessionHandle {
  session: PiSessionLike;
  /** Exact Pi runtime version (package version), or null when unavailable. */
  piVersion: string | null;
  /** Approved extensions loaded into the session (none in PI-1). */
  extensionVersions: Array<{ name: string; version?: string | null }>;
  /** Effective tool names exposed by the session (allowlist + terminal tools). */
  effectiveTools: string[];
  /** Dispose the session. Safe to call multiple times. */
  dispose(): void;
}

export interface PiSessionFactory {
  createSession(
    input: ProductResearchInput,
    context: ProductResearchContext,
    onSubmission: (submission: TerminalResultSubmission) => void,
  ): Promise<PiSessionHandle>;
}

// ---------------------------------------------------------------------------
// Real SDK factory
// ---------------------------------------------------------------------------

export interface PiSdkSessionFactoryOptions {
  /** Absolute path used for session tool-path resolution. */
  cwd?: string;
  /**
   * Bounded research-tool registry (PI-3). When omitted, no research tools
   * are exposed (fail closed).
   */
  toolRegistry?: PiToolRegistry | null;
}

type PiSdkModule = typeof import('@earendil-works/pi-coding-agent');

export class PiSdkSessionFactory implements PiSessionFactory {
  constructor(private readonly options: PiSdkSessionFactoryOptions = {}) {}

  async createSession(
    input: ProductResearchInput,
    context: ProductResearchContext,
    onSubmission: (submission: TerminalResultSubmission) => void,
  ): Promise<PiSessionHandle> {
    const sdk = await importSdk();
    const policy = context.policy;

    // --- Policy enforcement -------------------------------------------------
    const allowedTools = validateToolAllowlist(policy);

    if (!policy.modelRoute) {
      throw new PiSessionError(
        'model_unavailable',
        'No model route is configured in the immutable policy; refusing to run Pi with an unapproved model.',
      );
    }
    const route = policy.modelRoute;

    const modelRuntime = await sdk.ModelRuntime.create();
    const model = modelRuntime.getModel(route.provider, route.model);
    if (!model) {
      throw new PiSessionError(
        'model_unavailable',
        `Model ${route.provider}/${route.model} is not known to the Pi runtime.`, 
      );
    }

    // Fail fast on missing credentials: a run whose model has no valid auth
    // would otherwise burn budget and fail at the first model call.
    const available = await modelRuntime.getAvailable();
    const availableModel = available.find(
      (candidate) => candidate.provider === route.provider && candidate.id === route.model,
    );
    if (!availableModel) {
      throw new PiSessionError(
        'model_unavailable',
        `Model ${route.provider}/${route.model} has no valid credentials configured ` +
          `(${available.length} model(s) currently available). Configure credentials for this model ` +
          'or update the immutable policy modelRoute.',
      );
    }

    // --- Resources: approved extensions only -------------------------------
    const resourceLoader = await buildApprovedResourceLoader({
      cwd: this.options.cwd ?? process.cwd(),
    });

    // --- Terminal submission tools (PI-4 workflow only; the legacy PI-1
    // envelope tool was removed in P0-3) --------------------------------
    const workflowTerminalTools = buildWorkflowTerminalTools(onSubmission);
    const customToolNames = [...workflowTerminalTools.map((t) => t.name)];

    // PI-3: research tools from the registry, gated by the policy's
    // researchTools allowlist (empty -> none granted, fail closed).
    const researchTools = this.options.toolRegistry?.buildSessionTools({
      runId: context.runId,
      workspaceId: context.workspaceId,
      workspacePath: context.workspacePath,
      allowedTools: policy.researchTools,
      policy,
      signal: context.signal ?? new AbortController().signal,
      remainingMs: policy.deadlineMs,
    });
    if (researchTools && researchTools.length > 0) {
      customToolNames.push(...researchTools.map((tool) => tool.name));
    }

    // --- Session ------------------------------------------------------------
    // SDK quirk (pi-coding-agent): passing `tools: []` makes the SDK treat the
    // empty array as an allowlist that filters out EVERY tool — custom tools
    // included — so the model sees no callable tools and ends without
    // submitting (live-smoke finding). Builtins must instead be excluded
    // explicitly while custom research tools pass through unfiltered:
    //   tools: undefined            -> allowedToolNames = undefined (all pass)
    //   excludeTools: <not granted> -> the policy's fail-closed isolation is
    //                                  preserved exactly (PI-5).
    const { session, extensionsResult } = await sdk.createAgentSession({
      cwd: this.options.cwd ?? process.cwd(),
      sessionManager: sdk.SessionManager.inMemory(),
      resourceLoader,
      modelRuntime,
      model: model,
      thinkingLevel: route.thinkingLevel,
      tools: undefined,
      excludeTools: KNOWN_BUILTIN_TOOLS.filter((name) => !allowedTools.includes(name)),
      // The workflow terminal tools and research tools are added by the SDK's
      // extension runtime, not the built-in allowlist.
      customTools:
        researchTools && researchTools.length > 0
          ? [...workflowTerminalTools, ...researchTools]
          : workflowTerminalTools,
    });

    let disposed = false;
    const handle: PiSessionHandle = {
      session: session as unknown as PiSessionLike,
      piVersion: sdk.VERSION ?? null,
      extensionVersions: extensionsResult.extensions.map((extension) => ({
        name: extension.path,
        version: null,
      })),
      effectiveTools: [...allowedTools, ...customToolNames],
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          session.dispose();
        } catch {
          // Disposal must never mask the run outcome.
        }
      },
    };
    return handle;
  }
}

export class PiSessionError extends Error {
  constructor(
    readonly code: 'model_unavailable' | 'policy_denied' | 'sdk_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'PiSessionError';
  }
}

/** Validate the policy allowlist against known built-in tools (fail closed). */
export function validateToolAllowlist(policy: ProductIntelligencePolicy): string[] {
  const unknown = policy.allowedTools.filter((tool) => !KNOWN_BUILTIN_TOOLS.includes(tool));
  if (unknown.length > 0) {
    throw new PiSessionError(
      'policy_denied',
      `Policy allowlists unknown tools: ${unknown.join(', ')}. Refusing to start the session.`,
    );
  }
  return [...policy.allowedTools];
}

/** Effective tool names for a policy: allowlisted built-ins + terminal tools. */
export function effectiveToolNames(policy: ProductIntelligencePolicy): string[] {
  return [...validateToolAllowlist(policy), ...TERMINAL_TOOLS];
}

// ---------------------------------------------------------------------------
// Lazy SDK import + version capture
// ---------------------------------------------------------------------------

let sdkPromise: Promise<PiSdkModule> | null = null;
let cachedVersion: string | null | undefined;

/**
 * Import the Pi SDK lazily. The first call resolves the module and the exact
 * package version; subsequent calls reuse both. Never called by onboarding
 * code paths — only by Pi execution.
 */
export async function importSdk(): Promise<PiSdkModule> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const sdk = (await import('@earendil-works/pi-coding-agent')) as PiSdkModule;
      cachedVersion = await captureSdkVersion();
      return sdk;
    })();
  }
  return sdkPromise;
}

/**
 * Exact Pi package version. The SDK exports its own VERSION constant — the
 * authoritative source (package.json is not reachable through the exports
 * map). Returns null when the SDK module cannot be loaded.
 */
export async function captureSdkVersion(): Promise<string | null> {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const sdk = (await import('@earendil-works/pi-coding-agent')) as PiSdkModule;
    cachedVersion = typeof sdk.VERSION === 'string' ? sdk.VERSION : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}
