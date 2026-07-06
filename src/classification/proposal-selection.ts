/**
 * Provisional proposal selection helpers for the classification pipeline.
 *
 * During first-pass curation (before human review), downstream stages need
 * a "best available" proposal to work with — even if it hasn't been accepted
 * yet. These helpers bridge that gap by trying accepted proposals first,
 * then falling back to the highest-confidence pending/deferred proposal.
 *
 * Provisional selection does NOT mutate proposal status and does NOT
 * auto-accept. The selection is purely for downstream computation and
 * draft preview. All proposals remain pending for the Review stage.
 */
import type { StageInput } from './types';
import type { ClassificationProposal } from '../shared/schemas/classification';

export interface ProposalSelection {
  /** The selected proposal, or null if none available */
  proposal: ClassificationProposal | null;
  /** How the proposal was selected */
  source: 'accepted' | 'provisional' | null;
}

/**
 * Select the best available Primary Product Type proposal for a stage input.
 *
 * Selection order:
 * 1. An accepted `primary_product_type` proposal (human-reviewed)
 * 2. The highest-confidence non-stale `primary_product_type` proposal
 *    with status `pending` or `deferred` (provisional)
 *
 * @returns The selection result with proposal and source indicator
 */
export function selectPrimaryProductTypeProposal(input: StageInput): ProposalSelection {
  // 1. Look for an accepted proposal first
  const accepted = input.acceptedProposals.find(
    p => p.proposalType === 'primary_product_type' && p.status === 'accepted',
  );
  if (accepted) {
    return { proposal: accepted, source: 'accepted' };
  }

  // 2. Fall back to the best pending/deferred proposal
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
