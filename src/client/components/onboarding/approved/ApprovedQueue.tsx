/**
 * Epic #46 — Dense eligible-approved queue (reviewed, not yet approved).
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import { allSelected, type SelectionState } from './approved-logic';

interface ApprovedQueueProps {
  items: OnboardingWorkState[];
  selection: SelectionState;
  rejectedReasons: Map<string, string>;
  onToggle: (itemId: string) => void;
  onToggleAll: () => void;
}

export function ApprovedQueue({
  items,
  selection,
  rejectedReasons,
  onToggle,
  onToggleAll,
}: ApprovedQueueProps) {
  return (
    <div className="ow-list" style={{ marginTop: 'var(--spacing-sm)' }}>
      <label className="ow-row" style={{ cursor: 'pointer', minHeight: 44 }}>
        <input
          type="checkbox"
          checked={allSelected(selection)}
          onChange={() => onToggleAll()}
        />
        <span className="ow-row-main">
          <span className="ow-row-title">Select all {items.length} reviewed products</span>
        </span>
      </label>
      {items.map(item => {
        const reason = rejectedReasons.get(item.itemId);
        return (
          <label key={item.itemId} className="ow-row" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={selection.selectedIds.includes(item.itemId)}
              onChange={() => onToggle(item.itemId)}
            />
            <span className="ow-row-main">
              <span className="ow-row-title">{item.curatedTitle || item.name}</span>
              <span className="ow-row-sub">UPC {item.upc}{item.brand ? ` · ${item.brand}` : ''}</span>
            </span>
            <span className="ow-row-meta">
              {reason && (
                <span className="ow-chip ow-chip--attention" title={reason}>
                  Rejected · {reason}
                </span>
              )}
              <span className="ow-chip ow-chip--success">Reviewed</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
