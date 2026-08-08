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
  comparePiRun: vi.fn(),
  parseRunInput: vi.fn(),
  parseRunPolicy: vi.fn(),
  importRunToOnboarding: vi.fn(),
  reviewPiRun: vi.fn(),
  getPiRunReview: vi.fn(),
}));

vi.mock('../../client/hooks/useProductIntelligenceRun', () => ({
  useProductIntelligenceRun: vi.fn(),
}));
vi.mock('../../client/hooks/useProductIntelligenceEvents', () => ({
  useProductIntelligenceEvents: vi.fn(),
}));

import { AgentRunLauncher } from '../../client/components/agent-lab/AgentRunLauncher';
import { AgentRunTimeline } from '../../client/components/agent-lab/AgentRunTimeline';
import { AgentRunList } from '../../client/components/agent-lab/AgentRunList';
import { AgentRunInspector } from '../../client/components/agent-lab/AgentRunInspector';
import {
  useProductIntelligenceRun,
} from '../../client/hooks/useProductIntelligenceRun';
import {
  useProductIntelligenceEvents,
} from '../../client/hooks/useProductIntelligenceEvents';
import {
  createPiRun,
  listPiRuns,
  getPiFlags,
  importRunToOnboarding,
  getPiRunReview,
  type PiRunProjection,
} from '../../client/product-intelligence-api';

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

// ---------------------------------------------------------------------------
// AgentRunInspector — Send to Onboarding review (PI-8)
// ---------------------------------------------------------------------------

function makeProjection(overrides: Partial<PiRunProjection> = {}): PiRunProjection {
  return {
    run: {
      id: 'run-import-1',
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
      actualCost: 0.01,
      tokenUsageJson: null,
    },
    steps: [],
    toolCalls: [],
    sources: [],
    evidence: [],
    conflicts: [],
    assets: [],
    result: {
      id: 'res-1',
      runId: 'run-import-1',
      schemaVersion: 1,
      disposition: 'submitted',
      resultJson: '{"submission":{"identity":{"status":"exact_match"}}}',
      resultHash: 'hash',
      createdAt: '2026-01-01T00:01:00Z',
    },
    comparisons: [],
    eventCount: 0,
    ...overrides,
  };
}

describe('AgentRunInspector — onboarding import (PI-8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useProductIntelligenceEvents).mockReturnValue({
      events: [],
      status: 'closed',
      stop: vi.fn(),
    });
  });

  it('renders Send to Onboarding review and imports a reviewed result (create mode)', async () => {
    vi.mocked(useProductIntelligenceRun).mockReturnValue({
      run: makeProjection(),
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    vi.mocked(getPiFlags).mockResolvedValue({
      flags: {
        productIntelligenceEnabled: true,
        piEnabled: true,
        shadowOnly: false,
        allowOnboardingImport: true,
        allowBatchRuns: false,
        killSwitch: false,
      },
    });
    vi.mocked(importRunToOnboarding).mockResolvedValue({
      import: {
        id: 'imp-1',
        runId: 'run-import-1',
        onboardingItemId: 'item-1',
        resultHash: 'hash',
        mode: 'create',
        importingUser: null,
        status: 'active',
        fieldSelectionJson: '[]',
        excludedValuesJson: '[]',
        overriddenValuesJson: '[]',
        importedSourceIdsJson: '[]',
        importedEvidenceIdsJson: '[]',
        importedImageIdsJson: '[]',
        createdAt: '2026-01-01T00:02:00Z',
      },
      itemId: 'item-1',
      batchId: 'batch-1',
      created: true,
    });
    // P1-2: an approved review decision unlocks the import button.
    vi.mocked(getPiRunReview).mockResolvedValue({
      decision: {
        id: 'd1',
        runId: 'run-import-1',
        decision: 'approve',
        resultHash: 'hash',
        supersedesDecisionId: null,
        reviewer: 'user',
        reviewerActor: { actorType: 'local_operator', authentication: 'local_ui', displayLabel: 'user' },
        note: null,
        createdAt: '2026-01-01T00:01:00Z',
      },
      approved: true,
    });

    const { container, unmount } = await renderAsync(
      <AgentRunInspector runId="run-import-1" onBack={vi.fn()} />,
    );

    // Flags load asynchronously — flush microtasks so the button appears.
    const text = container.textContent ?? '';
    expect(text).toContain('Send to Onboarding review');

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Send to Onboarding review'),
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });

    expect(importRunToOnboarding).toHaveBeenCalledTimes(1);
    expect(importRunToOnboarding).toHaveBeenCalledWith('run-import-1', {
      mode: 'create',
      onboardingItemId: null,
      importingUser: null,
    });

    const afterText = container.textContent ?? '';
    expect(afterText).toContain('Imported to onboarding item');

    unmount();
  });

  it('does not render the import button when the import flag is off', async () => {
    vi.mocked(useProductIntelligenceRun).mockReturnValue({
      run: makeProjection(),
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    vi.mocked(getPiRunReview).mockResolvedValue({ decision: null, approved: false });
    vi.mocked(getPiFlags).mockResolvedValue({
      flags: {
        productIntelligenceEnabled: true,
        piEnabled: true,
        shadowOnly: true,
        allowOnboardingImport: false,
        allowBatchRuns: false,
        killSwitch: false,
      },
    });

    const { container, unmount } = await renderAsync(
      <AgentRunInspector runId="run-import-1" onBack={vi.fn()} />,
    );

    expect(container.textContent ?? '').not.toContain('Send to Onboarding review');

    unmount();
  });

  it('renders Open in Onboarding when the run is linked to an onboarding item', async () => {
    vi.mocked(useProductIntelligenceRun).mockReturnValue({
      run: makeProjection({
        run: {
          ...makeProjection().run,
          onboardingItemId: 'item-42',
        },
      }),
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    vi.mocked(getPiRunReview).mockResolvedValue({ decision: null, approved: false });
    vi.mocked(getPiFlags).mockResolvedValue({
      flags: {
        productIntelligenceEnabled: true,
        piEnabled: true,
        shadowOnly: true,
        allowOnboardingImport: false,
        allowBatchRuns: false,
        killSwitch: false,
      },
    });

    const { container, unmount } = await renderAsync(
      <AgentRunInspector runId="run-import-1" onBack={vi.fn()} />,
    );

    expect(container.textContent ?? '').toContain('Open in Onboarding');

    unmount();
  });
});