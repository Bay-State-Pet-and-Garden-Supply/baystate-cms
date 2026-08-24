import React, { useRef } from 'react';

/**
 * Accessible settings tab shell (P1 UI revamp).
 *
 * Renders an ARIA tablist with roving tabindex and arrow-key/Home/End
 * navigation, plus a matching `SettingsTabPanel` for each tab body.
 * Tab ids are exposed as `${idPrefix}-tab-${id}` / `${idPrefix}-tabpanel-${id}`
 * so deep links (`?view=settings&tab=...`) and tests stay stable.
 *
 * Consumers: Store Settings tabs (Settings.tsx); refactor target for
 * catalog-workbench WorkbenchTabs and future OnboardingSettings migration.
 */

export interface SettingsTabDef {
  id: string;
  label: string;
}

interface SettingsTabShellProps {
  tabs: readonly SettingsTabDef[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  idPrefix?: string;
}

export function SettingsTabShell({ tabs, active, onChange, ariaLabel, idPrefix = 'settings' }: SettingsTabShellProps) {
  const tabRefs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});

  const focusTab = (id: string) => {
    tabRefs.current[id]?.focus();
  };

  const handleTablistKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const focusedTab = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[role="tab"]')
      ?.dataset.settingsTab as string | undefined;

    if (event.key === 'Enter' || event.key === ' ') {
      if (!focusedTab) return;
      event.preventDefault();
      onChange(focusedTab);
      focusTab(focusedTab);
      return;
    }

    const currentTab = focusedTab ?? active;
    const currentIndex = tabs.findIndex((tab) => tab.id === currentTab);
    let nextIndex: number | null = null;

    if (event.key === 'ArrowLeft') {
      nextIndex = currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
    } else if (event.key === 'ArrowRight') {
      nextIndex = currentIndex === -1 || currentIndex === tabs.length - 1 ? 0 : currentIndex + 1;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = tabs.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextId = tabs[nextIndex].id;
    onChange(nextId);
    focusTab(nextId);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleTablistKeyDown}
      style={{
        display: 'flex',
        gap: 4,
        borderBottom: '1px solid #e5e7eb',
        marginBottom: 20,
        overflowX: 'auto',
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(node) => {
            tabRefs.current[tab.id] = node;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          data-settings-tab={tab.id}
          aria-selected={active === tab.id}
          aria-controls={`${idPrefix}-tabpanel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          style={{
            padding: '8px 16px',
            fontSize: 14,
            fontWeight: active === tab.id ? 600 : 500,
            color: active === tab.id ? '#111827' : '#4b5563',
            background: 'transparent',
            border: 'none',
            borderBottom: active === tab.id ? '2px solid #14532D' : '2px solid transparent',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

interface SettingsTabPanelProps {
  /** Tab id this panel belongs to (ids derive from it). */
  tabId: string;
  active: string;
  children: React.ReactNode;
  idPrefix?: string;
}

/** Matching ARIA tabpanel; hidden via attribute + display for wide test compat. */
export function SettingsTabPanel({ tabId, active, children, idPrefix = 'settings' }: SettingsTabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-tabpanel-${tabId}`}
      aria-labelledby={`${idPrefix}-tab-${tabId}`}
      hidden={active !== tabId}
      style={{ display: active === tabId ? 'block' : 'none' }}
    >
      {children}
    </div>
  );
}
