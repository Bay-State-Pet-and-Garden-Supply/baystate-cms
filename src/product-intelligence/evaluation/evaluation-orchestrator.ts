/**
 * Agent Lab: Evaluation Orchestrator.
 *
 * Orchestrates paired candidate vs baseline evaluation over frozen benchmark datasets,
 * persists paired agent_evaluation_cases and aggregate agent_evaluation_snapshots,
 * and assesses the agent promotion gate.
 */
import { getDb } from '../../db/connection';
import {
  getDatasetForWorkspace,
  getExamples,
  listDatasets,
} from '../../db/repositories/benchmark-repo';
import {
  getActiveVersion,
  getVersionSnapshot,
  updateCandidateLifecycleStatus,
} from '../../db/repositories/agent-version-repo';
import {
  completeEvaluationSnapshot,
  createEvaluationSnapshot,
  insertEvaluationCase,
} from '../../db/repositories/agent-evaluation-repo';
import { getPiResult, getPiRun } from '../../db/repositories/product-intelligence-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { PI_GOLDEN_DATASET_NAME } from './fixture-dataset';
import { seedPiGoldenDataset } from './runner';
import { PiGoldLabelsSchema, type PiGoldLabels } from './gold';
import {
  aggregatePiComparisons,
  classifyRunOutcome,
  comparePredictionToGold,
  extractPredictionFromResult,
  type PiComparison,
} from './metrics';
import { evaluateAgentPromotionGate } from './agent-promotion-gate';
import { startProductIntelligenceRun } from '../run-service';
import { createExecutionRouter } from '../execution-router';
import { PiProductIntelligenceExecutor } from '../pi/pi-executor';
import { PiSdkSessionFactory } from '../pi/pi-session-factory';
import { defaultToolRegistry } from '../tools';
import { LegacyProductIntelligenceExecutor } from '../legacy-executor';
import type { ProductIntelligenceExecutor } from '../executor';
import { ProductResearchInputSchema } from '../contracts';
import type {
  AgentEvaluationCase,
  AgentEvaluationSnapshot,
  EvaluationDeltaClass,
} from '../../shared/schemas/agent-training';

export interface PairedEvaluationOptions {
  candidateVersionId: string;
  baselineVersionId?: string;
  datasetId?: string;
  splitGroup?: 'promotion_test' | 'test' | 'validation' | 'train';
  actor?: string;
  executor?: ProductIntelligenceExecutor;
}

export interface PairedEvaluationResult {
  snapshot: AgentEvaluationSnapshot;
  cases: AgentEvaluationCase[];
}

