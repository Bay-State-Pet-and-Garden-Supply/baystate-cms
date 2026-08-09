import React from 'react';
import type { EvidenceCitationRow } from '../../classification-evidence-view';
import { safeSourceUrl } from '../../classification-evidence-view';

interface EvidenceCitationListProps {
  rows: EvidenceCitationRow[];
  /** Whether the reviewer may toggle citations on/off for the current decision. */
  selectable?: boolean;
  /** Currently selected citation ids (when selectable). */
  selectedIds?: string[];
  onToggleCitation?: (evidenceId: string) => void;
  /** True to show the explicit "no citation supplied" state. */
  showUncited?: boolean;
  isUncited?: boolean;
}

const ROLE_LABEL: Record<EvidenceCitationRow['role'], string> = {
  supporting: 'Supporting',
  contradicting: 'Contradicting',
  context: 'Context',
  legacy: 'Legacy',
  missing: 'Missing',
};

/**
 * Renders proposal-linked evidence grouped by role with source, reliability,
 * bounded snippet/value, and a safe source link. React escaping applies to all
 * text; URLs are restricted to http/https via `safeSourceUrl`.
 */
export function EvidenceCitationList({
  rows,
  selectable = false,
  selectedIds = [],
  onToggleCitation,
  showUncited = false,
  isUncited = false,
}: EvidenceCitationListProps) {
  if (rows.length === 0) {
    if (showUncited && isUncited) {
      return <p className="text-xs text-gray-500">No citation supplied for this correction.</p>;
    }
    return <p className="text-xs text-gray-500">No linked evidence for this proposal.</p>;
  }

  const selected = new Set(selectedIds);
  const grouped = new Map<EvidenceCitationRow['role'], EvidenceCitationRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.role) ?? [];
    list.push(row);
    grouped.set(row.role, list);
  }
  const order: EvidenceCitationRow['role'][] = ['supporting', 'contradicting', 'context', 'legacy', 'missing'];

  return (
    <div className="space-y-2">
      {order.flatMap(role => {
        const list = grouped.get(role) ?? [];
        if (list.length === 0) return [];
        return [
          <div key={role}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">
              {ROLE_LABEL[role]} ({list.length})
            </h4>
            <ul className="mt-1 space-y-1">
              {list.map(row => {
                const link = safeSourceUrl(row.sourceUrl);
                const isSelected = selected.has(row.evidenceId);
                return (
                  <li
                    key={row.evidenceId}
                    className="rounded border border-gray-200 bg-white px-2 py-1 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-medium">{row.source || 'unknown source'}</span>
                        {row.reliability ? (
                          <span className="ml-1 text-gray-500">· {row.reliability}</span>
                        ) : null}
                        {row.snippet ? (
                          <p className="mt-0.5 text-gray-700">{row.snippet}</p>
                        ) : row.value ? (
                          <p className="mt-0.5 text-gray-700">{row.value}</p>
                        ) : null}
                        {link ? (
                          <a
                            href={link}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-0.5 inline-block break-all text-blue-600 underline"
                          >
                            {link}
                          </a>
                        ) : null}
                      </div>
                      {selectable && onToggleCitation ? (
                        <label className="ml-2 flex shrink-0 items-center gap-1">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => onToggleCitation(row.evidenceId)}
                          />
                          <span className="text-gray-600">cite</span>
                        </label>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>,
        ];
      })}
      {showUncited && isUncited ? (
        <p className="text-xs text-gray-500">No citation supplied for this correction.</p>
      ) : null}
    </div>
  );
}
