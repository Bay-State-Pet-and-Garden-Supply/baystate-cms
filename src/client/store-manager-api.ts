/**
 * Store Manager API client.
 *
 * Client-side fetch wrapper for Store Manager endpoints. Wire types are
 * defined locally (mirroring the server shapes) so the client never imports
 * from src/server or src/ai (those pull bun:sqlite / node:fs and would break
 * the Vite build).
 */

export type StoreManagerModelLocality = 'local' | 'cloud';
export type StoreManagerCostBasis = 'local_zero' | 'published_rate' | 'unknown';

export interface StoreManagerModelPricingInfo {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  costBasis: StoreManagerCostBasis;
  effectiveAt: string | null;
}

export interface StoreManagerModelDescriptor {
  id: string;
  provider: string;
  providerLabel: string;
  locality: StoreManagerModelLocality;
  capabilitySummary: string;
  pricing: StoreManagerModelPricingInfo;
  isDefault: boolean;
}

export interface StoreManagerModelsResponse {
  models: StoreManagerModelDescriptor[];
  defaultModelId: string | null;
  /** Present only when no compatible default exists. */
  setupMessage?: string;
}

/** Format a descriptor's pricing for the picker label. */
export function formatModelPricing(option: StoreManagerModelDescriptor): string {
  if (option.locality === 'local') return 'Free (Local)';
  const p = option.pricing;
  if (p.costBasis === 'published_rate' && p.inputPerMillion != null && p.outputPerMillion != null) {
    return `$${p.inputPerMillion} / 1M In · $${p.outputPerMillion} / 1M Out`;
  }
  return 'Cost unknown';
}

/**
 * Fetch the server-owned list of usable Store Manager models. The picker is
 * populated exclusively from this endpoint so the client and server cannot
 * maintain independent model catalogs.
 */
export async function fetchStoreManagerModels(): Promise<StoreManagerModelsResponse> {
  const res = await fetch('/api/store-manager/models');
  if (!res.ok) {
    let message = `Failed to load Store Manager models (${res.status}).`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data && typeof data.error === 'string') message = data.error;
    } catch {
      // keep the default message
    }
    throw new Error(message);
  }
  return (await res.json()) as StoreManagerModelsResponse;
}

// ---------------------------------------------------------------------------
// Operations console (Issue 2): slash commands, pinned scope, preferences.
// Wire types mirror the shared schemas so the client never imports server code.
// ---------------------------------------------------------------------------

export interface StoreManagerCommandArgDescriptor {
  name: string;
  label: string;
  description: string;
  required: boolean;
  valueType: 'string' | 'enum' | 'number';
  options?: string[];
  suggestions?: string[];
  placeholder?: string;
}

export interface StoreManagerCommandDescriptor {
  name: string;
  version: number;
  aliases: string[];
  description: string;
  argSpecs: StoreManagerCommandArgDescriptor[];
}

export interface StoreManagerToolHint {
  name: string;
  version: number;
}

export type StoreManagerScopeKind = 'onboarding_batch' | 'change_set' | 'product_field' | 'vendor' | 'sku_set';

export interface StoreManagerPinnedScope {
  kind: StoreManagerScopeKind;
  batchId?: string;
  changeSetId?: string;
  field?: string;
  vendorId?: string;
  skus?: string[];
}

export interface StoreManagerCompiledCommand {
  commandName: string;
  commandVersion: number;
  objective: string;
  scopeHint: StoreManagerPinnedScope | null;
  expectedToolHints: StoreManagerToolHint[];
  requiresApproval: boolean;
  networkActivity: 'none' | 'bounded';
  planPreview: boolean;
  estimatedOutputKinds: string[];
}

export interface StoreManagerResolvedScope {
  pinnedScope: StoreManagerPinnedScope;
  scopeHash: string;
  resolved: {
    kind: StoreManagerScopeKind;
    displayName: string;
    itemCount?: number;
  };
}

export interface StoreManagerPreviewDescriptor {
  entrypoint: string;
  executionMode: string;
  actorClass: string;
  runId: string;
  objectiveHash: string;
  scopeHash: string | null;
  expectedTools: Array<{
    name: string;
    version: number;
    riskClass: string;
    requiresApproval: boolean;
    allowedPhases: string[];
    scopeSupported: boolean;
  }>;
  expectedApprovals: Array<{ toolName: string; toolVersion: number }>;
  persistentToolsDenied: boolean;
  budgets: {
    maxToolCalls: number;
    deadlineMs: number;
    maxModelCostUsd: number;
    perCallTimeoutMs: number;
  };
  networkActivity: 'none' | 'bounded';
  modelCalls: 0;
  toolDispatches: 0;
}

export interface StoreManagerCommandToolOutcome {
  toolCallId: string;
  toolName: string;
  status: 'ok' | 'error' | 'denied';
  output?: unknown;
  errorText?: string;
}

export interface StoreManagerCommandResult {
  ok: true;
  runId: string;
  turnId: string;
  terminalStatus: string;
  outcomeReason: string | null;
  modelCallId: string | null;
  text: string;
  toolResults: StoreManagerCommandToolOutcome[];
}

