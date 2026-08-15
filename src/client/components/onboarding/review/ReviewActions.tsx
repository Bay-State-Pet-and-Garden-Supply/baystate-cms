/**
 * Epic #46 — Review actions bar (Phase 6).
 *
 * Primary rhythm: [Looks Good & Next] → durable reviewed → auto-advance to the
 * next unreviewed product. Previous/next, edit toggle, and disabled states for
 * blocked items are all guarded here.
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ItemDetailResponse } from '../../../onboarding-api';
import { warningInfoFromDetail } from './review-logic';

export interface ReviewActionsProps {
  workState: OnboardingWorkState | null;
  detail: ItemDetailResponse | null;
  busy: boolean;
  editing: boolean;
  allReviewed: boolean;
  /** Preferred keyboard shortcut for Looks Good & Next (for the hint). */
  shortcutKey?: string;
  onLooksGood: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggleEdit: () => void;
}

export function ReviewActions({
  workState,
  detail,
  busy,
  editing,
  allReviewed,
  shortcutKey = 'G',
  onLooksGood,
  onPrevious,
  onNext,
  onToggleEdit,
}: ReviewActionsProps) {
  const blocked = workState ? warningInfoFromDetail(detail ?? {}).blocked : false;

  return (
    <div className="rv-actions">
      <button
        type="button"
        className="rv-btn rv-btn-primary"
        onClick={onLooksGood}
        disabled={!workState || busy || blocked || editing}
        title={`Mark reviewed and open the next unreviewed product${blocked ? ' (blocked — resolve warnings first)' : ''} (${shortcutKey})`}
      >
        {busy ? 'Saving…' : 'Looks Good & Next'}
      </button>

      <button
        type="button"
        className="rv-btn rv-btn-secondary"
        onClick={onPrevious}
        disabled={!workState || busy}
        title="Previous product (←)"
      >
        ← Prev
      </button>
      <button
        type="button"
        className="rv-btn rv-btn-secondary"
        onClick={onNext}
        disabled={!workState || busy}
        title="Next product (→)"
      >
        Next →
      </button>

      <button
        type="button"
        className="rv-btn rv-btn-secondary"
        onClick={onToggleEdit}
        disabled={!workState || busy}
        title={editing ? 'Cancel editing' : 'Edit listing fields'}
      >
        {editing ? 'Cancel edit' : 'Edit'}
      </button>

      {!workState && !allReviewed && (
        <span className="rv-shortcut-hint">Select a product to begin reviewing.</span>
      )}
      {allReviewed && (
        <span className="rv-shortcut-hint" role="status">
          All products reviewed — ready for bulk approval in the Approved tab.
        </span>
      )}
    </div>
  );
}