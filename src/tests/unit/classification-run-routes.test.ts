import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import { insertModelCallStart, completeModelCall } from '../../db/repositories/classification-model-call-repo';
import { MODEL_CALL_STATUS, COST_BASIS } from '../../classification/model-operation-registry';
import classificationRoutes from '../../server/routes/classification-routes';

const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

let wsA: { id: string; path: string };
let wsB: { id: string; path: string };

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', classificationRoutes);
  return app;
}

describe('GET /api/classification/runs/:id (issue #17 E)', () => {
  beforeAll(() => {
    wsA = { id: randomUUID(), path: '' };
    wsA.path = path.join(os.tmpdir(), `baystate-cms-run-routes-a-${wsA.id.slice(0, 8)}`);
    fs.mkdirSync(path.join(wsA.path, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsA.path, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({ id: wsA.id, name: 'ws-a', workspacePath: wsA.path, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  });

  it('returns 404 for a run that does not exist', async () => {
    const res = await makeApp().request('/api/classification/runs/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a run owned by another workspace (no existence leak)', async () => {
    // Second workspace in the same DB (the active workspace is wsA).
    wsB = { id: randomUUID(), path: '' };
    wsB.path = path.join(os.tmpdir(), `baystate-cms-run-routes-b-${wsB.id.slice(0, 8)}`);
    const { insertWorkspace: insertWs2 } = await import('../../db/repositories/workspace-repo');
    insertWs2({ id: wsB.id, name: 'ws-b', workspacePath: wsB.path, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
    const foreignRun = createRun(wsB.id, 'SKU-FOREIGN', null, null, { sourceKind: 'catalog_product', sourceProductHash: 'pf' });
    const res = await makeApp().request(`/api/classification/runs/${foreignRun.id}`);
    expect(res.status).toBe(404);
  });

  it('returns full run detail with model calls and snapshot summary, never prompt bodies or credentials', async () => {
    const run = createRun(wsA.id, 'SKU-1', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p1' });
    // Persist a runtime snapshot under the run's config snapshot hash so the
    // summary resolves (schema-v1 shape is accepted by the route).
    const { persistRuntimeSnapshot, buildRuntimeSnapshot } = await import('../../classification/runtime-snapshot');
    const { saveClassificationConfig, loadClassificationConfig } = await import('../../classification/config-loader');
    const { createConfigSnapshot } = await import('../../db/repositories/classification-config-repo');
    const now = '2026-08-01T12:00:00.000Z';
    fs.mkdirSync(path.join(wsA.path, 'store', 'classification'), { recursive: true });
    saveClassificationConfig(wsA.path, {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [
        { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] },
      ],
      attributes: [],
      attributeProfiles: [],
      attributeMappings: [],
      curationTargets: [],
      brands: [],
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
      dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
    });
    const config = loadClassificationConfig(wsA.path);
    const { id: snapId, hash: snapHash } = createConfigSnapshot(wsA.id, config);
    const snapshot = buildRuntimeSnapshot({
      workspaceId: wsA.id,
      workspacePath: wsA.path,
      productSku: 'SKU-1',
      config,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: now },
      sourceProductHash: 'p1',
      pages: { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
    });
    persistRuntimeSnapshot(snapshot);
    // The run references the snapshot hash directly for summary lookup.
    getDbRunSetSnapshotHash(run.id, snapshot.snapshotHash);

    const callId = insertModelCallStart({
      runId: run.id,
      stageName: 'product_attribute_proposals',
      operation: 'attribute_ranking',
      attempt: 1,
      provider: 'ollama',
      model: 'llama3',
      locality: 'local',
      snapshotHash: snapshot.snapshotHash,
      modelPolicyDigest: DIGEST,
      promptTemplateVersion: 'attribute-ranking-prompt-v1',
      ruleVersion: 'attribute-ranking-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    completeModelCall(callId, {
      status: MODEL_CALL_STATUS.success,
      durationMs: 5,
      promptTokens: 3,
      completionTokens: 2,
      estimatedCostUsd: 0,
      costBasis: COST_BASIS.localZero,
    });

    const res = await makeApp().request(`/api/classification/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.run.id).toBe(run.id);
    expect(body.run.workspaceId).toBe(wsA.id);
    expect(body.run.sourceKind).toBe('catalog_product');
    expect(body.run.productSku).toBe('SKU-1');

    expect(body.modelCalls).toHaveLength(1);
    const call = body.modelCalls[0];
    expect(call.operation).toBe('attribute_ranking');
    expect(call.provider).toBe('ollama');
    expect(call.model).toBe('llama3');
    expect(call.status).toBe(MODEL_CALL_STATUS.success);
    expect(call.promptTemplateVersion).toBe('attribute-ranking-prompt-v1');
    expect(call.ruleVersion).toBe('attribute-ranking-rules-v1');
    expect(call.systemPromptHash).toBe('s'.repeat(64));
    expect(call.userPromptHash).toBe('u'.repeat(64));
    // Never prompt/response bodies or credentials.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('sk-');

    expect(body.snapshotSummary).not.toBeNull();
    expect(body.snapshotSummary.schemaVersion).toBe(1);
    expect(body.snapshotSummary.snapshotHash).toBe(snapshot.snapshotHash);
    expect(body.snapshotSummary.modelExecutionPlanDigest).toBeNull();
    expect(body.snapshotSummary.runtimeRuleVersionsDigest).toBeNull();
    // The full config (with allowed values) is never returned.
    expect(body.snapshotSummary.config).toBeUndefined();

    expect(Array.isArray(body.evidence)).toBe(true);
    expect(Array.isArray(body.proposals)).toBe(true);
    expect(Array.isArray(body.decisions)).toBe(true);
    expect(Array.isArray(body.stageResults)).toBe(true);
    expect(body.drift).toEqual({ configDrift: false, sourceDrift: false });
  });

  it('reports snapshot_unavailable when the config hash is not a persisted runtime snapshot', async () => {
    const run = createRun(wsA.id, 'SKU-2', null, 'f'.repeat(64), { sourceKind: 'catalog_product', sourceProductHash: 'p2' });
    const res = await makeApp().request(`/api/classification/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshotSummary).toEqual({ unavailable: 'snapshot_unavailable', configSnapshotHash: 'f'.repeat(64) });
  });
});

// Helper: update the run row's config_snapshot_hash so the route resolves the
// persisted runtime snapshot summary.
import { getDb } from '../../db/connection';
function getDbRunSetSnapshotHash(runId: string, hash: string): void {
  getDb().run('UPDATE classification_runs SET config_snapshot_hash = ? WHERE id = ?', [hash, runId]);
}
