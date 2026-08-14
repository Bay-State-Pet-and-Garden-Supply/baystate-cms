import React, { useEffect } from 'react';
import type { StoreManagerConsoleFlags } from '../../store-manager-api';
import {
  OperationsNav,
  type OperationsViewDescriptor,
  type OperationsViewId,
} from './OperationsNav';
import { OperationsEmptyState } from './OperationsEmptyState';

/**
 * Operations console (Issue 9) — the composed operations surface.
 *
 * Owns deep links (`#sm-view=<view>`), the accessible nav, and per-view
 * rendering. A view that is feature-flagged off renders an honest empty
 * state; under the kill switch the nav shows the frozen notice and every
 * run-producing view is disabled while history/inbox stays reachable. The
 * actual view panels are injected by the parent (StoreManagerAssistant)
 * through `renderView` — this component only routes and labels, it never
 * executes or mutates anything itself.
 */
export interface OperationsConsoleProps {
  activeView: OperationsViewId;
  onNavigate: (view: OperationsViewId) => void;
  flags: StoreManagerConsoleFlags;
  views: OperationsViewDescriptor[];
  renderView: (view: OperationsViewId) => React.ReactNode;
}

/** Read the deep-link view from the URL hash (`#sm-view=inbox`). */
export function readViewFromHash(): OperationsViewId | null {
  if (typeof window === 'undefined') return null;
  const match = /#sm-view=([a-z_]+)/.exec(window.location.hash);
  if (!match) return null;
  const view = match[1] as OperationsViewId;
  return view;
}

export function writeViewToHash(view: OperationsViewId): void {
  if (typeof window === 'undefined') return;
  try {
    const base = window.location.hash.replace(/#sm-view=[a-z_]+&?/, '');
    const next = `#sm-view=${view}${base ? `&${base.replace(/^#/, '')}` : ''}`;
    window.history.replaceState(null, '', next);
  } catch {
    /* hash replacement must never break the session */
  }
}

/** A view is run-producing (disabled under the kill switch); history/inbox stay readable. */
const RUN_PRODUCING: OperationsViewId[] = ['chat', 'schedules', 'triggers', 'playbooks', 'bulk'];

const FLAG_KEY: Partial<Record<OperationsViewId, keyof StoreManagerConsoleFlags>> = {
  inbox: 'operationsConsoleEnabled',
  schedules: 'schedulesEnabled',
  triggers: 'eventTriggersEnabled',
  playbooks: 'playbooksEnabled',
  bulk: 'bulkReviewEnabled',
  preferences: 'operationsConsoleEnabled',
};

export function OperationsConsole({ activeView, onNavigate, flags, views, renderView }: OperationsConsoleProps) {
  // Deep link: apply a hash view on first mount (after the parent seeded state).
  useEffect(() => {
    const hashView = readViewFromHash();
    if (hashView && hashView !== activeView) onNavigate(hashView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link: keep the hash in sync with the active view.
  useEffect(() => {
    writeViewToHash(activeView);
  }, [activeView]);

  const disabledReasons = new Map<OperationsViewId, string>();
  for (const view of views) {
    const flag = FLAG_KEY[view.id];
    if (flag && !flags[flag]) {
      disabledReasons.set(
        view.id,
        view.id === 'schedules'
          ? 'Scheduled runs are disabled (feature flag off).'
          : view.id === 'triggers'
            ? 'Event triggers are disabled (feature flag off).'
            : view.id === 'playbooks'
              ? 'Playbooks are disabled (feature flag off).'
              : view.id === 'bulk'
                ? 'Bulk review is disabled (feature flag off).'
                : 'The operations console is disabled (feature flag off).',
      );
    }
    if (flags.killSwitch && RUN_PRODUCING.includes(view.id)) {
      disabledReasons.set(view.id, 'New Store Manager runs are frozen by the kill switch. History and Inbox remain readable.');
    }
  }

  const viewsWithState = views.map((view) => ({
    ...view,
    disabledReason: disabledReasons.get(view.id),
  }));

  const activeViewDisabled = disabledReasons.get(activeView) !== undefined;

  return (
    <section data-testid="operations-console" aria-label="Store Manager operations console">
      <OperationsNav
        views={viewsWithState}
        activeView={activeView}
        onNavigate={onNavigate}
        killSwitch={flags.killSwitch}
      />

      {activeViewDisabled ? (
        flags.killSwitch && RUN_PRODUCING.includes(activeView) ? (
          <div style={{ padding: '16px 0' }}>
            <OperationsEmptyState
              reason="kill-switch"
              title="Runs are frozen"
              description="The global kill switch is on: no new runs, claims, or resumes can start. Run history and the Manager Inbox stay readable so you can keep reviewing past work."
            />
          </div>
        ) : (
          <div style={{ padding: '16px 0' }}>
            <OperationsEmptyState
              reason="flag-off"
              title="This surface is inert by default"
              description="This Store Manager surface ships disabled. Enable the matching BAYSTATE_CMS_STORE_MANAGER_* flag (or the future Settings toggle) to use it — nothing here runs without an explicit opt-in."
            />
          </div>
        )
      ) : (
        renderView(activeView)
      )}
    </section>
  );
}

export type { OperationsViewId } from './OperationsNav';
export type { OperationsViewDescriptor } from './OperationsNav';
