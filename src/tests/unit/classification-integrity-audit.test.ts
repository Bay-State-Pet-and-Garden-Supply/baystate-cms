import { describe, expect, it, beforeEach } from 'vitest';
import { Database } from '../../db/driver';
import {
  auditClassificationIntegrity,
  buildIntegrityManifest,
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
    expect(repair.wouldRepairProposals).toBe(1);
    expect(repair.repairedProposals).toBe(0);

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
    expect(repair.repairedStageResults).toBe(1);
    expect(repair.repairedEvidence).toBe(1);
    expect(repair.repairedProposals).toBe(1);
    expect(repair.repairedProposalDecisions).toBe(1);
  });
});

describe('Classification Integrity Audit & Repair extended (Issue #17 C1)', () => {
  let db: Database;

  /** Full fixture with real FK shapes for the allowlisted orphan classes. */
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE classification_runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, product_sku TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE classification_proposals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES classification_runs(id), product_sku TEXT NOT NULL, proposal_type TEXT NOT NULL);
      CREATE TABLE classification_stage_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES classification_runs(id), stage_name TEXT NOT NULL);
      CREATE TABLE classification_evidence (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES classification_runs(id), source_kind TEXT NOT NULL);
      CREATE TABLE classification_proposal_decisions (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES classification_proposals(id), decision TEXT NOT NULL);
      CREATE TABLE classification_proposal_evidence (proposal_id TEXT NOT NULL REFERENCES classification_proposals(id), evidence_id TEXT NOT NULL REFERENCES classification_evidence(id), relation TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY (proposal_id, evidence_id));
      CREATE TABLE classification_model_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES classification_runs(id), status TEXT NOT NULL, created_at TEXT);
      CREATE TABLE onboarding_items (id TEXT PRIMARY KEY, upc TEXT, existing_sku TEXT, curation_data_json TEXT, status TEXT NOT NULL DEFAULT 'imported');
      CREATE TABLE onboarding_sources (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES onboarding_items(id), url TEXT NOT NULL);
      CREATE TABLE onboarding_extractions (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES onboarding_items(id), kind TEXT NOT NULL);
      CREATE TABLE profile_generations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE profile_generation_revisions (id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES profile_generations(id), status TEXT NOT NULL);
    `);
    db.run(`INSERT INTO classification_runs VALUES ('run-1', 'ws-1', 'SKU-1', 'completed')`);
  });

  it('detects and repairs onboarding_sources orphans independently', () => {
    db.run(`INSERT INTO onboarding_items VALUES ('item-1', 'UPC1', NULL, NULL, 'imported')`);
    db.run(`INSERT INTO onboarding_sources VALUES ('src-orphan', 'item-ghost', 'https://x')`);
    db.run(`INSERT INTO onboarding_sources VALUES ('src-ok', 'item-1', 'https://y')`);

    let audit = auditClassificationIntegrity(db);
    expect(audit.orphanOnboardingSources).toBe(1);
    expect(audit.isClean).toBe(false);

    const repair = repairClassificationIntegrity(db, { dryRun: false });
    expect(repair.repairedOnboardingSources).toBe(1);
    expect(repair.postAudit.isClean).toBe(true);
    audit = auditClassificationIntegrity(db);
    expect(audit.orphanOnboardingSources).toBe(0);
    expect((db.query("SELECT COUNT(*) c FROM onboarding_sources WHERE id = 'src-ok'").get() as { c: number }).c).toBe(1);
  });

  it('detects and repairs onboarding_extractions orphans independently', () => {
    db.run(`INSERT INTO onboarding_items VALUES ('item-1', 'UPC1', NULL, NULL, 'imported')`);
    db.run(`INSERT INTO onboarding_extractions VALUES ('ext-orphan', 'item-ghost', 'product')`);
    db.run(`INSERT INTO onboarding_extractions VALUES ('ext-ok', 'item-1', 'product')`);

    const repair = repairClassificationIntegrity(db, { dryRun: false });
    expect(repair.repairedOnboardingExtractions).toBe(1);
    expect(repair.postAudit.isClean).toBe(true);
    expect((db.query("SELECT COUNT(*) c FROM onboarding_extractions WHERE id = 'ext-orphan'").get() as { c: number }).c).toBe(0);
  });

  it('detects and repairs profile_generation_revisions orphans independently', () => {
    db.run(`INSERT INTO profile_generations VALUES ('gen-1', 'g')`);
    db.run(`INSERT INTO profile_generation_revisions VALUES ('rev-orphan', 'gen-ghost', 'proposed')`);
    db.run(`INSERT INTO profile_generation_revisions VALUES ('rev-ok', 'gen-1', 'proposed')`);

    const repair = repairClassificationIntegrity(db, { dryRun: false });
    expect(repair.repairedProfileGenerationRevisions).toBe(1);
    expect(repair.postAudit.isClean).toBe(true);
  });

  it('detects and repairs proposal_evidence and model_calls orphans', () => {
    db.run(`INSERT INTO classification_proposals VALUES ('prop-1', 'run-1', 'SKU-1', 'category_page')`);
    db.run(`INSERT INTO classification_evidence VALUES ('ev-1', 'run-1', 'catalog_product')`);
    db.run(`INSERT INTO classification_proposal_evidence VALUES ('prop-1', 'ev-1', 'supporting')`);
    db.run(`INSERT INTO classification_proposal_evidence VALUES ('prop-ghost', 'ev-1', 'context')`);
    db.run(`INSERT INTO classification_model_calls VALUES ('call-orphan', 'run-ghost', 'success', 't')`);
    db.run(`INSERT INTO classification_model_calls VALUES ('call-ok', 'run-1', 'success', 't')`);

    const repair = repairClassificationIntegrity(db, { dryRun: false });
    expect(repair.repairedProposalEvidence).toBe(1);
    expect(repair.repairedModelCalls).toBe(1);
    expect(repair.postAudit.isClean).toBe(true);
  });

  it('detects and repairs every approved orphan class together', () => {
    db.run(`INSERT INTO onboarding_items VALUES ('item-1', 'UPC1', NULL, NULL, 'imported')`);
    db.run(`INSERT INTO onboarding_sources VALUES ('src-orphan', 'item-ghost', 'https://x')`);
    db.run(`INSERT INTO onboarding_extractions VALUES ('ext-orphan', 'item-ghost', 'product')`);
    db.run(`INSERT INTO profile_generations VALUES ('gen-1', 'g')`);
    db.run(`INSERT INTO profile_generation_revisions VALUES ('rev-orphan', 'gen-ghost', 'proposed')`);
    db.run(`INSERT INTO classification_proposals VALUES ('prop-orphan', 'run-ghost', 'SKU-1', 'category_page')`);
    db.run(`INSERT INTO classification_stage_results VALUES ('stage-orphan', 'run-ghost', 'evidence_extraction')`);
    db.run(`INSERT INTO classification_evidence VALUES ('ev-orphan', 'run-ghost', 'catalog_product')`);
    db.run(`INSERT INTO classification_proposal_decisions VALUES ('dec-orphan', 'prop-ghost', 'accepted')`);
    db.run(`INSERT INTO classification_proposal_evidence VALUES ('prop-ghost', 'ev-orphan', 'context')`);
    db.run(`INSERT INTO classification_model_calls VALUES ('call-orphan', 'run-ghost', 'success', 't')`);

    const pre = auditClassificationIntegrity(db);
    expect(pre.orphanStageResults).toBe(1);
    expect(pre.orphanEvidence).toBe(1);
    expect(pre.orphanProposals).toBe(1);
    expect(pre.orphanProposalDecisions).toBe(1);
    expect(pre.orphanProposalEvidence).toBe(1);
    expect(pre.orphanModelCalls).toBe(1);
    expect(pre.orphanOnboardingSources).toBe(1);
    expect(pre.orphanOnboardingExtractions).toBe(1);
    expect(pre.orphanProfileGenerationRevisions).toBe(1);

    const repair = repairClassificationIntegrity(db, { dryRun: false });
    expect(repair.postAudit.isClean).toBe(true);
    expect(repair.repairedStageResults).toBe(1);
    expect(repair.repairedEvidence).toBe(1);
    expect(repair.repairedProposals).toBe(1);
    expect(repair.repairedProposalDecisions).toBe(1);
    expect(repair.repairedProposalEvidence).toBe(1);
    expect(repair.repairedModelCalls).toBe(1);
    expect(repair.repairedOnboardingSources).toBe(1);
    expect(repair.repairedOnboardingExtractions).toBe(1);
    expect(repair.repairedProfileGenerationRevisions).toBe(1);
  });

  it('aborts on an unknown FK violation class with no row changes', () => {
    db.exec(`CREATE TABLE unknown_parent (id TEXT PRIMARY KEY); CREATE TABLE unknown_child (pid TEXT REFERENCES unknown_parent(id));`);
    db.run(`INSERT INTO unknown_parent VALUES ('p1')`);
    db.run(`INSERT INTO unknown_child VALUES ('c1')`);
    db.run(`DELETE FROM unknown_parent WHERE id = 'p1'`);
    // classification orphan so the pre-audit is otherwise dirty too
    db.run(`INSERT INTO classification_proposals VALUES ('prop-orphan', 'run-ghost', 'SKU-1', 'category_page')`);

    const audit = auditClassificationIntegrity(db);
    // Two violations: unknown_child -> unknown_parent, plus the orphaned
    // classification_proposals row (proposals -> runs) in the fixture.
    expect(audit.foreignKeyViolations).toBe(2);
    expect(audit.fkViolationGroups.some(g => g.childTable === 'unknown_child' && g.parentTable === 'unknown_parent')).toBe(true);

    expect(() => repairClassificationIntegrity(db, { dryRun: false })).toThrow(/unknown FK violation class/);
    // Nothing changed.
    const after = auditClassificationIntegrity(db);
    expect(after.orphanProposals).toBe(1);
    expect(after.foreignKeyViolations).toBe(2);
    expect((db.query("SELECT COUNT(*) c FROM unknown_child WHERE pid = 'c1'").get() as { c: number }).c).toBe(1);
    expect((db.query("SELECT COUNT(*) c FROM classification_proposals WHERE id = 'prop-orphan'").get() as { c: number }).c).toBe(1);
  });

  it('counts invalid curation_data_json separately and blocks repair', () => {
    db.run(`INSERT INTO onboarding_items VALUES ('item-1', 'UPC1', NULL, '{broken json', 'imported')`);

    const audit = auditClassificationIntegrity(db);
    expect(audit.invalidCurationJson).toBe(1);
    expect(audit.isClean).toBe(false);

    expect(() => repairClassificationIntegrity(db, { dryRun: false })).toThrow(/invalid curation_data_json/);
    expect((db.query("SELECT COUNT(*) c FROM onboarding_items WHERE id = 'item-1'").get() as { c: number }).c).toBe(1);
  });

  it('produces a byte-for-byte deterministic dry-run manifest that mutates nothing', () => {
    db.run(`INSERT INTO onboarding_items VALUES ('item-1', 'UPC1', NULL, NULL, 'imported')`);
    db.run(`INSERT INTO onboarding_sources VALUES ('src-orphan', 'item-ghost', 'https://x')`);
    db.run(`INSERT INTO classification_proposals VALUES ('prop-orphan', 'run-ghost', 'SKU-1', 'category_page')`);

    const first = buildIntegrityManifest(db, auditClassificationIntegrity(db));
    const second = buildIntegrityManifest(db, auditClassificationIntegrity(db));
    expect(first.json).toBe(second.json);
    expect(first.sha256).toBe(second.sha256);
    expect(first.manifest.counts.orphanOnboardingSources).toBe(1);
    expect(first.manifest.orphanClasses.length).toBeGreaterThanOrEqual(1);

    const repair = repairClassificationIntegrity(db, { dryRun: true });
    expect(repair.wouldRepairOnboardingSources).toBe(1);
    expect(repair.repairedOnboardingSources).toBe(0);
    expect(auditClassificationIntegrity(db).orphanOnboardingSources).toBe(1);
  });

  it('removes only dangling embedded proposal objects and preserves other JSON fields', () => {
    const curation = JSON.stringify({
      store: { name: 'Bay State', open: true },
      classificationProposals: [
        { id: 'keep-1', proposal_type: 'field_assignment', value: 'Salmon' },
        { id: 'dangling-1', proposal_type: 'primary_product_type', value: 'dog-food-dry' },
        { id: 'keep-2', proposal_type: 'field_assignment', value: 'Adult', extra: { a: 1 } },
        { id: 'dangling-2', proposal_type: 'category_page', value: 'x' },
      ],
      classificationDecisions: [{ id: 'dec-1', decision: 'accepted' }],
    });
    db.run(`INSERT INTO onboarding_items VALUES ('item-1', 'UPC1', NULL, ?, 'imported')`, [curation]);
    db.run(`INSERT INTO classification_proposals VALUES ('keep-1', 'run-1', 'SKU-1', 'field_assignment')`);
    db.run(`INSERT INTO classification_proposals VALUES ('keep-2', 'run-1', 'SKU-1', 'field_assignment')`);

    const audit = auditClassificationIntegrity(db);
    expect(audit.embeddedProposalsMissingFromSql).toBe(2);
    expect(audit.danglingEmbeddedProposals).toHaveLength(2);
    expect(audit.danglingEmbeddedProposals.map(d => d.proposalId).sort()).toEqual(['dangling-1', 'dangling-2']);
    expect(audit.danglingEmbeddedProposals.every(d => typeof d.hash === 'string' && d.hash.length === 64)).toBe(true);
    expect(audit.isClean).toBe(false); // embedded missing is part of isClean

    const repair = repairClassificationIntegrity(db, { dryRun: false });
    expect(repair.repairedEmbeddedProposals).toBe(2);
    expect(repair.postAudit.isClean).toBe(true);

    const row = db.query(`SELECT curation_data_json FROM onboarding_items WHERE id = 'item-1'`).get() as { curation_data_json: string };
    const parsed = JSON.parse(row.curation_data_json);
    expect(parsed.classificationProposals.map((p: any) => p.id)).toEqual(['keep-1', 'keep-2']);
    expect(parsed.store).toEqual({ name: 'Bay State', open: true });
    expect(parsed.classificationDecisions).toEqual([{ id: 'dec-1', decision: 'accepted' }]);
  });

  it('rolls back ALL deletes and JSON updates when a late failure occurs', () => {
    const curation = JSON.stringify({
      store: { name: 'Bay State' },
      classificationProposals: [
        { id: 'keep-1', proposal_type: 'field_assignment' },
        { id: 'dangling-1', proposal_type: 'primary_product_type' },
      ],
    });
    db.run(`INSERT INTO onboarding_items VALUES ('item-1', 'UPC1', NULL, ?, 'imported')`, [curation]);
    db.run(`INSERT INTO classification_proposals VALUES ('keep-1', 'run-1', 'SKU-1', 'field_assignment')`);
    db.run(`INSERT INTO onboarding_sources VALUES ('src-orphan', 'item-ghost', 'https://x')`);

    expect(() => repairClassificationIntegrity(db, { dryRun: false, simulateLateFailure: true })).toThrow(
      /simulated late failure/,
    );

    // Every delete and JSON update rolled back.
    const after = auditClassificationIntegrity(db);
    expect(after.orphanOnboardingSources).toBe(1);
    expect(after.embeddedProposalsMissingFromSql).toBe(1);
    expect((db.query("SELECT COUNT(*) c FROM onboarding_sources WHERE id = 'src-orphan'").get() as { c: number }).c).toBe(1);
    const row = db.query(`SELECT curation_data_json FROM onboarding_items WHERE id = 'item-1'`).get() as { curation_data_json: string };
    expect(JSON.parse(row.curation_data_json).classificationProposals).toHaveLength(2);
  });

  it('reports FK violations grouped by child, parent, and fk index', () => {
    db.run(`INSERT INTO onboarding_items VALUES ('item-1', 'UPC1', NULL, NULL, 'imported')`);
    db.run(`INSERT INTO onboarding_sources VALUES ('src-1', 'item-ghost', 'https://x')`);
    db.run(`INSERT INTO onboarding_sources VALUES ('src-2', 'item-ghost', 'https://y')`);
    db.run(`INSERT INTO classification_proposals VALUES ('prop-orphan', 'run-ghost', 'SKU-1', 'category_page')`);

    const audit = auditClassificationIntegrity(db);
    const sourcesGroup = audit.fkViolationGroups.find(
      g => g.childTable === 'onboarding_sources' && g.parentTable === 'onboarding_items',
    );
    expect(sourcesGroup?.count).toBe(2);
    expect(typeof sourcesGroup?.fkIndex).toBe('string');
    expect(audit.foreignKeyViolations).toBeGreaterThanOrEqual(3);
  });
});
