// @vitest-environment jsdom
/**
 * Component tests for the dismissible keyboard-shortcut legend
 * (impeccable polish pass): renders the accelerators, persists dismissal,
 * and offers a reopen affordance. Uses the repo's createRoot+act pattern
 * (no @testing-library dependency).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import {
  KeyboardLegend,
  isLegendDismissed,
} from '../../client/components/onboarding/review/ReviewWorkspace';

const DISMISS_KEY = 'rv-shortcuts-dismissed';

/** Minimal localStorage stand-in: this vitest jsdom env does not expose one,
 *  and the tests need deterministic persistence semantics. */
function installStorageStub() {
  const map = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
}

function clickButton(container: HTMLElement, name: RegExp) {
  const buttons = Array.from(container.querySelectorAll('button'));
  const target = buttons.find(b => name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
  if (!target) throw new Error(`button matching ${name} not found`);
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('KeyboardLegend', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  const renderLegend = () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<KeyboardLegend />);
    });
    return container;
  };

  beforeEach(() => {
    installStorageStub();
  });

  afterEach(() => {
    if (root && container) {
      act(() => root.unmount());
      container.remove();
      container = undefined as unknown as HTMLElement;
      root = undefined as unknown as ReturnType<typeof createRoot>;
    }
    document.body.innerHTML = '';
  });

  it('renders all three documented accelerators by default', () => {
    const c = renderLegend();
    expect(c.textContent).toContain('Looks Good');
    expect(c.textContent).toContain('previous / next product');
    expect(c.textContent).toContain('close product / image');
    // Dismissal control is present and labelled (not icon-only).
    expect(c.querySelector('button[aria-label="Hide keyboard shortcuts"]')).toBeTruthy();
  });

  it('dismisses to a reopen affordance and persists the dismissal', () => {
    const c = renderLegend();
    clickButton(c, /hide keyboard shortcuts/i);
    // Legend content is gone…
    expect(c.textContent).not.toContain('Looks Good');
    // …a discoverable reopen control exists…
    expect(c.querySelector('button[aria-label="Show keyboard shortcuts"]')).toBeTruthy();
    // …and the dismissal persisted.
    expect(isLegendDismissed()).toBe(true);
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1');
  });

  it('reopens after dismissal and clears the persisted flag', () => {
    localStorage.setItem(DISMISS_KEY, '1');
    const c = renderLegend();
    expect(c.textContent).not.toContain('Looks Good');

    clickButton(c, /show keyboard shortcuts/i);
    expect(c.textContent).toContain('Looks Good');
    expect(isLegendDismissed()).toBe(false);
    expect(localStorage.getItem(DISMISS_KEY)).toBeNull();
  });
});
