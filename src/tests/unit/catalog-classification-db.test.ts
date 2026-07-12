import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun, completeRun } from '../../db/repositories/classification-run-repo';
import { getDb } from '../../db/connection';
import { submitProposalDecisions } from '../../classification/proposal-review-service';

const workspaceId = 'ws-catalog-class-db-test';

describe('proposal-review-service (catalog product)', () => {
  beforeEach(() => {
    // Fresh in-memory database before each test
    const wsPath = path.join(os.tmpdir(), `catalog-class-db-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.shopsite-cms'), { recursive: true });
    const dbPath = path.join(wsPath, '.shopsite-cms', 'app.db');
    initDb(dbPath);
    runMigrations();
  });

  it('rejects decisions for a non-existent run', () => {
    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: 'nonexistent',
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'p1', decision: 'accepted' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('run_not_found');
  });

  it('rejects decisions for a running run', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', '"test"', 0.8, 'pending', ?)`,
      ['proposal-1', run.id, 'SKU001', new Date().toISOString()],
    );

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'proposal-1', decision: 'accepted' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('run_not_completed');
  });

  it('accepts valid decisions for a completed catalog run', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', '"Beef"', 0.9, 'pending', ?)`,
      ['proposal-accept', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'proposal-accept', decision: 'accepted' }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0].decision).toBe('accepted');
    }
  });

  it('rejects workspace mismatch', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', '"test"', 0.8, 'pending', ?)`,
      ['proposal-ws', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId: 'wrong-ws',
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'proposal-ws', decision: 'accepted' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('workspace_mismatch');
  });

  it('rejects source kind mismatch', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'onboarding',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', '"test"', 0.8, 'pending', ?)`,
      ['proposal-sk', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'proposal-sk', decision: 'accepted' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('source_mismatch');
  });
});
