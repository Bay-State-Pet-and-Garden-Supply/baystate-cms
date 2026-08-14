// @vitest-environment jsdom
/**
 * Operations console, Issue 2 — command palette / scope pin / plan preview /
 * preferences UI smoke tests. Components delegate ALL execution to the parent
 * (which calls the server runtime) — nothing executes client-side.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('../../client/store-manager-api', () => ({
  fetchStoreManagerModels: vi.fn(),
  formatModelPricing: vi.fn(() => 'Free (Local)'),
  fetchStoreManagerCommands: vi.fn(),
  executeStoreManagerCommand: vi.fn(),
  compileStoreManagerCommand: vi.fn(),
  resolveStoreManagerScope: vi.fn(),
  fetchStoreManagerPreferences: vi.fn(),
  saveStoreManagerPreferences: vi.fn(),
}));

import { CommandPalette } from '../../client/components/store-manager/CommandPalette';
import { ScopePin } from '../../client/components/store-manager/ScopePin';
import { PlanPreview } from '../../client/components/store-manager/PlanPreview';
import { PreferencesPanel } from '../../client/components/store-manager/PreferencesPanel';
import type {
  StoreManagerCommandDescriptor,
  StoreManagerPreviewDescriptor,
  StoreManagerResolvedScope,
} from '../../client/store-manager-api';

const COMMANDS: StoreManagerCommandDescriptor[] = [
  {
    name: 'audit',
    version: 1,
    aliases: ['a'],
    description: 'Audit a registered ProductField.',
    argSpecs: [
      { name: 'value', label: 'ProductField', description: 'Registered field', required: true, valueType: 'string', suggestions: ['ProductField24', 'ProductField16'] },
    ],
  },
  {
    name: 'health',
    version: 1,
    aliases: ['h'],
    description: 'Catalog health scan.',
    argSpecs: [],
  },
  {
    name: 'plan',
    version: 1,
    aliases: [],
    description: 'Preview what a command or objective would do.',
    argSpecs: [{ name: 'value', label: 'Objective or command', description: 'Objective', required: true, valueType: 'string' }],
  },
];

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
      });
      container.remove();
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CommandPalette (Issue 2)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows keyboard-navigable server-derived command suggestions and delegates execution', async () => {
    const onExecute = vi.fn();
    const onPrefill = vi.fn();
    const { container, unmount } = await renderAsync(
      <CommandPalette input="/he" commands={COMMANDS} onExecute={onExecute} onPrefill={onPrefill} />,
    );
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(container.textContent).toContain('/health');

    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    // Keyboard: Enter executes the highlighted (no-arg) command.
    await act(async () => {
      listbox!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onExecute).toHaveBeenCalledWith('/health');
    expect(onPrefill).not.toHaveBeenCalled();
    await unmount();
  });

  it('uses server-provided argument completions and never executes locally', async () => {
    const onExecute = vi.fn();
    const onPrefill = vi.fn();
    const { container, unmount } = await renderAsync(
      <CommandPalette input="/audit " commands={COMMANDS} onExecute={onExecute} onPrefill={onPrefill} />,
    );
    expect(container.textContent).toContain('ProductField24');
    const suggestion = Array.from(container.querySelectorAll('[role="option"] button')).find((o) =>
      o.textContent?.includes('ProductField24'),
    );
    expect(suggestion).toBeTruthy();
    await act(async () => {
      suggestion!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Selecting a suggestion only prefills — no execution happened here.
    expect(onPrefill).toHaveBeenCalledWith('/audit ProductField24');
    expect(onExecute).not.toHaveBeenCalled();
    await unmount();
  });

  it('prefills commands that need an argument (e.g. /plan) instead of executing', async () => {
    const onExecute = vi.fn();
    const onPrefill = vi.fn();
    const { container, unmount } = await renderAsync(
      <CommandPalette input="/p" commands={COMMANDS} onExecute={onExecute} onPrefill={onPrefill} />,
    );
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    await act(async () => {
      listbox!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => {
      listbox!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onPrefill).toHaveBeenCalled();
    expect(onExecute).not.toHaveBeenCalled();
    await unmount();
  });

  it('hides when the input is not a command', async () => {
    const { container, unmount } = await renderAsync(
      <CommandPalette input="find the weird ones" commands={COMMANDS} onExecute={() => undefined} onPrefill={() => undefined} />,
    );
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await unmount();
  });
});

describe('ScopePin (Issue 2)', () => {
  it('renders the resolved scope chip and clears on demand', async () => {
    const scope: StoreManagerResolvedScope = {
      pinnedScope: { kind: 'product_field', field: 'ProductField24' },
      scopeHash: 'a'.repeat(64),
      resolved: { kind: 'product_field', displayName: 'Category' },
    };
    const onClear = vi.fn();
    const { container, unmount } = await renderAsync(
      <ScopePin scope={scope} onPin={() => undefined} onClear={onClear} />,
    );
    expect(container.textContent).toContain('Category');
    const clearButton = container.querySelector('[aria-label="Clear pinned scope"]');
    expect(clearButton).not.toBeNull();
    await act(async () => {
      clearButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClear).toHaveBeenCalled();
    await unmount();
  });

  it('lets the user pin a product_field scope (delegated to the parent/server)', async () => {
    const onPin = vi.fn();
    const { container, unmount } = await renderAsync(
      <ScopePin scope={null} onPin={onPin} onClear={() => undefined} />,
    );
    const pinButton = container.querySelector('button');
    await act(async () => {
      pinButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = container.querySelector('input');
    const select = container.querySelector('select');
    expect(select).not.toBeNull();
    setInputValue(input!, 'ProductField24');
    const submit = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Pin');
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPin).toHaveBeenCalledWith({ kind: 'product_field', field: 'ProductField24' });
    await unmount();
  });
});

describe('PlanPreview (Issue 2)', () => {
  const preview: StoreManagerPreviewDescriptor = {
    entrypoint: 'plan_preview',
    executionMode: 'preview',
    actorClass: 'preview',
    runId: 'run-1',
    objectiveHash: 'b'.repeat(64),
    scopeHash: null,
    expectedTools: [
      { name: 'getProductFieldAudit', version: 1, riskClass: 'read', requiresApproval: false, allowedPhases: ['investigate'], scopeSupported: true },
      { name: 'repair_approved_change_set_images', version: 1, riskClass: 'network_filesystem_repair', requiresApproval: true, allowedPhases: ['approve'], scopeSupported: true },
    ],
    expectedApprovals: [{ toolName: 'repair_approved_change_set_images', toolVersion: 1 }],
    persistentToolsDenied: false,
    budgets: { maxToolCalls: 10, deadlineMs: 600000, maxModelCostUsd: 10, perCallTimeoutMs: 60000 },
    networkActivity: 'bounded',
    modelCalls: 0,
    toolDispatches: 0,
  };

  it('renders the zero-execution contract preview with risk/approval/network labels', async () => {
    const { container, unmount } = await renderAsync(
      <PlanPreview objective="/plan /repair-images cs-1" plan={preview} />,
    );
    expect(container.textContent).toContain('/plan preview');
    expect(container.textContent).toContain('nothing executed');
    expect(container.textContent).toContain('getProductFieldAudit');
    expect(container.textContent).toContain('repair_approved_change_set_images');
    expect(container.textContent).toContain('approval required');
    expect(container.textContent).toContain('Network activity');
    expect(container.textContent).toContain('bounded');
    await unmount();
  });

  it('displays errors without executing anything', async () => {
    const { container, unmount } = await renderAsync(
      <PlanPreview objective="/plan /bogus" plan={null} error={'Unknown command "/bogus".'} />,
    );
    expect(container.textContent).toContain('Unknown command');
    await unmount();
  });
});

describe('PreferencesPanel (Issue 2)', () => {
  it('renders the explicit versioned preferences form without writing anything on mount', async () => {
    const { container, unmount } = await renderAsync(<PreferencesPanel open onClose={() => undefined} />);
    expect(container.textContent).toContain('Operational preferences');
    expect(container.textContent).toContain('ProductField labels');
    expect(container.textContent).toContain('Save new revision');
    await unmount();
  });
});
