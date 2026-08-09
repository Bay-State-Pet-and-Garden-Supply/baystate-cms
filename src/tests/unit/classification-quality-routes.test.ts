import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun, completeRun } from '../../db/repositories/classification-run-repo';
import { insertModelCallStart, completeModelCall } from '../../db/repositories/classification-model-call-repo';
import { MODEL_CALL_STATUS, COST_BASIS } from '../../classification/model-operation-registry';
import { QualityReportSchema } from '../../shared/schemas/classification-metrics';
import classificationRoutes from '../../server/routes/classification-routes';
import { buildQualityReport } from '../../db/repositories/classification-metrics-repo';

const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);
const PLAN = 'plan'.padEnd(64, 'x');
const RULES = 'rules'.padEnd(64, 'x');

// Windows are relative to the real clock so seeded runs (started_at = now)
// always fall inside the report window regardless of the environment date.
const NOW = new Date();
const WIN_START = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
const WIN_END = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

let wsId: string;
let wsPath: string;

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', classificationRoutes);
  return app;
}

/** Insert a v2 runtime snapshot (digests + enabled targets) under a hash. */
function seedSnapshot(hash: string, enabled = true, snapshotWsId = wsId): void {
  const now = new Date().toISOString();
  const snapshot = {
    schemaVersion: 2,
    snapshotHash: hash,
    createdAt: now,
    workspaceId: snapshotWsId,
    workspacePath: wsPath,
    productSku: 'SKU',
    configAuthorityKind: 'v2' as const,
    sourceCatalogCommit: null,
    config: {
      manifest: { schemaVersion: 2, bundleHash: hash, fileVersions: {}, createdAt: now, updatedAt: now, activeRevision: '1' },
      productTypes: [],
      attributes: [],
      attributeProfiles: [],
      attributeMappings: [],
      curationTargets: [
        {
          id: 'primary-product-type',
          kind: 'product_type',
          label: 'Primary Product Type',
          enabled,
          mandatory: false,
          selectionMode: 'single',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
      ],
      brands: [],
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: 'qwen2.5vl:latest', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only', mlFeatures: {} },
      dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
    },
    configSnapshotRef: { id: 'x', hash, sourceCommit: null, createdAt: now },
    focusedFileHashes: {},
    catalogEvidenceHash: null,
    modelExecutionPlan: {
      version: 1,
      registryVersion: 1,
      entries: [],
      digest: PLAN,
    },
    runtimeRuleVersions: {
      version: 1,
      registryVersion: 1,
      promptTemplateVersions: {},
      ruleVersions: {},
      outputPolicyVersion: '1',
      digest: RULES,
    },
  };
  getDb().run(
    'INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, config_json, created_at) VALUES (?, ?, ?, ?, ?)',
    [randomUUID(), wsId, hash, JSON.stringify(snapshot), now],
  );
}

function seedProposal(runId: string, proposalId: string, opts: { type?: string; confidence?: number; support?: string[]; contradict?: string[] } = {}): void {
  const db = getDb();
  db.run(
    `INSERT INTO classification_proposals
     (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status,
      is_bulk_acceptable, is_stale, config_snapshot_hash, supporting_evidence_ids_json,
      contradicting_evidence_ids_json, model_call_ids_json, created_at)
     VALUES (?, ?, 'SKU', ?, NULL, '"v"', ?, 'pending', 0, 0, ?, ?, ?, NULL, ?)`,
    [
      proposalId, runId, opts.type ?? 'primary_product_type', opts.confidence ?? 0.9, HASH,
      JSON.stringify(opts.support ?? []), JSON.stringify(opts.contradict ?? []), new Date().toISOString(),
    ],
  );
}

function seedDecision(proposalId: string, decision: 'accepted' | 'rejected' | 'deferred', opts: { revised?: boolean; evidenceIds?: string[] } = {}): void {
  const db = getDb();
  const decisionId = randomUUID();
  db.run(
    `INSERT INTO classification_proposal_decisions
     (id, proposal_id, decision, revised_value_json, has_revised_target, superseded_at, created_at)
     VALUES (?, ?, ?, ?, 0, NULL, ?)`,
    [decisionId, proposalId, decision, opts.revised ? '"revised"' : null, new Date().toISOString()],
  );
  for (const eid of opts.evidenceIds ?? []) {
    db.run(
      'INSERT INTO classification_proposal_decision_evidence (decision_id, evidence_id) VALUES (?, ?)',
      [decisionId, eid],
    );
  }
}

function tableSnapshotChecksum(): string {
  const db = getDb();
  const rows = db.query(
    `SELECT 'runs:' || COUNT(*) FROM classification_runs
     UNION ALL SELECT 'proposals:' || COUNT(*) FROM classification_proposals
     UNION ALL SELECT 'decisions:' || COUNT(*) FROM classification_proposal_decisions
     UNION ALL SELECT 'calls:' || COUNT(*) FROM classification_model_calls
     UNION ALL SELECT 'cit:' || COUNT(*) FROM classification_proposal_decision_evidence
     UNION ALL SELECT 'snaps:' || COUNT(*) FROM classification_config_snapshots`,
  ).all() as Array<{ [k: string]: string }>;
  return rows.map(r => Object.values(r)[0]).sort().join('|');
}

describe('GET /api/classification/quality-report (issue #17 F)', () => {
  beforeAll(() => {
    wsId = randomUUID();
    wsPath = path.join(os.tmpdir(), `baystate-cms-quality-routes-${wsId.slice(0, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({ id: wsId, name: 'ws-a', workspacePath: wsPath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  });

  it('rejects invalid, reversed, and over-cap ranges', async () => {
    const app = makeApp();
    const invalid = await app.request('/api/classification/quality-report?start=not-a-date&end=2026-08-08T00:00:00.000Z');
    expect(invalid.status).toBe(400);
    const reversed = await app.request('/api/classification/quality-report?start=2026-08-08T00:00:00.000Z&end=2026-08-01T00:00:00.000Z');
    expect(reversed.status).toBe(400);
    const overCap = await app.request('/api/classification/quality-report?start=2026-01-01T00:00:00.000Z&end=2026-08-08T00:00:00.000Z');
    expect(overCap.status).toBe(400);
  });

  it('returns a schema-valid empty report when no data exists', async () => {
    const res = await makeApp().request('/api/classification/quality-report?start=2026-08-01T00:00:00.000Z&end=2026-08-08T00:00:00.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = QualityReportSchema.safeParse(body.report);
    expect(parsed.success).toBe(true);
    expect(body.report.groups).toHaveLength(0);
    expect(body.report.sampleCounts.runs).toBe(0);
  });

  it('produces a deterministic, schema-valid report over seeded data (read-only)', async () => {
    const now = '2026-08-02T00:00:00.000Z';
    seedSnapshot(HASH);
    seedSnapshot(HASH2, false); // disabled target — run group not coverage-eligible

    const run1 = createRun(wsId, 'SKU', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p1' });
    const run2 = createRun(wsId, 'SKU-2', null, HASH2, { sourceKind: 'onboarding', sourceProductHash: 'p2' });
    completeRun(run1.id, 'completed');
    completeRun(run2.id, 'completed');

    seedProposal(run1.id, 'pp-1', { type: 'primary_product_type', confidence: 0.9, support: ['e1'] });
    seedProposal(run1.id, 'fa-1', { type: 'field_assignment', confidence: 0.6, contradict: ['e2'] });
    seedDecision('pp-1', 'accepted');
    seedDecision('fa-1', 'rejected');

    const callId = insertModelCallStart({
      runId: run1.id,
      stageName: 'product_attribute_proposals',
      operation: 'attribute_ranking',
      attempt: 1,
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      locality: 'local',
      snapshotHash: HASH,
      modelPolicyDigest: 'd'.repeat(64),
      promptTemplateVersion: 'attribute-ranking-prompt-v1',
      ruleVersion: 'attribute-ranking-rules-v1',
      systemPromptHash: 's'.repeat(64),
      userPromptHash: 'u'.repeat(64),
    });
    completeModelCall(callId, {
      status: MODEL_CALL_STATUS.success,
      durationMs: 120,
      promptTokens: 100,
      completionTokens: 40,
      estimatedCostUsd: 0,
      costBasis: COST_BASIS.localZero,
    });

    const beforeChecksum = tableSnapshotChecksum();
    const start = WIN_START;
    const end = WIN_END;

    const res1 = await makeApp().request(`/api/classification/quality-report?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    const parsed = QualityReportSchema.safeParse(body1.report);
    expect(parsed.success).toBe(true);

    // Determinism: second request yields an identical report modulo the
    // generation-time stamp (generatedAt is per-request; metrics are fixed).
    const res2 = await makeApp().request(`/api/classification/quality-report?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    const body2 = await res2.json();
    const stripGenerated = (r: any) => {
      const { generatedAt: _g, ...rest } = r;
      return rest;
    };
    expect(stripGenerated(body1.report)).toEqual(stripGenerated(body2.report));

    // Read-only: no row changed.
    expect(tableSnapshotChecksum()).toBe(beforeChecksum);

    // Groups: run1 (enabled snapshot) and run2 (disabled snapshot) split.
    expect(body1.report.sampleCounts.runs).toBe(2);
    const groupForHash = body1.report.groups.find((g: any) => g.configSnapshotHash === HASH);
    expect(groupForHash).toBeDefined();
    expect(groupForHash.modelPlanDigest).toBe(PLAN);
    expect(groupForHash.ruleVersionsDigest).toBe(RULES);
    expect(groupForHash.sourceKind).toBe('catalog_product');
    expect(groupForHash.reviewAgreement.precision).toBe(0.5); // 1 unchanged / (1 + 1)
    expect(groupForHash.coverage.eligibleRuns).toBe(1);
    expect(groupForHash.coverage.value).toBe(1);
    expect(groupForHash.grounding.supportingCitationCoverage).toBe(0.5); // 1 of 2 non-abstention
    expect(groupForHash.calibration.sampleCount).toBe(2);
    expect(groupForHash.latency.runSampleCount).toBe(1);
    expect(groupForHash.cost.totalKnownUsd).toBe(0);
    expect(groupForHash.modelRoutes).toEqual([{ provider: 'ollama', model: 'qwen2.5vl:latest', count: 1 }]);

    // run2 group: disabled target → coverage null.
    const groupForHash2 = body1.report.groups.find((g: any) => g.configSnapshotHash === HASH2);
    expect(groupForHash2).toBeDefined();
    expect(groupForHash2.coverage.value).toBeNull();
    expect(groupForHash2.coverage.eligibleRuns).toBe(0);
  });

  it('is workspace-scoped: foreign-workspace data is excluded', async () => {
    const foreignWsId = randomUUID();
    const foreignHash = 'f'.repeat(64);
    insertWorkspace({ id: foreignWsId, name: 'ws-foreign', workspacePath: '/tmp/foreign', gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
    seedSnapshot(foreignHash);
    const foreignRun = createRun(foreignWsId, 'FOREIGN-SKU', null, foreignHash, { sourceKind: 'catalog_product', sourceProductHash: 'pf' });
    completeRun(foreignRun.id, 'completed');

    const start = WIN_START;
    const end = WIN_END;
    const report = buildQualityReport(wsId, start, end, '2026-08-08T00:00:01.000Z');
    expect(report.sampleCounts.runs).toBe(2); // only the two ws-a runs seeded earlier
    expect(report.groups.every(g => g.configSnapshotHash === HASH || g.configSnapshotHash === HASH2)).toBe(true);
  });

  it('buildQualityReport validates and returns a schema-valid report', async () => {
    const start = WIN_START;
    const end = WIN_END;
    const report = buildQualityReport(wsId, start, end, '2026-08-08T00:00:01.000Z');
    const parsed = QualityReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
    expect(report.generatedAt).toBe('2026-08-08T00:00:01.000Z');
  });

  it('returns 400 (never 500) for an unparseable end with an omitted start (blocker 3)', async () => {
    const res = await makeApp().request('/api/classification/quality-report?end=not-a-date');
    expect(res.status).toBe(400);
  });

  it('normalizes date-only inputs to a schema-valid report (never 500) (blocker 4)', async () => {
    // Both parse permissively but are schema-invalid as raw ISO datetimes.
    const res = await makeApp().request('/api/classification/quality-report?start=2026-08-01&end=2026-08-02');
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = QualityReportSchema.safeParse(body.report);
    expect(parsed.success).toBe(true);
  });

  it('uses the latest live decision per proposal regardless of insertion order (blocker 5)', async () => {
    const db = getDb();
    // Isolated workspace so earlier seeded runs do not pollute the aggregates.
    const orderWsId = randomUUID();
    const orderHash = 'c'.repeat(64);
    insertWorkspace({ id: orderWsId, name: 'ws-order', workspacePath: '/tmp/order', gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
    seedSnapshot(orderHash, true, orderWsId);
    const run = createRun(orderWsId, 'SKU-ORDER', null, orderHash, { sourceKind: 'catalog_product', sourceProductHash: 'po' });
    completeRun(run.id, 'completed');
    seedProposal(run.id, 'pp-order', { type: 'primary_product_type', confidence: 0.9 });
    seedProposal(run.id, 'pp-order-2', { type: 'primary_product_type', confidence: 0.8 });

    const insertDecision = (proposalId: string, decision: string, createdAt: string) => {
      db.run(
        `INSERT INTO classification_proposal_decisions
         (id, proposal_id, decision, revised_value_json, has_revised_target, superseded_at, created_at)
         VALUES (?, ?, ?, NULL, 0, NULL, ?)`,
        [randomUUID(), proposalId, decision, createdAt],
      );
    };
    // pp-order: OLDER accepted inserted first, NEWER rejected second → newer wins.
    const older = new Date(NOW.getTime() - 2 * 60 * 1000).toISOString();
    const newer = new Date(NOW.getTime() - 1 * 60 * 1000).toISOString();
    insertDecision('pp-order', 'accepted', older);
    insertDecision('pp-order', 'rejected', newer);
    // pp-order-2: NEWER rejected inserted first, OLDER accepted second → newer wins.
    insertDecision('pp-order-2', 'rejected', newer);
    insertDecision('pp-order-2', 'accepted', older);

    const report = buildQualityReport(orderWsId, WIN_START, WIN_END, '2026-08-08T00:00:01.000Z');
    const group = report.groups.find(g => g.configSnapshotHash === orderHash);
    expect(group).toBeDefined();
    // Both proposals: the latest live decision (00:00:03) is 'rejected' —
    // insertion order must not change which decision is counted.
    expect(group!.reviewAgreement.rejected).toBe(2);
    expect(group!.reviewAgreement.acceptedUnchanged).toBe(0);
  });
});
