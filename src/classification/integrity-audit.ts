/**
 * Classification Referential Integrity Audit & Repair Utility (Issue #16 / #17-C1)
 *
 * Audits database relations for orphan stage results, evidence, proposals,
 * decisions, proposal-evidence links, model calls, and the allowlisted
 * onboarding/profile child tables; reports `PRAGMA foreign_key_check`
 * violations grouped by child/parent/FK index; counts invalid
 * `curation_data_json` separately (JSON/JSON1 failures THROW, never zero);
 * and repairs historical integrity violations transactionally with dry-run
 * support and a deterministic content-addressed dry-run manifest.
 *
 * Repair is fail-closed:
 * - Unknown FK tuple classes, invalid curation JSON, non-clean pre-audit
 *   states, count drift (checked by the CLI against a reviewed manifest), or
 *   a non-clean post-audit all abort the single repair transaction.
 * - Only orphan child rows whose parents are gone are deleted; nothing is
 *   invented. Dangling embedded proposal objects are removed from
 *   `curation_data_json` while every other JSON field is preserved.
 */
import type { Database } from '../db/driver';
import { sha256Hex, canonicalJsonStringify } from '../shared/stable-id';

export interface FkViolationGroup {
  childTable: string;
  parentTable: string;
  fkIndex: string;
  count: number;
}

export interface DanglingEmbeddedProposal {
  itemId: string;
  /** Onboarding item UPC (fallback: existing_sku). */
  upc: string;
  proposalId: string;
  /** Canonical JSON SHA-256 of the dangling proposal object (pre-repair). */
  hash: string;
}

/**
 * A single SQL row the reviewed repair is authorized to delete. `rowid` is
 * the SQLite row id; `key` is a deterministic non-sensitive identity (the
 * table's `id` column value when present, else a canonical row-content
 * hash). The audit manifest binds the exact planned deletion set so a
 * same-count replacement of a reviewed orphan can never be deleted
 * unreviewed.
 */
export interface PlannedDeletion {
  table: string;
  rowid: number;
  key: string;
}

export interface IntegrityAuditResult {
  orphanStageResults: number;
  orphanEvidence: number;
  orphanProposals: number;
  orphanProposalDecisions: number;
  orphanProposalEvidence: number;
  orphanProposalDecisionEvidence: number;
  orphanModelCalls: number;
  orphanOnboardingSources: number;
  orphanOnboardingExtractions: number;
  orphanProfileGenerationRevisions: number;
  /** Rows whose curation_data_json is non-null but not valid JSON. */
  invalidCurationJson: number;
  embeddedProposalsMissingFromSql: number;
  danglingEmbeddedProposals: DanglingEmbeddedProposal[];
  foreignKeyViolations: number;
  fkViolationGroups: FkViolationGroup[];
  isClean: boolean;
}

export interface IntegrityRepairResult {
  dryRun: boolean;
  preAudit: IntegrityAuditResult;
  wouldRepairStageResults: number;
  wouldRepairEvidence: number;
  wouldRepairProposals: number;
  wouldRepairProposalDecisions: number;
  wouldRepairProposalEvidence: number;
  wouldRepairProposalDecisionEvidence: number;
  wouldRepairModelCalls: number;
  wouldRepairOnboardingSources: number;
  wouldRepairOnboardingExtractions: number;
  wouldRepairProfileGenerationRevisions: number;
  wouldRepairEmbeddedProposals: number;
  repairedStageResults: number;
  repairedEvidence: number;
  repairedProposals: number;
  repairedProposalDecisions: number;
  repairedProposalEvidence: number;
  repairedProposalDecisionEvidence: number;
  repairedModelCalls: number;
  repairedOnboardingSources: number;
  repairedOnboardingExtractions: number;
  repairedProfileGenerationRevisions: number;
  repairedEmbeddedProposals: number;
  postAudit: IntegrityAuditResult;
}

export interface IntegrityManifest {
  format: 'classification-integrity-manifest';
  version: 1;
  dbIdentity: string;
  schemaVersion: number;
  userVersion: number;
  counts: Record<string, number>;
  orphanClasses: FkViolationGroup[];
  danglingEmbeddedProposals: DanglingEmbeddedProposal[];
  /** Exact SQL rows the reviewed repair is authorized to delete. */
  plannedDeletions: PlannedDeletion[];
}

