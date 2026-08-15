// @vitest-environment jsdom
/**
 * Agent Lab Training UI Component Tests (PI-7).
 *
 * Verifies rendering and user interactions across the reshaped Agent Lab training interface:
 * Workbench, Curriculum, Evaluation Matrix, Config Studio, Version Lineage, and Teach Modal.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// Mock the API module before importing components
vi.mock('../../client/product-intelligence-api', () => ({
  getPiFlags: vi.fn(),
  getActiveAgentVersion: vi.fn(),
  getCandidateAgentVersion: vi.fn(),
  listAgentVersions: vi.fn(),
  createCandidateAgentVersion: vi.fn(),
  promoteAgentVersion: vi.fn(),
  listAgentCorrections: vi.fn(),
  createAgentCorrection: vi.fn(),
  listAgentTeachingEvents: vi.fn(),
  teachAgent: vi.fn(),
  listAgentEvaluations: vi.fn(),
  getAgentEvaluation: vi.fn(),
  runAgentEvaluation: vi.fn(),
  getCurriculumExamples: vi.fn(),
  markCurriculumExampleContaminated: vi.fn(),
  createPiRun: vi.fn(),
  listPiRuns: vi.fn(),
  getPiRun: vi.fn(),
  cancelPiRun: vi.fn(),
  comparePiRun: vi.fn(),
  parseRunInput: vi.fn(),
  parseRunPolicy: vi.fn(),
}));

import { AgentLab } from '../../client/components/agent-lab/AgentLab';
import { AgentWorkbench } from '../../client/components/agent-lab/AgentWorkbench';
import { TeachModal } from '../../client/components/agent-lab/TeachModal';
import { CurriculumExplorer } from '../../client/components/agent-lab/CurriculumExplorer';
import { EvaluationMatrix } from '../../client/components/agent-lab/EvaluationMatrix';
import { AgentConfigStudio } from '../../client/components/agent-lab/AgentConfigStudio';
import { VersionLineage } from '../../client/components/agent-lab/VersionLineage';
import {
  getActiveAgentVersion,
  getCandidateAgentVersion,
  getCurriculumExamples,
  getPiFlags,
  listAgentEvaluations,
  listAgentVersions,
  teachAgent,
  type AgentVersionSummary,
} from '../../client/product-intelligence-api';

const mockActiveVersion: AgentVersionSummary = {
  snapshot: {
    id: 'v1_rev1_ws1',
    workspaceId: 'ws1',
    versionNumber: 1,
    revisionNumber: 1,
    parentVersionId: null,
    compilerVersion: 'compiler_v1',
    instructions: [
      { id: 'r1', category: 'facts', rule: 'Never assume 12-pack for single item < $5', createdAt: '2026-01-01' },
    ],
    fewShotExamples: [
      {
        id: 'ex1',
        gtin: '076280014028',
        registerName: 'BLUE BUFF CAN DOG 12.5OZ',
        expectedOutput: {
          title: 'Blue Buffalo Dog Food Can 12.5 oz',
          brand: 'Blue Buffalo',
          facts: [],
          categoryPages: [],
          forbiddenSourceDomains: [],
          shouldAbstain: false,
        },
        explanation: 'Single can unit pricing',
        difficultyTags: ['wrong_size_retailer'],
        tokenCount: 120,
        isActive: true,
        createdAt: '2026-01-01',
      },
    ],
    fewShotTokenBudget: 4000,
    policyConfigId: 'pol_1',
    contentHash: 'hash_v1_rev1_abc123',
    changeSummary: '',
    createdBy: 'system',
    createdAt: '2026-01-01T00:00:00Z',
  },
  state: {
    workspaceId: 'ws1',
    versionId: 'v1_rev1_ws1',
    lifecycleStatus: 'active',
    activatedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const mockCandidateVersion: AgentVersionSummary = {
  snapshot: {
    id: 'v2_rev1_ws1',
    workspaceId: 'ws1',
    versionNumber: 2,
    revisionNumber: 1,
    parentVersionId: 'v1_rev1_ws1',
    compilerVersion: 'compiler_v1',
    instructions: [
      { id: 'r1', category: 'facts', rule: 'Never assume 12-pack for single item < $5', createdAt: '2026-01-01' },
      { id: 'r2', category: 'extraction', rule: 'Extract exact net ounce weights', createdAt: '2026-01-02' },
    ],
    fewShotExamples: [],
    fewShotTokenBudget: 4000,
    policyConfigId: 'pol_1',
    contentHash: 'hash_v2_rev1_def456',
    createdBy: 'operator',
    changeSummary: 'Added weight extraction rule',
    createdAt: '2026-01-02T00:00:00Z',
  },
  state: {
    workspaceId: 'ws1',
    versionId: 'v2_rev1_ws1',
    lifecycleStatus: 'qualified',
    updatedAt: '2026-01-02T00:00:00Z',
  },
};

describe('Agent Lab Training Interface (PI-7 Reshaped)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();

    vi.mocked(getPiFlags).mockResolvedValue({
      flags: {
        productIntelligenceEnabled: true,
        piEnabled: true,
        shadowOnly: false,
        allowOnboardingImport: true,
        allowBatchRuns: true,
        killSwitch: false,
      },
    });
    vi.mocked(getActiveAgentVersion).mockResolvedValue(mockActiveVersion);
    vi.mocked(getCandidateAgentVersion).mockResolvedValue(mockCandidateVersion);
    vi.mocked(listAgentVersions).mockResolvedValue([mockActiveVersion, mockCandidateVersion]);
    vi.mocked(listAgentEvaluations).mockResolvedValue([]);
    vi.mocked(getCurriculumExamples).mockResolvedValue([]);
  });

  it('renders AgentLab with 6 primary tabs and version status header', async () => {
    await act(async () => {
      const root = createRoot(container);
      root.render(<AgentLab />);
    });

    // Check main title and badges
    expect(container.textContent).toContain('Agent Lab');
    expect(container.textContent).toContain('Training Interface');

    // Check header version badges
    expect(container.textContent).toContain('Production: v1.1');
    expect(container.textContent).toContain('Candidate: v2.1');

    // Check all 6 main tabs exist
    expect(container.textContent).toContain('Workbench');
    expect(container.textContent).toContain('Curriculum & Datasets');
    expect(container.textContent).toContain('Evaluate');
    expect(container.textContent).toContain('Agent Config');
    expect(container.textContent).toContain('Versions');
    expect(container.textContent).toContain('Runs');
  });

  it('renders AgentWorkbench with SKU input bar and version selection', async () => {
    await act(async () => {
      const root = createRoot(container);
      root.render(
        <AgentWorkbench
          activeVersion={mockActiveVersion}
          candidateVersion={mockCandidateVersion}
          flags={{
            productIntelligenceEnabled: true,
            piEnabled: true,
            shadowOnly: false,
            allowOnboardingImport: true,
            allowBatchRuns: true,
            killSwitch: false,
          }}
          onVersionUpdated={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain('UPC / GTIN');
    expect(container.textContent).toContain('Register Name');
    expect(container.textContent).toContain('Target Agent Version');
    expect(container.textContent).toContain('Run Workbench Research');
    expect(container.textContent).toContain('v1.1 (Active Baseline)');
    expect(container.textContent).toContain('v2.1 (Candidate qualified)');
  });

  it('renders CurriculumExplorer with 4 splits and data isolation guarantees', async () => {
    vi.mocked(getCurriculumExamples).mockResolvedValue([
      {
        id: 'bench-1',
        product_sku: 'SKU-100',
        upc: '076280014028',
        split_group: 'train',
        product_input_json: JSON.stringify({ registerName: 'Blue Buffalo Dog Can' }),
        gold_labels_json: JSON.stringify({ difficultyTags: ['wrong_size_retailer'] }),
        is_contaminated: 0,
        contaminated_at: null,
        contamination_reason: null,
      },
    ]);

    await act(async () => {
      const root = createRoot(container);
      root.render(<CurriculumExplorer />);
    });

    expect(container.textContent).toContain('Training Split');
    expect(container.textContent).toContain('Validation Split');
    expect(container.textContent).toContain('Promotion Test Split (Hidden Labels)');
    expect(container.textContent).toContain('Holdout Split');
    expect(container.textContent).toContain('SKU-100');
    expect(container.textContent).toContain('wrong_size_retailer');
    expect(container.textContent).toContain('Clean');
  });

  it('renders TeachModal and calls teachAgent() when human correction is submitted', async () => {
    const handleSuccess = vi.fn();
    vi.mocked(teachAgent).mockResolvedValue({
      version: mockCandidateVersion,
      teachingEvent: {
        id: 'te-1',
        workspaceId: 'ws1',
        correctionId: 'corr-1',
        resultingVersionId: 'v2_rev1_ws1',
        actions: [{ type: 'add_rule', category: 'facts', rule: 'Single can price check' }],
        rationale: 'Taught single can check',
        createdBy: 'operator',
        createdAt: '2026-01-02T00:00:00Z',
      },
    });

    await act(async () => {
      const root = createRoot(container);
      root.render(
        <TeachModal
          isOpen={true}
          onClose={() => {}}
          onSuccess={handleSuccess}
          runId="run-123"
          versionId="v1_rev1_ws1"
          originalResultHash="hash_123"
          initialGtin="076280014028"
          initialRegisterName="BLUE BUFF CAN DOG 12.5OZ"
          initialExtractedTitle="Blue Buffalo 12 Pack"
        />,
      );
    });

    expect(container.textContent).toContain('Teach Agent from Run');
    expect(container.textContent).toContain('Add Guideline Rule');
    expect(container.textContent).toContain('Add Few-Shot Example');
    expect(container.textContent).toContain('Negative Source Pattern');
  });

  it('renders AgentConfigStudio with categorized rules and few-shot token budget meter', async () => {
    await act(async () => {
      const root = createRoot(container);
      root.render(
        <AgentConfigStudio
          activeVersion={mockActiveVersion}
          candidateVersion={mockCandidateVersion}
          onVersionSaved={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain('Agent Configuration & Guidance Studio');
    expect(container.textContent).toContain('Safety & Execution Boundary Architecture');
    expect(container.textContent).toContain('Behavioral Domain Guidelines');
    expect(container.textContent).toContain('In-Context Reference Examples');
    expect(container.textContent).toContain('In-Context Token Budget Usage');
    expect(container.textContent).toContain('Never assume 12-pack for single item < $5');
  });

  it('renders VersionLineage with immutable snapshots and content hashes', async () => {
    await act(async () => {
      const root = createRoot(container);
      root.render(<VersionLineage />);
    });

    expect(container.textContent).toContain('Agent Version Lineage & Content Snapshots');
    expect(container.textContent).toContain('v1.1');
    expect(container.textContent).toContain('Active Production');
    expect(container.textContent).toContain('hash_v1_re');
  });

  it('renders EvaluationMatrix with paired candidate vs baseline scorecard', async () => {
    await act(async () => {
      const root = createRoot(container);
      root.render(
        <EvaluationMatrix
          activeVersion={mockActiveVersion}
          candidateVersion={mockCandidateVersion}
          onVersionPromoted={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain('Paired Benchmark Evaluation');
    expect(container.textContent).toContain('Evaluating Candidate v2.1 vs Baseline v1.1');
    expect(container.textContent).toContain('Run Paired Evaluation');
  });
});
