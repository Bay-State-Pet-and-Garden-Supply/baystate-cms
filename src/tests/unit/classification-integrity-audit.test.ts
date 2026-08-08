import { describe, expect, it, beforeEach } from 'vitest';
import { Database } from '../../db/driver';
import {
  auditClassificationIntegrity,
  repairClassificationIntegrity,
} from '../../classification/integrity-audit';

describe('Classification Integrity Audit & Repair (Issue #16)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = OFF;');

    db.exec(`
      CREATE TABLE classification_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        product_sku TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE classification_proposals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        product_sku TEXT NOT NULL,
        proposal_type TEXT NOT NULL
      );

      CREATE TABLE classification_stage_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stage_name TEXT NOT NULL
      );

      CREATE TABLE classification_evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source_kind TEXT NOT NULL
      );

      CREATE TABLE classification_proposal_decisions (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        decision TEXT NOT NULL
      );
    `);
  });

  it('detects clean database state', () => {
    db.run(`INSERT INTO classification_runs VALUES ('run-1', 'ws-1', 'SKU-1', 'completed')`);
    db.run(`INSERT INTO classification_proposals VALUES ('prop-1', 'run-1', 'SKU-1', 'category_page')`);
    db.run(`INSERT INTO classification_stage_results VALUES ('stage-1', 'run-1', 'evidence_extraction')`);
    db.run(`INSERT INTO classification_evidence VALUES ('ev-1', 'run-1', 'catalog_product')`);
    db.run(`INSERT INTO classification_proposal_decisions VALUES ('dec-1', 'prop-1', 'accepted')`);

    const audit = auditClassificationIntegrity(db);
    expect(audit.isClean).toBe(true);
    expect(audit.orphanProposals).toBe(0);
    expect(audit.orphanStageResults).toBe(0);
    expect(audit.orphanEvidence).toBe(0);
    expect(audit.orphanProposalDecisions).toBe(0);
  });

  it('detects orphan rows across relations', () => {
    db.run(`INSERT INTO classification_stage_results VALUES ('stage-orphan', 'run-ghost', 'evidence_extraction')`);
    db.run(`INSERT INTO classification_evidence VALUES ('ev-orphan', 'run-ghost', 'catalog_product')`);
    db.run(`INSERT INTO classification_proposals VALUES ('prop-orphan', 'run-ghost', 'SKU-1', 'category_page')`);
    db.run(`INSERT INTO classification_proposal_decisions VALUES ('dec-orphan', 'prop-ghost', 'accepted')`);

    const audit = auditClassificationIntegrity(db);
    expect(audit.isClean).toBe(false);
    expect(audit.orphanStageResults).toBe(1);
    expect(audit.orphanEvidence).toBe(1);
    expect(audit.orphanProposals).toBe(1);
    expect(audit.orphanProposalDecisions).toBe(1);
  });

  it('executes dry-run repair without mutating database', () => {
    db.run(`INSERT INTO classification_proposals VALUES ('prop-orphan', 'run-ghost', 'SKU-1', 'category_page')`);

    const repair = repairClassificationIntegrity(db, { dryRun: true });
    expect(repair.dryRun).toBe(true);
    expect(repair.preAudit.orphanProposals).toBe(1);

    const check = auditClassificationIntegrity(db);
    expect(check.orphanProposals).toBe(1);
  });

  it('repairs orphan records transactionally and returns clean state', () => {
    db.run(`INSERT INTO classification_runs VALUES ('run-valid', 'ws-1', 'SKU-1', 'completed')`);
    db.run(`INSERT INTO classification_proposals VALUES ('prop-valid', 'run-valid', 'SKU-1', 'category_page')`);

    db.run(`INSERT INTO classification_stage_results VALUES ('stage-orphan', 'run-ghost', 'evidence_extraction')`);
    db.run(`INSERT INTO classification_evidence VALUES ('ev-orphan', 'run-ghost', 'catalog_product')`);
    db.run(`INSERT INTO classification_proposals VALUES ('prop-orphan', 'run-ghost', 'SKU-1', 'category_page')`);
    db.run(`INSERT INTO classification_proposal_decisions VALUES ('dec-orphan', 'prop-ghost', 'accepted')`);

    const repair = repairClassificationIntegrity(db, { dryRun: false });
    expect(repair.dryRun).toBe(false);
    expect(repair.preAudit.isClean).toBe(false);
    expect(repair.postAudit.isClean).toBe(true);
  });
});
