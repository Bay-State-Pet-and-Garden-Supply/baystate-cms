/**
 * Store Manager schedule service (operations console, Issue 4).
 *
 * Owns schedule CRUD + the deterministic recurrence calculator and the
 * occurrence dispatch path. Every occurrence enters the single runtime runner
 * (`runStoreManagerExecution`) with entrypoint `schedule`, execution mode
 * `unattended_read_only`, and actor class `system_schedule` — the runtime
 * derives the read-only allowlist and denies persistent adapters at registry
 * dispatch, so no schedule can stage, approve, publish, sync, or repair even
 * if the model requests it. Candidate-proposal ARTIFACTS are stored as review
 * evidence; converting one into a stored `catalog_health_proposals` row
 * remains an interactive, approval-gated action elsewhere.
 *
 * Deterministic recurrence (Locked Decision 7): one occurrence per local
 * schedule label; spring-forward gaps advance to the next valid instant;
 * repeated fall-back hours use the first instant (and the unique occurrence
 * key prevents duplication).
 */

import { randomUUID } from 'node:crypto';
import { hashCanonicalJson } from '../../shared/stable-id';
import type {
  StoreManagerExecutionDeps,
  StoreManagerExecutionResult,
} from '../../store-manager/runtime/executor';
import { runStoreManagerExecution } from '../../store-manager/runtime/executor';
import { createStoreManagerExecutionRequest } from '../../store-manager/runtime/execution-request';
import type { StoreManagerRuntimePolicy } from '../../store-manager/runtime/policy';
import { getScheduleTemplate } from '../../store-manager/schedules/templates';
import { createStoreManagerArtifact } from '../../store-manager/runtime/artifacts';
import type { StoreManagerScheduleDefinition } from '../../shared/schemas/store-manager-schedule';
import type { StoreManagerPinnedScope } from '../../shared/schemas/store-manager-operations';
import { ModelUnavailableError } from './ai-sdk-model-resolver';
import {
  createSchedule,
  getSchedule,
  getOccurrence,
  listSchedules,
  updateScheduleDefinition,
  setScheduleEnabled,
  updateScheduleRunState,
  createOccurrence,
  claimOccurrence,
  finalizeOccurrence,
  requeueOccurrence,
  cancelOverdueOccurrences,
  listOccurrencesBySchedule,
  type ScheduleDefinitionRow,
} from '../../db/repositories/store-manager-schedule-repo';
import {
  createStoreManagerRunArtifact,
  getStoreManagerSession,
} from '../../db/repositories/store-manager-session-repo';
import { reconcileInbox } from './store-manager-inbox-service';
import { evaluateNotificationRules } from './store-manager-notification-service';
import {
  getNotificationRule,
  updateNotificationRuleSnapshot,
  insertNotification,
} from '../../db/repositories/store-manager-notification-repo';
import { insertInboxItem } from '../../db/repositories/store-manager-inbox-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import {
  resolveStoreManagerScopeRequest,
  StoreManagerScopeError,
} from './store-manager-scope-service';

