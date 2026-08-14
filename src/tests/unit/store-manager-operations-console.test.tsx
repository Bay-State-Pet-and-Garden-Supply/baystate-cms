// @vitest-environment jsdom
/**
 * Operations console (Issue 9) — nav / deep links / empty states UI smoke
 * tests. The console only routes and labels: all capability is server-gated
 * (flags from GET /console/state), nothing executes client-side, and there
 * is no automatic action anywhere.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { OperationsConsole, readViewFromHash, writeViewToHash } from '../../client/components/store-manager/OperationsConsole';
import { OperationsNav, type OperationsViewId } from '../../client/components/store-manager/OperationsNav';
import { OperationsEmptyState } from '../../client/components/store-manager/OperationsEmptyState';
import type { StoreManagerConsoleFlags } from '../../client/store-manager-api';

async function renderAsync(component: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        container.remove();
      });
    },
  };
}

function byText(container: HTMLElement, text: string): boolean {
  return container.textContent?.includes(text) ?? false;
}

const ALL_ON: StoreManagerConsoleFlags = {
  operationsConsoleEnabled: true,
  schedulesEnabled: true,
  eventTriggersEnabled: true,
  playbooksEnabled: true,
  bulkReviewEnabled: true,
  notificationsEnabled: true,
  killSwitch: false,
};

const ALL_OFF: StoreManagerConsoleFlags = {
  operationsConsoleEnabled: false,
  schedulesEnabled: false,
  eventTriggersEnabled: false,
  playbooksEnabled: false,
  bulkReviewEnabled: false,
  notificationsEnabled: false,
  killSwitch: false,
};

const VIEWS = [
  { id: 'chat' as const, label: 'Chat', icon: '💬' },
  { id: 'inbox' as const, label: 'Inbox', icon: '📥' },
  { id: 'schedules' as const, label: 'Schedules', icon: '⏰' },
  { id: 'triggers' as const, label: 'Triggers', icon: '⚡' },
  { id: 'playbooks' as const, label: 'Playbooks', icon: '📋' },
  { id: 'bulk' as const, label: 'Bulk Review', icon: '📦' },
  { id: 'history' as const, label: 'History', icon: '🕘' },
  { id: 'preferences' as const, label: 'Preferences', icon: '⚙' },
];

describe('Operations console (Issue 9)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('deep-link helpers read and write #sm-view=<id> without breaking the session', () => {
    writeViewToHash('inbox');
    expect(window.location.hash).toContain('sm-view=inbox');
    expect(readViewFromHash()).toBe('inbox');
    writeViewToHash('history');
    expect(readViewFromHash()).toBe('history');
    window.history.replaceState(null, '', '/');
    expect(readViewFromHash()).toBeNull();
  });

  it('OperationsNav renders all views, marks the active view, and moves focus with Arrow keys (roving tabindex)', async () => {
    const navigated: OperationsViewId[] = [];
    const { container, unmount } = await renderAsync(
      <OperationsNav
        views={VIEWS}
        activeView="inbox"
        onNavigate={(v) => navigated.push(v)}
      />,
    );
    try {
      const buttons = Array.from(container.querySelectorAll('button[aria-current]'));
      expect(buttons.length).toBe(1);
      expect(buttons[0].getAttribute('aria-label')).toContain('Inbox');
      expect(byText(container, 'Chat')).toBe(true);
      expect(byText(container, 'Bulk Review')).toBe(true);

      // ArrowRight moves focus to the next enabled view.
      const chatButton = container.querySelector('button[aria-label="Chat"]') as HTMLButtonElement | null;
      expect(chatButton).toBeTruthy();
      chatButton!.focus();
      chatButton!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const focused = document.activeElement as HTMLElement | null;
      expect(focused?.textContent).toContain('Inbox');

      // Clicking navigates (no automatic action beyond navigation).
      const historyButton = container.querySelector('button[aria-label="History"]') as HTMLButtonElement | null;
      historyButton!.click();
      expect(navigated).toContain('history');
    } finally {
      await unmount();
    }
  });

  it('OperationsConsole renders the active view, disabled flag-off views show the empty state, and the kill switch freezes run views while keeping reads labeled', async () => {
    const navigated: OperationsViewId[] = [];
    const { container, unmount } = await renderAsync(
      <OperationsConsole
        flags={ALL_OFF}
        activeView="inbox"
        onNavigate={(v) => navigated.push(v)}
        views={VIEWS}
        renderView={(view) => <div data-testid={`view-${view}`}>view body {view}</div>}
      />,
    );
    try {
      // Inbox gated by operationsConsoleEnabled=off → empty state, no view body.
      expect(container.querySelector('[data-testid="view-inbox"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="operations-empty-flag-off"]')).toBeTruthy();
    } finally {
      await unmount();
    }

    // All-on: the active view body renders and disabled reasons disappear.
    const { container: c2, unmount: u2 } = await renderAsync(
      <OperationsConsole
        flags={ALL_ON}
        activeView="schedules"
        onNavigate={(v) => navigated.push(v)}
        views={VIEWS}
        renderView={(view) => <div data-testid={`view-${view}`}>view body {view}</div>}
      />,
    );
    try {
      expect(c2.querySelector('[data-testid="view-schedules"]')).toBeTruthy();
    } finally {
      await u2();
    }

    // Kill switch: run-producing views disabled, inbox/history stay reachable.
    const { container: c3, unmount: u3 } = await renderAsync(
      <OperationsConsole
        flags={{ ...ALL_ON, killSwitch: true }}
        activeView="chat"
        onNavigate={(v) => navigated.push(v)}
        views={VIEWS}
        renderView={(view) => <div data-testid={`view-${view}`}>view body {view}</div>}
      />,
    );
    try {
      const chatButton = c3.querySelector('button[aria-label^="Chat"]') as HTMLButtonElement | null;
      expect(chatButton?.getAttribute('aria-disabled')).toBe('true');
      // Inbox is a read surface — stays enabled under the kill switch.
      const inboxButton = c3.querySelector('button[aria-label="Inbox"]') as HTMLButtonElement | null;
      expect(inboxButton?.getAttribute('aria-disabled')).toBeFalsy();
      // Kill-switch empty state for the (frozen) active chat view.
      expect(c3.querySelector('[data-testid="operations-empty-kill-switch"]')).toBeTruthy();
    } finally {
      await u3();
    }
  });

  it('ships enabled by default: core surfaces render while only the opt-in automation views show the disabled state', async () => {
    const DEFAULT_FLAGS: StoreManagerConsoleFlags = {
      operationsConsoleEnabled: true,
      schedulesEnabled: false,
      eventTriggersEnabled: false,
      playbooksEnabled: false,
      bulkReviewEnabled: false,
      notificationsEnabled: false,
      killSwitch: false,
    };
    // Core shipped surfaces render with default flags — no disabled banner.
    for (const view of ['inbox', 'preferences', 'history', 'chat'] as const) {
      const { container, unmount } = await renderAsync(
        <OperationsConsole
          flags={DEFAULT_FLAGS}
          activeView={view}
          onNavigate={() => undefined}
          views={VIEWS}
          renderView={(v) => <div data-testid={`view-${v}`}>view body {v}</div>}
        />,
      );
      try {
        expect(container.querySelector(`[data-testid="view-${view}"]`)).toBeTruthy();
        expect(container.querySelector('[data-testid="operations-empty-flag-off"]')).toBeFalsy();
      } finally {
        await unmount();
      }
    }
    // Opt-in automation views show the per-surface disabled state by default.
    for (const view of ['schedules', 'triggers', 'playbooks', 'bulk'] as const) {
      const { container, unmount } = await renderAsync(
        <OperationsConsole
          flags={DEFAULT_FLAGS}
          activeView={view}
          onNavigate={() => undefined}
          views={VIEWS}
          renderView={(v) => <div data-testid={`view-${v}`}>view body {v}</div>}
        />,
      );
      try {
        expect(container.querySelector(`[data-testid="view-${view}"]`)).toBeFalsy();
        const empty = container.querySelector('[data-testid="operations-empty-flag-off"]');
        expect(empty).toBeTruthy();
        // The copy names the exact env flag for this surface.
        expect(empty!.textContent).toContain('BAYSTATE_CMS_STORE_MANAGER');
      } finally {
        await unmount();
      }
    }
  });

  it('OperationsEmptyState is purely presentational and offers no automatic action', async () => {
    const { container, unmount } = await renderAsync(
      <OperationsEmptyState
        reason="flag-off"
        title="Inert by default"
        description="Enable the matching flag to use this surface."
      />,
    );
    try {
      expect(byText(container, 'Inert by default')).toBe(true);
      expect(container.querySelector('button')).toBeFalsy();
      expect(container.querySelector('a')).toBeFalsy();
      expect(container.querySelector('[data-testid="operations-empty-flag-off"]')).toBeTruthy();
    } finally {
      await unmount();
    }
  });
});