export interface StoreManagerPlanPreviewResult {
  ok: true;
  runId: string;
  turnId: string;
  plan: StoreManagerPreviewDescriptor;
}

export interface StoreManagerCommandError {
  ok: false;
  errorCode: string;
  error: string;
}

export interface StoreManagerPreferencesContent {
  product_field_labels?: Record<string, string>;
  vendor_identifier_convention?: string;
  health_exclusions?: string[];
  review_scope_defaults?: Record<string, StoreManagerPinnedScope>;
}

export interface StoreManagerPreferenceRevision {
  id: string;
  workspaceId: string;
  version: number;
  content: StoreManagerPreferencesContent;
  contentHash: string;
  actorClass: string;
  createdAt: string;
}

/** Fetch server-owned command palette descriptors (never a client catalog). */
export async function fetchStoreManagerCommands(): Promise<StoreManagerCommandDescriptor[]> {
  const res = await fetch('/api/store-manager/commands');
  if (!res.ok) throw new Error(`Failed to load Store Manager commands (${res.status}).`);
  const data = (await res.json()) as { commands: StoreManagerCommandDescriptor[] };
  return data.commands ?? [];
}

/** Compile a raw command line server-side (zero execution). */
export async function compileStoreManagerCommand(
  raw: string,
  pinnedScope?: StoreManagerPinnedScope | null,
): Promise<{ compiled: StoreManagerCompiledCommand; resolvedScope: StoreManagerResolvedScope | null }> {
  const res = await fetch('/api/store-manager/commands/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, pinnedScope: pinnedScope ?? null }),
  });
  const data = (await res.json()) as
    | { ok: true; compiled: StoreManagerCompiledCommand; resolvedScope: StoreManagerResolvedScope | null }
    | StoreManagerCommandError;
  if (!data.ok) throw new Error((data as StoreManagerCommandError).error ?? 'Command compile failed.');
  return { compiled: (data as { compiled: StoreManagerCompiledCommand }).compiled, resolvedScope: (data as { resolvedScope: StoreManagerResolvedScope | null }).resolvedScope };
}

/**
 * Execute a compiled command through the runtime (drained) or return the
 * zero-execution /plan preview descriptor.
 */
export async function executeStoreManagerCommand(
  raw: string,
  opts: { pinnedScope?: StoreManagerPinnedScope | null; selectedModel?: string | null; mode?: 'execute' | 'plan' } = {},
): Promise<StoreManagerCommandResult | StoreManagerPlanPreviewResult> {
  const res = await fetch('/api/store-manager/commands/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw,
      pinnedScope: opts.pinnedScope ?? null,
      selectedModel: opts.selectedModel ?? undefined,
      mode: opts.mode ?? 'execute',
    }),
  });
  const data = (await res.json()) as
    | StoreManagerCommandResult
    | StoreManagerPlanPreviewResult
    | StoreManagerCommandError;
  if (!(data as StoreManagerCommandError).ok) {
    throw new Error((data as StoreManagerCommandError).error ?? `Command execution failed (${res.status}).`);
  }
  return data as StoreManagerCommandResult | StoreManagerPlanPreviewResult;
}

/** Validate + resolve a pinned scope (client-held pin; server is stateless). */
export async function resolveStoreManagerScope(
  scope: StoreManagerPinnedScope | null,
): Promise<StoreManagerResolvedScope | null> {
  const res = await fetch('/api/store-manager/scope', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  const data = (await res.json()) as
    | { ok: true; resolvedScope: StoreManagerResolvedScope | null }
    | StoreManagerCommandError;
  if (!data.ok) throw new Error((data as StoreManagerCommandError).error ?? 'Scope resolution failed.');
  return (data as { resolvedScope: StoreManagerResolvedScope | null }).resolvedScope;
}

/** Fetch active + recent preference revisions (Settings UI). */
export async function fetchStoreManagerPreferences(): Promise<{
  active: StoreManagerPreferenceRevision | null;
  revisions: StoreManagerPreferenceRevision[];
}> {
  const res = await fetch('/api/store-manager/preferences');
  if (!res.ok) throw new Error(`Failed to load Store Manager preferences (${res.status}).`);
  return (await res.json()) as { active: StoreManagerPreferenceRevision | null; revisions: StoreManagerPreferenceRevision[] };
}

/** Save a new immutable preference revision (Settings-only). */
export async function saveStoreManagerPreferences(
  content: StoreManagerPreferencesContent,
): Promise<{ ok: true; revision: StoreManagerPreferenceRevision; unknownSkus: string[] }> {
  const res = await fetch('/api/store-manager/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const data = (await res.json()) as
    | { ok: true; revision: StoreManagerPreferenceRevision; unknownSkus: string[] }
    | StoreManagerCommandError;
  if (!data.ok) throw new Error((data as StoreManagerCommandError).error ?? 'Preference save failed.');
  return data as { ok: true; revision: StoreManagerPreferenceRevision; unknownSkus: string[] };
}
