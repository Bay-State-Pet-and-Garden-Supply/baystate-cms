/**
 * Pure derivation for the classification review evidence UI (issue #17 I).
 *
 * Groups proposal-linked evidence by role (supporting/contradicting/context),
 * resolves missing evidence ids, surfaces conflicts, and reports whether a
 * reviewer correction carries citations. Both onboarding and catalog review
 * surfaces consume this module so the presentation contract is shared and
 * unit-testable without a DOM.
 */
import type { ClassificationEvidence } from '../shared/schemas/classification';
import type { ClassificationProposal, ClassificationProposalDecision } from '../shared/schemas/classification';

export type EvidenceRole = 'supporting' | 'contradicting' | 'context' | 'legacy' | 'missing';

export interface EvidenceCitationRow {
  evidenceId: string;
  role: EvidenceRole;
  source: string;
  reliability: string | null;
  sourceUrl: string | null;
  snippet: string | null;
  /** Bounded display value (never raw credentials; redaction applied upstream). */
  value: string | null;
}

export interface EvidenceViewState {
  /** Proposal-linked evidence grouped by role, in stable order. */
  rows: EvidenceCitationRow[];
  supportingCount: number;
  contradictingCount: number;
  contextCount: number;
  /** Evidence ids referenced by the proposal that are missing from the run. */
  missingEvidenceIds: string[];
  /** Proposal carries at least one contradicting record (visible conflict). */
  hasConflict: boolean;
  /** Whether the proposal links any evidence at all. */
  hasEvidence: boolean;
  /** Decision citation state. */
  citation: {
    /** Sorted cited evidence ids on the decision (or []). */
    citedIds: string[];
    /** True when the decision explicitly supplied at least one citation. */
    isCited: boolean;
    /** True when the decision has no citations — UI must show "no citation supplied". */
    isUncited: boolean;
  };
}

/** Resolve the role of an evidence id from the proposal's authoritative split. */
export function evidenceRoleFor(
  proposal: Pick<ClassificationProposal, 'supportingEvidenceIds' | 'contradictingEvidenceIds'>,
  evidenceId: string,
): EvidenceRole {
  if (proposal.supportingEvidenceIds?.includes(evidenceId)) return 'supporting';
  if (proposal.contradictingEvidenceIds?.includes(evidenceId)) return 'contradicting';
  return 'context';
}

/**
 * Derive the review evidence view for one proposal. `evidence` is the run's
 * hydrated evidence keyed by id; ids referenced by the proposal that are
 * absent resolve to `missing` rows and are listed in `missingEvidenceIds`.
 */
export function deriveEvidenceView(input: {
  proposal: ClassificationProposal;
  /** Run evidence keyed by id (canonical hydrated array). */
  evidence: ClassificationEvidence[];
  /** The reviewer's latest decision for this proposal (optional). */
  decision?: ClassificationProposalDecision | null;
}): EvidenceViewState {
  const { proposal, evidence, decision } = input;
  const byId = new Map(evidence.map(record => [record.id, record]));

  // Proposal-linked ids: union of supporting + contradicting + context.
  const supportingIds = proposal.supportingEvidenceIds ?? [];
  const contradictingIds = proposal.contradictingEvidenceIds ?? [];
  const contextIds = (proposal.evidenceIds ?? []).filter(
    id => !supportingIds.includes(id) && !contradictingIds.includes(id),
  );

  const rows: EvidenceCitationRow[] = [];
  const missingEvidenceIds: string[] = [];
  const seen = new Set<string>();

  const pushRow = (evidenceId: string, role: EvidenceRole) => {
    if (seen.has(evidenceId)) return;
    seen.add(evidenceId);
    const record = byId.get(evidenceId);
    if (!record) {
      missingEvidenceIds.push(evidenceId);
      rows.push({
        evidenceId,
        role: 'missing',
        source: '',
        reliability: null,
        sourceUrl: null,
        snippet: null,
        value: null,
      });
      return;
    }
    rows.push({
      evidenceId,
      role,
      source: record.source,
      reliability: record.reliability ?? null,
      sourceUrl: record.sourceUrl ?? null,
      snippet: record.snippet ? record.snippet.slice(0, 300) : null,
      value:
        typeof record.value === 'string'
          ? record.value.slice(0, 300)
          : record.value !== null && record.value !== undefined
            ? JSON.stringify(record.value).slice(0, 300)
            : null,
    });
  };

  for (const id of supportingIds) pushRow(id, 'supporting');
  for (const id of contradictingIds) pushRow(id, 'contradicting');
  for (const id of contextIds) pushRow(id, 'context');

  const citedIds = [...new Set(decision?.evidenceIds ?? [])].sort();
  // "Uncited correction" means a correction (decision) EXISTS but carries no
  // citations. A proposal with no decision at all is a neutral no-correction
  // state and must never render the uncited wording (issue #17 pass 5c).
  const hasDecision = decision !== null && decision !== undefined;

  return {
    rows,
    supportingCount: supportingIds.length,
    contradictingCount: contradictingIds.length,
    contextCount: contextIds.filter(id => byId.has(id)).length,
    missingEvidenceIds: [...new Set(missingEvidenceIds)],
    hasConflict: contradictingIds.length > 0,
    hasEvidence: (proposal.evidenceIds ?? []).length > 0,
    citation: {
      citedIds,
      isCited: citedIds.length > 0,
      isUncited: hasDecision && citedIds.length === 0,
    },
  };
}

/** Safe display of an evidence source link (https/http only). */
export function safeSourceUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}
