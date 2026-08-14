import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { z } from 'zod';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createStoreManagerEventWorker } from '../../server/services/store-manager-event-worker';
import {
  observeTrigger,
  createTriggerFromTemplate,
  dispatchTriggerOccurrence,
  type TriggerDispatchDeps,
} from '../../server/services/store-manager-trigger-service';
import {
  getTrigger,
  createTriggerOccurrence,
  getTriggerOccurrence,
  listOccurrencesByTrigger,
  getSourceCursor,
} from '../../db/repositories/store-manager-trigger-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, completePromotionStage } from '../../db/repositories/onboarding-item-repo';
import { createChangeSet, updateChangeSetStatus } from '../../db/repositories/change-set-repo';
import { createSyncJob, completeSyncJob } from '../../db/repositories/sync-job-repo';
import { insertProposal } from '../../db/repositories/catalog-health-proposal-repo';
import { setTriggerEnabledForWorkspace } from '../../server/services/store-manager-trigger-service';
import { getStoreManagerSession, getStoreManagerRunArtifacts } from '../../db/repositories/store-manager-session-repo';
import { getAiModelCallsByWorkspace } from '../../db/repositories/ai-model-call-repo';
import { overrideStoreManagerFlags, resetStoreManagerFlagsOverride } from '../../store-manager/flags';
import { StoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import { buildStoreManagerActionDiff } from '../../store-manager/runtime/action-preview';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../../store-manager/runtime/contracts';
import { okResult } from '../../store-manager/runtime/contracts';
import type { ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { StoreManagerExecutionDeps } from '../../store-manager/runtime/executor';

/**
 * Event-trigger worker + observation (Issue 5). DB-backed: run under
 * `bun test`. All clocks injected; no real time, network, or model.
 */

const workspaceId = 'ws-event-worker';
const workspacePath = './test-workspace';
const testDbPath = './test-event-worker.db';

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
        { type: 'text-delta', id: 't1', delta: 'event report: no blockers found.' },
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

function runtimeDeps(registry?: StoreManagerToolRegistry): Partial<StoreManagerExecutionDeps> {
  return {
    resolveModel: () => ({ ...resolvedFake, modelInstance: plainTextModel() as unknown as ResolvedAiSdkModel['modelInstance'] }),
    registry,
  };
}

const dispatchDeps: TriggerDispatchDeps = { runtime: runtimeDeps(), workspacePath };

let writeCalls = 0;
const writeAdapter: StoreManagerToolAdapter = {
  name: 'runtime_write',
  version: 1,
  description: 'write for event test',
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

function forgedPersistentModel() {
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

describe('event-trigger worker + observation (Issue 5)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    insertWorkspace({
      id: workspaceId,
      name: 'Event Worker Store',
      workspacePath,
      gitPath: `${workspacePath}/.git`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    overrideStoreManagerFlags({ eventTriggersEnabled: true, killSwitch: false });
  });

  afterAll(() => {
    resetStoreManagerFlagsOverride();
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('import_finished emits an occurrence only when every item is terminal AND every promoted SKU is known', () => {
    const batch = createBatch({ workspaceId, name: 'Import batch A', fileName: 'a.csv', totalItems: 2 });
    insertItems(batch.id, [
      { upc: '111111111111', name: 'Product A', rowNumber: 1, stage: 'promotion', stageStatus: 'in_progress' },
      { upc: '222222222222', name: 'Product B', rowNumber: 2, stage: 'promotion', stageStatus: 'in_progress' },
    ]);
    const trigger = createTriggerFromTemplate(workspaceId, {
      kind: 'import_finished',
      name: 'Import audit A',
      config: { kind: 'import_finished', batchId: batch.id },
    }).trigger;

    // 1) Not terminal yet: observation records a diagnostic, no run.
    const diag = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-02T00:00:00.000Z') });
    expect(diag.diagnostics).toBe(1);
    expect(diag.occurrences).toBe(0);
    const diagOcc = listOccurrencesByTrigger(workspaceId, trigger.id, { status: 'diagnostic', limit: 20 });
    expect(diagOcc.some((o) => o.errorCode === 'import_not_terminal')).toBe(true);

    // 2) Terminalize both items (promotion completed → SKU = UPC).
    const rows = getDb().query('SELECT id FROM onboarding_items WHERE batch_id = ?').all(batch.id) as Array<{ id: string }>;
    for (const row of rows) completePromotionStage(row.id, true);
    expect(rows.length).toBe(2);

    // 3) Now the observation is terminal and SKUs are known → one occurrence.
    const ok = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-03T00:00:00.000Z') });
    expect(ok.occurrences).toBe(1);
    expect(ok.diagnostics).toBe(0);
    const runnable = listOccurrencesByTrigger(workspaceId, trigger.id, { status: 'pending', limit: 20 });
    const importOcc = runnable.find((o) => o.occurrenceKey === `import_finished:batch:${batch.id}`);
    expect(importOcc).toBeDefined();
    expect(importOcc!.sourceRef).toMatchObject({ kind: 'onboarding_batch', id: batch.id });
    const scope = JSON.parse(importOcc!.scopeJson!) as { kind: string; skus: string[] };
    expect(scope.kind).toBe('sku_set');
    expect(scope.skus).toEqual(expect.arrayContaining(['111111111111', '222222222222']));

    // 4) Re-observing the same committed state emits nothing (cursor dedupe).
    const again = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-04T00:00:00.000Z') });
    expect(again.occurrences).toBe(0);

    // 5) The cursor advanced with the terminal fingerprint.
    const cursor = getSourceCursor(workspaceId, 'onboarding_batch', batch.id);
    expect(cursor?.terminalObserved).toBe(true);
  });

  it('import_finished with a promoted item that has NO SKU records a diagnostic, never a run', () => {
    const batch = createBatch({ workspaceId, name: 'Import batch B', fileName: 'b.csv', totalItems: 1 });
    insertItems(batch.id, [
      { upc: '', name: 'No SKU product', rowNumber: 1, stage: 'promotion', stageStatus: 'completed' },
    ]);
    const trigger = createTriggerFromTemplate(workspaceId, {
      kind: 'import_finished',
      name: 'Import audit B',
      config: { kind: 'import_finished', batchId: batch.id },
    }).trigger;
    const result = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-05T00:00:00.000Z') });
    expect(result.occurrences).toBe(0);
    expect(result.diagnostics).toBe(1);
    const diag = listOccurrencesByTrigger(workspaceId, trigger.id, { status: 'diagnostic', limit: 20 });
    expect(diag.some((o) => o.errorCode === 'sku_unknown')).toBe(true);
  });

  it('change_set_approved emits one verification occurrence per approved change set (never a push)', () => {
    const cs = createChangeSet({ workspaceId, title: 'CS approved', baseCommit: 'a'.repeat(40) });
    updateChangeSetStatus(cs.id, 'approved', 'b'.repeat(40));
    const trigger = createTriggerFromTemplate(workspaceId, {
      kind: 'change_set_approved',
      name: 'CS verify',
    }).trigger;
    const result = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-06T00:00:00.000Z') });
    expect(result.occurrences).toBe(1);
    const occ = listOccurrencesByTrigger(workspaceId, trigger.id, { status: 'pending', limit: 20 });
    const found = occ.find((o) => o.occurrenceKey === `change_set_approved:${cs.id}`);
    expect(found).toBeDefined();
    expect(JSON.parse(found!.scopeJson!)).toMatchObject({ kind: 'change_set', changeSetId: cs.id });
    // Re-observation dedupes.
    const again = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-07T00:00:00.000Z') });
    expect(again.occurrences).toBe(0);
  });

  it('sync_failed emits one occurrence per failed sync job and dispatches with event lineage + telemetry', async () => {
    const job = createSyncJob({ workspaceId, kind: 'push', metadataJson: null });
    completeSyncJob(job.id, 'failed', { errorSummary: 'https://shopsite.example.com/api failed with token=secret123' });
    const trigger = createTriggerFromTemplate(workspaceId, { kind: 'sync_failed', name: 'Sync investigate' }).trigger;
    const result = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-08T00:00:00.000Z') });
    expect(result.occurrences).toBe(1);
    const occ = listOccurrencesByTrigger(workspaceId, trigger.id, { status: 'pending', limit: 20 }).find(
      (o) => o.occurrenceKey === `sync_failed:${job.id}`,
    );
    expect(occ).toBeDefined();

    // Claim + dispatch through the common runner.
    const { claimTriggerOccurrence } = await import('../../db/repositories/store-manager-trigger-repo');
    expect(claimTriggerOccurrence(workspaceId, occ!.id, 'test', 60_000, new Date().toISOString())).toBe(true);
    const dispatched = await dispatchTriggerOccurrence(workspaceId, occ!.id, dispatchDeps);
    expect(dispatched.status).toBe('completed');
    expect(dispatched.runId).toBeTruthy();

    const session = getStoreManagerSession(workspaceId, dispatched.runId!);
    expect(session?.entrypoint).toBe('event');
    expect(session?.execution_mode).toBe('unattended_read_only');
    expect(session?.actor_class).toBe('system_event');
    expect(session?.lineage_json).toContain('sync_failed');
    const artifacts = getStoreManagerRunArtifacts(workspaceId, dispatched.runId!);
    expect(artifacts.some((a) => a.kind === 'report')).toBe(true);
    const calls = getAiModelCallsByWorkspace(workspaceId);
    expect(calls.find((c) => c.id === session?.model_call_id)?.status).toBe('success');
  });

  it('product_field_drift emits only when a field delta exceeds the configured threshold', () => {
    const trigger = createTriggerFromTemplate(workspaceId, {
      kind: 'product_field_drift',
      name: 'Drift watch',
      config: { kind: 'product_field_drift', threshold: 5 },
    }).trigger;
    insertProposal({ workspaceId, field: 'ProductField24', oldValue: 'x', newValue: 'y', affectedSkus: ['s1'], reason: 'casing', confidence: 1, source: 'deterministic', status: 'proposed' });
    // Baseline establishment happens on the FIRST observation (no occurrence).
    const first = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-09T00:00:00.000Z') });
    expect(first.occurrences).toBe(0);

    // Grow the field's pending count by 5 more (delta 5 >= threshold 5) → one occurrence.
    for (let i = 0; i < 5; i += 1) {
      insertProposal({ workspaceId, field: 'ProductField24', oldValue: `x${i}`, newValue: 'y', affectedSkus: ['s1'], reason: 'casing', confidence: 1, source: 'deterministic', status: 'proposed' });
    }
    const second = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-10T00:00:00.000Z') });
    expect(second.occurrences).toBe(1);
    const occ = listOccurrencesByTrigger(workspaceId, trigger.id, { status: 'pending', limit: 20 }).find(
      (o) => o.occurrenceKey.startsWith('product_field_drift:ProductField24'),
    );
    expect(occ).toBeDefined();
    expect(JSON.parse(occ!.scopeJson!)).toMatchObject({ kind: 'product_field', field: 'ProductField24' });
    // No further delta: re-observation emits nothing.
    const third = observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-11T00:00:00.000Z') });
    expect(third.occurrences).toBe(0);
  });

  it('the worker tick observes + dispatches in one pass, and stops cleanly', async () => {
    const trigger = createTriggerFromTemplate(workspaceId, {
      kind: 'sync_failed',
      name: 'Worker sync trigger',
    }).trigger;
    // Enable the trigger so the worker's observation pass considers it.
    setTriggerEnabledForWorkspace(workspaceId, trigger.id, true, 'test');
    const job = createSyncJob({ workspaceId, kind: 'push' });
    completeSyncJob(job.id, 'failed', { errorSummary: 'boom' });
    const worker = createStoreManagerEventWorker({
      now: () => new Date('2026-01-12T00:00:00.000Z'),
      pollIntervalMs: 60_000,
      dispatchDeps,
    });
    const dispatched = await worker.tick();
    expect(dispatched).toBeGreaterThanOrEqual(1);
    const occs = listOccurrencesByTrigger(workspaceId, trigger.id, { limit: 20 });
    expect(occs.some((o) => o.status === 'completed')).toBe(true);
    worker.stop();
    expect(worker.running).toBe(false);
  });

  it('a forged persistent tool call in an event run is denied before side effects', async () => {
    writeCalls = 0;
    const trigger = createTriggerFromTemplate(workspaceId, { kind: 'sync_failed', name: 'Forged sync' }).trigger;
    const job = createSyncJob({ workspaceId, kind: 'push' });
    completeSyncJob(job.id, 'failed', { errorSummary: 'forged' });
    observeTrigger(workspaceId, getTrigger(workspaceId, trigger.id)!, { now: () => new Date('2026-01-13T00:00:00.000Z') });
    const occ = listOccurrencesByTrigger(workspaceId, trigger.id, { status: 'pending', limit: 20 }).find(
      (o) => o.occurrenceKey === `sync_failed:${job.id}`,
    );
    expect(occ).toBeDefined();
    const { claimTriggerOccurrence } = await import('../../db/repositories/store-manager-trigger-repo');
    expect(claimTriggerOccurrence(workspaceId, occ!.id, 'test', 60_000, new Date().toISOString())).toBe(true);
    const result = await dispatchTriggerOccurrence(workspaceId, occ!.id, {
      workspacePath,
      runtime: {
        resolveModel: () => ({ ...resolvedFake, modelInstance: forgedPersistentModel() as unknown as ResolvedAiSdkModel['modelInstance'] }),
        registry: new StoreManagerToolRegistry([writeAdapter]),
      },
    });
    // The persistent adapter never executes; the run still terminalizes.
    expect(writeCalls).toBe(0);
    expect(result.status).toBe('completed');
    const finalized = getTriggerOccurrence(workspaceId, occ!.id);
    expect(finalized?.status).toBe('completed');
  });

  it('diagnostic occurrences never become runs even when dispatched manually', async () => {
    const trigger = createTriggerFromTemplate(workspaceId, {
      kind: 'sync_failed',
      name: 'Diag guard',
    }).trigger;
    const diag = createTriggerOccurrence({
      workspaceId,
      triggerId: trigger.id,
      triggerVersion: trigger.version,
      occurrenceKey: 'diag-guard:1',
      sourceRef: { kind: 'sync_job', id: 'job-none' },
      scopeJson: null,
      scheduledAt: '2026-01-14T00:00:00.000Z',
      status: 'diagnostic',
      errorCode: 'import_not_terminal',
    });
    expect(diag.status).toBe('diagnostic');
    const { listDueTriggerOccurrences } = await import('../../db/repositories/store-manager-trigger-repo');
    const due = listDueTriggerOccurrences(workspaceId, '2026-01-15T00:00:00.000Z', { limit: 50 });
    expect(due.some((o) => o.id === diag.id)).toBe(false);
  });
});
