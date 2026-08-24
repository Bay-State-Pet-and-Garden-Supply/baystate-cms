/**
 * Final confirmation step before durable review (story e10s03, epic
 * #review-final-gate).
 *
 * Shown by ReviewWorkspace only when the item was edited during the session
 * AND at least one mandatory-check value changed (the "no changes" case
 * short-circuits straight to approve — zero added friction on the dominant
 * clean-pass path). Compact effective-value diff of the five promotion-gate
 * fields, pre-edit vs current, plus non-blocking warnings. /impeccable
 * Operate mode: a plain ledger table, no decoration.
 */
import type { GateValueDiffRow } from './review-readiness';
import { gateText } from './review-readiness';
import type { ReviewCompletenessWarningCode } from '../../../../shared/schemas/onboarding';

export interface ReviewConfirmStepProps {
  open: boolean;
  diffRows: GateValueDiffRow[];
  warnings: ReviewCompletenessWarningCode[];
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
}

export function hasChangesToConfirm(diffRows: GateValueDiffRow[]): boolean {
  return diffRows.length > 0;
}

/**
 * The full confirm-gate decision used by ReviewWorkspace.handleLooksGood:
 * the modal opens ONLY for a session-edited item with at least one changed
 * mandatory-check value. Extracted pure so the "appears iff edited AND
 * changed" acceptance criterion is unit-testable without mounting the
 * workspace.
 */
export function shouldOpenConfirmStep(
  itemId: string,
  editedIds: ReadonlySet<string>,
  diffRows: GateValueDiffRow[],
): boolean {
  return editedIds.has(itemId) && hasChangesToConfirm(diffRows);
}

export function ReviewConfirmStep({
  open,
  diffRows,
  warnings,
  busy,
  onApprove,
  onCancel,
}: ReviewConfirmStepProps) {
  if (!open) return null;
  return (
    <div className="rv-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="rv-modal rv-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm review"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="rv-modal-title">Confirm edits before marking reviewed</h3>
        <p className="rv-modal-body">
          This product was edited during this session. Confirm what promotion will use:
        </p>
        <table className="rv-confirm-diff">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Before edits</th>
              <th scope="col">Will be promoted as</th>
            </tr>
          </thead>
          <tbody>
            {diffRows.map((row) => (
              <tr key={row.field}>
                <th scope="row">{row.field}</th>
                <td>{row.previous}</td>
                <td>{row.current}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {warnings.length > 0 && (
          <ul className="rv-confirm-warnings" aria-label="Non-blocking warnings">
            {warnings.map((code) => (
              <li key={code}>Warning — {gateText(code)}</li>
            ))}
          </ul>
        )}
        <p className="rv-modal-body rv-confirm-note">
          Marking reviewed is durable; later edits return the product for re-review.
        </p>
        <div className="rv-modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>
            Keep editing
          </button>
          <button type="button" className="btn btn-primary" onClick={onApprove} disabled={busy}>
            {busy ? 'Saving…' : 'Confirm & mark reviewed'}
          </button>
        </div>
      </div>
    </div>
  );
}
