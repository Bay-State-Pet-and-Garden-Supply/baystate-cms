/**
 * Classification Referential Integrity Audit & Repair Utility (Issue #16)
 *
 * Audits database relations for orphan stage results, evidence, proposals, and decisions,
 * and repairs historical integrity violations transactionally with dry-run support.
 */
import type { Database } from '../db/driver';

export interface IntegrityAuditResult {
  orphanStageResults: number;
  orphanEvidence: number;
  orphanProposals: number;
  orphanProposalDecisions: number;
  embeddedProposalsMissingFromSql: number;
  foreignKeyViolations: number;
  isClean: boolean;
}

export interface IntegrityRepairResult {
  dryRun: boolean;
  preAudit: IntegrityAuditResult;
  repairedStageResults: number;
  repairedEvidence: number;
  repairedProposals: number;
  repairedProposalDecisions: number;
  postAudit: IntegrityAuditResult;
}

export function auditClassificationIntegrity(db: Database): IntegrityAuditResult {
  const orphanStageResults = (db.query(
    `SELECT COUNT(*) AS c FROM classification_stage_results s
     LEFT JOIN classification_runs r ON r.id = s.run_id WHERE r.id IS NULL`,
  ).get() as { c: number }).c;

  const orphanEvidence = (db.query(
    `SELECT COUNT(*) AS c FROM classification_evidence e
     LEFT JOIN classification_runs r ON r.id = e.run_id WHERE r.id IS NULL`,
  ).get() as { c: number }).c;

  const orphanProposals = (db.query(
    `SELECT COUNT(*) AS c FROM classification_proposals p
     LEFT JOIN classification_runs r ON r.id = p.run_id WHERE r.id IS NULL`,
  ).get() as { c: number }).c;

  const orphanProposalDecisions = (db.query(
    `SELECT COUNT(*) AS c FROM classification_proposal_decisions d
     LEFT JOIN classification_proposals p ON p.id = d.proposal_id WHERE p.id IS NULL`,
  ).get() as { c: number }).c;

  let embeddedProposalsMissingFromSql = 0;
  try {
    const row = db.query(
      `WITH embedded AS (
         SELECT json_extract(j.value, '$.id') AS id
         FROM onboarding_items i,
              json_each(i.curation_data_json, '$.classificationProposals') j
         WHERE i.curation_data_json IS NOT NULL AND json_valid(i.curation_data_json) = 1
       )
       SELECT SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END) AS missing
       FROM embedded e LEFT JOIN classification_proposals p ON p.id = e.id`,
    ).get() as { missing: number | null };
    embeddedProposalsMissingFromSql = row?.missing ?? 0;
  } catch {
    embeddedProposalsMissingFromSql = 0;
  }

  let foreignKeyViolations = 0;
  try {
    const fkCheck = db.query('PRAGMA foreign_key_check').all() as any[];
    foreignKeyViolations = fkCheck.length;
  } catch {
    foreignKeyViolations = 0;
  }

  const isClean = orphanStageResults === 0
    && orphanEvidence === 0
    && orphanProposals === 0
    && orphanProposalDecisions === 0
    && foreignKeyViolations === 0;

  return {
    orphanStageResults,
    orphanEvidence,
    orphanProposals,
    orphanProposalDecisions,
    embeddedProposalsMissingFromSql,
    foreignKeyViolations,
    isClean,
  };
}

export function repairClassificationIntegrity(
  db: Database,
  options: { dryRun?: boolean } = {},
): IntegrityRepairResult {
  const dryRun = options.dryRun ?? false;
  const preAudit = auditClassificationIntegrity(db);

  if (dryRun || preAudit.isClean) {
    return {
      dryRun,
      preAudit,
      repairedStageResults: preAudit.orphanStageResults,
      repairedEvidence: preAudit.orphanEvidence,
      repairedProposals: preAudit.orphanProposals,
      repairedProposalDecisions: preAudit.orphanProposalDecisions,
      postAudit: preAudit,
    };
  }

  db.transaction(() => {
    db.run(
      `DELETE FROM classification_proposal_decisions
       WHERE proposal_id IN (
         SELECT d.proposal_id FROM classification_proposal_decisions d
         LEFT JOIN classification_proposals p ON p.id = d.proposal_id
         WHERE p.id IS NULL
       )`,
    );

    db.run(
      `DELETE FROM classification_stage_results
       WHERE id IN (
         SELECT s.id FROM classification_stage_results s
         LEFT JOIN classification_runs r ON r.id = s.run_id
         WHERE r.id IS NULL
       )`,
    );

    db.run(
      `DELETE FROM classification_evidence
       WHERE id IN (
         SELECT e.id FROM classification_evidence e
         LEFT JOIN classification_runs r ON r.id = e.run_id
         WHERE r.id IS NULL
       )`,
    );

    db.run(
      `DELETE FROM classification_proposals
       WHERE id IN (
         SELECT p.id FROM classification_proposals p
         LEFT JOIN classification_runs r ON r.id = p.run_id
         WHERE r.id IS NULL
       )`,
    );
  })();

  const postAudit = auditClassificationIntegrity(db);

  return {
    dryRun: false,
    preAudit,
    repairedStageResults: preAudit.orphanStageResults,
    repairedEvidence: preAudit.orphanEvidence,
    repairedProposals: preAudit.orphanProposals,
    repairedProposalDecisions: preAudit.orphanProposalDecisions,
    postAudit,
  };
}
