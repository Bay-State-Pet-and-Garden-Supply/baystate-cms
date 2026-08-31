/**
 * Epic #46 — Processing grouped list (Phase 5).
 *
 * Renders processing items grouped by the server-derived activity
 * (Distributor Lookup → Official Site Search → Extracting Product Data →
 * Curating Product Family). Pure presentation over pre-computed groups.
 */
import React from 'react';
import type { ActivityGroup } from './processing-logic';
import { ProcessingStatus } from './ProcessingStatus';

interface ProcessingListProps {
  groups: ActivityGroup[];
  onViewFamily?: (cohortId: string) => void;
}

export function ProcessingList({ groups, onViewFamily }: ProcessingListProps) {
  if (groups.length === 0) {
    return (
      <div className="pw-empty">
        <p className="pw-empty-title">Nothing processing right now</p>
        <p className="pw-empty-copy">
          Automation is caught up. New uploads and resolved blockers will appear here as they run.
        </p>
      </div>
    );
  }
  return (
    <div className="pw-list">
      {groups.map((group) => (
        <section key={group.activity ?? 'other'} className="pw-group" aria-label={group.title}>
          <header className="pw-group-header">
            <h4 className="pw-group-title">{group.title}</h4>
            <span className="pw-group-count">{group.items.length}</span>
          </header>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {group.items.map((item) => (
              <ProcessingStatus key={item.itemId} item={item} onViewFamily={onViewFamily} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