export interface IntegrityManifestResult {
  manifest: IntegrityManifest;
  json: string;
  sha256: string;
}

/**
 * FK tuple classes the repair is allowed to address. Anything else is an
 * unknown violation class and aborts repair (fail closed). Matches the
 * reviewed live disposition: 2,831 classification orphans
 * (evidence/stage_results/proposals) + 231 onboarding/profile orphans.
 */
const ALLOWED_FK_CLASSES = new Set<string>([
  'classification_stage_results->classification_runs',
  'classification_evidence->classification_runs',
  'classification_proposals->classification_runs',
  'classification_proposal_decisions->classification_proposals',
  'classification_proposal_evidence->classification_proposals',
  'classification_proposal_evidence->classification_evidence',
  'classification_proposal_decision_evidence->classification_proposal_decisions',
  'classification_proposal_decision_evidence->classification_evidence',
  'classification_model_calls->classification_runs',
  'onboarding_sources->onboarding_items',
  'onboarding_extractions->onboarding_items',
  'profile_generation_revisions->profile_generations',
]);

function tableExists(db: Database, name: string): boolean {
  return !!db.query('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    c => c.name === column,
  );
}

function countOrphans(
  db: Database,
  childTable: string,
  parentTable: string,
  childColumn: string,
  parentColumn: string,
): number {
  if (!tableExists(db, childTable) || !tableExists(db, parentTable)) return 0;
  const row = db.query(
    `SELECT COUNT(*) AS c FROM ${childTable} child
     LEFT JOIN ${parentTable} parent ON parent.${parentColumn} = child.${childColumn}
     WHERE parent.${parentColumn} IS NULL`,
  ).get() as { c: number };
  return row.c;
}

