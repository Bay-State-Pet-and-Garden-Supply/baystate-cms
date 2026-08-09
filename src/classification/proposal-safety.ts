/**
 * Central Candidate Safety Validator
 *
 * Every proposal a pipeline stage produces must pass this validator before the
 * run may succeed. The validator enforces:
 *
 * - Claims require linked direct evidence with an approved source. Absence,
 *   inference, and Page context are rejected; third-party and manager-guidance
 *   evidence is not treated as direct product evidence.
 * - Composition attributes require the same direct-evidence provenance.
 * - Confidence is never a license to bypass review: claim/composition
 *   proposals can never be bulk-acceptable, and every proposal is persisted
 *   pending until a human decision exists.
 * - Controlled membership, measured units, cardinality, and delimiter policy
 *   are validated against the attribute config and mapping serialization.
 */
import type { ClassificationEvidence, ClassificationProposal } from '../shared/types';
import type { ProductAttributeConfig } from '../shared/schemas/classification';
import { validateSerializableValue } from './assignment-projection';

export type SafetyFindingCode =
  | 'claim_missing_direct_evidence'
  | 'claim_page_context'
  | 'claim_unapproved_source'
  | 'claim_contradicting_evidence'
  | 'composition_missing_direct_evidence'
  | 'composition_page_context'
  | 'composition_unapproved_source'
  | 'composition_contradicting_evidence'
  | 'bulk_accept_claim'
  | 'bulk_accept_composition'
  | 'controlled_membership'
  | 'measured_unit'
  | 'delimiter_policy';

export interface ProposalSafetyFinding {
  proposalId: string;
  code: SafetyFindingCode;
  message: string;
}

export interface ProposalSafetyReport {
  ok: boolean;
  findings: ProposalSafetyFinding[];
}

export interface ProposalSafetyContext {
  /** Attribute configuration for claim/composition/controlled/measured checks. */
  attributes: ProductAttributeConfig[];
  /** Every evidence record accumulated by the run, keyed lookup by id. */
  evidence: ClassificationEvidence[];
}

/**
 * Sources that constitute direct product evidence for claims and composition.
 * Page context, manager guidance, third-party pages, and spreadsheets are NOT
 * direct product statements and are rejected (fail closed).
 */
const DIRECT_EVIDENCE_SOURCES = new Set([
  'official_product_page',
  'visual_product_evidence',
  'catalog_product',
]);

function findEvidence(
  context: ProposalSafetyContext,
  evidenceId: string,
): ClassificationEvidence | null {
  const lookup = new Map(context.evidence.map(evidence => [evidence.id, evidence]));
  return lookup.get(evidenceId) ?? null;
}

function validateDirectEvidence(
  proposal: ClassificationProposal,
  attribute: ProductAttributeConfig,
  context: ProposalSafetyContext,
): ProposalSafetyFinding | null {
  const isClaim = attribute.isClaim === true;

  if (!proposal.evidenceIds || proposal.evidenceIds.length === 0) {
    return {
      proposalId: proposal.id,
      code: isClaim ? 'claim_missing_direct_evidence' : 'composition_missing_direct_evidence',
      message: `${attribute.name} (${attribute.id}) requires linked direct evidence, but proposal has none. Absence and inference cannot support a claim or composition value.`,
    };
  }

  for (const evidenceId of proposal.evidenceIds) {
    const evidence = findEvidence(context, evidenceId);
    if (!evidence) {
      return {
        proposalId: proposal.id,
        code: isClaim ? 'claim_missing_direct_evidence' : 'composition_missing_direct_evidence',
        message: `${attribute.name} (${attribute.id}) links missing evidence "${evidenceId}".`,
      };
    }
    if (evidence.source === 'page_context') {
      return {
        proposalId: proposal.id,
        code: isClaim ? 'claim_page_context' : 'composition_page_context',
        message: `${attribute.name} (${attribute.id}) is supported only by Page context. Page context is review context, never direct product evidence.`,
      };
    }
    if (!DIRECT_EVIDENCE_SOURCES.has(evidence.source)) {
      return {
        proposalId: proposal.id,
        code: isClaim ? 'claim_unapproved_source' : 'composition_unapproved_source',
        message: `${attribute.name} (${attribute.id}) is supported by unapproved source "${evidence.source}". Claims and composition require direct product evidence (official product page, visual product evidence, or catalog product data).`,
      };
    }
  }

  return null;
}

/**
 * Validate every reviewable proposal in a run.
 *
 * `reviewable_abstention`, `primary_product_type`, and `category_page`
 * proposals carry no attribute value and are not claim-scoped; they pass.
 * `configuration_gap` proposals are advisory and pass.
 */
export function validateProposalSafety(
  proposals: ClassificationProposal[],
  context: ProposalSafetyContext,
): ProposalSafetyReport {
  const findings: ProposalSafetyFinding[] = [];

  for (const proposal of proposals) {
    if (proposal.proposalType !== 'field_assignment') continue;

    const attribute = context.attributes.find(candidate => candidate.id === proposal.targetId);
    if (!attribute) {
      // No attribute configuration: nothing to enforce for unknown attributes.
      continue;
    }

    const isClaim = attribute.isClaim === true;
    const isComposition = attribute.isCompositionAttribute === true;

    if (isClaim || isComposition) {
      // Contradictory or insufficient direct evidence withholds the proposal:
      // a claim/composition can never proceed through an unresolved conflict
      // (issue #17 H). Contradictions are never resolved by source order or
      // confidence.
      if (proposal.contradictingEvidenceIds && proposal.contradictingEvidenceIds.length > 0) {
        findings.push({
          proposalId: proposal.id,
          code: isClaim ? 'claim_contradicting_evidence' : 'composition_contradicting_evidence',
          message: `${attribute.name} (${attribute.id}) has ${proposal.contradictingEvidenceIds.length} contradicting evidence record(s). ${isClaim ? 'Claims' : 'Composition'} cannot proceed through a conflict.`,
        });
        continue;
      }
      const evidenceFinding = validateDirectEvidence(proposal, attribute, context);
      if (evidenceFinding) {
        findings.push(evidenceFinding);
        continue;
      }
      if (proposal.isBulkAcceptable === true) {
        findings.push({
          proposalId: proposal.id,
          code: isClaim ? 'bulk_accept_claim' : 'bulk_accept_composition',
          message: `${attribute.name} (${attribute.id}) is a ${isClaim ? 'claim' : 'composition'} attribute and can never be bulk-acceptable; it requires manual review.`,
        });
      }
    }

    // Value-shape validation (controlled membership, measured units).
    // Cardinality is enforced by the proposal builder (single truncation) and
    // delimiter policy by the shared serializer.
    const shapeFinding = validateSerializableValue(proposal.proposedValue, attribute);
    if (!shapeFinding.ok) {
      findings.push({ proposalId: proposal.id, code: shapeFinding.code as SafetyFindingCode, message: shapeFinding.message });
    }
  }

  return { ok: findings.length === 0, findings };
}
