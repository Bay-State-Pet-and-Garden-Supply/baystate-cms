/**
 * Review readiness panel (story e10s03, epic #review-final-gate).
 *
 * Record-level mandatory-checklist + warnings display wired to the e10s01
 * gate codes. /impeccable Operate mode: scanable text-first status — every
 * entry names its field in TEXT (SC 3.3.1), status is never color-only
 * (each row carries the literal "Blocking"/"Warning" label, SC 1.4.1), and
 * blocker rows are jump-to-fix controls that move focus to the offending
 * field (SC 3.3.3 recovery path).
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';
import type { ItemDetailResponse } from '../../../onboarding-api';
import {
  deriveReadiness,
  focusJumpTarget,
  gateMessageId,
  gateText,
  jumpTargetFor,
  type ReviewReadiness,
} from './review-readiness';

export interface ReviewReadinessPanelProps {
  detail: ItemDetailResponse | null;
  workState?: ReviewQueueRow | OnboardingWorkState | null;
  /** Pre-derived readiness (used when the caller already holds one). */
  readiness?: ReviewReadiness;
  /** Present ⇒ blocker/warning rows are focus-jump buttons. */
  enableJump?: boolean;
  /**
   * Called with the jump target id when the reviewer activates a row.
   * When provided it REPLACES direct focusing so the parent can enter
   * edit mode before focus moves (field targets only exist while editing).
   */
  onJumpRequest?: (targetId: string) => void;
}

export function resolvePanelReadiness(
  detail: ItemDetailResponse | null,
  workState?: ReviewQueueRow | OnboardingWorkState | null,
): ReviewReadiness {
  return deriveReadiness(detail, workState);
}

export function ReviewReadinessPanel({
  detail,
  workState,
  readiness,
  enableJump = true,
  onJumpRequest,
}: ReviewReadinessPanelProps) {
  const view = readiness ?? resolvePanelReadiness(detail, workState);
  const jump = (code: string) => {
    if (!enableJump) return;
    const target = jumpTargetFor(code);
    if (!target) return;
    if (onJumpRequest) {
      onJumpRequest(target);
      return;
    }
    focusJumpTarget(target);
  };

  return (
    <section className="rv-panel rv-readiness" aria-label="Review readiness">
      <header className="rv-panel-head">Review readiness</header>
      <div className="rv-panel-body rv-readiness-body">
        {view.blockers.length === 0 ? (
          <p className="rv-readiness-ok" role="status">
            Ready — all mandatory checks pass
            {!view.authoritative && ' (advisory check; the server verifies on completion)'}
          </p>
        ) : (
          <ul className="rv-readiness-list" aria-label="Blocking checks">
            {view.blockers.map((code) => {
              const target = jumpTargetFor(code);
              const label = `Blocking — ${gateText(code)}`;
              return (
                <li key={code} className="rv-readiness-row rv-readiness-row-blocker">
                  <span className="rv-readiness-status" aria-hidden="true">
                    Blocking
                  </span>
                  {enableJump && target ? (
                    <button
                      type="button"
                      id={gateMessageId(code)}
                      className="rv-readiness-fix"
                      onClick={() => jump(code)}
                      title={`Go to the field to fix: ${gateText(code)}`}
                    >
                      {label}
                      <span className="rv-readiness-fix-hint" aria-hidden="true">
                        Fix →
                      </span>
                    </button>
                  ) : (
                    <span id={gateMessageId(code)}>{label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {view.warnings.length > 0 && (
          <ul className="rv-readiness-list" aria-label="Warnings">
            {view.warnings.map((code) => {
              const target = jumpTargetFor(code);
              const label = `Warning — ${gateText(code)}`;
              return (
                <li key={code} className="rv-readiness-row rv-readiness-row-warning">
                  <span className="rv-readiness-status" aria-hidden="true">
                    Warning
                  </span>
                  {enableJump && target ? (
                    <button
                      type="button"
                      className="rv-readiness-fix"
                      onClick={() => jump(code)}
                      title={`Go to the field: ${gateText(code)}`}
                    >
                      {label}
                      <span className="rv-readiness-fix-hint" aria-hidden="true">
                        Review →
                      </span>
                    </button>
                  ) : (
                    <span>{label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {view.notes.map((note, idx) => (
          <p key={idx} className="rv-readiness-note">
            {note}
          </p>
        ))}
      </div>
    </section>
  );
}