export function auditClassificationIntegrity(db: Database): IntegrityAuditResult {
  const orphanStageResults = countOrphans(db, 'classification_stage_results', 'classification_runs', 'run_id', 'id');
  const orphanEvidence = countOrphans(db, 'classification_evidence', 'classification_runs', 'run_id', 'id');
  const orphanProposals = countOrphans(db, 'classification_proposals', 'classification_runs', 'run_id', 'id');
  const orphanProposalDecisions = countOrphans(
    db,
    'classification_proposal_decisions',
    'classification_proposals',
    'proposal_id',
    'id',
  );
  const orphanOnboardingSources = countOrphans(db, 'onboarding_sources', 'onboarding_items', 'item_id', 'id');
  const orphanOnboardingExtractions = countOrphans(
    db,
    'onboarding_extractions',
    'onboarding_items',
    'item_id',
    'id',
  );
  const orphanProfileGenerationRevisions = countOrphans(
    db,
    'profile_generation_revisions',
    'profile_generations',
    'generation_id',
    'id',
  );

  // classification_proposal_evidence: orphaned when either side dangles.
  let orphanProposalEvidence = 0;
  if (tableExists(db, 'classification_proposal_evidence')) {
    const row = db.query(
      `SELECT COUNT(*) AS c FROM classification_proposal_evidence l
       WHERE NOT EXISTS (SELECT 1 FROM classification_proposals p WHERE p.id = l.proposal_id)
          OR NOT EXISTS (SELECT 1 FROM classification_evidence e WHERE e.id = l.evidence_id)`,
    ).get() as { c: number };
    orphanProposalEvidence = row.c;
  }

  // classification_model_calls: orphaned when the run is gone.
  let orphanModelCalls = 0;
  if (tableExists(db, 'classification_model_calls')) {
    const row = db.query(
      `SELECT COUNT(*) AS c FROM classification_model_calls m
       WHERE NOT EXISTS (SELECT 1 FROM classification_runs r WHERE r.id = m.run_id)`,
    ).get() as { c: number };
    orphanModelCalls = row.c;
  }

  // classification_proposal_decision_evidence: orphaned when either the
  // decision parent or the evidence parent dangles.
  let orphanProposalDecisionEvidence = 0;
  if (tableExists(db, 'classification_proposal_decision_evidence')) {
    const row = db.query(
      `SELECT COUNT(*) AS c FROM classification_proposal_decision_evidence l
       WHERE NOT EXISTS (SELECT 1 FROM classification_proposal_decisions d WHERE d.id = l.decision_id)
          OR NOT EXISTS (SELECT 1 FROM classification_evidence e WHERE e.id = l.evidence_id)`,
    ).get() as { c: number };
    orphanProposalDecisionEvidence = row.c;
  }

  // Invalid curation_data_json is counted separately. JSON/JSON1 failures
  // (e.g. missing functions) THROW — they never silently become zero.
  let invalidCurationJson = 0;
  if (tableHasColumn(db, 'onboarding_items', 'curation_data_json')) {
    const row = db.query(
      `SELECT COUNT(*) AS c FROM onboarding_items
       WHERE curation_data_json IS NOT NULL AND json_valid(curation_data_json) = 0`,
    ).get() as { c: number };
    invalidCurationJson = row.c;
  }

  // Dangling embedded proposals (valid JSON only): collect the refs with
  // canonical hashes for the reviewed manifest. JSON1 failures throw.
  const danglingEmbeddedProposals: DanglingEmbeddedProposal[] = [];
  let embeddedProposalsMissingFromSql = 0;
  if (tableHasColumn(db, 'onboarding_items', 'curation_data_json')) {
    // A proposal referenced by embedded curation JSON counts as dangling
    // when its SQL row is MISSING OR is itself scheduled for orphan deletion.
    // This is what makes the combined embedded+SQL repair possible: an
    // orphan SQL proposal referenced by embedded JSON is removed from BOTH
    // places in the same transaction (blocker 6).
    const orphanProposalIds = new Set<string>();
    if (tableExists(db, 'classification_proposals') && tableExists(db, 'classification_runs')) {
      for (const r of db.query(
        `SELECT p.id FROM classification_proposals p
         LEFT JOIN classification_runs r ON r.id = p.run_id
         WHERE r.id IS NULL`,
      ).all() as Array<{ id: string }>) {
        orphanProposalIds.add(r.id);
      }
    }
    const knownProposalIds = new Set<string>();
    if (tableExists(db, 'classification_proposals')) {
      for (const r of db.query('SELECT id FROM classification_proposals').all() as Array<{ id: string }>) {
        if (!orphanProposalIds.has(r.id)) {
          knownProposalIds.add(r.id);
        }
      }
    }
    const rows = db.query(
      `SELECT i.id AS item_id, i.upc AS upc, i.existing_sku AS existing_sku, j.value AS proposal_text
       FROM onboarding_items i,
            json_each(i.curation_data_json, '$.classificationProposals') j
       WHERE i.curation_data_json IS NOT NULL
         AND json_valid(i.curation_data_json) = 1
         AND json_type(i.curation_data_json, '$.classificationProposals') = 'array'
         AND json_type(j.value) = 'object'`,
    ).all() as Array<{ item_id: string; upc: string | null; existing_sku: string | null; proposal_text: string }>;
    for (const row of rows) {
      let proposalId: unknown;
      try {
        proposalId = JSON.parse(row.proposal_text)?.id ?? null;
      } catch {
        // The audit above already guaranteed json_valid = 1; a parse failure
        // here is a JSON1/library inconsistency — fail closed.
        throw new Error(
          `Integrity audit: curation_data_json element could not be parsed for item ${row.item_id}.`,
        );
      }
      if (typeof proposalId !== 'string' || !proposalId) continue;
      if (knownProposalIds.has(proposalId)) continue;
      embeddedProposalsMissingFromSql += 1;
      danglingEmbeddedProposals.push({
        itemId: row.item_id,
        upc: row.upc ?? row.existing_sku ?? '',
        proposalId,
        hash: sha256Hex(canonicalJsonStringify(JSON.parse(row.proposal_text))),
      });
    }
    danglingEmbeddedProposals.sort((a, b) =>
      a.itemId === b.itemId ? a.proposalId.localeCompare(b.proposalId) : a.itemId.localeCompare(b.itemId),
    );
  }

  // PRAGMA foreign_key_check — grouped by (child table, parent table, fkid).
  // Any error (e.g. missing table) throws: audits never silently pass.
  const fkRows = db.query('PRAGMA foreign_key_check').all() as Array<{
    table: string;
    rowid: unknown;
    parent: string;
    fkid: number;
  }>;
  const groupMap = new Map<string, FkViolationGroup>();
  for (const r of fkRows) {
    const key = `${r.table}|${r.parent}|${String(r.fkid)}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groupMap.set(key, {
        childTable: r.table,
        parentTable: r.parent,
        fkIndex: String(r.fkid),
        count: 1,
      });
    }
  }
  const fkViolationGroups = [...groupMap.values()].sort((a, b) =>
    a.childTable === b.childTable
      ? a.parentTable === b.parentTable
        ? a.fkIndex.localeCompare(b.fkIndex)
        : a.parentTable.localeCompare(b.parentTable)
      : a.childTable.localeCompare(b.childTable),
  );
  const foreignKeyViolations = fkRows.length;

  const isClean =
    orphanStageResults === 0 &&
    orphanEvidence === 0 &&
    orphanProposals === 0 &&
    orphanProposalDecisions === 0 &&
    orphanProposalEvidence === 0 &&
    orphanProposalDecisionEvidence === 0 &&
    orphanModelCalls === 0 &&
    orphanOnboardingSources === 0 &&
    orphanOnboardingExtractions === 0 &&
    orphanProfileGenerationRevisions === 0 &&
    invalidCurationJson === 0 &&
    embeddedProposalsMissingFromSql === 0 &&
    foreignKeyViolations === 0;

  return {
    orphanStageResults,
    orphanEvidence,
    orphanProposals,
    orphanProposalDecisions,
    orphanProposalEvidence,
    orphanProposalDecisionEvidence,
    orphanModelCalls,
    orphanOnboardingSources,
    orphanOnboardingExtractions,
    orphanProfileGenerationRevisions,
    invalidCurationJson,
    embeddedProposalsMissingFromSql,
    danglingEmbeddedProposals,
    foreignKeyViolations,
    fkViolationGroups,
    isClean,
  };
}

/**
 * Deletion dependency order: children before parents, matching the schema's
 * FK cascade relationships. The planned-deletion set and `runRepair` both
 * use this exact ordering so the physical deletion set equals the manifest.
 */
const DEPENDENCY_ORDER = [
  'classification_proposal_decision_evidence',
  'classification_proposal_evidence',
  'classification_proposal_decisions',
  'classification_proposals',
  'classification_evidence',
  'classification_stage_results',
  'classification_model_calls',
  'onboarding_sources',
  'onboarding_extractions',
  'profile_generation_revisions',
] as const;

/**
 * Parent → child FK relations used to expand a planned deletion into its
 * complete descendant closure (children of parents scheduled for deletion
 * are themselves scheduled, even when their immediate parents currently
 * exist). Only parent tables that are ever planned participate; link tables
 * (no `id` column) have no children.
 */
const CHILD_RELATIONS = [
  { parentTable: 'classification_proposals', childTable: 'classification_proposal_decisions', fkCol: 'proposal_id' },
  { parentTable: 'classification_proposals', childTable: 'classification_proposal_evidence', fkCol: 'proposal_id' },
  { parentTable: 'classification_proposal_decisions', childTable: 'classification_proposal_decision_evidence', fkCol: 'decision_id' },
  { parentTable: 'classification_evidence', childTable: 'classification_proposal_evidence', fkCol: 'evidence_id' },
  { parentTable: 'classification_evidence', childTable: 'classification_proposal_decision_evidence', fkCol: 'evidence_id' },
] as const;

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

interface PlannedRow {
  rowid: number;
  id?: string | null;
  values: unknown[];
}

/**
 * Enumerate the EXACT SQL rows the repair is authorized to delete, in
 * dependency order matching `runRepair`. Each entry carries the SQLite
 * rowid plus a deterministic non-sensitive identity key (the table's `id`
 * column when present, else a canonical row-content hash) so the reviewed
 * manifest binds the concrete deletion set. A same-count replacement of a
 * reviewed orphan therefore changes the manifest hash and aborts repair.
 *
 * The set is the complete descendant CLOSURE: every current orphan PLUS
 * every child row whose parent is itself planned for deletion (following the
 * schema's FK/cascade relations), so the transaction's physical deletion set
 * EXACTLY equals the manifest under both foreign_keys=OFF and ON.
 */
export function collectPlannedDeletions(db: Database): PlannedDeletion[] {
  const planned = new Map<string, Map<number, PlannedDeletion>>();
  const idValuesByTable = new Map<string, Set<string>>();

  function addRow(table: string, row: PlannedRow): void {
    let byRow = planned.get(table);
    if (!byRow) {
      byRow = new Map();
      planned.set(table, byRow);
    }
    if (byRow.has(row.rowid)) return;
    const key =
      typeof row.id === 'string' && row.id
        ? row.id
        : sha256Hex(canonicalJsonStringify([table, row.rowid, row.values]));
    byRow.set(row.rowid, { table, rowid: row.rowid, key });
    if (typeof row.id === 'string' && row.id) {
      let ids = idValuesByTable.get(table);
      if (!ids) {
        ids = new Set();
        idValuesByTable.set(table, ids);
      }
      ids.add(row.id);
    }
  }

  function collectRoots(table: string, predicateSql: string): void {
    if (!tableExists(db, table)) return;
    const rows = db.query(
      `SELECT rowid, * FROM ${table} WHERE ${predicateSql}`,
    ).all() as Array<Record<string, unknown> & { rowid: number; id?: string }>;
    for (const r of rows) {
      const values = Object.entries(r)
        .filter(([k]) => k !== 'rowid')
        .map(([, v]) => v);
      addRow(table, { rowid: r.rowid, id: r.id ?? null, values });
    }
  }

  // Roots: current orphans per class (parents missing).
  if (tableExists(db, 'classification_proposal_decisions') && tableExists(db, 'classification_proposals')) {
    collectRoots(
      'classification_proposal_decisions',
      `id IN (SELECT d.id FROM classification_proposal_decisions d
              LEFT JOIN classification_proposals p ON p.id = d.proposal_id WHERE p.id IS NULL)`,
    );
  }
  if (tableExists(db, 'classification_proposal_evidence')) {
    collectRoots(
      'classification_proposal_evidence',
      `NOT EXISTS (SELECT 1 FROM classification_proposals p WHERE p.id = classification_proposal_evidence.proposal_id)
        OR NOT EXISTS (SELECT 1 FROM classification_evidence e WHERE e.id = classification_proposal_evidence.evidence_id)`,
    );
  }
  if (tableExists(db, 'classification_proposal_decision_evidence')) {
    collectRoots(
      'classification_proposal_decision_evidence',
      `NOT EXISTS (SELECT 1 FROM classification_proposal_decisions d WHERE d.id = classification_proposal_decision_evidence.decision_id)
        OR NOT EXISTS (SELECT 1 FROM classification_evidence e WHERE e.id = classification_proposal_decision_evidence.evidence_id)`,
    );
  }
  if (tableExists(db, 'classification_proposals') && tableExists(db, 'classification_runs')) {
    collectRoots(
      'classification_proposals',
      `id IN (SELECT p.id FROM classification_proposals p
              LEFT JOIN classification_runs r ON r.id = p.run_id WHERE r.id IS NULL)`,
    );
  }
  if (tableExists(db, 'classification_evidence') && tableExists(db, 'classification_runs')) {
    collectRoots(
      'classification_evidence',
      `id IN (SELECT e.id FROM classification_evidence e
              LEFT JOIN classification_runs r ON r.id = e.run_id WHERE r.id IS NULL)`,
    );
  }
  if (tableExists(db, 'classification_stage_results') && tableExists(db, 'classification_runs')) {
    collectRoots(
      'classification_stage_results',
      `id IN (SELECT s.id FROM classification_stage_results s
              LEFT JOIN classification_runs r ON r.id = s.run_id WHERE r.id IS NULL)`,
    );
  }
  if (tableExists(db, 'classification_model_calls')) {
    collectRoots(
      'classification_model_calls',
      `NOT EXISTS (SELECT 1 FROM classification_runs r WHERE r.id = classification_model_calls.run_id)`,
    );
  }
  if (tableExists(db, 'onboarding_sources') && tableExists(db, 'onboarding_items')) {
    collectRoots(
      'onboarding_sources',
      `item_id IN (SELECT s.item_id FROM onboarding_sources s
                   LEFT JOIN onboarding_items i ON i.id = s.item_id WHERE i.id IS NULL)`,
    );
  }
  if (tableExists(db, 'onboarding_extractions') && tableExists(db, 'onboarding_items')) {
    collectRoots(
      'onboarding_extractions',
      `item_id IN (SELECT x.item_id FROM onboarding_extractions x
                   LEFT JOIN onboarding_items i ON i.id = x.item_id WHERE i.id IS NULL)`,
    );
  }
  if (tableExists(db, 'profile_generation_revisions') && tableExists(db, 'profile_generations')) {
    collectRoots(
      'profile_generation_revisions',
      `generation_id IN (SELECT r.generation_id FROM profile_generation_revisions r
                         LEFT JOIN profile_generations g ON g.id = r.generation_id WHERE g.id IS NULL)`,
    );
  }

  // Descendant closure: children of planned rows are also planned, even when
  // their immediate parents currently exist (they become orphans the moment
  // the parent is deleted). Iterate to a fixpoint for transitive children.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { parentTable, childTable, fkCol } of CHILD_RELATIONS) {
      const parentIds = idValuesByTable.get(parentTable);
      if (!parentIds || parentIds.size === 0) continue;
      if (!tableExists(db, childTable)) continue;
      const ids = [...parentIds];
      for (const chunk of chunkArray(ids, 400)) {
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = db.query(
          `SELECT rowid, * FROM ${childTable} WHERE ${fkCol} IN (${placeholders})`,
        ).all(...chunk) as Array<Record<string, unknown> & { rowid: number; id?: string }>;
        for (const r of rows) {
          const byRow = planned.get(childTable);
          if (byRow?.has(r.rowid)) continue;
          const values = Object.entries(r)
            .filter(([k]) => k !== 'rowid')
            .map(([, v]) => v);
          addRow(childTable, { rowid: r.rowid, id: r.id ?? null, values });
          changed = true;
        }
      }
    }
  }

  const order = new Map<string, number>(DEPENDENCY_ORDER.map((t, i) => [t, i]));
  const out: PlannedDeletion[] = [];
  for (const byRow of planned.values()) {
    for (const plan of byRow.values()) out.push(plan);
  }
  out.sort((a, b) => {
    const oa = order.get(a.table) ?? 999;
    const ob = order.get(b.table) ?? 999;
    return oa === ob ? a.rowid - b.rowid : oa - ob;
  });
  return out;
}

/** Planned deletion count per table (for the repair result counters). */
function plannedCounts(planned: PlannedDeletion[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of planned) {
    counts[p.table] = (counts[p.table] ?? 0) + 1;
  }
  return counts;
}

export function buildIntegrityManifest(db: Database, audit: IntegrityAuditResult): IntegrityManifestResult {
  const identityRow = (db.query(`SELECT file FROM pragma_database_list WHERE name = 'main'`).get() as
    | { file: string }
    | undefined);
  const dbIdentity = identityRow?.file ?? '';
  const schemaVersion = (db.query('PRAGMA schema_version').get() as { schema_version: number }).schema_version;
  const userVersion = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;

  const manifest: IntegrityManifest = {
    format: 'classification-integrity-manifest',
    version: 1,
    dbIdentity,
    schemaVersion,
    userVersion,
    counts: {
      orphanStageResults: audit.orphanStageResults,
      orphanEvidence: audit.orphanEvidence,
      orphanProposals: audit.orphanProposals,
      orphanProposalDecisions: audit.orphanProposalDecisions,
      orphanProposalEvidence: audit.orphanProposalEvidence,
      orphanProposalDecisionEvidence: audit.orphanProposalDecisionEvidence,
      orphanModelCalls: audit.orphanModelCalls,
      orphanOnboardingSources: audit.orphanOnboardingSources,
      orphanOnboardingExtractions: audit.orphanOnboardingExtractions,
      orphanProfileGenerationRevisions: audit.orphanProfileGenerationRevisions,
      invalidCurationJson: audit.invalidCurationJson,
      embeddedProposalsMissingFromSql: audit.embeddedProposalsMissingFromSql,
      foreignKeyViolations: audit.foreignKeyViolations,
    },
    orphanClasses: audit.fkViolationGroups,
    danglingEmbeddedProposals: audit.danglingEmbeddedProposals,
    plannedDeletions: collectPlannedDeletions(db),
  };
  const json = canonicalJsonStringify(manifest);
  return { manifest, json, sha256: sha256Hex(json) };
}

function assertRepairAllowed(audit: IntegrityAuditResult): void {
  if (audit.invalidCurationJson > 0) {
    throw new Error(
      `Integrity repair blocked: ${audit.invalidCurationJson} onboarding item(s) have invalid curation_data_json. ` +
        `Fix the JSON before repairing.`,
    );
  }
  for (const group of audit.fkViolationGroups) {
    const cls = `${group.childTable}->${group.parentTable}`;
    if (!ALLOWED_FK_CLASSES.has(cls)) {
      throw new Error(
        `Integrity repair blocked: unknown FK violation class ${cls} (${group.count} row(s)). ` +
          `No rows were changed.`,
      );
    }
  }
}

function runRepair(db: Database, dangling: DanglingEmbeddedProposal[]): void {
  // The EXACT deletion set (roots + descendant closure) — the same set the
  // reviewed manifest binds. Children are deleted before parents in
  // dependency order so the physical deletion set equals the planned set
  // under both foreign_keys=OFF and ON.
  const planned = collectPlannedDeletions(db);
  const rowidsByTable = new Map<string, number[]>();
  for (const p of planned) {
    let list = rowidsByTable.get(p.table);
    if (!list) {
      list = [];
      rowidsByTable.set(p.table, list);
    }
    list.push(p.rowid);
  }
  for (const table of DEPENDENCY_ORDER) {
    const rowids = rowidsByTable.get(table);
    if (!rowids || rowids.length === 0) continue;
    for (const chunk of chunkArray(rowids, 400)) {
      const placeholders = chunk.map(() => '?').join(', ');
      db.run(`DELETE FROM ${table} WHERE rowid IN (${placeholders})`, chunk);
    }
  }

  // Embedded dangling proposals: remove ONLY the missing proposal objects,
  // preserving every other JSON field and the remaining array order.
  const byItem = new Map<string, Set<string>>();
  for (const d of dangling) {
    const set = byItem.get(d.itemId) ?? new Set<string>();
    set.add(d.proposalId);
    byItem.set(d.itemId, set);
  }
  for (const [itemId, ids] of byItem) {
    const row = db.query('SELECT curation_data_json FROM onboarding_items WHERE id = ?').get(itemId) as
      | { curation_data_json: string | null }
      | undefined;
    if (!row || row.curation_data_json == null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.curation_data_json);
    } catch {
      throw new Error(`Integrity repair: curation_data_json for item ${itemId} became invalid during repair.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.classificationProposals)) continue;
    const before = obj.classificationProposals.length;
    obj.classificationProposals = (obj.classificationProposals as unknown[]).filter((p: unknown) => {
      if (!p || typeof p !== 'object') return true;
      const id = (p as { id?: unknown }).id;
      return !(typeof id === 'string' && ids.has(id));
    });
    if ((obj.classificationProposals as unknown[]).length === before) continue;
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
      JSON.stringify(obj),
      itemId,
    ]);
  }
}

