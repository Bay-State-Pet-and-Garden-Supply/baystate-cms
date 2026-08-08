import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { createRun, completeRun } from '../../db/repositories/classification-run-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import onboardingRoutes from '../../server/routes/onboarding-routes';

const workspaceId = 'ws-onboarding-decision-routes';
const tempPaths: string[] = [];

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingRoutes);
  return app;
}

function seedReviewItem(sku = 'SKU-ROUTE-1') {
  const db = getDb();
  const batch = createBatch({
    workspaceId,
    name: 'Decision route test',
    fileName: 'test.csv',
    totalItems: 1,
  });
  const [item] = insertItems(batch.id, [{ upc: sku, name: 'Original item', rowNumber: 1 }]);
  const run = createRun(workspaceId, sku, null, 'snapshot-hash', {
    onboardingItemId: item.id,
    sourceKind: 'onboarding',
  });
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO classification_evidence
     (id, run_id, onboarding_item_id, product_sku, stage_name, source, reliability,
      source_field, snippet, value_json, created_at)
     VALUES (?, ?, ?, ?, 'evidence_extraction', 'official_product_page', 'high', ?, ?, ?, ?)`,
    ['evidence-canonical', run.id, item.id, sku, 'title', 'Canonical evidence', '"Canonical evidence"', now],
  );
  db.run(
    `INSERT INTO classification_proposals
     (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
      confidence, status, is_bulk_acceptable, is_stale, created_at)
     VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', 0, 0, ?)`,
    ['proposal-canonical', run.id, sku, now],
  );
  completeRun(run.id, 'completed');

  db.run(
    `UPDATE onboarding_items
     SET stage = 'review', stage_status = 'completed', curation_data_json = ?
     WHERE id = ?`,
    [JSON.stringify({
      curatedTitle: 'Stored title',
      packagingOcrTitle: null,
      titleSource: 'web',
      suggestedPages: [],
      suggestedProductType: null,
      classificationRunId: run.id,
      classificationProposals: [{ id: 'stale-proposal-copy' }],
      classificationEvidence: [{ id: 'stale-evidence-copy' }],
    }), item.id],
  );

  return { itemId: item.id, runId: run.id, sku, batchId: batch.id };
}

beforeEach(() => {
  try { resetDb(); } catch { /* first test */ }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-decision-routes-'));
  tempPaths.push(root);
  const dbPath = path.join(root, 'app.db');
  initDb(dbPath);
  runMigrations();
  const now = new Date().toISOString();
  insertWorkspace({
    id: workspaceId,
    name: 'Route test workspace',
    workspacePath: root,
    gitPath: path.join(root, '.git'),
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'complete',
    baselineCommit: 'baseline',
  });
});

afterAll(() => {
  closeDb();
  for (const tempPath of tempPaths) fs.rmSync(tempPath, { recursive: true, force: true });
});

