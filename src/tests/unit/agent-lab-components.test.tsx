// @vitest-environment jsdom
/**
 * Agent Lab component smoke tests (PI-7).
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

// Mock the API module BEFORE importing components.
vi.mock('../../client/product-intelligence-api', () => ({
  getPiFlags: vi.fn(),
  listPiRuns: vi.fn(),
  getPiRun: vi.fn(),
  createPiRun: vi.fn(),
  cancelPiRun: vi.fn(),
  deletePiRun: vi.fn(),
  comparePiRun: vi.fn(),
  parseRunInput: vi.fn(),
  parseRunPolicy: vi.fn(),
}));

import { AgentRunLauncher } from '../../client/components/agent-lab/AgentRunLauncher';
import { AgentRunTimeline } from '../../client/components/agent-lab/AgentRunTimeline';
import { AgentRunList } from '../../client/components/agent-lab/AgentRunList';
import { createPiRun, listPiRuns } from '../../client/product-intelligence-api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set a React-controlled input value via the native setter so React sees the change. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderAsync(component: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
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

// ---------------------------------------------------------------------------
// AgentRunLauncher
// ---------------------------------------------------------------------------

describe('AgentRunLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows validation errors for invalid GTIN and does not call createPiRun', async () => {
    vi.mocked(createPiRun).mockResolvedValue({ runId: 'r1', executor: 'pi', status: 'running' });
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    const { container, unmount } = await renderAsync(<AgentRunLauncher onCreated={onCreated} onCancel={onCancel} />);

    // Enter invalid GTIN (letters)
    const inputs = container.querySelectorAll('input');
    const gtinInput = inputs[0] as HTMLInputElement;
    await act(async () => {
      setInputValue(gtinInput, 'abc');
    });

    // Click start
    const buttons = container.querySelectorAll('button');
    const startBtn = Array.from(buttons).find((b) => b.textContent?.includes('Start run')) as HTMLButtonElement;
    await act(async () => {
      startBtn.click();
    });

    // Should NOT have called createPiRun
    expect(createPiRun).not.toHaveBeenCalled();

    // Should show an issue
    const invalidElements = container.querySelectorAll('p');
    const hasInvalidMessage = Array.from(invalidElements).some((p) => p.textContent?.includes('⚠'));
    expect(hasInvalidMessage).toBe(true);

    unmount();
  });

  it('calls createPiRun once for valid input', async () => {
    vi.mocked(createPiRun).mockResolvedValue({ runId: 'r-new', executor: 'pi', status: 'running' });
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    const { container, unmount } = await renderAsync(<AgentRunLauncher onCreated={onCreated} onCancel={onCancel} />);

    const inputs = container.querySelectorAll('input');
    const gtinInput = inputs[0] as HTMLInputElement;
    const regInput = inputs[1] as HTMLInputElement;

    await act(async () => {
      setInputValue(gtinInput, '039978004012');
    });
    await act(async () => {
      setInputValue(regInput, 'Test Product');
    });

    const buttons = container.querySelectorAll('button');
    const startBtn = Array.from(buttons).find((b) => b.textContent?.includes('Start run')) as HTMLButtonElement;

    await act(async () => {
      startBtn.click();
    });

    expect(createPiRun).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith('r-new');

    unmount();
  });
});

// ---------------------------------------------------------------------------
// AgentRunTimeline
// ---------------------------------------------------------------------------

describe('AgentRunTimeline', () => {
  it('renders event labels and does NOT leak chain-of-thought content', async () => {
    const events = [
      {
        runId: 'r1',
        sequence: 0,
        type: 'run.started',
        payload: { executor: 'pi' },
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        runId: 'r1',
        sequence: 1,
        type: 'tool.completed',
        payload: { toolName: 'search', thought: 'secret internal reasoning for the model' },
        createdAt: '2026-01-01T00:00:01Z',
      },
      {
        runId: 'r1',
        sequence: 2,
        type: 'conflict.detected',
        payload: { field: 'title', severity: 'high' },
        createdAt: '2026-01-01T00:00:02Z',
      },
      {
        runId: 'r1',
        sequence: 3,
        type: 'run.failed',
        payload: { code: 'validation_error' },
        createdAt: '2026-01-01T00:00:03Z',
      },
    ];

    const { container, unmount } = await renderAsync(<AgentRunTimeline events={events} />);
    const text = container.textContent ?? '';

    // Labels should appear
    expect(text).toContain('Run started');
    expect(text).toContain('Tool completed');
    expect(text).toContain('Conflict detected');
    expect(text).toContain('Run failed');

    // chain-of-thought should NOT appear
    expect(text).not.toContain('secret internal reasoning');
    expect(text).not.toContain('thought');

    // allowed payload fields should appear
    expect(text).toContain('search');

    unmount();
  });
});

// ---------------------------------------------------------------------------
// AgentRunList
// ---------------------------------------------------------------------------

describe('AgentRunList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state when no runs', async () => {
    vi.mocked(listPiRuns).mockResolvedValue({ runs: [] });
    const { container, unmount } = await renderAsync(<AgentRunList onSelect={vi.fn()} />);

    const text = container.textContent ?? '';
    expect(text).toContain('No runs yet');

    unmount();
  });

  it('renders rows when runs exist', async () => {
    vi.mocked(listPiRuns).mockResolvedValue({
      runs: [
        {
          id: 'run-abc',
          workspaceId: 'ws-1',
          onboardingItemId: null,
          mode: 'shadow',
          status: 'completed',
          executor: 'pi',
          inputJson: '{}',
          policyJson: '{}',
          configSnapshotId: 'cfg',
          configSnapshotHash: 'hash',
          codeCommit: null,
          promptHash: null,
          piVersion: '1.0',
          extensionVersionsJson: '[]',
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:01:00Z',
          cancelledAt: null,
          errorCode: null,
          errorMessage: null,
          estimatedCost: null,
          actualCost: 0.02,
          tokenUsageJson: null,
        },
      ],
    });
    const { container, unmount } = await renderAsync(<AgentRunList onSelect={vi.fn()} />);

    const text = container.textContent ?? '';
    expect(text).toContain('pi');
    expect(text).toContain('completed');

    unmount();
  });
});