/** Zero-fill the repair counters for dry-run / clean pre-audit returns. */
function zeroRepairCounters() {
  return {
    repairedStageResults: 0,
    repairedEvidence: 0,
    repairedProposals: 0,
    repairedProposalDecisions: 0,
    repairedProposalEvidence: 0,
    repairedProposalDecisionEvidence: 0,
    repairedModelCalls: 0,
    repairedOnboardingSources: 0,
    repairedOnboardingExtractions: 0,
    repairedProfileGenerationRevisions: 0,
    repairedEmbeddedProposals: 0,
  };
}

/**
 * Map the planned deletion counts onto the repair result's would/repaired
 * fields. The planned set (roots + closure) is the ACTUAL set the repair
 * deletes, so the counters reflect it rather than only current orphans.
 */
function plannedCountFields(db: Database): {
  wouldRepairStageResults: number;
  wouldRepairEvidence: number;
  wouldRepairProposals: number;
  wouldRepairProposalDecisions: number;
  wouldRepairProposalEvidence: number;
  wouldRepairProposalDecisionEvidence: number;
  wouldRepairModelCalls: number;
  wouldRepairOnboardingSources: number;
  wouldRepairOnboardingExtractions: number;
  wouldRepairProfileGenerationRevisions: number;
} {
  const counts = plannedCounts(collectPlannedDeletions(db));
  return {
    wouldRepairStageResults: counts['classification_stage_results'] ?? 0,
    wouldRepairEvidence: counts['classification_evidence'] ?? 0,
    wouldRepairProposals: counts['classification_proposals'] ?? 0,
    wouldRepairProposalDecisions: counts['classification_proposal_decisions'] ?? 0,
    wouldRepairProposalEvidence: counts['classification_proposal_evidence'] ?? 0,
    wouldRepairProposalDecisionEvidence: counts['classification_proposal_decision_evidence'] ?? 0,
    wouldRepairModelCalls: counts['classification_model_calls'] ?? 0,
    wouldRepairOnboardingSources: counts['onboarding_sources'] ?? 0,
    wouldRepairOnboardingExtractions: counts['onboarding_extractions'] ?? 0,
    wouldRepairProfileGenerationRevisions: counts['profile_generation_revisions'] ?? 0,
  };
}

