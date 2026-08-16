/**
 * Epic #46 — Review queue (Phase 6).
 *
 * High-density product list: review-state icon, primary image thumbnail,
 * curated/imported title, UPC, brand, source chip, family badge, warning
 * badge, reviewed state. Rows are keyboard-accessible (ArrowUp/Down handled
 * by the workspace).
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ItemDetailResponse } from '../../../onboarding-api';
import { isReviewed, itemDisplayName, sourceTypeLabel } from './review-logic';

export interface ReviewQueueProps {
  items: OnboardingWorkState[];
  currentItemId: string | null;
  /** Enriched detail cache (for thumbnails + warning badges). */
  details: Map<string, ItemDetailResponse>;
  /** Item ids known to carry warnings (enriched). */
  warnedIds: Set<string>;
  /** Item ids edited during this session. */
  editedIds: Set<string>;
  /** Bulk-review selection (epic #46 follow-up, phase 4). */
  selectedIds?: Set<string>;
  onToggleSelected?: (itemId: string) => void;
  emptyMessage: string;
  onSelect: (itemId: string) => void;
}

export function ReviewQueue({
  items,
  currentItemId,
  details,
  warnedIds,
  editedIds,
  selectedIds = new Set(),
  onToggleSelected,
  emptyMessage,
  onSelect,
}: ReviewQueueProps) {
  if (items.length === 0) {
    return <div className="rv-state-note">{emptyMessage}</div>;
  }

  return (
    <ul className="rv-queue-list" role="listbox" aria-label="Review queue" aria-activedescendant={currentItemId ?? undefined}>
      {items.map(item => (
        <ReviewQueueRow
          key={item.itemId}
          item={item}
          active={item.itemId === currentItemId}
          detail={details.get(item.itemId) ?? null}
          warned={warnedIds.has(item.itemId)}
          edited={editedIds.has(item.itemId)}
          selected={onToggleSelected ? selectedIds.has(item.itemId) : false}
          onSelect={onSelect}
          onToggleSelected={onToggleSelected}
        />
      ))}
    </ul>
  );
}

function ReviewQueueRow({
  item,
  active,
  detail,
  warned,
  edited,
  selected,
  onSelect,
  onToggleSelected,
}: {
  item: OnboardingWorkState;
  active: boolean;
  detail: ItemDetailResponse | null;
  warned: boolean;
  edited: boolean;
  selected: boolean;
  onSelect: (itemId: string) => void;
  onToggleSelected?: (itemId: string) => void;
}) {
  const ext = detail?.extraction ?? detail?.item.extractionData ?? null;
  const image = ext?.primaryImage ?? null;
  const curatedTitle = detail?.item.curationData?.curatedTitle ?? null;
  const title = itemDisplayName(item, curatedTitle);
  const brand = item.brand ?? detail?.item.brandHint ?? null;
  const reviewed = isReviewed(item);

  return (
    <li
      id={item.itemId}
      role="option"
      aria-selected={active}
      className={`rv-queue-row${active ? ' rv-row-active' : ''}${selected ? ' rv-row-selected' : ''}${onToggleSelected ? ' rv-row-selectable' : ''}`}
      onClick={() => onSelect(item.itemId)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(item.itemId);
        }
      }}
      tabIndex={-1}
    >
      {onToggleSelected && (
        <span className="rv-row-checkbox" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Select ${title} for bulk review`}
            checked={selected}
            onChange={() => onToggleSelected(item.itemId)}
          />
        </span>
      )}
      <span className={image ? undefined : 'rv-row-thumb rv-no-thumb'}>
        {image ? (
          <img className="rv-row-thumb" src={image} alt="" aria-hidden="true" loading="lazy" />
        ) : (
          <>📦</>
        )}
      </span>

      <span className="rv-row-main">
        <span className="rv-row-title" title={title}>
          {title}
        </span>
        <span className="rv-row-meta">
          <span style={{ fontFamily: 'var(--font-mono)' }}>{item.upc}</span>
          {brand ? <span>{brand}</span> : null}
          {item.family ? (
            <span className="rv-badge rv-badge-family" title={`${item.family.label ?? 'Family'} — ${item.family.readyCount}/${item.family.memberCount} ready`}>
              👪 {item.family.readyCount}/{item.family.memberCount}
            </span>
          ) : null}
        </span>
      </span>

      <span className="rv-row-checks">
        <span
          className={`rv-badge ${reviewed ? 'rv-badge-review' : 'rv-badge-unreviewed'}`}
          title={reviewed ? 'Durably reviewed' : 'Not yet reviewed'}
        >
          {reviewed ? '✓ reviewed' : 'unreviewed'}
        </span>
        <span className="rv-row-meta" style={{ justifyContent: 'flex-end' }}>
          <span className="rv-badge rv-badge-source">{sourceTypeLabel(item.sourceType)}</span>
          {warned && <span className="rv-badge rv-badge-warn" title="Warnings present">⚠</span>}
          {edited && <span className="rv-badge rv-badge-warn" title="Edited during review">edit</span>}
        </span>
      </span>
    </li>
  );
}