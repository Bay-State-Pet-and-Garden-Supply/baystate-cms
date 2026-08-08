import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun, insertDecisionRow, supersedeDecisionsForProposals } from '../../db/repositories/classification-run-repo';
import {
  collectReviewedFacts,
  isFactCompatible,
  filterCompatibleFacts,
} from '../../classification/reviewed-facts';

const workspaceId = 'ws-reviewed-facts-test';

function insertProposal(runId: string, sku: string, proposalId: string, proposalType = 'field_assignment', value = '"Chicken"', targetId: string | null = 'flavor'): void {
  getDb().run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [proposalId, runId, sku, proposalType, targetId, value, 0.8, new Date().toISOString()],
  );
}

function submitDecision(proposalId: string, decision: 'accepted' | 'rejected' | 'deferred', options: { id: string }): void {
  insertDecisionRow(getDb(), {
    id: options.id,
    proposalId,
    decision,
    createdAt: new Date().toISOString(),
  });
}

describe('reviewed facts', () => {
  beforeEach(() => {
    const wsPath = path.join(os.tmpdir(), `reviewed-facts-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
  });

  it('collects facts only from accepted, live decisions — never pending or superseded', () => {
    const sku = 'SKU-001';
    const run = createRun(workspaceId, sku, null, 'config-hash-1', {
      sourceKind: 'catalog_product',
      sourceProductHash: 'src-hash-1',
    });

    insertProposal(run.id, sku, 'prop-accepted');
    insertProposal(run.id, sku, 'prop-pending');
    insertProposal(run.id, sku, 'prop-superseded');

    submitDecision('prop-accepted', 'accepted', { id: 'decision-accepted' });
    // Insert a live decision, then supersede it: audit history remains but the
    // fact must no longer be collected.
    insertDecisionRow(getDb(), { id: 'decision-superseded', proposalId: 'prop-superseded', decision: 'accepted', createdAt: new Date().toISOString() });
    supersedeDecisionsForProposals(['prop-superseded']);
    // Leave prop-pending untouched.

    const facts = collectReviewedFacts({ workspaceId, productSku: sku });

    const ids = facts.map(fact => fact.proposalId);
    expect(ids).toContain('prop-accepted');
    expect(ids).not.toContain('prop-pending');
    expect(ids).not.toContain('prop-superseded');
  });

  it('preserves decision/run/config/source provenance on every fact', () => {
    const sku = 'SKU-002';
    const run = createRun(workspaceId, sku, null, 'config-hash-2', {
      sourceKind: 'catalog_product',
      sourceProductHash: 'src-hash-2',
    });
    insertProposal(run.id, sku, 'prop-1', 'field_assignment', '"Beef"', 'flavor');
    submitDecision('prop-1', 'accepted', { id: 'decision-1' });

    const facts = collectReviewedFacts({ workspaceId, productSku: sku });
    expect(facts).toHaveLength(1);
    const fact = facts[0];
    expect(fact.proposalId).toBe('prop-1');
    expect(fact.decisionId).toBe('decision-1');
    expect(fact.runId).toBe(run.id);
    expect(fact.workspaceId).toBe(workspaceId);
    expect(fact.productSku).toBe(sku);
    expect(fact.targetId).toBe('flavor');
    expect(fact.value).toBe('Beef');
    expect(fact.configSnapshotHash).toBe('config-hash-2');
    expect(fact.sourceHash).toBe('src-hash-2');
  });

  it('uses revised values and targets from the latest live decision', () => {
    const sku = 'SKU-003';
    const run = createRun(workspaceId, sku, null, 'config-hash-3', {
      sourceKind: 'catalog_product',
      sourceProductHash: 'src-hash-3',
    });
    insertProposal(run.id, sku, 'prop-2', 'field_assignment', '"Original"', 'flavor');
    insertDecisionRow(getDb(), {
      id: 'decision-revised',
      proposalId: 'prop-2',
      decision: 'accepted',
      revisedValue: 'Salmon',
      revisedTargetId: 'food-form',
      createdAt: new Date().toISOString(),
    });

    const facts = collectReviewedFacts({ workspaceId, productSku: sku });
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe('Salmon');
    expect(facts[0].targetId).toBe('food-form');
  });

  it('isFactCompatible requires config AND source hash to match the current snapshot', () => {
    const fact = {
      proposalId: 'p',
      decisionId: 'd',
      runId: 'r',
      workspaceId,
      productSku: 'SKU',
      proposalType: 'field_assignment',
      targetId: 'flavor',
      value: 'Chicken',
      configSnapshotHash: 'config-hash-1',
      sourceHash: 'src-hash-1',
      createdAt: '2026-08-01T00:00:00.000Z',
    };

    expect(isFactCompatible(fact, 'config-hash-1', 'src-hash-1')).toBe(true);
    expect(isFactCompatible(fact, 'config-hash-2', 'src-hash-1')).toBe(false);
    expect(isFactCompatible(fact, 'config-hash-1', 'src-hash-2')).toBe(false);
  });

  it('filterCompatibleFacts drops drifted facts instead of silently reusing them', () => {
    const base = {
      proposalId: 'p',
      decisionId: 'd',
      runId: 'r',
      workspaceId,
      productSku: 'SKU',
      proposalType: 'field_assignment',
      targetId: 'flavor',
      value: 'Chicken',
      configSnapshotHash: 'config-hash-1',
      sourceHash: 'src-hash-1',
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const compatible = { ...base };
    const driftedConfig = { ...base, proposalId: 'p2', configSnapshotHash: 'config-hash-OLD' };
    const driftedSource = { ...base, proposalId: 'p3', sourceHash: 'src-hash-OLD' };

    const kept = filterCompatibleFacts([compatible, driftedConfig, driftedSource], 'config-hash-1', 'src-hash-1');
    expect(kept.map(fact => fact.proposalId)).toEqual(['p']);
  });

  it('returns no facts for a product with no accepted decisions', () => {
    const sku = 'SKU-EMPTY';
    const run = createRun(workspaceId, sku, null, 'config-hash-4', { sourceKind: 'catalog_product', sourceProductHash: 'src-hash-4' });
    insertProposal(run.id, sku, 'prop-pending-only');
    expect(collectReviewedFacts({ workspaceId, productSku: sku })).toHaveLength(0);
  });
});
