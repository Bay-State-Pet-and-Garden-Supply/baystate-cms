// @vitest-environment jsdom
/**
 * Store Settings tab accessibility smoke tests.
 *
 * Verifies the ARIA tab pattern introduced for the General / AI Compute /
 * Catalog tabs: labelled tablist, stable tab/panel ids, aria-selected,
 * aria-controls/labelledby, roving tabindex, and arrow-key navigation.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('../../client/api', () => ({
  listFieldRegistry: vi.fn(async () => ({ entries: [] })),
  updateFieldRegistryEntry: vi.fn(async () => ({})),
  getConnection: vi.fn(async () => ({ connection: null })),
  saveConnection: vi.fn(async () => ({})),
  testConnection: vi.fn(async () => ({ ok: true, message: 'ok' })),
}));

vi.mock('../../client/components/AiComputePanel', () => ({
  AiComputePanel: () => <div data-testid="ai-compute-panel">AI Compute</div>,
}));

import { Settings } from '../../client/components/Settings';

async function renderSettings(search = ''): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  window.history.replaceState(null, '', `/?view=settings${search}`);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Settings />);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function getTab(container: HTMLElement, id: string): HTMLButtonElement {
  const tab = container.querySelector<HTMLButtonElement>(`#settings-tab-${id}`);
  expect(tab, `expected tab #settings-tab-${id}`).not.toBeNull();
  return tab!;
}

function getPanel(container: HTMLElement, id: string): HTMLElement {
  const panel = container.querySelector<HTMLElement>(`#settings-tabpanel-${id}`);
  expect(panel, `expected panel #settings-tabpanel-${id}`).not.toBeNull();
  return panel!;
}

describe('Settings tab accessibility', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('renders an accessible tablist with labelled tabs and panels', async () => {
    const { container, unmount } = await renderSettings();
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    expect(tablist!.getAttribute('aria-label')).toBe('Store Settings sections');

    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(3);

    const generalTab = getTab(container, 'general');
    const aiTab = getTab(container, 'ai');
    const catalogTab = getTab(container, 'catalog');

    expect(generalTab.getAttribute('aria-selected')).toBe('true');
    expect(aiTab.getAttribute('aria-selected')).toBe('false');
    expect(catalogTab.getAttribute('aria-selected')).toBe('false');

    expect(generalTab.getAttribute('aria-controls')).toBe('settings-tabpanel-general');
    expect(aiTab.getAttribute('aria-controls')).toBe('settings-tabpanel-ai');
    expect(catalogTab.getAttribute('aria-controls')).toBe('settings-tabpanel-catalog');

    expect(generalTab.tabIndex).toBe(0);
    expect(aiTab.tabIndex).toBe(-1);
    expect(catalogTab.tabIndex).toBe(-1);

    const generalPanel = getPanel(container, 'general');
    const aiPanel = getPanel(container, 'ai');
    const catalogPanel = getPanel(container, 'catalog');

    expect(generalPanel.getAttribute('role')).toBe('tabpanel');
    expect(generalPanel.getAttribute('aria-labelledby')).toBe('settings-tab-general');
    expect(generalPanel.hasAttribute('hidden')).toBe(false);

    expect(aiPanel.getAttribute('role')).toBe('tabpanel');
    expect(aiPanel.getAttribute('aria-labelledby')).toBe('settings-tab-ai');
    expect(aiPanel.hasAttribute('hidden')).toBe(true);

    expect(catalogPanel.getAttribute('role')).toBe('tabpanel');
    expect(catalogPanel.getAttribute('aria-labelledby')).toBe('settings-tab-catalog');
    expect(catalogPanel.hasAttribute('hidden')).toBe(true);

    await unmount();
  });

  it('supports ArrowRight/ArrowLeft/Home/End keyboard navigation with focus movement', async () => {
    const { container, unmount } = await renderSettings();
    const generalTab = getTab(container, 'general');
    const aiTab = getTab(container, 'ai');
    const catalogTab = getTab(container, 'catalog');

    await act(async () => {
      generalTab.focus();
      generalTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(aiTab);
    expect(aiTab.getAttribute('aria-selected')).toBe('true');
    expect(generalTab.tabIndex).toBe(-1);
    expect(aiTab.tabIndex).toBe(0);
    expect(getPanel(container, 'ai').hasAttribute('hidden')).toBe(false);

    await act(async () => {
      aiTab.focus();
      aiTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(catalogTab);
    expect(catalogTab.getAttribute('aria-selected')).toBe('true');
    expect(catalogTab.tabIndex).toBe(0);
    expect(getPanel(container, 'catalog').hasAttribute('hidden')).toBe(false);

    await act(async () => {
      catalogTab.focus();
      catalogTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(generalTab);
    expect(generalTab.getAttribute('aria-selected')).toBe('true');
    expect(generalTab.tabIndex).toBe(0);
    expect(getPanel(container, 'general').hasAttribute('hidden')).toBe(false);

    await act(async () => {
      generalTab.focus();
      generalTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.activeElement).toBe(catalogTab);
    expect(catalogTab.getAttribute('aria-selected')).toBe('true');
    expect(catalogTab.tabIndex).toBe(0);

    await act(async () => {
      catalogTab.focus();
      catalogTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(document.activeElement).toBe(generalTab);
    expect(generalTab.getAttribute('aria-selected')).toBe('true');
    expect(generalTab.tabIndex).toBe(0);

    await act(async () => {
      generalTab.focus();
      generalTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(catalogTab);
    expect(catalogTab.getAttribute('aria-selected')).toBe('true');
    expect(catalogTab.tabIndex).toBe(0);

    await unmount();
  });

  it('activates a focused tab with Enter/Space and keeps the URL deep link current', async () => {
    const { container, unmount } = await renderSettings();
    const aiTab = getTab(container, 'ai');

    await act(async () => {
      aiTab.focus();
      aiTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(aiTab.getAttribute('aria-selected')).toBe('true');
    expect(window.location.search).toContain('view=settings');
    expect(window.location.search).toContain('tab=ai');

    const catalogTab = getTab(container, 'catalog');
    await act(async () => {
      catalogTab.focus();
      catalogTab.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(catalogTab.getAttribute('aria-selected')).toBe('true');
    expect(window.location.search).toContain('tab=catalog');

    await unmount();
  });

  it('syncs the active tab when browser navigation changes the URL', async () => {
    const { container, unmount } = await renderSettings();
    const catalogTab = getTab(container, 'catalog');
    const aiTab = getTab(container, 'ai');

    await act(async () => {
      catalogTab.click();
    });
    expect(catalogTab.getAttribute('aria-selected')).toBe('true');

    window.history.pushState(null, '', '/?view=settings&tab=ai');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(aiTab.getAttribute('aria-selected')).toBe('true');
    expect(aiTab.tabIndex).toBe(0);
    expect(getPanel(container, 'ai').hasAttribute('hidden')).toBe(false);
    expect(catalogTab.getAttribute('aria-selected')).toBe('false');
    expect(getPanel(container, 'catalog').hasAttribute('hidden')).toBe(true);

    await unmount();
  });

  it('preserves deep-linked tab state on initial render', async () => {
    window.history.replaceState(null, '', '/?view=settings&tab=ai');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Settings />);
    });
    const aiTab = getTab(container, 'ai');
    const aiPanel = getPanel(container, 'ai');
    expect(aiTab.getAttribute('aria-selected')).toBe('true');
    expect(aiTab.tabIndex).toBe(0);
    expect(aiPanel.hasAttribute('hidden')).toBe(false);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