describe('onboarding decision routes', () => {
  it('hydrates canonical proposals and evidence from the active run', async () => {
    const seeded = seedReviewItem();
    const response = await makeApp().request(`/api/onboarding/items/${seeded.itemId}`);

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.item.curationData.classificationProposals).toHaveLength(1);
    expect(body.item.curationData.classificationProposals[0]).toMatchObject({
      id: 'proposal-canonical',
      proposedValue: 'Chicken',
      currentDecisionId: null,
    });
    expect(body.item.curationData.classificationEvidence).toHaveLength(1);
    expect(body.item.curationData.classificationEvidence[0]).toMatchObject({
      id: 'evidence-canonical',
      snippet: 'Canonical evidence',
    });
  });

  it('protects canonical arrays and active run from stale generic item updates', async () => {
    const seeded = seedReviewItem();
    const response = await makeApp().request(`/api/onboarding/items/${seeded.itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        curation_data: {
          curatedTitle: 'Reviewer title',
          classificationRunId: 'stale-run',
          classificationProposals: [{ id: 'client-overwrite' }],
          classificationEvidence: [{ id: 'client-overwrite' }],
        },
      }),
    });

    expect(response.status).toBe(200);
    const row = getDb().query('SELECT curation_data_json FROM onboarding_items WHERE id = ?')
      .get(seeded.itemId) as { curation_data_json: string };
    const saved = JSON.parse(row.curation_data_json);
    expect(saved.curatedTitle).toBe('Reviewer title');
    expect(saved.classificationRunId).toBe(seeded.runId);
    expect(saved.classificationProposals.map((entry: any) => entry.id)).toEqual(['proposal-canonical']);
    expect(saved.classificationEvidence.map((entry: any) => entry.id)).toEqual(['evidence-canonical']);
  });

  it('does not hydrate a foreign persisted run and strips no-run poisoning attempts', async () => {
    const seeded = seedReviewItem('SKU-OWNER-A');
    const secondBatch = createBatch({
      workspaceId,
      name: 'Foreign hydration item',
      fileName: 'foreign.csv',
      totalItems: 1,
    });
    const [foreignItem] = insertItems(secondBatch.id, [{
      upc: 'SKU-OWNER-B',
      name: 'Foreign item',
      rowNumber: 1,
    }]);
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({
        curatedTitle: 'Foreign item',
        classificationRunId: seeded.runId,
        classificationProposals: [{ id: 'poisoned-copy' }],
        classificationEvidence: [{ id: 'poisoned-copy' }],
      }), foreignItem.id],
    );

    const detail = await makeApp().request(`/api/onboarding/items/${foreignItem.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as any;
    expect(detailBody.item.curationData.classificationRunId).toBeUndefined();
    expect(detailBody.item.curationData.classificationProposals).toBeUndefined();
    expect(detailBody.item.curationData.classificationEvidence).toBeUndefined();

    const noRunBatch = createBatch({
      workspaceId,
      name: 'No run item',
      fileName: 'no-run.csv',
      totalItems: 1,
    });
    const [noRunItem] = insertItems(noRunBatch.id, [{ upc: 'SKU-NO-RUN', name: 'No run', rowNumber: 1 }]);
    const update = await makeApp().request(`/api/onboarding/items/${noRunItem.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curation_data: {
        curatedTitle: 'Safe title',
        classificationRunId: seeded.runId,
        classificationProposals: [{ id: 'client-proposal' }],
        classificationEvidence: [{ id: 'client-evidence' }],
        classificationDecisions: [{ id: 'client-decision' }],
        classificationHistory: [{ id: 'client-history' }],
      } }),
    });
    expect(update.status).toBe(200);
    const savedRow = getDb().query('SELECT curation_data_json FROM onboarding_items WHERE id = ?')
      .get(noRunItem.id) as { curation_data_json: string };
    const saved = JSON.parse(savedRow.curation_data_json);
    expect(saved.curatedTitle).toBe('Safe title');
    expect(saved).not.toHaveProperty('classificationRunId');
    expect(saved).not.toHaveProperty('classificationProposals');
    expect(saved).not.toHaveProperty('classificationEvidence');
    expect(saved).not.toHaveProperty('classificationDecisions');
    expect(saved).not.toHaveProperty('classificationHistory');
  });

  it('rejects a proposal whose independent SKU disagrees with its run', async () => {
    const seeded = seedReviewItem('SKU-PROPOSAL-OWNER');
    getDb().run(
      'UPDATE classification_proposals SET product_sku = ? WHERE id = ?',
      ['SKU-CORRUPTED', 'proposal-canonical'],
    );

    const response = await makeApp().request(`/api/onboarding/items/${seeded.itemId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions: [{
        proposalId: 'proposal-canonical',
        decision: 'accepted',
        actionToken: 'corrupt-proposal-token',
        expectedRevisionId: null,
      }] }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.code).toBe('invalid_proposals');
    const count = getDb().query(
      'SELECT COUNT(*) AS count FROM classification_proposal_decisions WHERE proposal_id = ?',
    ).get('proposal-canonical') as { count: number };
    expect(count.count).toBe(0);
  });

  it('rejects mixed canonical and deprecated predecessor aliases', async () => {
    const seeded = seedReviewItem('SKU-ALIASES');
    const response = await makeApp().request(`/api/onboarding/items/${seeded.itemId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions: [{
        proposalId: 'proposal-canonical',
        decision: 'accepted',
        expectedRevisionId: null,
        revisedFromId: 'legacy-predecessor',
      }] }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('keeps predictions immutable and makes exact action-token retries idempotent', async () => {
    const seeded = seedReviewItem();
    const payload = {
      decisions: [{
        id: 'decision-route-1',
        proposalId: 'proposal-canonical',
        decision: 'accepted',
        revisedValue: 'Beef',
        actionToken: 'route-token-1',
        expectedRevisionId: null,
      }],
    };
    const app = makeApp();
    const first = await app.request(`/api/onboarding/items/${seeded.itemId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const retry = await app.request(`/api/onboarding/items/${seeded.itemId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    const firstBody = await first.json() as any;
    const retryBody = await retry.json() as any;
    expect(firstBody.decisions[0].id).toBe('decision-route-1');
    expect(retryBody.decisions[0].id).toBe('decision-route-1');

    const proposalRow = getDb().query(
      'SELECT proposed_value_json, target_id, status FROM classification_proposals WHERE id = ?',
    ).get('proposal-canonical') as { proposed_value_json: string; target_id: string; status: string };
    expect(proposalRow).toEqual({ proposed_value_json: '"Chicken"', target_id: 'flavor', status: 'accepted' });
    const decisionRows = getDb().query(
      'SELECT id, revised_value_json FROM classification_proposal_decisions WHERE proposal_id = ?',
    ).all('proposal-canonical') as Array<{ id: string; revised_value_json: string }>;
    expect(decisionRows).toEqual([{ id: 'decision-route-1', revised_value_json: '"Beef"' }]);
  });

  it('returns 409 without mutation for a stale predecessor', async () => {
    const seeded = seedReviewItem();
    const app = makeApp();
    const initial = await app.request(`/api/onboarding/items/${seeded.itemId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions: [{
        id: 'decision-current',
        proposalId: 'proposal-canonical',
        decision: 'accepted',
        actionToken: 'token-current',
        expectedRevisionId: null,
      }] }),
    });
    expect(initial.status).toBe(200);

    const conflict = await app.request(`/api/onboarding/items/${seeded.itemId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions: [{
        id: 'decision-stale',
        proposalId: 'proposal-canonical',
        decision: 'rejected',
        actionToken: 'token-stale',
        expectedRevisionId: 'not-the-live-decision',
      }] }),
    });

    expect(conflict.status).toBe(409);
    const body = await conflict.json() as any;
    expect(body.code).toBe('decision_conflict');
    const rows = getDb().query(
      'SELECT id, decision, superseded_at FROM classification_proposal_decisions WHERE proposal_id = ?',
    ).all('proposal-canonical') as Array<{ id: string; decision: string; superseded_at: string | null }>;
    expect(rows).toEqual([{ id: 'decision-current', decision: 'accepted', superseded_at: null }]);
  });

  it('fails closed when a run/proposal is presented through another onboarding item', async () => {
    const seeded = seedReviewItem('SKU-OWNER-1');
    const secondBatch = createBatch({
      workspaceId,
      name: 'Other item',
      fileName: 'other.csv',
      totalItems: 1,
    });
    const [otherItem] = insertItems(secondBatch.id, [{ upc: 'SKU-OWNER-2', name: 'Other', rowNumber: 1 }]);
    getDb().run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ classificationRunId: seeded.runId }), otherItem.id],
    );

    const response = await makeApp().request(`/api/onboarding/items/${otherItem.id}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions: [{
        proposalId: 'proposal-canonical',
        decision: 'accepted',
        actionToken: 'wrong-owner-token',
        expectedRevisionId: null,
      }] }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.code).toBe('sku_mismatch');
    const count = getDb().query(
      'SELECT COUNT(*) AS count FROM classification_proposal_decisions WHERE proposal_id = ?',
    ).get('proposal-canonical') as { count: number };
    expect(count.count).toBe(0);
  });
});
