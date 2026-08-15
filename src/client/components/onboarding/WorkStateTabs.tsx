import React from 'react';
import type { WorkStateCounts } from '../../../shared/schemas/onboarding-work-state';
import {
  attentionIsUrgent,
  formatCount,
  getTabCount,
  WORKSPACE_TABS,
  type WorkspaceTabId,
} from './batch-workspace-logic';

/**
 * Epic #46 — Work-state tab bar (UX workstream 1).
 *
 * Tab order is fixed: Needs Attention first, then Processing, Waiting on
 * Family, Review, Approved. Badges show live server-derived counts; the
 * Needs Attention badge turns urgent (accent) whenever its count is non-zero.
 */

export interface WorkStateTabsProps {
  activeId: WorkspaceTabId;
  counts: WorkStateCounts;
  onChange: (id: WorkspaceTabId) => void;
}

export function WorkStateTabs({ activeId, counts, onChange }: WorkStateTabsProps) {
  const urgent = attentionIsUrgent(counts);

  return (
    <div className="bws-tabs" role="tablist" aria-label="Operator work states">
      {WORKSPACE_TABS.map(tab => {
        const count = getTabCount(tab, counts);
        const selected = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`bws-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls="bws-tabpanel"
            className="bws-tab"
            title={tab.description}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            <span
              className={`bws-tab-count${tab.id === 'needs_attention' && urgent ? ' bws-tab-count--urgent' : ''}`}
              aria-label={`${count} ${tab.label.toLowerCase()}`}
            >
              {formatCount(count)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
