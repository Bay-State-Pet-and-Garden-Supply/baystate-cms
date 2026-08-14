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

// ---------------------------------------------------------------------------
// Operations console (Issue 3): Manager Inbox + notifications.
// Wire types mirror the shared schemas; the client never imports server code.
// ---------------------------------------------------------------------------

export type StoreManagerInboxKind =
  | 'high_severity_catalog_issues'
  | 'proposals_awaiting_review'
  | 'failed_sync_jobs'
  | 'image_repairs_recommended'
  | 'curation_stalled'
  | 'scheduled_run_failed';

export type StoreManagerInboxLifecycle = 'open' | 'acknowledged' | 'resolved' | 'superseded';
export type StoreManagerSeverity = 'info' | 'warning' | 'critical';

export interface StoreManagerInboxScope {
  kind: 'catalog' | StoreManagerScopeKind;
  batchId?: string;
  changeSetId?: string;
  field?: string;
  vendorId?: string;
  skus?: string[];
}

export interface StoreManagerInboxSourceRef {
  kind: string;
  id: string;
}

export interface StoreManagerInboxItem {
  id: string;
  workspaceId: string;
  kind: StoreManagerInboxKind;
  dedupeKey: string;
  severity: StoreManagerSeverity;
  title: string;
  summary: string;
  scope: StoreManagerInboxScope;
  count: number;
  sourceRefs: StoreManagerInboxSourceRef[];
  fingerprint: string;
  lifecycle: StoreManagerInboxLifecycle;
  sourceUpdatedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  supersededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerInboxOpenResult {
  item: StoreManagerInboxItem;
  current: StoreManagerInboxItem | null;
  isCurrent: boolean;
}

export interface StoreManagerNotification {
  id: string;
  workspaceId: string;
  ruleId: string;
  ruleKind: string;
  ruleVersion: number;
  fingerprint: string;
  severity: StoreManagerSeverity;
  title: string;
  message: string;
  inboxItemId: string | null;
  sourceRunId: string | null;
  sequence: number;
  readAt: string | null;
  createdAt: string;
}

export interface StoreManagerInboxReconcileResult {
  ok: true;
  inserted: number;
  refreshed: number;
  reopened: number;
  resolved: number;
  items: StoreManagerInboxItem[];
  emittedNotifications: StoreManagerNotification[];
  latestNotificationSequence: number;
}

/** Re-derive inbox candidates + reconcile lifecycle rows + evaluate rules. */
export async function reconcileStoreManagerInbox(): Promise<StoreManagerInboxReconcileResult> {
  const res = await fetch('/api/store-manager/inbox/reconcile', { method: 'POST' });
  const data = (await res.json()) as StoreManagerInboxReconcileResult | StoreManagerCommandError;
  if (!data.ok) throw new Error((data as StoreManagerCommandError).error ?? 'Inbox reconcile failed.');
  return data as StoreManagerInboxReconcileResult;
}

/** List inbox items (lifecycle filter optional). */
export async function fetchStoreManagerInbox(opts: { lifecycle?: StoreManagerInboxLifecycle | null } = {}): Promise<{
  items: StoreManagerInboxItem[];
  openCount: number;
}> {
  const qs = opts.lifecycle ? `?lifecycle=${encodeURIComponent(opts.lifecycle)}` : '';
  const res = await fetch(`/api/store-manager/inbox${qs}`);
  if (!res.ok) throw new Error(`Failed to load Manager Inbox (${res.status}).`);
  return (await res.json()) as { items: StoreManagerInboxItem[]; openCount: number };
}

/** Open an item and re-validate against current authority. */
export async function fetchStoreManagerInboxItem(id: string): Promise<StoreManagerInboxOpenResult> {
  const res = await fetch(`/api/store-manager/inbox/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to open inbox item (${res.status}).`);
  return (await res.json()) as StoreManagerInboxOpenResult;
}

/** Operator acknowledge (no catalog effect). */
export async function acknowledgeStoreManagerInboxItem(id: string): Promise<StoreManagerInboxItem> {
  const res = await fetch(`/api/store-manager/inbox/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' });
  const data = (await res.json()) as { ok: boolean; item?: StoreManagerInboxItem; error?: string };
  if (!data.ok) throw new Error(data.error ?? 'Acknowledge failed.');
  return data.item!;
}

/** Operator resolve (no catalog effect). */
export async function resolveStoreManagerInboxItem(id: string): Promise<StoreManagerInboxItem> {
  const res = await fetch(`/api/store-manager/inbox/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
  const data = (await res.json()) as { ok: boolean; item?: StoreManagerInboxItem; error?: string };
  if (!data.ok) throw new Error(data.error ?? 'Resolve failed.');
  return data.item!;
}

/** Fetch bounded notification list + unread count. */
export async function fetchStoreManagerNotifications(opts: { afterSequence?: number } = {}): Promise<{
  notifications: StoreManagerNotification[];
  unread: number;
}> {
  const qs = opts.afterSequence ? `?afterSequence=${opts.afterSequence}` : '';
  const res = await fetch(`/api/store-manager/notifications${qs}`);
  if (!res.ok) throw new Error(`Failed to load notifications (${res.status}).`);
  return (await res.json()) as { notifications: StoreManagerNotification[]; unread: number };
}

/** Mark one notification read. */
export async function markStoreManagerNotificationRead(id: string): Promise<void> {
  await fetch(`/api/store-manager/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Operations console (Issue 4): leased scheduled read-only runs.
// Wire types mirror the shared schedule schemas; the client never imports
// server code. All execution enters the common runtime server-side — these
// are plain fetch wrappers with no client-side scheduling logic.
// ---------------------------------------------------------------------------

export type StoreManagerRecurrencePreset = 'daily' | 'nightly' | 'weekly';
export type StoreManagerScheduleTemplateKind =
  | 'daily_catalog_health'
  | 'weekly_cleanup_report'
  | 'nightly_anomalies'
  | 'failed_sync_digest'
  | 'stale_proposal_review';
export type StoreManagerOccurrenceStatus =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'unavailable'
  | 'cancelled';

export interface StoreManagerScheduleDefinition {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  templateKind: StoreManagerScheduleTemplateKind;
  enabled: boolean;
  timezone: string;
  recurrencePreset: StoreManagerRecurrencePreset;
  timeOfDay: string;
  dayOfWeek: number | null;
  scope: StoreManagerPinnedScope | null;
  selectedModel: string | null;
  objective: string;
  definitionHash: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: StoreManagerOccurrenceStatus | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerScheduleTemplate {
  kind: StoreManagerScheduleTemplateKind;
  name: string;
  description: string;
  objective: string;
  defaultRecurrencePreset: StoreManagerRecurrencePreset;
  defaultTimeOfDay: string;
  defaultDayOfWeek?: number;
}

export interface StoreManagerScheduleOccurrence {
  id: string;
  workspaceId: string;
  scheduleId: string;
  scheduleVersion: number;
  occurrenceKey: string;
  scheduledAt: string;
  status: StoreManagerOccurrenceStatus;
  runId: string | null;
  errorCode: string | null;
  retryCount: number;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerScheduleCreateInput {
  templateKind: StoreManagerScheduleTemplateKind;
  name: string;
  timezone: string;
  recurrencePreset: StoreManagerRecurrencePreset;
  timeOfDay: string;
  dayOfWeek?: number;
  scope?: StoreManagerPinnedScope;
  selectedModel?: string;
}

export interface StoreManagerScheduleUpdateInput {
  name?: string;
  timezone?: string;
  recurrencePreset?: StoreManagerRecurrencePreset;
  timeOfDay?: string;
  dayOfWeek?: number;
  scope?: StoreManagerPinnedScope | null;
  selectedModel?: string | null;
}

export async function fetchStoreManagerSchedules(): Promise<StoreManagerScheduleDefinition[]> {
  const res = await fetch('/api/store-manager/schedules');
  if (!res.ok) throw new Error(`Failed to load schedules (${res.status}).`);
  const data = (await res.json()) as { schedules: StoreManagerScheduleDefinition[] };
  return data.schedules ?? [];
}

export async function fetchStoreManagerScheduleTemplates(): Promise<StoreManagerScheduleTemplate[]> {
  const res = await fetch('/api/store-manager/schedules/templates');
  if (!res.ok) throw new Error(`Failed to load schedule templates (${res.status}).`);
  const data = (await res.json()) as { templates: StoreManagerScheduleTemplate[] };
  return data.templates ?? [];
}

export async function createStoreManagerSchedule(
  input: StoreManagerScheduleCreateInput,
): Promise<StoreManagerScheduleDefinition> {
  const res = await fetch('/api/store-manager/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { ok: boolean; schedule?: StoreManagerScheduleDefinition; error?: string; errorCode?: string };
  if (!data.ok || !data.schedule) throw new Error(data.error ?? `Schedule create failed (${res.status}).`);
  return data.schedule;
}

export async function updateStoreManagerSchedule(
  id: string,
  input: StoreManagerScheduleUpdateInput,
): Promise<StoreManagerScheduleDefinition> {
  const res = await fetch(`/api/store-manager/schedules/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { ok: boolean; schedule?: StoreManagerScheduleDefinition; error?: string; errorCode?: string };
  if (!data.ok || !data.schedule) throw new Error(data.error ?? `Schedule update failed (${res.status}).`);
  return data.schedule;
}

export async function setStoreManagerScheduleEnabled(id: string, enabled: boolean): Promise<StoreManagerScheduleDefinition> {
  const res = await fetch(`/api/store-manager/schedules/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
  });
  const data = (await res.json()) as { ok: boolean; schedule?: StoreManagerScheduleDefinition; error?: string; errorCode?: string };
  if (!data.ok || !data.schedule) throw new Error(data.error ?? `Schedule enable/disable failed (${res.status}).`);
  return data.schedule;
}

export interface StoreManagerRunNowResult {
  occurrenceId: string;
  occurrenceKey: string;
  result: {
    occurrenceId: string;
    occurrenceKey: string;
    status: string;
    runId: string | null;
    errorCode: string | null;
    terminalStatus: string | null;
    retryCount: number;
  };
}

export async function runStoreManagerScheduleNow(id: string): Promise<StoreManagerRunNowResult> {
  const res = await fetch(`/api/store-manager/schedules/${encodeURIComponent(id)}/run-now`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; errorCode?: string } & Partial<StoreManagerRunNowResult>;
  if (!data.ok) throw new Error(data.error ?? `Run-now failed (${res.status}).`);
  return data as StoreManagerRunNowResult;
}

export async function fetchStoreManagerScheduleOccurrences(
  id: string,
  opts: { limit?: number; status?: StoreManagerOccurrenceStatus } = {},
): Promise<StoreManagerScheduleOccurrence[]> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  const res = await fetch(`/api/store-manager/schedules/${encodeURIComponent(id)}/occurrences${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`Failed to load schedule occurrences (${res.status}).`);
  const data = (await res.json()) as { occurrences: StoreManagerScheduleOccurrence[] };
  return data.occurrences ?? [];
}

// ---------------------------------------------------------------------------
// Operations console (Issue 5): durable event-triggered read-only runs.
// Wire types mirror the shared trigger schemas; the client never imports
// server code. All observation + execution is server-side; these are plain
// fetch wrappers with no client-side trigger logic.
// ---------------------------------------------------------------------------

export type StoreManagerTriggerKind = 'import_finished' | 'change_set_approved' | 'sync_failed' | 'product_field_drift';

export type StoreManagerTriggerOccurrenceStatus =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'unavailable'
  | 'cancelled'
  | 'diagnostic';

export type StoreManagerTriggerConfig =
  | { kind: 'import_finished'; batchId: string | null }
  | { kind: 'change_set_approved' }
  | { kind: 'sync_failed' }
  | { kind: 'product_field_drift'; threshold: number };

export interface StoreManagerTriggerDefinition {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  kind: StoreManagerTriggerKind;
  enabled: boolean;
  config: StoreManagerTriggerConfig;
  scope: StoreManagerPinnedScope | null;
  selectedModel: string | null;
  objective: string;
  definitionHash: string;
  lastScanAt: string | null;
  lastScanStatus: 'completed' | 'failed' | 'unavailable' | 'diagnostic' | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerTriggerTemplate {
  kind: StoreManagerTriggerKind;
  name: string;
  description: string;
  objective: string;
  defaultConfig: StoreManagerTriggerConfig;
  scopeSummary: string;
  readOnly: true;
}

export interface StoreManagerTriggerOccurrence {
  id: string;
  workspaceId: string;
  triggerId: string;
  triggerVersion: number;
  occurrenceKey: string;
  sourceRef: { kind: string; id: string };
  scopeJson: string | null;
  scheduledAt: string;
  status: StoreManagerTriggerOccurrenceStatus;
  runId: string | null;
  errorCode: string | null;
  retryCount: number;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerTriggerCreateInput {
  kind: StoreManagerTriggerKind;
  name: string;
  config?: StoreManagerTriggerConfig;
  scope?: StoreManagerPinnedScope;
  selectedModel?: string;
}

export interface StoreManagerTriggerUpdateInput {
  name?: string;
  config?: StoreManagerTriggerConfig;
  scope?: StoreManagerPinnedScope | null;
  selectedModel?: string | null;
}

export async function fetchStoreManagerTriggers(): Promise<StoreManagerTriggerDefinition[]> {
  const res = await fetch('/api/store-manager/triggers');
  if (!res.ok) throw new Error(`Failed to load triggers (${res.status}).`);
  const data = (await res.json()) as { triggers: StoreManagerTriggerDefinition[] };
  return data.triggers ?? [];
}

export async function fetchStoreManagerTriggerTemplates(): Promise<StoreManagerTriggerTemplate[]> {
  const res = await fetch('/api/store-manager/triggers/templates');
  if (!res.ok) throw new Error(`Failed to load trigger templates (${res.status}).`);
  const data = (await res.json()) as { templates: StoreManagerTriggerTemplate[] };
  return data.templates ?? [];
}

export async function createStoreManagerTrigger(
  input: StoreManagerTriggerCreateInput,
): Promise<StoreManagerTriggerDefinition> {
  const res = await fetch('/api/store-manager/triggers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { ok: boolean; trigger?: StoreManagerTriggerDefinition; error?: string; errorCode?: string };
  if (!data.ok || !data.trigger) throw new Error(data.error ?? `Trigger create failed (${res.status}).`);
  return data.trigger;
}

export async function updateStoreManagerTrigger(
  id: string,
  input: StoreManagerTriggerUpdateInput,
): Promise<StoreManagerTriggerDefinition> {
  const res = await fetch(`/api/store-manager/triggers/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { ok: boolean; trigger?: StoreManagerTriggerDefinition; error?: string; errorCode?: string };
  if (!data.ok || !data.trigger) throw new Error(data.error ?? `Trigger update failed (${res.status}).`);
  return data.trigger;
}

export async function setStoreManagerTriggerEnabled(id: string, enabled: boolean): Promise<StoreManagerTriggerDefinition> {
  const res = await fetch(`/api/store-manager/triggers/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
  });
  const data = (await res.json()) as { ok: boolean; trigger?: StoreManagerTriggerDefinition; error?: string; errorCode?: string };
  if (!data.ok || !data.trigger) throw new Error(data.error ?? `Trigger enable/disable failed (${res.status}).`);
  return data.trigger;
}

export interface StoreManagerTriggerRunNowResult {
  occurrenceId: string;
  occurrenceKey: string;
  result: {
    occurrenceId: string;
    occurrenceKey: string;
    status: string;
    runId: string | null;
    errorCode: string | null;
    terminalStatus: string | null;
    retryCount: number;
  };
}

export async function runStoreManagerTriggerNow(id: string): Promise<StoreManagerTriggerRunNowResult> {
  const res = await fetch(`/api/store-manager/triggers/${encodeURIComponent(id)}/run-now`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; errorCode?: string } & Partial<StoreManagerTriggerRunNowResult>;
  if (!data.ok) throw new Error(data.error ?? `Trigger run-now failed (${res.status}).`);
  return data as StoreManagerTriggerRunNowResult;
}

export async function fetchStoreManagerTriggerOccurrences(
  id: string,
  opts: { limit?: number; status?: StoreManagerTriggerOccurrenceStatus } = {},
): Promise<StoreManagerTriggerOccurrence[]> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  const res = await fetch(`/api/store-manager/triggers/${encodeURIComponent(id)}/occurrences${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`Failed to load trigger occurrences (${res.status}).`);
  const data = (await res.json()) as { occurrences: StoreManagerTriggerOccurrence[] };
  return data.occurrences ?? [];
}

// ---------------------------------------------------------------------------
// Operations console (Issue 6): immutable versioned playbooks.
// Wire types mirror the shared schemas; the client never imports server code.
// ---------------------------------------------------------------------------

export type StoreManagerPlaybookTemplateKind =
  | 'weekly_taxonomy_cleanup'
  | 'new_vendor_import_review'
  | 'image_integrity_pass'
  | 'launch_readiness_check';

export type StoreManagerPlaybookStepKind =
  | 'read'
  | 'summarize'
  | 'propose'
  | 'approval_checkpoint'
  | 'execute'
  | 'verify';

export type StoreManagerPlaybookRiskClass =
  | 'read'
  | 'proposal_write'
  | 'catalog_mutation'
  | 'network_filesystem_repair';

export type StoreManagerPlaybookStatus = 'draft' | 'active';

export interface StoreManagerPlaybookToolRef {
  toolName: string;
  toolVersion: number;
}

export interface StoreManagerPlaybookStep {
  stepId: string;
  kind: StoreManagerPlaybookStepKind;
  description?: string;
  dependsOnStepIds?: string[];
  toolName?: string;
  toolVersion?: number;
  inputTemplate?: Record<string, unknown>;
  mode?: 'deterministic' | 'model_bounded' | 'transient_preview' | 'persistent_stored';
  proposalWriteRiskDeclared?: boolean;
  diffRequired?: boolean;
  declaredRiskClass?: StoreManagerPlaybookRiskClass;
  toolNames?: StoreManagerPlaybookToolRef[];
}

export interface StoreManagerPlaybookScopeInput {
  allowedKinds: string[];
  maxSkus: number;
}

export interface StoreManagerPlaybookVariable {
  name: string;
  type: string;
  required: boolean;
}

export interface StoreManagerPlaybookStaticRisk {
  riskClasses: StoreManagerPlaybookRiskClass[];
  expectedApprovals: StoreManagerPlaybookToolRef[];
  networkActivity: 'none' | 'bounded';
  expectedDiffKinds: ('diff' | 'verification_diff')[];
  hasMutationStep: boolean;
  hasVerifyStep: boolean;
}

export interface StoreManagerPlaybookVersion {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  templateKind: StoreManagerPlaybookTemplateKind | null;
  version: number;
  status: StoreManagerPlaybookStatus;
  scopeInput: StoreManagerPlaybookScopeInput;
  variables: StoreManagerPlaybookVariable[];
  steps: StoreManagerPlaybookStep[];
  definitionHash: string;
  versionId: string;
  activatedAt: string | null;
  activatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerPlaybookSummary {
  id: string;
  workspaceId: string;
  name: string;
  templateKind: StoreManagerPlaybookTemplateKind | null;
  currentVersion: number;
  status: StoreManagerPlaybookStatus;
  activeVersion: number | null;
  activeHash: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerPlaybookTemplate {
  kind: StoreManagerPlaybookTemplateKind;
  name: string;
  description: string;
  scopeAllowedKinds: string[];
  stepCount: number;
}

export interface StoreManagerPlaybookDetail {
  playbook: StoreManagerPlaybookSummary;
  versions: StoreManagerPlaybookVersion[];
}

/** List workspace playbooks (read access stays available under kill switch). */
export async function fetchStoreManagerPlaybooks(): Promise<StoreManagerPlaybookSummary[]> {
  const res = await fetch('/api/store-manager/playbooks');
  if (!res.ok) throw new Error(`Failed to load playbooks (${res.status}).`);
  const data = (await res.json()) as { playbooks: StoreManagerPlaybookSummary[] };
  return data.playbooks ?? [];
}

/** Server-owned template descriptors (the client renders only these). */
export async function fetchStoreManagerPlaybookTemplates(): Promise<StoreManagerPlaybookTemplate[]> {
  const res = await fetch('/api/store-manager/playbooks/templates');
  if (!res.ok) throw new Error(`Failed to load playbook templates (${res.status}).`);
  const data = (await res.json()) as { templates: StoreManagerPlaybookTemplate[] };
  return data.templates ?? [];
}

/** Copy a starter template into a workspace draft (inert until activated). */
export async function createStoreManagerPlaybook(
  templateKind: StoreManagerPlaybookTemplateKind,
  name?: string,
): Promise<StoreManagerPlaybookSummary> {
  const res = await fetch('/api/store-manager/playbooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateKind, name }),
  });
  const data = (await res.json()) as { ok: boolean; playbook?: StoreManagerPlaybookSummary; error?: string; errorCode?: string };
  if (!data.ok) throw new Error(data.error ?? `Playbook create failed (${res.status}).`);
  return data.playbook!;
}

/** Playbook detail + immutable version history. */
export async function fetchStoreManagerPlaybookDetail(id: string): Promise<StoreManagerPlaybookDetail> {
  const res = await fetch(`/api/store-manager/playbooks/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to load playbook (${res.status}).`);
  return (await res.json()) as StoreManagerPlaybookDetail;
}

/** One immutable version. */
export async function fetchStoreManagerPlaybookVersion(id: string, version: number): Promise<StoreManagerPlaybookVersion> {
  const res = await fetch(`/api/store-manager/playbooks/${encodeURIComponent(id)}/versions/${version}`);
  if (!res.ok) throw new Error(`Failed to load playbook version (${res.status}).`);
  const data = (await res.json()) as { version: StoreManagerPlaybookVersion };
  return data.version;
}

/** Save a new immutable draft version (copy-on-edit; registry-validated). */
export async function saveStoreManagerPlaybookDraft(
  id: string,
  draft: {
    name: string;
    description?: string;
    scopeInput: StoreManagerPlaybookScopeInput;
    variables: StoreManagerPlaybookVariable[];
    steps: StoreManagerPlaybookStep[];
  },
): Promise<{ version: StoreManagerPlaybookVersion; staticRisk: StoreManagerPlaybookStaticRisk }> {
  const res = await fetch(`/api/store-manager/playbooks/${encodeURIComponent(id)}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  const data = (await res.json()) as
    | { ok: true; version: StoreManagerPlaybookVersion; staticRisk: StoreManagerPlaybookStaticRisk }
    | { ok: false; error?: string; errorCode?: string };
  if (!data.ok) throw new Error((data as { error?: string }).error ?? `Playbook save failed (${res.status}).`);
  return { version: data.version, staticRisk: data.staticRisk };
}

/** Explicit reviewed activation of an immutable version (records actor/time/hash). */
export async function activateStoreManagerPlaybook(id: string, version: number): Promise<StoreManagerPlaybookSummary> {
  const res = await fetch(`/api/store-manager/playbooks/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  const data = (await res.json()) as { ok: boolean; playbook?: StoreManagerPlaybookSummary; error?: string; errorCode?: string };
  if (!data.ok) throw new Error(data.error ?? `Playbook activation failed (${res.status}).`);
  return data.playbook!;
}

// ---------------------------------------------------------------------------
// Operations console — Issue 7: diff-first previews, run history, replay,
// comparison, and bounded history queries.
// ---------------------------------------------------------------------------

export interface StoreManagerActionDiff {
  schemaVersion: 1;
  toolName: string;
  toolVersion: number;
  riskClass: 'read' | 'proposal_write' | 'catalog_mutation' | 'network_filesystem_repair';
  workspaceId: string;
  scopeHash: string | null;
  affectedSkuCount: number;
  affectedSkus: string[];
  affectedSkusTruncated: boolean;
  beforeAfter: Array<{ field: string; sku?: string; before: string; after: string; affectedCount?: number }>;
  filesTouched: Array<{ path: string; note?: string }>;
  changeSet: { id?: string; currentState?: string | null; expectedState?: string; itemCount?: number } | null;
  networkActivity:
    | { kind: 'none' }
    | { kind: 'bounded'; hosts: string[]; requestCount: number; note?: string }
    | { kind: 'unknown'; note: string };
  evidenceRefs: string[];
  stateHashes: Record<string, string>;
  generatedAt: string;
  diffHash: string;
}

export interface StoreManagerHistoryRun {
  runId: string;
  workspaceId: string;
  entrypoint: string;
  executionMode: string;
  actorClass: string;
  objective: string;
  status: string;
  terminalStatus: string | null;
  outcomeReason: string | null;
  createdAt: string;
  updatedAt: string;
  modelCallId: string | null;
  policyHash: string;
  scopeHash: string | null;
  lineage: unknown;
  artifactCount: number;
}

export interface StoreManagerRunHistoryDetail {
  run: StoreManagerHistoryRun;
  events: unknown[];
  artifacts: Array<{ id: string; kind: string; schemaVersion: number; contentHash: string; createdAt: string }>;
  modelCall: {
    id: string;
    provider: string;
    model: string;
    locality: string;
    status: string;
    promptTokens: number | null;
    completionTokens: number | null;
    estimatedApiCostUsd: number | null;
    errorCode: string | null;
    startedAt: string;
  } | null;
}

export interface StoreManagerReplayResult {
  ok: boolean;
  replayRunId: string;
  replayOfRunId: string;
  terminalStatus: string;
  text: string;
  toolResults: Array<{ toolName: string; status: string }>;
}

export interface StoreManagerCompareResult {
  comparable: boolean;
  runIdA: string;
  runIdB: string;
  kind: string | null;
  delta: Array<{ field: string; before: string | number | null; after: string | number | null }> | null;
  reason: string | null;
}

export interface StoreManagerHistoryQueryResult {
  queryId: string;
  matchedRows: number;
  sourceRunIds: string[];
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  truncated: boolean;
}

export interface StoreManagerHistoryQueryDescriptor {
  queryId: string;
  version: number;
  description: string;
  paramSpec: unknown;
}

export interface StoreManagerPlaybookRunResult {
  runId: string;
  playbookId: string;
  version: number;
  status: 'running' | 'paused_at_checkpoint' | 'completed' | 'failed';
  currentStepId: string | null;
  steps: Array<{
    stepId: string;
    kind: string;
    status: string;
    toolName: string | null;
    diffHash: string | null;
    executionRunId: string | null;
    output: unknown;
    errorCode: string | null;
  }>;
  checkpoint: { stepId: string; toolName: string; toolCallId: string; diffHash: string; expiresAtMs: number } | null;
  errorCode: string | null;
}

export async function fetchStoreManagerActionPreview(
  toolName: string,
  input: Record<string, unknown>,
): Promise<StoreManagerActionDiff> {
  const res = await fetch('/api/store-manager/action-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolName, input }),
  });
  const data = (await res.json()) as { ok: boolean; diff?: StoreManagerActionDiff; error?: string };
  if (!data.ok || !data.diff) throw new Error(data.error ?? `Preview failed (${res.status}).`);
  return data.diff;
}

export async function fetchStoreManagerRuns(opts: { after?: { createdAt: string; id: string } | null; limit?: number } = {}): Promise<{
  runs: StoreManagerHistoryRun[];
  nextCursor: { createdAt: string; id: string } | null;
}> {
  const params = new URLSearchParams();
  if (opts.after) params.set('after', JSON.stringify(opts.after));
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const res = await fetch(`/api/store-manager/runs${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`Failed to load run history (${res.status}).`);
  return (await res.json()) as { runs: StoreManagerHistoryRun[]; nextCursor: { createdAt: string; id: string } | null };
}

export async function fetchStoreManagerRunDetail(runId: string): Promise<StoreManagerRunHistoryDetail> {
  const res = await fetch(`/api/store-manager/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) throw new Error(`Failed to load run detail (${res.status}).`);
  return (await res.json()) as StoreManagerRunHistoryDetail;
}

export async function replayStoreManagerRun(
  runId: string,
  selectedModel?: string,
): Promise<StoreManagerReplayResult> {
  const res = await fetch(`/api/store-manager/runs/${encodeURIComponent(runId)}/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(selectedModel ? { selectedModel } : {}),
  });
  const data = (await res.json()) as StoreManagerReplayResult & { error?: string; errorCode?: string };
  if (!data.ok) throw new Error(data.error ?? `Replay failed (${res.status}).`);
  return data;
}

export async function compareStoreManagerRuns(runIdA: string, runIdB: string): Promise<StoreManagerCompareResult> {
  const res = await fetch('/api/store-manager/runs/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runIdA, runIdB }),
  });
  return (await res.json()) as StoreManagerCompareResult;
}

export async function fetchStoreManagerHistoryQueries(): Promise<StoreManagerHistoryQueryDescriptor[]> {
  const res = await fetch('/api/store-manager/history/queries');
  if (!res.ok) return [];
  const data = (await res.json()) as { queries?: StoreManagerHistoryQueryDescriptor[] };
  return data.queries ?? [];
}

export async function executeStoreManagerHistoryQuery(
  queryId: string,
  params: Record<string, unknown>,
): Promise<StoreManagerHistoryQueryResult> {
  const res = await fetch('/api/store-manager/history/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queryId, params }),
  });
  const data = (await res.json()) as StoreManagerHistoryQueryResult & { error?: string; errorCode?: string };
  if (data.error) throw new Error(data.error);
  return data;
}

export async function runStoreManagerPlaybook(
  playbookId: string,
  variables: Record<string, unknown>,
): Promise<StoreManagerPlaybookRunResult> {
  const res = await fetch(`/api/store-manager/playbooks/${encodeURIComponent(playbookId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variables }),
  });
  const data = (await res.json()) as StoreManagerPlaybookRunResult & { error?: string; errorCode?: string };
  if (data.error) throw new Error(data.error);
  return data;
}

export async function resumeStoreManagerPlaybookRun(
  runId: string,
  approve: boolean,
  diffHash: string,
): Promise<StoreManagerPlaybookRunResult> {
  const res = await fetch(`/api/store-manager/playbook-runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve, diffHash }),
  });
  const data = (await res.json()) as StoreManagerPlaybookRunResult & { error?: string; errorCode?: string };
  if (data.error) throw new Error(data.error);
  return data;
}

// ---------------------------------------------------------------------------
// Homogeneous bulk review (operations console, Issue 8)
// ---------------------------------------------------------------------------

export type StoreManagerBulkReviewKind = 'casing' | 'whitespace' | 'separator';

export interface StoreManagerBulkReviewExclusion {
  proposalId: string;
  reason: string;
}

export interface StoreManagerBulkReviewGroup {
  workspaceId: string;
  field: string;
  normalizationKind: StoreManagerBulkReviewKind;
  ruleVersion: string;
  evidenceKey: string;
  proposalCount: number;
  distinctSkuCount: number;
  beforeAfterSamples: Array<{ oldValue: string; newValue: string; affectedCount: number }>;
  exclusions: StoreManagerBulkReviewExclusion[];
  truncated: boolean;
  maxItems: number;
}

export interface StoreManagerBulkReviewBatchSummary {
  id: string;
  field: string;
  normalizationKind: StoreManagerBulkReviewKind;
  status: 'pending' | 'applied' | 'denied';
  proposalCount: number;
  distinctSkuCount: number;
  createdAt: string;
}

export interface StoreManagerBulkReviewBatch {
  id: string;
  workspaceId: string;
  field: string;
  normalizationKind: StoreManagerBulkReviewKind;
  ruleVersion: string;
  evidenceKey: string;
  groupKey: string;
  status: 'pending' | 'applied' | 'denied';
  proposalCount: number;
  distinctSkuCount: number;
  diffHash: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerBulkReviewItem {
  id: string;
  workspaceId: string;
  batchId: string;
  proposalId: string;
  field: string;
  oldValue: string;
  newValue: string;
  affectedSkus: string[];
  itemDigest: string;
  decision: 'pending' | 'applied' | 'denied';
  decisionActor: string | null;
  changeSetItemRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerBulkReviewPreviewResult {
  ok: true;
  batch: StoreManagerBulkReviewBatch;
  items: StoreManagerBulkReviewItem[];
  group: StoreManagerBulkReviewGroup;
  diffHash: string;
  diffSummary: {
    affectedSkuCount: number;
    proposalCount: number;
    beforeAfterSamples: Array<{ oldValue: string; newValue: string; affectedCount: number }>;
    filesTouched: string[];
    changeSetCurrentState: string | null;
    changeSetExpectedState: string;
    networkActivity: 'none' | 'bounded' | 'unknown';
  };
}

export interface StoreManagerBulkReviewBatchDetail {
  ok: true;
  batch: StoreManagerBulkReviewBatch;
  items: StoreManagerBulkReviewItem[];
  stale: boolean;
  staleReason: string | null;
  currentProposalCount: number;
}

export async function previewStoreManagerBulkReview(
  field: string,
  opts: { normalizationKind?: StoreManagerBulkReviewKind; maxItems?: number } = {},
): Promise<StoreManagerBulkReviewPreviewResult> {
  const res = await fetch('/api/store-manager/bulk-review/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, ...(opts.normalizationKind ? { normalizationKind: opts.normalizationKind } : {}), ...(opts.maxItems ? { maxItems: opts.maxItems } : {}) }),
  });
  const data = (await res.json()) as StoreManagerBulkReviewPreviewResult & { error?: string; errorCode?: string };
  if (!data.ok || data.error) throw new Error(data.error ?? `Bulk review preview failed (${res.status}).`);
  return data;
}

export async function fetchStoreManagerBulkReviewBatches(): Promise<StoreManagerBulkReviewBatchSummary[]> {
  const res = await fetch('/api/store-manager/bulk-review/batches');
  if (!res.ok) throw new Error(`Failed to load bulk-review batches (${res.status}).`);
  const data = (await res.json()) as { batches: StoreManagerBulkReviewBatchSummary[] };
  return data.batches ?? [];
}

export async function fetchStoreManagerBulkReviewBatch(id: string): Promise<StoreManagerBulkReviewBatchDetail> {
  const res = await fetch(`/api/store-manager/bulk-review/batches/${encodeURIComponent(id)}`);
  const data = (await res.json()) as StoreManagerBulkReviewBatchDetail & { error?: string };
  if (!data.ok || data.error) throw new Error(data.error ?? `Failed to load batch (${res.status}).`);
  return data;
}

export async function denyStoreManagerBulkReviewBatch(id: string, reason?: string): Promise<{ batchId: string; status: 'denied'; itemCount: number }> {
  const res = await fetch(`/api/store-manager/bulk-review/batches/${encodeURIComponent(id)}/deny`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(reason ? { reason } : {}) }),
  });
  const data = (await res.json()) as { ok: boolean; batchId?: string; status?: string; itemCount?: number; error?: string; errorCode?: string };
  if (!data.ok) throw new Error(data.error ?? `Deny failed (${res.status}).`);
  return { batchId: String(data.batchId), status: 'denied', itemCount: Number(data.itemCount ?? 0) };
}