export function repairClassificationIntegrity(
  db: Database,
  options: { dryRun?: boolean; simulateLateFailure?: boolean } = {},
): IntegrityRepairResult {
  const dryRun = options.dryRun ?? false;
  const preAudit = auditClassificationIntegrity(db);

  // The ACTUAL deletion set (roots + descendant closure) is what the repair
  // deletes and what the reviewed manifest binds; the counters reflect it.
  const wouldFields = plannedCountFields(db);

  const base = {
    preAudit,
    ...wouldFields,
    wouldRepairEmbeddedProposals: preAudit.danglingEmbeddedProposals.length,
    ...zeroRepairCounters(),
  };

  if (dryRun || preAudit.isClean) {
    return { dryRun, ...base, postAudit: preAudit };
  }

  assertRepairAllowed(preAudit);

  let result: IntegrityRepairResult | null = null;
  db.transaction(() => {
    runRepair(db, preAudit.danglingEmbeddedProposals);
    if (options.simulateLateFailure) {
      // Test-only seam: force a late failure after all deletes/JSON updates
      // to prove the single transaction rolls everything back.
      throw new Error('Integrity repair: simulated late failure.');
    }
    const postAudit = auditClassificationIntegrity(db);
    if (!postAudit.isClean) {
      throw new Error(
        'Integrity repair: post-audit is not clean (orphans, dangling embedded proposals, or FK violations remain). ' +
          'Rolling back.',
      );
    }
    result = {
      dryRun: false,
      preAudit,
      ...wouldFields,
      wouldRepairEmbeddedProposals: preAudit.danglingEmbeddedProposals.length,
      // The planned set (roots + closure) is EXACTLY what the repair deletes;
      // under the no-writer maintenance gate the pre/post sets are identical.
      repairedStageResults: wouldFields.wouldRepairStageResults,
      repairedEvidence: wouldFields.wouldRepairEvidence,
      repairedProposals: wouldFields.wouldRepairProposals,
      repairedProposalDecisions: wouldFields.wouldRepairProposalDecisions,
      repairedProposalEvidence: wouldFields.wouldRepairProposalEvidence,
      repairedProposalDecisionEvidence: wouldFields.wouldRepairProposalDecisionEvidence,
      repairedModelCalls: wouldFields.wouldRepairModelCalls,
      repairedOnboardingSources: wouldFields.wouldRepairOnboardingSources,
      repairedOnboardingExtractions: wouldFields.wouldRepairOnboardingExtractions,
      repairedProfileGenerationRevisions: wouldFields.wouldRepairProfileGenerationRevisions,
      repairedEmbeddedProposals:
        preAudit.danglingEmbeddedProposals.length - postAudit.danglingEmbeddedProposals.length,
      postAudit,
    };
  })();

  return result!;
}
