/**
 * Packaging VLM Model Comparison Experiment (PR 5).
 *
 * Compares Gemma 4 12B MLX against the existing Qwen2.5-VL baseline
 * for packaging OCR extraction accuracy, field-level F1, and UPC exact matching.
 */

import { scoreVlmOcr, type VlmEvalCase, type VlmScorerResult } from '../ai/evals/vlm-scorer';

export interface VlmExperimentResult {
  baselineModel: string; // e.g. qwen2.5vl:latest
  candidateModel: string; // e.g. gemma4:12b-mlx
  baselineScores: VlmScorerResult;
  candidateScores: VlmScorerResult;
  qualified: boolean;
  upcMatchRegressed: boolean;
  f1Comparable: boolean;
  recommendation: 'promote_gemma_unified' | 'retain_qwen_vlm';
}

export function runVlmExperiment(
  cases: VlmEvalCase[],
  baselinePredictions: Array<{ caseId: string; extractedUpc?: string | null; extractedFields: Record<string, string> }>,
  candidatePredictions: Array<{ caseId: string; extractedUpc?: string | null; extractedFields: Record<string, string> }>,
  baselineModel = 'qwen2.5vl:latest',
  candidateModel = 'gemma4:12b-mlx',
): VlmExperimentResult {
  const baselineScores = scoreVlmOcr(cases, baselinePredictions);
  const candidateScores = scoreVlmOcr(cases, candidatePredictions);

  const upcMatchRegressed = candidateScores.upcMatchRate < baselineScores.upcMatchRate;
  const f1Comparable = candidateScores.fieldF1 >= baselineScores.fieldF1 * 0.97;

  const hasSuccesses = candidateScores.upcMatchRate > 0 || candidateScores.fieldF1 > 0;
  const qualified = hasSuccesses && !upcMatchRegressed && f1Comparable;

  return {
    baselineModel,
    candidateModel,
    baselineScores,
    candidateScores,
    qualified,
    upcMatchRegressed,
    f1Comparable,
    recommendation: qualified ? 'promote_gemma_unified' : 'retain_qwen_vlm',
  };
}
