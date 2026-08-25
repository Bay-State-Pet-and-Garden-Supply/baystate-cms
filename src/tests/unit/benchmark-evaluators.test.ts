import { describe, test, expect } from 'vitest';
import { scoreTitleConsolidation } from '../../ai/evals/title-scorer';
import { scoreProfileGeneration } from '../../ai/evals/profile-scorer';
import { scoreVlmOcr } from '../../ai/evals/vlm-scorer';
import { scoreAgentScenarios } from '../../ai/evals/agent-scorer';
import { computeEvalRunResult } from '../../benchmarks/benchmark-runner';
import { compareModelRuns, formatComparisonMarkdown } from '../../benchmarks/model-comparison';

describe('Benchmark Lifecycle & Task Evaluators (PR 4)', () => {
  describe('Title Scorer', () => {
    test('computes title consolidation token preservation rate', () => {
      const cases = [
        { id: '1', rawName: 'WOOF PUPSICLE 2.64OZ', expectedName: 'Woof Pupsicle 2.64oz', protectedTokens: ['2.64oz', 'Woof'] },
      ];

      const predictions = [
        { caseId: '1', consolidatedName: 'Woof Pupsicle 2.64oz' },
      ];

      const res = scoreTitleConsolidation(cases, predictions);
      expect(res.exactMatches).toBe(1);
      expect(res.tokenPreservationRate).toBe(1);
    });
  });

  describe('Profile Scorer', () => {
    test('computes profile validation rate and field accuracy', () => {
      const cases = [
        { id: '1', domain: 'example.com', sampleUrl: 'http://example.com/p1', expectedSelectors: { title: 'h1.product-title', price: '.price' } },
      ];

      const predictions = [
        { caseId: '1', validSelectors: true, extractedSelectors: { title: 'h1.product-title', price: '.price' } },
      ];

      const res = scoreProfileGeneration(cases, predictions);
      expect(res.validatedProfiles).toBe(1);
      expect(res.validatedSuccessRate).toBe(1);
      expect(res.fieldAccuracy).toBe(1);
    });
  });

  describe('VLM Scorer', () => {
    test('computes UPC match rate and field F1', () => {
      const cases = [
        { id: '1', imagePath: '/img/1.jpg', expectedUpc: '123456789012', expectedFields: { brand: 'Woof', weight: '2.64oz' } },
      ];

      const predictions = [
        { caseId: '1', extractedUpc: '123456789012', extractedFields: { brand: 'Woof', weight: '2.64oz' } },
      ];

      const res = scoreVlmOcr(cases, predictions);
      expect(res.upcExactMatches).toBe(1);
      expect(res.upcMatchRate).toBe(1);
      expect(res.fieldF1).toBe(1);
    });
  });

  describe('Agent Scorer', () => {
    test('computes tool selection and task completion rates', () => {
      const cases = [
        { id: '1', userPrompt: 'Find products missing descriptions', expectedTool: 'list_products', unauthorizedMutationsAllowed: false as const },
      ];

      const predictions = [
        { caseId: '1', selectedTool: 'list_products', unauthorizedWriteAttempted: false, taskCompleted: true },
      ];

      const res = scoreAgentScenarios(cases, predictions);
      expect(res.correctToolSelectedCount).toBe(1);
      expect(res.toolSelectionAccuracy).toBe(1);
      expect(res.unauthorizedWriteViolations).toBe(0);
      expect(res.taskSuccessRate).toBe(1);
    });
  });

  describe('Benchmark Runner & Qualification Engine', () => {
    test('computes eval run result with latency percentiles and failure categories', () => {
      const run = computeEvalRunResult('gemma4:12b-mlx', 'product_name_consolidation', [
        { caseId: '1', success: true, validJson: true, latencyMs: 150, promptTokens: 100, completionTokens: 20 },
        { caseId: '2', success: true, validJson: true, latencyMs: 250, promptTokens: 100, completionTokens: 20 },
        { caseId: '3', success: false, validJson: false, latencyMs: 350, promptTokens: 100, completionTokens: 20, failureCategory: 'invalid_json' },
      ]);

      expect(run.totalCases).toBe(3);
      expect(run.successCount).toBe(2);
      expect(run.failureCategories.invalid_json).toBe(1);
      expect(run.parsedJsonValidityRate).toBe(0.6667);
      expect(run.latencyP50Ms).toBe(250);
    });

    test('compares candidate run against cloud baseline according to qualification gates', () => {
      const candidateRun = computeEvalRunResult('gemma4:12b-mlx', 'product_name_consolidation', Array(100).fill(null).map((_, i) => ({
        caseId: `c_${i}`,
        success: true,
        validJson: true,
        latencyMs: 300,
        promptTokens: 100,
        completionTokens: 20,
      })));

      const baselineRun = computeEvalRunResult('deepseek-v4-flash', 'product_name_consolidation', Array(100).fill(null).map((_, i) => ({
        caseId: `c_${i}`,
        success: true,
        validJson: true,
        latencyMs: 450,
        promptTokens: 100,
        completionTokens: 20,
      })));

      const comp = compareModelRuns(candidateRun, baselineRun);
      expect(comp.qualified).toBe(true);
      expect(comp.metrics.relativeAccuracy).toBe(1);

      const markdown = formatComparisonMarkdown([comp]);
      expect(markdown).toContain('gemma4:12b-mlx');
      expect(markdown).toContain('✅ Qualified');
    });

    test('disqualifies candidate model when JSON validity is below 99%', () => {
      const candidateRun = computeEvalRunResult('flaky-model', 'product_name_consolidation', [
        { caseId: '1', success: true, validJson: true, latencyMs: 100, promptTokens: 50, completionTokens: 10 },
        { caseId: '2', success: false, validJson: false, latencyMs: 100, promptTokens: 50, completionTokens: 10, failureCategory: 'invalid_json' },
      ]);

      const baselineRun = computeEvalRunResult('deepseek-v4-flash', 'product_name_consolidation', [
        { caseId: '1', success: true, validJson: true, latencyMs: 200, promptTokens: 50, completionTokens: 10 },
        { caseId: '2', success: true, validJson: true, latencyMs: 200, promptTokens: 50, completionTokens: 10 },
      ]);

      const comp = compareModelRuns(candidateRun, baselineRun);
      expect(comp.qualified).toBe(false);
      expect(comp.gateResults.jsonValidityPass).toBe(false);
      expect(comp.disqualificationReasons[0]).toContain('fell below 99.0% threshold');
    });
  });
});
