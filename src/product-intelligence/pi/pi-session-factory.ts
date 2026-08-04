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
  StructuredSubmission,
} from '../contracts';
import { KNOWN_BUILTIN_TOOLS, TERMINAL_TOOLS } from '../contracts';
import { buildApprovedResourceLoader } from './pi-resource-loader';
import { buildProductResearchSubmissionTool } from './pi-tool-registry';

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
    onSubmission: (submission: StructuredSubmission) => void,
  ): Promise<PiSessionHandle>;
}

// ---------------------------------------------------------------------------
// Real SDK factory
// ---------------------------------------------------------------------------

export interface PiSdkSessionFactoryOptions {
  /** Absolute path used for session tool-path resolution. */
  cwd?: string;
}

type PiSdkModule = typeof import('@earendil-works/pi-coding-agent');

export class PiSdkSessionFactory implements PiSessionFactory {
  constructor(private readonly options: PiSdkSessionFactoryOptions = {}) {}

  async createSession(
    input: ProductResearchInput,
    context: ProductResearchContext,
    onSubmission: (submission: StructuredSubmission) => void,
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

    const modelRuntime = await sdk.ModelRuntime.create();
    const model = modelRuntime.getModel(policy.modelRoute.provider, policy.modelRoute.model);
    if (!model) {
      throw new PiSessionError(
        'model_unavailable',
        `Model ${policy.modelRoute.provider}/${policy.modelRoute.model} is not known to the Pi runtime.`,
      );
    }

    // --- Resources: approved extensions only -------------------------------
    const resourceLoader = await buildApprovedResourceLoader({
      cwd: this.options.cwd ?? process.cwd(),
    });

    // --- Terminal submission tool -------------------------------------------
    const submissionTool = buildProductResearchSubmissionTool(onSubmission);
    const customToolNames = [submissionTool.name];

    // --- Session ------------------------------------------------------------
    const { session, extensionsResult } = await sdk.createAgentSession({
      cwd: this.options.cwd ?? process.cwd(),
      sessionManager: sdk.SessionManager.inMemory(),
      resourceLoader,
      modelRuntime,
      model,
      thinkingLevel: policy.modelRoute.thinkingLevel,
      tools: allowedTools,
      // The submission tool is added by the SDK's extension runtime, not the
      // built-in allowlist, so it is available exactly once per session.
      customTools: [submissionTool],
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
