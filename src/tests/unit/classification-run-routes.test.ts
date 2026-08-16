import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
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
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';

// P0 taxonomy freeze: this suite persists a legacy config inside a test, so
// the freeze is lifted for the duration of the suite (restored in afterAll).

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
    setTaxonomyFreezeForTests(false);
    wsA = { id: randomUUID(), path: '' };
    wsA.path = path.join(os.tmpdir(), `baystate-cms-run-routes-a-${wsA.id.slice(0, 8)}`);
    fs.mkdirSync(path.join(wsA.path, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsA.path, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({ id: wsA.id, name: 'ws-a', workspacePath: wsA.path, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
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

  it('returns snapshot_unavailable (not 500) for malformed historical snapshot JSON (pass 4b)', async () => {
    const run = createRun(wsA.id, 'SKU-3', null, 'zz'.repeat(32), { sourceKind: 'catalog_product', sourceProductHash: 'p3' });
    // Insert a row whose config_json is not valid JSON under the run's hash.
    getDb().run(
      "INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, config_json, created_at) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), wsA.id, 'zz'.repeat(32), 'not-json{{{', new Date().toISOString()],
    );
    const res = await makeApp().request(`/api/classification/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshotSummary).toEqual({ unavailable: 'snapshot_unavailable', configSnapshotHash: 'zz'.repeat(32) });
  });

  it('sanitizes credential-shaped evidence content out of the response body (pass 4b)', async () => {
    const run = createRun(wsA.id, 'SKU-4', null, null, { sourceKind: 'catalog_product', sourceProductHash: 'p4' });
    // Seed evidence whose metadata + snippet carry credential shapes.
    getDb().run(
      `INSERT INTO classification_evidence
       (id, run_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        run.id,
        'SKU-4',
        'evidence_extraction',
        'official_product_page',
        'medium',
        'flavor',
        'https://example.com/',
        'llm_flavor',
        'Authorization: Bearer sk-live-abcdef SecretKeyHere',
        JSON.stringify('Chicken'),
        JSON.stringify({ api_key: 'supersecret', token: 'tok_123', provenance: 'llm' }),
        new Date().toISOString(),
      ],
    );
    const res = await makeApp().request(`/api/classification/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('sk-live');
    expect(serialized).not.toContain('supersecret');
    expect(serialized).toContain('[REDACTED]');
  });

  it('computes real config/source drift flags instead of hard-coded false (pass 4b)', async () => {
    // Config drift: a configSnapshotHash that cannot match the current config
    // authority resolves to drift (unknown snapshot hash fails closed).
    const run = createRun(wsA.id, 'SKU-5', null, 'ff'.repeat(32), { sourceKind: 'catalog_product', sourceProductHash: 'p5' });
    // Complete the run so the source-drift branch evaluates (it only runs for
    // completed runs).
    const { completeRun } = await import('../../db/repositories/classification-run-repo');
    completeRun(run.id, 'completed');
    // Source drift: write a product file whose hash differs from the run's
    // recorded sourceProductHash.
    fs.mkdirSync(path.join(wsA.path, 'products'), { recursive: true });
    fs.writeFileSync(
      path.join(wsA.path, 'products', 'SKU-5.json'),
      JSON.stringify({ sku: 'SKU-5', name: 'Changed Product', shopsite: {}, fields: {} }),
      'utf-8',
    );
    const res = await makeApp().request(`/api/classification/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drift.configDrift).toBe(true);
    expect(body.drift.sourceDrift).toBe(true);
  });

  it('reports sourceDrift=true for a completed run whose recorded source file has disappeared (pass 4c)', async () => {
    const run = createRun(wsA.id, 'SKU-MISSING-SRC', null, null, { sourceKind: 'catalog_product', sourceProductHash: 'p-missing' });
    const { completeRun } = await import('../../db/repositories/classification-run-repo');
    completeRun(run.id, 'completed');
    // The product file was never written (or was removed): readProductFile
    // returns null, which IS drift for a completed run.
    const res = await makeApp().request(`/api/classification/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drift.sourceDrift).toBe(true);
  });

  it('drops credential-shaped OBJECT KEYS (sk-*, bearer) from the run-detail body (pass 4c)', async () => {
    const run = createRun(wsA.id, 'SKU-6', null, null, { sourceKind: 'catalog_product', sourceProductHash: 'p6' });
    // Seed evidence metadata with credential-shaped KEYS (sk-live-abcdef,
    // bearer header, secretKey) — these must be absent from the body.
    getDb().run(
      `INSERT INTO classification_evidence
       (id, run_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        run.id,
        'SKU-6',
        'evidence_extraction',
        'official_product_page',
        'medium',
        'flavor',
        'https://example.com/',
        'llm_flavor',
        'plain snippet',
        JSON.stringify('Chicken'),
        JSON.stringify({ 'sk-live-abcdef': 'secret-material', bearer: 'Bearer tok', secretKey: 'x', provenance: 'llm' }),
        new Date().toISOString(),
      ],
    );
    const res = await makeApp().request(`/api/classification/runs/${run.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('sk-live-abcdef');
    expect(serialized).not.toContain('secret-material');
    expect(serialized).not.toContain('secretKey');
    expect(serialized).not.toContain('Bearer tok');
    // The non-secret key survives.
    expect(serialized).toContain('provenance');
  });
});

// Helper: update the run row's config_snapshot_hash so the route resolves the
// persisted runtime snapshot summary.
import { getDb } from '../../db/connection';
function getDbRunSetSnapshotHash(runId: string, hash: string): void {
  getDb().run('UPDATE classification_runs SET config_snapshot_hash = ? WHERE id = ?', [hash, runId]);
}