export async function runPairedEvaluation(
  workspaceId: string,
  options: PairedEvaluationOptions,
): Promise<PairedEvaluationResult> {
  const candidateSummary = getVersionSnapshot(workspaceId, options.candidateVersionId);
  if (!candidateSummary) {
    throw new Error(`Candidate version ${options.candidateVersionId} not found`);
  }

  const baselineSummary = options.baselineVersionId
    ? getVersionSnapshot(workspaceId, options.baselineVersionId)
    : getActiveVersion(workspaceId);

  if (!baselineSummary) {
    throw new Error('No active baseline version found to evaluate against');
  }

  // Resolve dataset
  let targetDatasetId = options.datasetId;
  if (!targetDatasetId) {
    const existing = listDatasets(workspaceId).find((d) => d.name === PI_GOLDEN_DATASET_NAME);
    if (existing) {
      targetDatasetId = existing.id;
    } else {
      const seeded = seedPiGoldenDataset();
      targetDatasetId = seeded.datasetId;
    }
  }

  const dataset = getDatasetForWorkspace(targetDatasetId, workspaceId);
  if (!dataset) {
    throw new Error(`Dataset ${targetDatasetId} not found in workspace ${workspaceId}`);
  }
  if (dataset.status !== 'frozen') {
    throw new Error(`Dataset ${targetDatasetId} must be frozen before evaluation`);
  }

  const splitGroup = options.splitGroup ?? 'promotion_test';

  // Mark candidate version as evaluating
  updateCandidateLifecycleStatus(workspaceId, candidateSummary.snapshot.id, 'evaluating');

  // Create running evaluation snapshot header
  const evalSnapshot = createEvaluationSnapshot(workspaceId, {
    candidateVersionId: candidateSummary.snapshot.id,
    baselineVersionId: baselineSummary.snapshot.id,
    datasetId: dataset.id,
    datasetHash: dataset.dataset_hash ?? '',
    splitGroup,
  });

  const ws = findWorkspace();
  const wsPath = ws?.workspacePath ?? '.';

  // Resolve executor
  let executor = options.executor;
  if (!executor) {
    const router = createExecutionRouter({
      pi: new PiProductIntelligenceExecutor({
        sessionFactory: new PiSdkSessionFactory({ toolRegistry: defaultToolRegistry }),
      }),
      legacy: new LegacyProductIntelligenceExecutor(),
    });
    const selection = await router.resolveExecutor();
    executor = selection.executor;
  }

  // Get examples with gold labels (evaluation engine is authorized to access full gold labels)
  const examples = getExamples(dataset.id, splitGroup);

  const candidateComparisons: PiComparison[] = [];
  const baselineComparisons: PiComparison[] = [];
  const evaluationCases: AgentEvaluationCase[] = [];

  let fixedCount = 0;
  let regressedCount = 0;
  let unchangedCount = 0;
  let criticalRegressions = 0;
  let nonCriticalRegressions = 0;

  for (const example of examples) {
    const sku = example.product_sku;

    let gold: PiGoldLabels;
    try {
      const parsed = PiGoldLabelsSchema.safeParse(JSON.parse(example.gold_labels_json));
      if (!parsed.success) {
        continue;
      }
      gold = parsed.data;
    } catch {
      continue;
    }

    let inputData: any;
    try {
      inputData = JSON.parse(example.input_snapshot_json);
    } catch {
      inputData = { gtin: sku };
    }

    const parsedInput = ProductResearchInputSchema.parse({
      gtin: inputData.gtin ?? sku,
      registerName: inputData.registerName ?? '',
      brandHint: inputData.brandHint ?? '',
      departmentHint: inputData.departmentHint ?? '',
      price: inputData.price ? String(inputData.price) : '0.00',
      quantity: inputData.quantity ? Number(inputData.quantity) : 1,
    });

    let candRunId = '';
    let baseRunId = '';
    let candOutcome: any = 'failed';
    let baseOutcome: any = 'failed';
    let candComparison: PiComparison | null = null;
    let baseComparison: PiComparison | null = null;

    try {
      // 1. Launch candidate shadow run
      const candStart = await startProductIntelligenceRun(
        executor,
        {
          input: parsedInput,
          agentVersionSnapshotId: candidateSummary.snapshot.id,
          mode: 'shadow',
        },
        { workspaceId, workspacePath: wsPath },
      );
      await candStart.completed;
      candRunId = candStart.run.id;
      const candRun = getPiRun(candStart.run.id);

      // 2. Launch baseline shadow run
      const baseStart = await startProductIntelligenceRun(
        executor,
        {
          input: parsedInput,
          agentVersionSnapshotId: baselineSummary.snapshot.id,
          mode: 'shadow',
        },
        { workspaceId, workspacePath: wsPath },
      );
      await baseStart.completed;
      baseRunId = baseStart.run.id;
      const baseRun = getPiRun(baseStart.run.id);

      if (candRun && baseRun) {
        const candResult = getPiResult(candRun.id);
        const candPrediction = extractPredictionFromResult(candResult?.resultJson ?? null);
        candOutcome = classifyRunOutcome(
          candRun.status,
          candRun.errorCode,
          candResult?.disposition ?? null,
          candPrediction?.identityStatus ?? null,
        );
        candComparison = comparePredictionToGold(candPrediction, gold, candOutcome);

        const baseResult = getPiResult(baseRun.id);
        const basePrediction = extractPredictionFromResult(baseResult?.resultJson ?? null);
        baseOutcome = classifyRunOutcome(
          baseRun.status,
          baseRun.errorCode,
          baseResult?.disposition ?? null,
          basePrediction?.identityStatus ?? null,
        );
        baseComparison = comparePredictionToGold(basePrediction, gold, baseOutcome);
      }
    } catch {
      // If run execution failed, case will record as failed
    }

    if (!candComparison || !baseComparison) {
      const failedCase = insertEvaluationCase(workspaceId, {
        evaluationId: evalSnapshot.id,
        benchmarkExampleId: example.id,
        productSku: sku,
        candidateRunId: candRunId || 'failed',
        baselineRunId: baseRunId || 'failed',
        candidateOutcome: candOutcome,
        baselineOutcome: baseOutcome,
        comparison: { candidate: null, baseline: null },
        deltaClass: 'unchanged',
        criticalRegression: false,
        status: 'failed',
      });
      evaluationCases.push(failedCase);
      continue;
    }

    candidateComparisons.push(candComparison);
    baselineComparisons.push(baseComparison);

    // Delta classification
    const candPassed = candOutcome === 'submitted' && candComparison.identity.exactProductHit;
    const basePassed = baseOutcome === 'submitted' && baseComparison.identity.exactProductHit;

    let deltaClass: EvaluationDeltaClass = 'unchanged';
    let isCritical = false;

    if (candPassed && !basePassed) {
      deltaClass = 'fixed';
      fixedCount += 1;
    } else if (!candPassed && basePassed) {
      deltaClass = 'regressed';
      regressedCount += 1;

      // Check if critical regression
      if (
        candOutcome === 'wrong_variant' ||
        candOutcome === 'parent_product_only' ||
        !candComparison.identity.exactProductHit ||
        candComparison.image.rightsRejectionCorrect === false
      ) {
        isCritical = true;
        criticalRegressions += 1;
      } else {
        nonCriticalRegressions += 1;
      }
    } else {
      unchangedCount += 1;
    }

    const caseRow = insertEvaluationCase(workspaceId, {
      evaluationId: evalSnapshot.id,
      benchmarkExampleId: example.id,
      productSku: sku,
      candidateRunId: candRunId,
      baselineRunId: baseRunId,
      candidateOutcome: candOutcome,
      baselineOutcome: baseOutcome,
      comparison: { candidate: candComparison, baseline: baseComparison },
      deltaClass,
      criticalRegression: isCritical,
      status: 'completed',
    });

    evaluationCases.push(caseRow);
  }

  // Aggregate Reports
  const candidateReport = candidateComparisons.length > 0 ? aggregatePiComparisons(candidateComparisons) : null;
  const baselineReport = baselineComparisons.length > 0 ? aggregatePiComparisons(baselineComparisons) : null;

  const totalCases = examples.length;
  const completedCases = evaluationCases.length;

  const candExactHit = candidateReport?.rates['identity.exactProductHit'] ?? 0;
  const baseExactHit = baselineReport?.rates['identity.exactProductHit'] ?? 0;

  const scorecard = {
    totalCases,
    completedCases,
    fixedCount,
    regressedCount,
    unchangedCount,
    criticalRegressions,
    candidateExactProductHit: candExactHit,
    baselineExactProductHit: baseExactHit,
    candidateProductTypeAccuracy: candidateReport?.rates['classification.productTypeAccurate'] ?? null,
    baselineProductTypeAccuracy: baselineReport?.rates['classification.productTypeAccurate'] ?? null,
    candidateAbstentionCorrect: candidateReport?.rates['identity.abstentionCorrect'] ?? null,
    baselineAbstentionCorrect: baselineReport?.rates['identity.abstentionCorrect'] ?? null,
    deltaExactProductHit: candExactHit - baseExactHit,
  };

  // Evaluate promotion gate
  const gateVerdict = evaluateAgentPromotionGate({
    candidateReport,
    baselineReport,
    totalCases,
    completedCases,
    criticalRegressions,
    nonCriticalRegressions,
  });

  const finalStatus = gateVerdict.allowed ? 'passed' : 'failed';

  const completedSnapshot = completeEvaluationSnapshot(
    workspaceId,
    evalSnapshot.id,
    scorecard,
    gateVerdict,
    finalStatus,
  );

  // If passed, mark candidate as qualified
  if (gateVerdict.allowed) {
    updateCandidateLifecycleStatus(
      workspaceId,
      candidateSummary.snapshot.id,
      'qualified',
      completedSnapshot.id,
    );
  } else {
    updateCandidateLifecycleStatus(
      workspaceId,
      candidateSummary.snapshot.id,
      'draft',
      completedSnapshot.id,
    );
  }

  return {
    snapshot: completedSnapshot,
    cases: evaluationCases,
  };
}
