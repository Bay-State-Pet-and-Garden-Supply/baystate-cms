/**
 * Epic #46 — Shared action bar for approval + export views.
 * Selected-count-aware primary/secondary buttons with per-action outcome
 * reporting. Pure presentation; state lives in the parent views.
 */
interface ExportActionsProps {
  /** Primary action button. */
  primaryLabel: string;
  /** Secondary action button (e.g. select all / approve all). */
  secondaryLabel?: string;
  primaryDisabled: boolean;
  secondaryDisabled?: boolean;
  busy: boolean;
  onPrimary: () => void;
  onSecondary?: () => void;
  /** Context line under the buttons. */
  hint?: string;
}

export function ExportActions({
  primaryLabel,
  secondaryLabel,
  primaryDisabled,
  secondaryDisabled,
  busy,
  onPrimary,
  onSecondary,
  hint,
}: ExportActionsProps) {
  return (
    <div className="ow-actions-bar">
      <button
        type="button"
        className="btn btn-primary"
        onClick={onPrimary}
        disabled={primaryDisabled || busy}
      >
        {busy ? 'Working…' : primaryLabel}
      </button>
      {secondaryLabel && onSecondary && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onSecondary}
          disabled={secondaryDisabled || busy}
        >
          {secondaryLabel}
        </button>
      )}
      {hint && <span className="ow-audit-line">{hint}</span>}
    </div>
  );
}
