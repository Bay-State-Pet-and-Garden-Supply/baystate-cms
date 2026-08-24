// @vitest-environment jsdom
/**
 * FrozenBanner primitive tests (P1 UI revamp).
 *
 * The banner must state the active taxonomy revision when known, degrade to
 * a generic immutable-release statement otherwise, and never render edit
 * affordances — it replaces fake-disabled editors with an honest affordance.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { FrozenBanner } from '../../client/components/settings/FrozenBanner';

function render(element: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('FrozenBanner', () => {
  it('includes the active revision slug in its copy when provided', () => {
    const { container, unmount } = render(<FrozenBanner revision="bay-state-v4" />);
    const banner = container.querySelector('[data-frozen-banner="true"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('bay-state-v4');
    expect(banner!.textContent).toContain('immutable taxonomy release');
    expect(banner!.getAttribute('title')).toBe('Taxonomy frozen — read-only');
    unmount();
  });

  it('falls back to generic copy when the revision is unknown', () => {
    const { container, unmount } = render(<FrozenBanner />);
    const banner = container.querySelector('[data-frozen-banner="true"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).not.toContain('`undefined`');
    expect(banner!.textContent).toContain('immutable taxonomy release');
    expect(banner!.textContent).toContain('read-only');
    unmount();
  });

  it('appends optional note copy', () => {
    const { container, unmount } = render(<FrozenBanner note="Extra guidance." />);
    const banner = container.querySelector('[data-frozen-banner="true"]');
    expect(banner!.textContent).toContain('Extra guidance.');
    unmount();
  });

  it('renders no edit affordances (no buttons, inputs, or links)', () => {
    const { container, unmount } = render(<FrozenBanner revision="bay-state-v3" />);
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.querySelectorAll('input').length).toBe(0);
    expect(container.querySelectorAll('a').length).toBe(0);
    unmount();
  });
});
