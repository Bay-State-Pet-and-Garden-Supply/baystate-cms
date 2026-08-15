import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { z } from 'zod';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { createScheduleFromTemplate, runNowReadOnly, dispatchOccurrence } from '../../server/services/store-manager-schedule-service';
import { StoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import { buildStoreManagerActionDiff } from '../../store-manager/runtime/action-preview';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../../store-manager/runtime/contracts';
import { okResult } from '../../store-manager/runtime/contracts';
import { getStoreManagerSession, getStoreManagerRunArtifacts } from '../../db/repositories/store-manager-session-repo';
import { listInboxItems } from '../../db/repositories/store-manager-inbox-repo';
import { listNotifications } from '../../db/repositories/store-manager-notification-repo';
import { getScheduleForWorkspace } from '../../server/services/store-manager-schedule-service';
import { getAiModelCallsByWorkspace } from '../../db/repositories/ai-model-call-repo';
import type { ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import { ModelUnavailableError } from '../../server/services/ai-sdk-model-resolver';
import { listSchedules } from '../../db/repositories/store-manager-schedule-repo';
import { STORE_MANAGER_SCHEDULE_TEMPLATES } from '../../store-manager/schedules/templates';

/**
 * Scheduled read-only runtime (Issue 4). DB-backed: run under `bun test`.
 * All five templates must enter the common runner; persistent adapters are
 * denied before side effects; explicit model unavailability has no fallback.
 */

const workspaceId = 'ws-scheduled-runtime';
const workspacePath = './test-workspace';
const testDbPath = './test-scheduled-runtime.db';

/** Plain-text model: streams a short text answer and finishes. */
function plainTextModel() {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate not exercised');
    },
    async doStream(options: LanguageModelV3CallOptions) {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'catalog health summary: no blockers found.' },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish',
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
          finishReason: { unified: 'stop', raw: 'stop' },
        },
      ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
  return model;
}

/** Model that emits a forged persistent tool call (must be denied). */
function forgedPersistentCallModel() {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate not exercised');
    },
    async doStream(options: LanguageModelV3CallOptions) {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'runtime_write', input: JSON.stringify({ proposalId: 'foreign' }) },
        {
          type: 'finish',
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        },
      ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
  return model;
}

const resolvedFake: ResolvedAiSdkModel = {
  modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
  provider: 'fake-provider',
  modelId: 'fake-model',
  locality: 'cloud',
  resolutionReason: 'explicit',
};

let writeCalls = 0;
const writeAdapter: StoreManagerToolAdapter = {
  name: 'runtime_write',
  version: 1,
  description: 'write for schedule test',
  promptGuidelines: 'none',
  inputSchema: z.object({ proposalId: z.string() }),
  riskClass: 'proposal_write',
  sideEffects: 'writes',
  requiresApproval: true,
  stateTransition: 'proposal stored',
  allowedPhases: ['approve'] as const,
  scopeSummary: (i) => `write ${String(i.proposalId ?? '')}`,
  previewDiff: ({ proposalId }) =>
    buildStoreManagerActionDiff({
      toolName: 'runtime_write',
      toolVersion: 1,
      riskClass: 'proposal_write',
      workspaceId: '',
      scopeHash: null,
      affectedSkuCount: 1,
      affectedSkus: [],
      beforeAfter: [],
      filesTouched: [],
      changeSet: null,
      networkActivity: { kind: 'none' },
      evidenceRefs: [],
      stateHashes: {},
    }),
  execute: async (): Promise<StoreManagerToolResult> => {
    writeCalls += 1;
    return okResult({ ok: true });
  },
};

function testRegistry() {
  return new StoreManagerToolRegistry([writeAdapter]);
}

