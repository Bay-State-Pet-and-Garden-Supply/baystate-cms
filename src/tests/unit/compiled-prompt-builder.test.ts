import { describe, expect, it } from 'vitest';
import { buildResearchPrompt } from '../../product-intelligence/pi/pi-prompt-builder';
import { compileAgentPrompt } from '../../product-intelligence/pi/compiled-prompt-builder';
import type { ProductResearchContext, ProductResearchInput } from '../../product-intelligence/contracts';
import type { AgentVersionSnapshot } from '../../shared/schemas/agent-training';

describe('compiled-prompt-builder (compiler_v1)', () => {
  const dummyInput: ProductResearchInput = {
    gtin: '076280014028',
    registerName: 'BLUE BUFF CAN DOG 12.5OZ',
    brandHint: 'Blue Buffalo',
    departmentHint: 'Dog Food',
    price: '3.49',
    quantity: 1,
  };

  const dummyContext: ProductResearchContext = {
    runId: 'test-run-1',
    workspaceId: 'ws1',
    workspacePath: '/tmp/test',
    policy: {
      configId: 'test-policy-123',
      networkPolicy: 'allowlisted_remote',
      dataSharingPolicy: 'cloud_models_only',
      maxToolCalls: 20,
      maxCostUsd: null,
      deadlineMs: 120_000,
      allowedTools: [],
      researchTools: ['search_official_page', 'extract_product_page'],
      allowedSourceDomains: [],
      maxResponseBytes: 1_000_000,
      modelRoute: { provider: 'ollama', model: 'llama3:latest', thinkingLevel: 'off' },
    },
    executionMode: 'interactive',
    existingEvidenceRefs: ['ev-1', 'ev-2'],
  };

  it('proves 100% byte-for-byte baseline equivalence to buildResearchPrompt() for v1 snapshot', () => {
    const v1Snapshot: AgentVersionSnapshot = {
      id: 'v1_rev1_ws1',
      workspaceId: 'ws1',
      versionNumber: 1,
      revisionNumber: 1,
      parentVersionId: null,
      compilerVersion: 'compiler_v1',
      instructions: [],
      fewShotExamples: [],
      fewShotTokenBudget: 4000,
      policyConfigId: 'default',
      contentHash: 'hash123',
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      changeSummary: 'Baseline',
    };

    const existing = buildResearchPrompt(dummyInput, dummyContext);
    const compiled = compileAgentPrompt(v1Snapshot, dummyInput, dummyContext);

    // Assert exact string and structural hash equivalence
    expect(compiled.fullText).toBe(existing.text);
    expect(compiled.promptHash).toBe(existing.promptHash);
    expect(compiled.includedExamples).toEqual([]);
    expect(compiled.estimatedGuidanceTokens).toBe(0);
  });

  it('includes categorized domain guidelines in compiled prompt', () => {
    const customSnapshot: AgentVersionSnapshot = {
      id: 'v2_rev1_ws1',
      workspaceId: 'ws1',
      versionNumber: 2,
      revisionNumber: 1,
      parentVersionId: 'v1_rev1_ws1',
      compilerVersion: 'compiler_v1',
      instructions: [
        {
          id: 'rule-1',
          category: 'facts',
          rule: 'When register price strongly conflicts with candidate multipack quantity, treat as conflict signal.',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'rule-2',
          category: 'identity',
          rule: 'Always normalize 12-digit UPCs by checking 14-digit GTIN variations.',
          createdAt: new Date().toISOString(),
        },
      ],
      fewShotExamples: [],
      fewShotTokenBudget: 4000,
      policyConfigId: 'default',
      contentHash: 'hash456',
      createdBy: 'operator',
      createdAt: new Date().toISOString(),
      changeSummary: 'Added multipack and UPC rules',
    };

    const compiled = compileAgentPrompt(customSnapshot, dummyInput, dummyContext);

    expect(compiled.fullText).toContain('## Behavioral domain guidelines');
    expect(compiled.fullText).toContain('### Fact prioritization & conflict resolution');
    expect(compiled.fullText).toContain('- When register price strongly conflicts with candidate multipack quantity, treat as conflict signal.');
    expect(compiled.fullText).toContain('### Identity & GTIN resolution');
    expect(compiled.fullText).toContain('- Always normalize 12-digit UPCs by checking 14-digit GTIN variations.');
    expect(compiled.estimatedGuidanceTokens).toBeGreaterThan(0);
  });

  it('budgets few-shot examples deterministically up to token budget', () => {
    const customSnapshot: AgentVersionSnapshot = {
      id: 'v3_rev1_ws1',
      workspaceId: 'ws1',
      versionNumber: 3,
      revisionNumber: 1,
      parentVersionId: 'v2_rev1_ws1',
      compilerVersion: 'compiler_v1',
      instructions: [],
      fewShotExamples: [
        {
          id: 'ex-1',
          gtin: '076280014028',
          registerName: 'BLUE BUFF CAN DOG 12.5OZ',
          explanation: 'Single can dog food SKU.',
          expectedOutput: {
            title: 'Blue Buffalo Canned Dog Food 12.5 oz',
            brand: 'Blue Buffalo',
            facts: [{ field: 'Net Weight', value: '12.5 oz' }],
            categoryPages: ['canned-dog-food'],
            forbiddenSourceDomains: [],
            shouldAbstain: false,
          },
          difficultyTags: ['wrong_size_retailer'],
          tokenCount: 100,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'ex-2',
          gtin: '011111222222',
          registerName: 'LARGE BAG DOG FOOD',
          explanation: 'Large bag food.',
          expectedOutput: {
            title: 'Large Dog Food 30 lb',
            brand: 'BrandX',
            facts: [],
            categoryPages: [],
            forbiddenSourceDomains: [],
            shouldAbstain: false,
          },
          difficultyTags: [],
          tokenCount: 100,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      ],
      fewShotTokenBudget: 150, // Small budget: only 1 example should fit
      policyConfigId: 'default',
      contentHash: 'hash789',
      createdBy: 'operator',
      createdAt: new Date().toISOString(),
      changeSummary: 'Few-shot test',
    };

    const compiled = compileAgentPrompt(customSnapshot, dummyInput, dummyContext);

    expect(compiled.fullText).toContain('## In-context reference examples');
    expect(compiled.fullText).toContain('### Example: 076280014028');
    expect(compiled.includedExamples.length).toBe(1);
    expect(compiled.includedExamples[0].id).toBe('ex-1');
  });

  it('excludes few-shot examples completely if the first example exceeds the budget', () => {
    const customSnapshot: AgentVersionSnapshot = {
      id: 'v4_rev1_ws1',
      workspaceId: 'ws1',
      versionNumber: 4,
      revisionNumber: 1,
      parentVersionId: null,
      compilerVersion: 'compiler_v1',
      instructions: [],
      fewShotExamples: [
        {
          id: 'ex-oversized',
          gtin: '076280014028',
          registerName: 'BLUE BUFF CAN DOG 12.5OZ',
          explanation: 'Single can dog food SKU with lots of details.',
          expectedOutput: {
            title: 'Blue Buffalo Canned Dog Food 12.5 oz',
            brand: 'Blue Buffalo',
            facts: [{ field: 'Net Weight', value: '12.5 oz' }],
            categoryPages: ['canned-dog-food'],
            forbiddenSourceDomains: [],
            shouldAbstain: false,
          },
          difficultyTags: ['wrong_size_retailer'],
          tokenCount: 500,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      ],
      fewShotTokenBudget: 5, // Tiny budget smaller than the example
      policyConfigId: 'default',
      contentHash: 'hash999',
      createdBy: 'operator',
      createdAt: new Date().toISOString(),
      changeSummary: 'Budget overflow test',
    };

    const compiled = compileAgentPrompt(customSnapshot, dummyInput, dummyContext);
    expect(compiled.includedExamples).toEqual([]);
    expect(compiled.fullText).not.toContain('## In-context reference examples');
  });
});
