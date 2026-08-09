import { describe, test, expect } from 'vitest';
import { runVlmExperiment } from '../../benchmarks/vlm-experiment';

describe('Packaging VLM Experiment (PR 5)', () => {
  const cases = [
    { id: '1', imagePath: '/img/1.jpg', expectedUpc: '123456789012', expectedFields: { brand: 'Woof', weight: '2.64oz' } },
  ];

  test('recommends promote_gemma_unified when Gemma 4 12B matches Qwen2.5-VL baseline', () => {
    const preds = [
      { caseId: '1', extractedUpc: '123456789012', extractedFields: { brand: 'Woof', weight: '2.64oz' } },
    ];

    const exp = runVlmExperiment(cases, preds, preds);
    expect(exp.qualified).toBe(true);
    expect(exp.recommendation).toBe('promote_gemma_unified');
  });

  test('recommends retain_qwen_vlm when candidate UPC match regresses', () => {
    const baselinePreds = [
      { caseId: '1', extractedUpc: '123456789012', extractedFields: { brand: 'Woof', weight: '2.64oz' } },
    ];

    const candidatePreds = [
      { caseId: '1', extractedUpc: 'wrong-upc', extractedFields: { brand: 'Woof', weight: '2.64oz' } },
    ];

    const exp = runVlmExperiment(cases, baselinePreds, candidatePreds);
    expect(exp.qualified).toBe(false);
    expect(exp.upcMatchRegressed).toBe(true);
    expect(exp.recommendation).toBe('retain_qwen_vlm');
  });
});
