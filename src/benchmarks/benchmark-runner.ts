/**
 * Shared Benchmark Runner.
 *
 * Runs candidate models against frozen benchmark datasets, summarizing
 * accuracy, token usage, latency percentiles, and failure mode classifications.
 */

export type BenchmarkFailureCategory =
  | 'timeout'
  | 'invalid_json'
  | 'schema_failure'
  | 'hallucination'
  | 'wrong_answer'
  | 'tool_failure'
  | 'policy_denied'
  | 'context_overflow'
  | 'transport_failure';

export interface SingleCaseEvalResult {
  caseId: string;
  success: boolean;
  validJson: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  failureCategory?: BenchmarkFailureCategory;
  output?: unknown;
}

export interface ModelEvalRunResult {
  model: string;
  task: string;
  totalCases: number;
  successCount: number;
  failureCount: number;
  failureCategories: Record<BenchmarkFailureCategory, number>;
  parsedJsonValidityRate: number;
  accuracyRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  retryCount: number;
  fallbackCount: number;
}

export function computeEvalRunResult(
  model: string,
  task: string,
  results: SingleCaseEvalResult[],
  retryCount = 0,
  fallbackCount = 0,
): ModelEvalRunResult {
  const total = results.length;
  if (total === 0) {
    return {
      model,
      task,
      totalCases: 0,
      successCount: 0,
      failureCount: 0,
      failureCategories: {
        timeout: 0,
        invalid_json: 0,
        schema_failure: 0,
        hallucination: 0,
        wrong_answer: 0,
        tool_failure: 0,
        policy_denied: 0,
        context_overflow: 0,
        transport_failure: 0,
      },
      parsedJsonValidityRate: 0,
      accuracyRate: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      retryCount: 0,
      fallbackCount: 0,
    };
  }

  let successCount = 0;
  let validJsonCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  const failureCategories: Record<BenchmarkFailureCategory, number> = {
    timeout: 0,
    invalid_json: 0,
    schema_failure: 0,
    hallucination: 0,
    wrong_answer: 0,
    tool_failure: 0,
    policy_denied: 0,
    context_overflow: 0,
    transport_failure: 0,
  };

  const latencies: number[] = [];

  for (const r of results) {
    latencies.push(r.latencyMs);
    totalPromptTokens += r.promptTokens || 0;
    totalCompletionTokens += r.completionTokens || 0;

    if (r.validJson) validJsonCount += 1;

    if (r.success) {
      successCount += 1;
    } else if (r.failureCategory) {
      failureCategories[r.failureCategory] = (failureCategories[r.failureCategory] || 0) + 1;
    }
  }

  latencies.sort((a, b) => a - b);
  const p50Idx = Math.floor(latencies.length * 0.5);
  const p95Idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));

  return {
    model,
    task,
    totalCases: total,
    successCount,
    failureCount: total - successCount,
    failureCategories,
    parsedJsonValidityRate: Number((validJsonCount / total).toFixed(4)),
    accuracyRate: Number((successCount / total).toFixed(4)),
    latencyP50Ms: latencies[p50Idx] || 0,
    latencyP95Ms: latencies[p95Idx] || 0,
    totalPromptTokens,
    totalCompletionTokens,
    retryCount,
    fallbackCount,
  };
}
