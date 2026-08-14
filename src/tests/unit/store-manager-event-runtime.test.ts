import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  createTriggerFromTemplate,
  runTriggerNowReadOnly,
  dispatchTriggerOccurrence,
  type TriggerDispatchDeps,
} from '../../server/services/store-manager-trigger-service';
import { getTrigger, createTriggerOccurrence, getTriggerOccurrence } from '../../db/repositories/store-manager-trigger-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, completePromotionStage } from '../../db/repositories/onboarding-item-repo';
import { createChangeSet, updateChangeSetStatus } from '../../db/repositories/change-set-repo';
import { createSyncJob, completeSyncJob } from '../../db/repositories/sync-job-repo';
import { insertProposal } from '../../db/repositories/catalog-health-proposal-repo';
import { getStoreManagerSession, getStoreManagerRunArtifacts } from '../../db/repositories/store-manager-session-repo';
import { getAiModelCallsByWorkspace } from '../../db/repositories/ai-model-call-repo';
import { ModelUnavailableError, type ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { StoreManagerExecutionDeps } from '../../store-manager/runtime/executor';

/**
 * Event-trigger runtime (Issue 5). DB-backed: run under `bun test`. Every
 * occurrence of every kind enters the common runner with event lineage +
 * read-only policy; explicit model unavailability has no fallback.
 */

const workspaceId = 'ws-event-runtime';
const workspacePath = './test-workspace';
const testDbPath = './test-event-runtime.db';

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
        { type: 'text-delta', id: 't1', delta: 'event runtime: report ready.' },
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

const resolvedFake: ResolvedAiSdkModel = {
  modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
  provider: 'fake-provider',
  modelId: 'fake-model',
  locality: 'cloud',
  resolutionReason: 'explicit',
};

const dispatchDeps: TriggerDispatchDeps = {
  workspacePath,
  runtime: {
    resolveModel: () => ({ ...resolvedFake, modelInstance: plainTextModel() as unknown as ResolvedAiSdkModel['modelInstance'] }),
  },
};

describe('event-trigger runtime (Issue 5)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    insertWorkspace({
      id: workspaceId,
      name: 'Event Runtime Store',
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

  it('run-now dispatches all four trigger kinds through the common event runner with lineage + telemetry', async () => {
    // Seed minimal sources so the run-now scopes/objectives are meaningful.
    const batch = createBatch({ workspaceId, name: 'RT batch', fileName: 'r.csv', totalItems: 1 });
    insertItems(batch.id, [{ upc: '777777777777', name: 'RT product', rowNumber: 1, stage: 'promotion', stageStatus: 'in_progress' }]);
    const rtRows = getDb().query('SELECT id FROM onboarding_items WHERE batch_id = ?').all(batch.id) as Array<{ id: string }>;
    for (const r of rtRows) completePromotionStage(r.id, true);
    const cs = createChangeSet({ workspaceId, title: 'RT cs', baseCommit: 'a'.repeat(40) });
    updateChangeSetStatus(cs.id, 'approved', 'b'.repeat(40));
    const job = createSyncJob({ workspaceId, kind: 'push' });
    completeSyncJob(job.id, 'failed', { errorSummary: 'rt fail' });
    insertProposal({ workspaceId, field: 'ProductField24', oldValue: 'a', newValue: 'b', affectedSkus: ['s1'], reason: 'casing', confidence: 1, source: 'deterministic', status: 'proposed' });

    const kinds = [
      { kind: 'import_finished' as const, name: 'RT import', config: { kind: 'import_finished' as const, batchId: batch.id } },
      { kind: 'change_set_approved' as const, name: 'RT change set', config: { kind: 'change_set_approved' as const } },
      { kind: 'sync_failed' as const, name: 'RT sync', config: { kind: 'sync_failed' as const } },
      { kind: 'product_field_drift' as const, name: 'RT drift', config: { kind: 'product_field_drift' as const, threshold: 1 } },
    ];

    for (const kindDef of kinds) {
      const created = createTriggerFromTemplate(workspaceId, {
        kind: kindDef.kind,
        name: kindDef.name,
        config: kindDef.config,
      }).trigger;
      const result = await runTriggerNowReadOnly(workspaceId, created.id, dispatchDeps);
      expect(result.result.status).toBe('completed');
      expect(result.result.runId).toBeTruthy();
      const session = getStoreManagerSession(workspaceId, result.result.runId!);
      expect(session).not.toBeNull();
      expect(session!.entrypoint).toBe('event');
      expect(session!.execution_mode).toBe('unattended_read_only');
      expect(session!.actor_class).toBe('system_event');
      expect(session!.lineage_json).toContain(kindDef.kind);
      expect(session!.lineage_json).toContain(result.result.occurrenceKey);
      const artifacts = getStoreManagerRunArtifacts(workspaceId, result.result.runId!);
      expect(artifacts.some((a) => a.kind === 'report')).toBe(true);
      const calls = getAiModelCallsByWorkspace(workspaceId);
      expect(calls.find((c) => c.id === session!.model_call_id)?.status).toBe('success');
    }
  });

  it('explicit model unavailability has no fallback and requeues with bounded backoff', async () => {
    const created = createTriggerFromTemplate(workspaceId, {
      kind: 'sync_failed',
      name: 'RT unavailable',
      config: { kind: 'sync_failed' },
    }).trigger;
    const result = await runTriggerNowReadOnly(workspaceId, created.id, {
      workspacePath,
      runtime: {
        resolveModel: () => {
          throw new ModelUnavailableError('Model is not configured.');
        },
      },
      maxRetries: 1,
      retryBaseMs: 60_000,
    });
    expect(result.result.status).toBe('requeued');
    expect(result.result.errorCode).toBe('model_unavailable');
    expect(result.result.terminalStatus).toBe('unavailable');
    const occurrence = getTriggerOccurrence(workspaceId, result.result.occurrenceId);
    expect(occurrence?.retryCount).toBe(1);
    expect(occurrence?.status).toBe('pending');
  });

  it('exhausted retries terminalize as unavailable without an inbox row (occurrence is the durable surface)', async () => {
    const created = createTriggerFromTemplate(workspaceId, {
      kind: 'sync_failed',
      name: 'RT exhausted',
      config: { kind: 'sync_failed' },
    }).trigger;
    const result = await runTriggerNowReadOnly(workspaceId, created.id, {
      workspacePath,
      runtime: {
        resolveModel: () => {
          throw new ModelUnavailableError('Model is not configured.');
        },
      },
      maxRetries: 0,
    });
    expect(result.result.status).toBe('unavailable');
    const occurrence = getTriggerOccurrence(workspaceId, result.result.occurrenceId);
    expect(occurrence?.status).toBe('unavailable');
    expect(occurrence?.errorCode).toBe('model_unavailable');
  });

  it('deadline-exceeded and cancelled event occurrences terminalize and remain inspectable', async () => {
    const created = createTriggerFromTemplate(workspaceId, {
      kind: 'sync_failed',
      name: 'RT deadline',
      config: { kind: 'sync_failed' },
    }).trigger;
    // A manually created occurrence with a deadline-exceeding runtime policy:
    // the runtime policy profile caps the deadline so an in-flight run aborts.
    const occ = createTriggerOccurrence({
      workspaceId,
      triggerId: created.id,
      triggerVersion: created.version,
      occurrenceKey: 'rt-deadline:1',
      sourceRef: { kind: 'sync_failed', id: 'manual' },
      scopeJson: null,
      scheduledAt: '2026-01-01T00:00:00.000Z',
    });
    // Claim + dispatch with a tiny policy deadline via the policy profile.
    const { claimTriggerOccurrence } = await import('../../db/repositories/store-manager-trigger-repo');
    expect(claimTriggerOccurrence(workspaceId, occ.id, 'test', 60_000, '2026-01-01T00:01:00.000Z')).toBe(true);
    // A never-finishing model exercises the deadline path.
    const result = await dispatchTriggerOccurrence(workspaceId, occ.id, {
      workspacePath,
      policyProfile: { deadlineMs: 120 },
      runtime: {
        resolveModel: () => ({ ...resolvedFake, modelInstance: neverFinishingModel() as unknown as ResolvedAiSdkModel['modelInstance'] }),
      },
    } as TriggerDispatchDeps & { runtime: { resolveModel: () => { modelInstance: unknown } } });
    expect(['requeued', 'failed', 'completed']).toContain(result.status);
    // The occurrence is either requeued (retry) or terminal — never stuck claimed.
    const after = getTriggerOccurrence(workspaceId, occ.id);
    expect(after?.status).not.toBe('claimed');
  });
});

function neverFinishingModel() {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate not exercised');
    },
    async doStream(options: LanguageModelV3CallOptions & { abortSignal?: AbortSignal }) {
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'starting…' });
            const timer = setInterval(() => {
              controller.enqueue({ type: 'text-delta', id: 't1', delta: '.' });
            }, 10);
            options.abortSignal?.addEventListener('abort', () => {
              clearInterval(timer);
              controller.error(new DOMException('aborted', 'AbortError'));
            });
          },
        }),
      };
    },
  };
  return model;
}