// ---------------------------------------------------------------------------
// IANA timezone wall-clock helpers (deterministic, injected-clock friendly)
// ---------------------------------------------------------------------------

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  weekday: number; // 1=Mon .. 7=Sun
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function isValidIanaTimezone(tz: string): boolean {
  try {
    // Intl throws RangeError for unknown timezone identifiers.
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function wallClockInZone(tz: string, utcMs: number): WallClock {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const weekdayIdx = WEEKDAY_NAMES.indexOf((parts.weekday ?? '') as (typeof WEEKDAY_NAMES)[number]);
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    weekday: weekdayIdx + 1,
  };
}

function wallOrdinal(w: WallClock): number {
  return w.y * 525600 + w.mo * 43200 + w.d * 1440 + w.h * 60 + w.mi;
}

/**
 * Convert a wall-clock time in `tz` to a UTC instant. Spring-forward gaps
 * advance to the next valid instant (there is no instant with that wall time);
 * fall-back overlaps resolve to the FIRST instant. Bounded scan over a 32-hour
 * window (any real-world offset is covered).
 */
export function zonedWallClockToUtcMs(
  tz: string,
  target: { y: number; mo: number; d: number; h: number; mi: number },
): number {
  const guess = Date.UTC(target.y, target.mo - 1, target.d, target.h, target.mi);
  const STEP = 15 * 60 * 1000;
  const start = guess - 16 * 3600 * 1000;
  const steps = Math.ceil((32 * 3600 * 1000) / STEP);
  const targetOrdinal = target.y * 525600 + target.mo * 43200 + target.d * 1440 + target.h * 60 + target.mi;
  let firstGte: number | null = null;
  for (let i = 0; i <= steps; i++) {
    const c = start + i * STEP;
    const w = wallClockInZone(tz, c);
    if (w.y === target.y && w.mo === target.mo && w.d === target.d && w.h === target.h && w.mi === target.mi) {
      return c; // exact match — first overlap instant because we scan forward
    }
    if (firstGte === null && wallOrdinal(w) >= targetOrdinal) firstGte = c;
  }
  if (firstGte !== null) return firstGte;
  throw new Error(`Unable to resolve zoned time ${JSON.stringify({ tz, target })}`);
}

function addDays(y: number, mo: number, d: number, days: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function parseTimeOfDay(timeOfDay: string): { h: number; mi: number } {
  const [h, mi] = timeOfDay.split(':').map(Number);
  return { h, mi };
}

/**
 * Next scheduled label strictly after `afterMs` for a schedule definition.
 * Returns the UTC instant (already DST-resolved). One label per local day
 * (daily/nightly) or per matching weekday (weekly).
 */
export function computeNextRunAtMs(
  schedule: Pick<StoreManagerScheduleDefinition, 'timezone' | 'recurrencePreset' | 'timeOfDay' | 'dayOfWeek'>,
  afterMs: number,
): number {
  const tz = schedule.timezone;
  const { h, mi } = parseTimeOfDay(schedule.timeOfDay);
  const afterWall = wallClockInZone(tz, afterMs);
  // Scan at most 8 days forward (covers weekly + DST edge).
  for (let offset = 0; offset < 8; offset++) {
    const date = addDays(afterWall.y, afterWall.mo, afterWall.d, offset);
    if (schedule.recurrencePreset === 'weekly') {
      const candidateWall = wallClockInZone(tz, Date.UTC(date.y, date.mo - 1, date.d, 12, 0));
      if (schedule.dayOfWeek != null && candidateWall.weekday !== schedule.dayOfWeek) continue;
    }
    const candidateMs = zonedWallClockToUtcMs(tz, { y: date.y, mo: date.mo, d: date.d, h, mi });
    if (candidateMs > afterMs) return candidateMs;
  }
  throw new Error(`Unable to compute next run for schedule ${schedule.recurrencePreset}.`);
}

// ---------------------------------------------------------------------------
// Schedule CRUD
// ---------------------------------------------------------------------------

export interface CreateScheduleResult {
  schedule: ScheduleDefinitionRow;
  nextRunAt: string | null;
}

function definitionHashFor(
  schedule: Pick<
    StoreManagerScheduleDefinition,
    'workspaceId' | 'name' | 'templateKind' | 'timezone' | 'recurrencePreset' | 'timeOfDay' | 'dayOfWeek' | 'scope' | 'selectedModel' | 'objective' | 'policyProfile'
  >,
): string {
  return hashCanonicalJson(schedule);
}

/**
 * Create a schedule from one of the locked templates. `enabled` always
 * defaults false — automation is inert until explicitly enabled.
 */
export function createScheduleFromTemplate(
  workspaceId: string,
  input: {
    templateKind: StoreManagerScheduleDefinition['templateKind'];
    name: string;
    timezone: string;
    recurrencePreset: StoreManagerScheduleDefinition['recurrencePreset'];
    timeOfDay: string;
    dayOfWeek?: number;
    scope?: StoreManagerScheduleDefinition['scope'];
    selectedModel?: string;
  },
  deps: { now?: () => Date } = {},
): CreateScheduleResult {
  const template = getScheduleTemplate(input.templateKind);
  if (!template) {
    throw new Error(`Unknown schedule template "${input.templateKind}".`);
  }
  if (!isValidIanaTimezone(input.timezone)) {
    throw new Error(`Invalid IANA timezone "${input.timezone}".`);
  }
  if (input.recurrencePreset === 'weekly' && (input.dayOfWeek == null || input.dayOfWeek < 1 || input.dayOfWeek > 7)) {
    throw new Error('Weekly schedules require dayOfWeek 1 (Monday) .. 7 (Sunday).');
  }
  if (input.recurrencePreset !== 'weekly' && input.dayOfWeek != null) {
    throw new Error('dayOfWeek is only valid for weekly schedules.');
  }
  let scope: StoreManagerPinnedScope | null = input.scope ?? null;
  if (scope) {
    try {
      const resolved = resolveStoreManagerScopeRequest(workspaceId, scope);
      scope = resolved?.pinnedScope ?? null;
    } catch (err) {
      if (err instanceof StoreManagerScopeError) {
        throw new Error(`Invalid schedule scope: ${err.message}`);
      }
      throw err;
    }
  }
  const now = deps.now?.() ?? new Date();
  const base = {
    workspaceId,
    name: input.name,
    templateKind: input.templateKind,
    timezone: input.timezone,
    recurrencePreset: input.recurrencePreset,
    timeOfDay: input.timeOfDay,
    dayOfWeek: input.recurrencePreset === 'weekly' ? (input.dayOfWeek ?? template.defaultDayOfWeek ?? 1) : null,
    scope,
    selectedModel: input.selectedModel ?? null,
    objective: template.objective,
    policyProfile: null,
  };
  const definitionHash = definitionHashFor(base);
  const schedule = createSchedule({
    workspaceId,
    name: input.name,
    templateKind: input.templateKind,
    timezone: input.timezone,
    recurrencePreset: input.recurrencePreset,
    timeOfDay: input.timeOfDay,
    dayOfWeek: base.dayOfWeek,
    scopeJson: scope ? JSON.stringify(scope) : null,
    selectedModel: input.selectedModel ?? null,
    objective: template.objective,
    definitionHash,
    policyProfileJson: null,
    enabled: false,
    createdAt: now.toISOString(),
  });
  const nextRunAtMs = computeNextRunAtMs(schedule, now.getTime());
  const nextRunAt = new Date(nextRunAtMs).toISOString();
  updateScheduleRunState(workspaceId, schedule.id, { nextRunAt });
  return { schedule: { ...schedule, nextRunAt }, nextRunAt };
}

export function listSchedulesForWorkspace(workspaceId: string): ScheduleDefinitionRow[] {
  return listSchedules(workspaceId);
}

export function getScheduleForWorkspace(workspaceId: string, id: string): ScheduleDefinitionRow | null {
  return getSchedule(workspaceId, id);
}

/**
 * Update editable schedule fields, creating a new immutable definition
 * version. The runtime only ever captures the version active at dispatch.
 */
export function updateScheduleForWorkspace(
  workspaceId: string,
  id: string,
  patch: {
    name?: string;
    timezone?: string;
    recurrencePreset?: StoreManagerScheduleDefinition['recurrencePreset'];
    timeOfDay?: string;
    dayOfWeek?: number;
    scope?: StoreManagerScheduleDefinition['scope'] | null;
    selectedModel?: string | null;
  },
  deps: { now?: () => Date } = {},
): ScheduleDefinitionRow {
  const existing = getSchedule(workspaceId, id);
  if (!existing) throw new Error('Schedule not found in this workspace.');
  const next = {
    name: patch.name ?? existing.name,
    timezone: patch.timezone ?? existing.timezone,
    recurrencePreset: patch.recurrencePreset ?? existing.recurrencePreset,
    timeOfDay: patch.timeOfDay ?? existing.timeOfDay,
    dayOfWeek: patch.dayOfWeek !== undefined ? patch.dayOfWeek : existing.dayOfWeek,
    scope: patch.scope !== undefined ? patch.scope : existing.scope,
    selectedModel: patch.selectedModel !== undefined ? patch.selectedModel : existing.selectedModel,
  };
  if (!isValidIanaTimezone(next.timezone)) {
    throw new Error(`Invalid IANA timezone "${next.timezone}".`);
  }
  if (next.recurrencePreset === 'weekly' && (next.dayOfWeek == null || next.dayOfWeek < 1 || next.dayOfWeek > 7)) {
    throw new Error('Weekly schedules require dayOfWeek 1 (Monday) .. 7 (Sunday).');
  }
  if (next.scope) {
    try {
      const resolvedScope = resolveStoreManagerScopeRequest(workspaceId, next.scope);
      next.scope = resolvedScope?.pinnedScope ?? null;
    } catch (err) {
      if (err instanceof StoreManagerScopeError) {
        throw new Error(`Invalid schedule scope: ${err.message}`);
      }
      throw err;
    }
  }
  const base = {
    workspaceId,
    name: next.name,
    templateKind: existing.templateKind,
    timezone: next.timezone,
    recurrencePreset: next.recurrencePreset,
    timeOfDay: next.timeOfDay,
    dayOfWeek: next.recurrencePreset === 'weekly' ? next.dayOfWeek : null,
    scope: next.scope,
    selectedModel: next.selectedModel,
    objective: existing.objective,
    policyProfile: existing.policyProfile,
  };
  const definitionHash = definitionHashFor(base);
  const updated = updateScheduleDefinition(workspaceId, id, {
    name: next.name,
    timezone: next.timezone,
    recurrencePreset: next.recurrencePreset,
    timeOfDay: next.timeOfDay,
    dayOfWeek: base.dayOfWeek,
    scopeJson: next.scope ? JSON.stringify(next.scope) : null,
    selectedModel: next.selectedModel,
    objective: existing.objective,
    definitionHash,
    policyProfileJson: existing.policyProfile ? JSON.stringify(existing.policyProfile) : null,
  });
  const now = deps.now?.() ?? new Date();
  const nextRunAt = new Date(computeNextRunAtMs(updated, now.getTime())).toISOString();
  updateScheduleRunState(workspaceId, id, { nextRunAt });
  return { ...updated, nextRunAt };
}

export function setScheduleEnabledForWorkspace(
  workspaceId: string,
  id: string,
  enabled: boolean,
  actor: string,
  deps: { now?: () => Date } = {},
): ScheduleDefinitionRow | null {
  const now = deps.now?.() ?? new Date();
  const audit = JSON.stringify({ actor, at: now.toISOString(), enabled });
  const updated = setScheduleEnabled(workspaceId, id, enabled, audit);
  if (!updated) return null;
  if (enabled) {
    const nextRunAt = new Date(computeNextRunAtMs(updated, now.getTime())).toISOString();
    updateScheduleRunState(workspaceId, id, { nextRunAt });
    return { ...updated, nextRunAt };
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Occurrence dispatch
// ---------------------------------------------------------------------------

export interface ScheduleDispatchDeps {
  /** Injectable runtime deps (fake model resolver / registry for tests). */
  runtime?: Partial<StoreManagerExecutionDeps>;
  /** Injectable clock. */
  now?: () => Date;
  /** Lease duration for claims (default 10 minutes). */
  leaseMs?: number;
  /** Max retries before an occurrence is terminal-failed (default 3). */
  maxRetries?: number;
  /** Base retry backoff (default 5 minutes); capped exponential. */
  retryBaseMs?: number;
  /** Max backoff (default 1 hour). */
  maxBackoffMs?: number;
  /** Optional explicit workspace path (single-workspace fallback: findWorkspace). */
  workspacePath?: string;
  /** Per-occurrence model override (never mutates the schedule definition). */
  selectedModel?: string;
}

export interface ScheduleDispatchResult {
  occurrenceId: string;
  occurrenceKey: string;
  status: 'completed' | 'failed' | 'unavailable' | 'cancelled' | 'requeued';
  runId: string | null;
  errorCode: string | null;
  terminalStatus: string | null;
  retryCount: number;
}

/**
 * Dispatch one due occurrence through the single runtime runner. The caller
 * (scheduler or run-now route) must have claimed it first; this function
 * executes, persists artifacts/report reconciliation, and finalizes or
 * requeues the occurrence.
 */
export async function dispatchOccurrence(
  workspaceId: string,
  occurrenceId: string,
  deps: ScheduleDispatchDeps = {},
): Promise<ScheduleDispatchResult> {
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? 10 * 60 * 1000;
  const maxRetries = deps.maxRetries ?? 3;
  const retryBaseMs = deps.retryBaseMs ?? 5 * 60 * 1000;
  const maxBackoffMs = deps.maxBackoffMs ?? 60 * 60 * 1000;

  const occurrence = requireOccurrence(workspaceId, occurrenceId);
  const schedule = getSchedule(workspaceId, occurrence.scheduleId);
  if (!schedule) {
    finalizeOccurrence({ workspaceId, occurrenceId, status: 'failed', errorCode: 'schedule_deleted' });
    return { occurrenceId, occurrenceKey: occurrence.occurrenceKey, status: 'failed', runId: null, errorCode: 'schedule_deleted', terminalStatus: null, retryCount: occurrence.retryCount };
  }
  const workspace = deps.workspacePath
    ? { workspacePath: deps.workspacePath }
    : findWorkspace() ?? { workspacePath: '.' };

  const template = getScheduleTemplate(schedule.templateKind);

  const request = createStoreManagerExecutionRequest({
    workspaceId,
    workspacePath: workspace.workspacePath,
    threadId: null,
    entrypoint: 'schedule',
    executionMode: 'unattended_read_only',
    objective: schedule.objective,
    pinnedScope: schedule.scope ?? undefined,
    lineage: {
      scheduleId: schedule.id,
      scheduleVersion: schedule.version,
      occurrenceKey: occurrence.occurrenceKey,
    },
    // Per-occurrence override wins; otherwise the schedule's configured model
    // (explicit selection never falls back). Never mutates the definition.
    selectedModel: deps.selectedModel ?? schedule.selectedModel ?? undefined,
    policyProfile: schedule.policyProfile ?? undefined,
  });

  let result: StoreManagerExecutionResult;
  try {
    result = await runStoreManagerExecution(request, deps.runtime ?? {});
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      // Explicit model unavailable: no fallback. Retry capped, then a deduped
      // operational item. No retry storm.
      return handleUnavailable(workspaceId, occurrenceId, schedule, occurrence, now, deps);
    }
    const code = err instanceof Error ? err.name : 'SCHEDULE_DISPATCH_ERROR';
    return handleFailure(workspaceId, occurrenceId, schedule, occurrence, code, now, maxRetries, retryBaseMs, maxBackoffMs, deps);
  }

  if (result.kind !== 'completed') {
    // Preview/chat results are impossible for schedule entrypoints.
    return handleFailure(workspaceId, occurrenceId, schedule, occurrence, 'unexpected_result', now, maxRetries, retryBaseMs, maxBackoffMs, deps);
  }

  if (result.terminalStatus === 'success') {
    // Persist immutable normalized report + candidate-proposal artifacts.
    const artifacts = persistScheduleArtifacts(workspaceId, schedule, occurrence, result, template?.kind ?? schedule.templateKind, now().toISOString());
    // Reconcile inbox + notifications AFTER artifact validation (edge rules
    // and the scheduled-report fingerprint seam both read validated state).
    reconcileInbox(workspaceId);
    evaluateNotificationRules(workspaceId);
    maybeEmitScheduledReportNotification(workspaceId, schedule, occurrence, artifacts.reportArtifactId, now);
    updateScheduleRunState(workspaceId, schedule.id, {
      nextRunAt: new Date(computeNextRunAtMs(schedule, now().getTime())).toISOString(),
      lastRunAt: now().toISOString(),
      lastRunStatus: 'completed',
      lastRunId: result.runId,
    });
    const finalized = finalizeOccurrence({
      workspaceId,
      occurrenceId,
      status: 'completed',
      runId: result.runId,
      nowIso: now().toISOString(),
    });
    return {
      occurrenceId,
      occurrenceKey: occurrence.occurrenceKey,
      status: 'completed',
      runId: result.runId,
      errorCode: null,
      terminalStatus: 'success',
      retryCount: finalized?.retryCount ?? occurrence.retryCount,
    };
  }

  // failed / policy_denied / cancelled / deadline_exceeded
  return handleFailure(
    workspaceId,
    occurrenceId,
    schedule,
    occurrence,
    result.terminalStatus === 'policy_denied' ? 'policy_denied' : result.terminalStatus,
    now,
    maxRetries,
    retryBaseMs,
    maxBackoffMs,
    deps,
    result.runId,
  );
}

function requireOccurrence(workspaceId: string, occurrenceId: string) {
  const occurrence = getOccurrence(workspaceId, occurrenceId);
  if (!occurrence) throw new Error('Occurrence not found in this workspace.');
  return occurrence;
}

async function handleUnavailable(
  workspaceId: string,
  occurrenceId: string,
  schedule: ScheduleDefinitionRow,
  occurrence: StoreManagerScheduleOccurrenceLike,
  now: () => Date,
  deps: ScheduleDispatchDeps,
): Promise<ScheduleDispatchResult> {
  const maxRetries = deps.maxRetries ?? 3;
  const retryBaseMs = deps.retryBaseMs ?? 5 * 60 * 1000;
  const maxBackoffMs = deps.maxBackoffMs ?? 60 * 60 * 1000;
  updateScheduleRunState(workspaceId, schedule.id, {
    nextRunAt: new Date(computeNextRunAtMs(schedule, now().getTime())).toISOString(),
    lastRunAt: now().toISOString(),
    lastRunStatus: 'unavailable',
  });
  if (occurrence.retryCount < maxRetries) {
    const backoff = Math.min(retryBaseMs * 2 ** occurrence.retryCount, maxBackoffMs);
    requeueOccurrence(workspaceId, occurrenceId, new Date(now().getTime() + backoff).toISOString(), 'model_unavailable');
    return {
      occurrenceId, occurrenceKey: occurrence.occurrenceKey, status: 'requeued', runId: null,
      errorCode: 'model_unavailable', terminalStatus: 'unavailable', retryCount: occurrence.retryCount + 1,
    };
  }
  finalizeOccurrence({ workspaceId, occurrenceId, status: 'unavailable', errorCode: 'model_unavailable', nowIso: now().toISOString() });
  upsertScheduledRunFailureItem(workspaceId, schedule, 'model_unavailable', now);
  return {
    occurrenceId, occurrenceKey: occurrence.occurrenceKey, status: 'unavailable', runId: null,
    errorCode: 'model_unavailable', terminalStatus: 'unavailable', retryCount: occurrence.retryCount + 1,
  };
}

interface StoreManagerScheduleOccurrenceLike {
  occurrenceKey: string;
  retryCount: number;
}

async function handleFailure(
  workspaceId: string,
  occurrenceId: string,
  schedule: ScheduleDefinitionRow,
  occurrence: StoreManagerScheduleOccurrenceLike,
  errorCode: string,
  now: () => Date,
  maxRetries: number,
  retryBaseMs: number,
  maxBackoffMs: number,
  deps: ScheduleDispatchDeps,
  runId?: string | null,
): Promise<ScheduleDispatchResult> {
  updateScheduleRunState(workspaceId, schedule.id, {
    nextRunAt: new Date(computeNextRunAtMs(schedule, now().getTime())).toISOString(),
    lastRunAt: now().toISOString(),
    lastRunStatus: 'failed',
    lastRunId: runId ?? null,
  });
  if (occurrence.retryCount < maxRetries) {
    const backoff = Math.min(retryBaseMs * 2 ** occurrence.retryCount, maxBackoffMs);
    requeueOccurrence(workspaceId, occurrenceId, new Date(now().getTime() + backoff).toISOString(), errorCode.slice(0, 100));
    return {
      occurrenceId, occurrenceKey: occurrence.occurrenceKey, status: 'requeued', runId: runId ?? null,
      errorCode: errorCode.slice(0, 100), terminalStatus: errorCode, retryCount: occurrence.retryCount + 1,
    };
  }
  finalizeOccurrence({ workspaceId, occurrenceId, status: 'failed', errorCode: errorCode.slice(0, 100), runId: runId ?? null, nowIso: now().toISOString() });
  upsertScheduledRunFailureItem(workspaceId, schedule, errorCode.slice(0, 100), now);
  return {
    occurrenceId, occurrenceKey: occurrence.occurrenceKey, status: 'failed', runId: runId ?? null,
    errorCode: errorCode.slice(0, 100), terminalStatus: errorCode, retryCount: occurrence.retryCount + 1,
  };
}

/** One deduped operational item per schedule (supervisor-approved kind). */
function upsertScheduledRunFailureItem(
  workspaceId: string,
  schedule: ScheduleDefinitionRow,
  errorCode: string,
  now: () => Date,
): void {
  const dedupeKey = `scheduled_run_failed:${schedule.id}:v1`;
  const fingerprint = hashCanonicalJson({ kind: 'scheduled_run_failed', scheduleId: schedule.id, errorCode });
  insertInboxItem(workspaceId, {
    kind: 'scheduled_run_failed',
    dedupeKey,
    severity: 'warning',
    title: `Scheduled run failed — ${schedule.name.slice(0, 80)}`,
    summary: `The ${schedule.templateKind} schedule failed with ${errorCode}. Review occurrence history before re-enabling.`,
    scopeJson: JSON.stringify({ kind: 'catalog' }),
    count: 1,
    sourceRefsJson: JSON.stringify([{ kind: 'schedule', id: schedule.id }]),
    fingerprint,
    sourceUpdatedAt: now().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Run artifacts + report fingerprint notification
// ---------------------------------------------------------------------------

interface ScheduleArtifacts {
  reportArtifactId: string;
  candidateArtifactId: string | null;
}

function persistScheduleArtifacts(
  workspaceId: string,
  schedule: ScheduleDefinitionRow,
  occurrence: { occurrenceKey: string; scheduleVersion: number },
  result: StoreManagerExecutionResult & { kind: 'completed' },
  templateKind: string,
  nowIso: string,
): ScheduleArtifacts {
  const reportContent = {
    scheduleId: schedule.id,
    scheduleName: schedule.name.slice(0, 100),
    templateKind,
    occurrenceKey: occurrence.occurrenceKey,
    scheduleVersion: occurrence.scheduleVersion,
    terminalStatus: result.terminalStatus,
    runId: result.runId,
    generatedAt: nowIso,
    objective: schedule.objective.slice(0, 2000),
    summary: (result.output?.text ?? '').slice(0, 64 * 1024),
    toolOutcomes: (result.output?.toolResults ?? []).slice(0, 50).map((t) =>
      t.errorText
        ? { toolName: t.toolName, status: t.status, errorText: t.errorText.slice(0, 500) }
        : { toolName: t.toolName, status: t.status },
    ),
  };
  const artifact = createStoreManagerArtifact({
    runId: result.runId,
    workspaceId,
    kind: 'report',
    schemaVersion: 1,
    content: reportContent,
    createdAt: nowIso,
  });
  createStoreManagerRunArtifact({
    id: artifact.id,
    workspaceId,
    runId: result.runId,
    kind: 'report',
    schemaVersion: 1,
    contentJson: JSON.stringify(reportContent),
    contentHash: artifact.contentHash,
    createdAt: nowIso,
  });

  let candidateArtifactId: string | null = null;
  if (templateKind === 'stale_proposal_review' || templateKind === 'weekly_cleanup_report') {
    const proposalSummaries = (result.output?.toolResults ?? [])
      .filter((t) => t.status === 'ok' && t.toolName === 'listStoredProposals' && t.output && typeof t.output === 'object')
      .slice(0, 20)
      .map((t) => ({ digest: hashCanonicalJson(t.output), toolName: t.toolName }));
    if (proposalSummaries.length > 0 || templateKind === 'stale_proposal_review') {
      const candidateContent = {
        scheduleId: schedule.id,
        templateKind,
        occurrenceKey: occurrence.occurrenceKey,
        runId: result.runId,
        generatedAt: nowIso,
        count: proposalSummaries.length,
        items: proposalSummaries,
        note: 'Candidate-proposal review evidence only. Not stored proposals and not staging authority.',
      };
      const candidateArtifact = createStoreManagerArtifact({
        runId: result.runId,
        workspaceId,
        kind: 'candidate_proposal_set',
        schemaVersion: 1,
        content: candidateContent,
        createdAt: nowIso,
      });
      createStoreManagerRunArtifact({
        id: candidateArtifact.id,
        workspaceId,
        runId: result.runId,
        kind: 'candidate_proposal_set',
        schemaVersion: 1,
        contentJson: JSON.stringify(candidateContent),
        contentHash: candidateArtifact.contentHash,
        createdAt: nowIso,
      });
      candidateArtifactId = candidateArtifact.id;
    }
  }
  return { reportArtifactId: artifact.id, candidateArtifactId };
}

/**
 * Scheduled-report fingerprint rule (Issue 3 seam, Phase B wiring): when the
 * rule is enabled and a NEW report fingerprint appears for a schedule, emit
 * one deterministic notification. Default rule state is disabled, so nothing
 * emits unless the operator enables it.
 */
function maybeEmitScheduledReportNotification(
  workspaceId: string,
  schedule: ScheduleDefinitionRow,
  occurrence: { occurrenceKey: string },
  reportArtifactId: string,
  now: () => Date,
): void {
  const rule = getNotificationRule(workspaceId, 'scheduled_report_new_fingerprint');
  if (!rule || !rule.enabled) return;
  const fingerprint = hashCanonicalJson({
    scheduleId: schedule.id,
    occurrenceKey: occurrence.occurrenceKey,
    reportArtifactId,
  });
  const prev = rule.lastSeenSnapshotJson ? (JSON.parse(rule.lastSeenSnapshotJson) as { fingerprint?: string }) : null;
  if (prev?.fingerprint === fingerprint) return; // already emitted for this report
  updateNotificationRuleSnapshot(workspaceId, rule.kind, JSON.stringify({ fingerprint }));
  insertNotification({
    workspaceId,
    ruleId: rule.id,
    ruleKind: rule.kind,
    ruleVersion: rule.version,
    fingerprint: hashCanonicalJson({ ruleId: rule.id, reportFingerprint: fingerprint }),
    severity: 'info',
    title: 'Scheduled report ready',
    message: `Scheduled report "${schedule.name.slice(0, 80)}" produced a new fingerprint (${occurrence.occurrenceKey.slice(0, 24)}).`,
    sourceRunId: reportArtifactId,
  });
}

// ---------------------------------------------------------------------------
// Run-now (read-only, flag-gated by the route)
// ---------------------------------------------------------------------------

export interface RunNowResult {
  occurrenceId: string;
  occurrenceKey: string;
  result: ScheduleDispatchResult;
}

/**
 * Create an immediate occurrence and dispatch it synchronously through the
 * SAME unattended read-only runtime policy. "Run now" is not an approval
 * shortcut and carries no additional authority.
 */
export async function runNowReadOnly(
  workspaceId: string,
  scheduleId: string,
  deps: ScheduleDispatchDeps & { selectedModel?: string } = {},
): Promise<RunNowResult> {
  const now = deps.now ?? (() => new Date());
  const schedule = getSchedule(workspaceId, scheduleId);
  if (!schedule) throw new Error('Schedule not found in this workspace.');
  const occurrenceKey = `run-now:${randomUUID()}`;
  const occurrence = createOccurrence({
    workspaceId,
    scheduleId,
    scheduleVersion: schedule.version,
    occurrenceKey,
    scheduledAt: now().toISOString(),
  });
  const claimed = claimOccurrence(workspaceId, occurrence.id, 'operator', deps.leaseMs ?? 10 * 60 * 1000, now().toISOString());
  if (!claimed) {
    throw new Error('Occurrence could not be claimed.');
  }
  const result = await dispatchOccurrence(workspaceId, occurrence.id, deps);
  return { occurrenceId: occurrence.id, occurrenceKey, result };
}
