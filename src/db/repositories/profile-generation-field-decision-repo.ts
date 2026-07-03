import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

/**
 * Possible operator decisions for a single selector field.
 *
 *   approved   - operator approved the AI-revised selector and it was
 *                written to `extractor_profiles`.
 *   rejected   - operator rejected the AI-revised selector; nothing was
 *                written to `extractor_profiles`.
 *   rolled_back - operator rolled a previously approved selector back
 *                to the prior value (or to null if there was none).
 */
export type ProfileGenerationFieldDecisionType =
  | 'approved'
  | 'rejected'
  | 'rolled_back';

const PROFILE_GENERATION_FIELD_DECISIONS: ReadonlyArray<ProfileGenerationFieldDecisionType> = [
  'approved',
  'rejected',
  'rolled_back',
];

/**
 * Snapshot of a single field-level decision. Each decision is appended
 * (never mutated) so the governance UI can show a per-field history
 * (original AI selector → revised → approved/rolled back).
 */
export interface ProfileGenerationFieldDecision {
  id: string;
  generationId: string;
  revisionId: string | null;
  domain: string;
  selectorField: string;
  decision: ProfileGenerationFieldDecisionType;
  previousSelector: string | null;
  proposedSelector: string | null;
  approvedSelector: string | null;
  feedback: Record<string, unknown> | null;
  validationResultIds: string[] | null;
  decidedAt: string;
  decidedBy: string | null;
  notes: string | null;
}

interface DbProfileGenerationFieldDecision {
  id: string;
  generation_id: string;
  revision_id: string | null;
  domain: string;
  selector_field: string;
  decision: string;
  previous_selector: string | null;
  proposed_selector: string | null;
  approved_selector: string | null;
  feedback_json: string | null;
  validation_result_ids_json: string | null;
  decided_at: string;
  decided_by: string | null;
  notes: string | null;
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

function safeParseJson<T>(raw: string | null): T | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mapToDecision(
  row: DbProfileGenerationFieldDecision,
): ProfileGenerationFieldDecision {
  return {
    id: row.id,
    generationId: row.generation_id,
    revisionId: row.revision_id,
    domain: row.domain,
    selectorField: row.selector_field,
    decision: row.decision as ProfileGenerationFieldDecisionType,
    previousSelector: row.previous_selector,
    proposedSelector: row.proposed_selector,
    approvedSelector: row.approved_selector,
    feedback: safeParseJson<Record<string, unknown>>(row.feedback_json),
    validationResultIds: safeParseJson<string[]>(row.validation_result_ids_json),
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    notes: row.notes,
  };
}

export interface InsertProfileFieldDecisionInput {
  generationId: string;
  revisionId?: string | null;
  domain: string;
  selectorField: string;
  decision: ProfileGenerationFieldDecisionType;
  previousSelector?: string | null;
  proposedSelector?: string | null;
  approvedSelector?: string | null;
  feedback?: Record<string, unknown> | null;
  validationResultIds?: string[] | null;
  decidedBy?: string | null;
  notes?: string | null;
  decidedAt?: string;
}

export function insertProfileFieldDecision(
  input: InsertProfileFieldDecisionInput,
): ProfileGenerationFieldDecision {
  const db = getDb();
  const now = input.decidedAt ?? new Date().toISOString();
  const id = randomUUID();
  const normalizedDomain = normalizeDomain(input.domain);

  db.query(`
    INSERT INTO profile_generation_field_decisions (
      id, generation_id, revision_id, domain, selector_field, decision,
      previous_selector, proposed_selector, approved_selector, feedback_json,
      validation_result_ids_json, decided_at, decided_by, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.generationId,
    input.revisionId ?? null,
    normalizedDomain,
    input.selectorField,
    input.decision,
    input.previousSelector ?? null,
    input.proposedSelector ?? null,
    input.approvedSelector ?? null,
    input.feedback ? JSON.stringify(input.feedback) : null,
    input.validationResultIds
      ? JSON.stringify(input.validationResultIds)
      : null,
    now,
    input.decidedBy ?? null,
    input.notes ?? null,
  );

  return {
    id,
    generationId: input.generationId,
    revisionId: input.revisionId ?? null,
    domain: normalizedDomain,
    selectorField: input.selectorField,
    decision: input.decision,
    previousSelector: input.previousSelector ?? null,
    proposedSelector: input.proposedSelector ?? null,
    approvedSelector: input.approvedSelector ?? null,
    feedback: input.feedback ?? null,
    validationResultIds: input.validationResultIds ?? null,
    decidedAt: now,
    decidedBy: input.decidedBy ?? null,
    notes: input.notes ?? null,
  };
}

export function findProfileFieldDecisionById(
  id: string,
): ProfileGenerationFieldDecision | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM profile_generation_field_decisions WHERE id = ?')
    .get(id) as DbProfileGenerationFieldDecision | undefined;
  return row ? mapToDecision(row) : null;
}

export interface ListFieldDecisionsByDomainOptions {
  selectorField?: string;
  decision?: ProfileGenerationFieldDecisionType;
  orderDirection?: 'ASC' | 'DESC';
  limit?: number;
}

export function listFieldDecisionsByDomain(
  domain: string,
  options: ListFieldDecisionsByDomainOptions = {},
): ProfileGenerationFieldDecision[] {
  const db = getDb();
  const normalizedDomain = normalizeDomain(domain);
  const orderDir = options.orderDirection === 'ASC' ? 'ASC' : 'DESC';
  const limit = options.limit ?? 200;

  const where: string[] = ['domain = ?'];
  const params: Array<string | number> = [normalizedDomain];
  if (options.selectorField) {
    where.push('selector_field = ?');
    params.push(options.selectorField);
  }
  if (options.decision) {
    where.push('decision = ?');
    params.push(options.decision);
  }

  const rows = db
    .query(
      `SELECT * FROM profile_generation_field_decisions
       WHERE ${where.join(' AND ')}
       ORDER BY decided_at ${orderDir}, rowid ${orderDir}
       LIMIT ?`,
    )
    .all(...params, limit) as DbProfileGenerationFieldDecision[];

  return rows.map(mapToDecision);
}

// fallow-ignore-next-line unused-export
export function listFieldDecisionsByGeneration(
  generationId: string,
): ProfileGenerationFieldDecision[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT * FROM profile_generation_field_decisions
       WHERE generation_id = ?
       ORDER BY decided_at ASC, rowid ASC`,
    )
    .all(generationId) as DbProfileGenerationFieldDecision[];
  return rows.map(mapToDecision);
}

/**
 * Return the most recent `approved` decision for a domain + selector
 * field, regardless of generation. Used by rollback to find the value
 * that should be restored. Decisions that have already been rolled
 * back are excluded so a caller cannot double-roll-back the same
 * approval.
 */
export function findLatestApprovedFieldDecision(
  domain: string,
  selectorField: string,
): ProfileGenerationFieldDecision | null {
  const db = getDb();
  const normalizedDomain = normalizeDomain(domain);
  const row = db
    .query(
      `SELECT * FROM profile_generation_field_decisions AS approved
       WHERE approved.domain = ? AND approved.selector_field = ? AND approved.decision = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM profile_generation_field_decisions AS rb
           WHERE rb.domain = approved.domain
             AND rb.selector_field = approved.selector_field
             AND rb.decision = 'rolled_back'
             AND rb.previous_selector = approved.approved_selector
         )
       ORDER BY approved.decided_at DESC, approved.rowid DESC
       LIMIT 1`,
    )
    .get(normalizedDomain, selectorField) as DbProfileGenerationFieldDecision | undefined;
  return row ? mapToDecision(row) : null;
}
