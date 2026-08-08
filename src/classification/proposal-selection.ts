/**
 * Proposal selection helpers for the classification pipeline.
 *
 * Selection is split into two distinct contracts:
 *
 * 1. ACCEPTED selection (`selectAcceptedPrimaryProductType`) — the reviewed
 *    Primary Product Type. This is the ONLY authority that may unlock
 *    type-gated attribute and Page proposals. Pending guesses never unlock
 *    decision-eligible proposals.
 * 2. PREVIEW selection (`selectPrimaryProductTypeProposal`) — the "best
 *    available" proposal (accepted first, then highest-confidence pending)
 *    used ONLY for UI/draft preview. It never authorizes type-gated
 *    proposals and never mutates proposal status.
 *
 * Reviewed facts carried from prior runs (via the immutable runtime snapshot)
 * are also a legitimate source for the accepted type: a fact is accepted,
 * non-superseded, and provenance-compatible by construction of the snapshot.
 */
import type { StageInput } from './types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import type { ReviewedFact } from './reviewed-facts';
import type { ClassificationProposal } from '../shared/schemas/classification';
import { getProductTypeIdFromValue } from './assignment-projection';

export interface ProposalSelection {
  /** The selected proposal, or null if none available */
  proposal: ClassificationProposal | null;
  /** How the proposal was selected */
  source: 'accepted' | 'provisional' | null;
}

/**
 * Select the reviewed (accepted) Primary Product Type proposal from the run
 * input. Pending/deferred guesses are never accepted selections.
 */
export function selectAcceptedPrimaryProductType(input: StageInput): ProposalSelection {
  const accepted = input.acceptedProposals.find(
    p => p.proposalType === 'primary_product_type' && p.status === 'accepted',
  );
  if (accepted) {
    return { proposal: accepted, source: 'accepted' };
  }
  return { proposal: null, source: null };
}

/**
 * Select the best available Primary Product Type proposal for UI/draft preview
 * only. Selection order: an accepted proposal, then the highest-confidence
 * non-stale pending/deferred proposal. This never authorizes gating.
 */
export function selectPrimaryProductTypeProposal(input: StageInput): ProposalSelection {
  const accepted = selectAcceptedPrimaryProductType(input);
  if (accepted.proposal) return accepted;

  const provisional = input.allProposals
    .filter(
      p =>
        p.proposalType === 'primary_product_type' &&
        !p.isStale &&
        (p.status === 'pending' || p.status === 'deferred'),
    )
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null;

  if (provisional) {
    return { proposal: provisional, source: 'provisional' };
  }

  return { proposal: null, source: null };
}

/**
 * Extract a Product Type ID from a carried reviewed fact. The accepted value
 * is either the proposed shape { productTypeId } or a plain string id.
 */
export function getProductTypeIdFromFact(fact: ReviewedFact): string | null {
  return getProductTypeIdFromValue(fact.value);
}

/**
 * Resolve the one reviewed (accepted) Primary Product Type identity for a run:
 * in-run accepted proposals first, then provenance-compatible reviewed facts
 * carried in the immutable snapshot. Returns null when no reviewed type exists
 * — type-gated proposals must then be withheld (fail closed).
 */
export function getReviewedPrimaryProductTypeId(
  input: StageInput,
  snapshot?: RuntimeClassificationSnapshot,
): string | null {
  const accepted = selectAcceptedPrimaryProductType(input);
  if (accepted.proposal) {
    const id = getProductTypeIdFromValue(accepted.proposal.proposedValue) ?? accepted.proposal.targetId;
    if (id && id.length > 0) return id;
  }
  if (snapshot?.reviewedFacts?.length) {
    for (const fact of snapshot.reviewedFacts) {
      if (fact.proposalType !== 'primary_product_type') continue;
      const id = getProductTypeIdFromFact(fact);
      if (id && id.length > 0) return id;
    }
  }
  return null;
}