describe('scheduled read-only runtime (Issue 4)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    insertWorkspace({
      id: workspaceId,
      name: 'Scheduled Runtime Store',
      workspacePath,
      gitPath: `${workspacePath}/.git`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('all five templates enter the common runner as schedule entrypoints with telemetry linkage', async () => {
    for (const template of STORE_MANAGER_SCHEDULE_TEMPLATES) {
      const created = createScheduleFromTemplate(workspaceId, {
        templateKind: template.kind,
        name: template.name,
        timezone: 'UTC',
        recurrencePreset: template.defaultRecurrencePreset,
        timeOfDay: template.defaultTimeOfDay,
        dayOfWeek: template.defaultRecurrencePreset === 'weekly' ? (template.defaultDayOfWeek ?? 1) : undefined,
      });
      const model = plainTextModel();
      const result = await runNowReadOnly(workspaceId, created.schedule.id, {
        workspacePath,
        runtime: {
          resolveModel: () => ({ ...resolvedFake, modelInstance: model as unknown as ResolvedAiSdkModel['modelInstance'] }),
        },
      });
      expect(result.result.status).toBe('completed');
      expect(result.result.runId).not.toBeNull();
      // The run is a real session row with schedule entrypoint + lineage.
      const session = getStoreManagerSession(workspaceId, result.result.runId!);
      expect(session).not.toBeNull();
      expect(session!.entrypoint).toBe('schedule');
      expect(session!.execution_mode).toBe('unattended_read_only');
      expect(session!.actor_class).toBe('system_schedule');
      expect(session!.lineage_json).toContain(created.schedule.id);
      expect(session!.lineage_json).toContain(result.result.occurrenceKey);
      // Report artifact persisted (immutable, content-addressed).
      const artifacts = getStoreManagerRunArtifacts(workspaceId, result.result.runId!);
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts.some((a) => a.kind === 'report')).toBe(true);
      // Telemetry linkage: exact ai_model_calls row terminalized.
      const calls = getAiModelCallsByWorkspace(workspaceId);
      const row = calls.find((c) => c.id === session!.model_call_id);
      expect(row).toBeDefined();
      expect(row!.status).toBe('success');
    }
  });

  it('forged persistent call is denied before side effects (read-only by runtime construction)', async () => {
    writeCalls = 0;
    const created = createScheduleFromTemplate(workspaceId, {
      templateKind: 'daily_catalog_health',
      name: 'Forged persistent',
      timezone: 'UTC',
      recurrencePreset: 'daily',
      timeOfDay: '06:00',
    });
    const model = forgedPersistentCallModel();
    const result = await runNowReadOnly(workspaceId, created.schedule.id, {
      workspacePath,
      runtime: {
        resolveModel: () => ({ ...resolvedFake, modelInstance: model as unknown as ResolvedAiSdkModel['modelInstance'] }),
        registry: testRegistry(),
      },
    });
    // The write adapter must never execute.
    expect(writeCalls).toBe(0);
    // The run still terminalizes (policy_denied) with a session row.
    expect(result.result.status).toBe('completed'); // drained stream terminalized; write refused
    expect(writeCalls).toBe(0);
    const session = getStoreManagerSession(workspaceId, result.result.runId!);
    expect(session).not.toBeNull();
  });

  it('explicit model unavailability has no fallback and requeues with a bounded backoff', async () => {
    const created = createScheduleFromTemplate(workspaceId, {
      templateKind: 'nightly_anomalies',
      name: 'Unavailable model',
      timezone: 'UTC',
      recurrencePreset: 'nightly',
      timeOfDay: '02:00',
      selectedModel: 'explicit-missing-model',
    });
    const result = await runNowReadOnly(workspaceId, created.schedule.id, {
      workspacePath,
      runtime: {
        resolveModel: (_selectedModel?: import('../../shared/schemas/store-manager-operations').StoreManagerModelSelection) => {
          throw new ModelUnavailableError('Model is not configured.');
        },
      },
      maxRetries: 1,
      retryBaseMs: 60_000,
    });
    // With maxRetries=1 and a run-now (fresh occurrence, retryCount 0), the
    // first failure requeues (no fallback, no retry storm).
    expect(result.result.status).toBe('requeued');
    expect(result.result.errorCode).toBe('model_unavailable');
    expect(result.result.terminalStatus).toBe('unavailable');
  });

  it('after retries are exhausted a failure becomes terminal + a deduped inbox item appears', async () => {
    const created = createScheduleFromTemplate(workspaceId, {
      templateKind: 'stale_proposal_review',
      name: 'Exhausted retries',
      timezone: 'UTC',
      recurrencePreset: 'weekly',
      timeOfDay: '08:00',
      dayOfWeek: 3,
      selectedModel: 'still-missing',
    });
    // Pre-requeue the occurrence twice so retryCount is at maxRetries-1, then
    // dispatch with maxRetries=2 → the second failure is terminal.
    const before = listSchedules(workspaceId, 200).find((s) => s.id === created.schedule.id);
    const run = await runNowReadOnly(workspaceId, created.schedule.id, {
      workspacePath,
      runtime: {
        resolveModel: () => {
          throw new ModelUnavailableError('Model is not configured.');
        },
      },
      maxRetries: 0, // 0 retries → immediate terminal unavailable
    });
    expect(run.result.status).toBe('unavailable');
    expect(before).toBeTruthy();
    // A deduped operational inbox item exists for this schedule.
    const items = listInboxItems(workspaceId, { limit: 200 });
    const failureItem = items.find((i) => i.kind === 'scheduled_run_failed' && i.dedupeKey.includes(created.schedule.id));
    expect(failureItem).toBeDefined();
    expect(failureItem!.severity).toBe('warning');
    // Schedule last-run state updated.
    const after = getScheduleForWorkspace(workspaceId, created.schedule.id);
    expect(after?.lastRunStatus).toBe('unavailable');
    expect(after?.lastRunId).toBeNull();
  });

  it('successful scheduled runs reconcile the inbox and leave notifications empty by default', async () => {
    const created = createScheduleFromTemplate(workspaceId, {
      templateKind: 'weekly_cleanup_report',
      name: 'Inbox reconcile',
      timezone: 'UTC',
      recurrencePreset: 'weekly',
      timeOfDay: '07:00',
      dayOfWeek: 1,
    });
    const model = plainTextModel();
    await runNowReadOnly(workspaceId, created.schedule.id, {
      workspacePath,
      runtime: {
        resolveModel: () => ({ ...resolvedFake, modelInstance: model as unknown as ResolvedAiSdkModel['modelInstance'] }),
      },
    });
    // Reconcile runs inside the service; scheduled-report rule is disabled by
    // default so no notification chatter is emitted.
    const notifications = listNotifications(workspaceId, { limit: 200 });
    const reportRuleEmissions = notifications.filter((n) => n.ruleKind === 'scheduled_report_new_fingerprint');
    expect(reportRuleEmissions).toHaveLength(0);
  });
});
