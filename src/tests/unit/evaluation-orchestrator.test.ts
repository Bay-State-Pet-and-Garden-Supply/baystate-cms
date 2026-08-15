import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createCandidateSnapshot,
  ensureBaselineVersion,
} from '../../db/repositories/agent-version-repo';
import {
  createDataset,
  freezeDataset,
  insertExample,
  markFamilyReviewComplete,
} from '../../db/repositories/benchmark-repo';
import {
  createPiRun,
  insertPiResult,
  transitionPiRunStatus,
} from '../../db/repositories/product-intelligence-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { evaluateAgentPromotionGate } from '../../product-intelligence/evaluation/agent-promotion-gate';
import { runPairedEvaluation } from '../../product-intelligence/evaluation/evaluation-orchestrator';

describe('evaluation-orchestrator & promotion gate', () => {
  const wsId = 'ws-eval-test';

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'Test WS',
      workspacePath: '/tmp/test',
      gitPath: '/tmp/test/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterEach(() => {
    closeDb();
  });

  it('enforces that incomplete evaluations fail promotion gate', () => {
    const verdict = evaluateAgentPromotionGate({
      candidateReport: null,
      baselineReport: null,
      totalCases: 10,
      completedCases: 8, // Incomplete!
      criticalRegressions: 0,
      nonCriticalRegressions: 0,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.complete).toBe(false);
    expect(verdict.reasons[0]).toContain('incomplete_evaluation');
  });

  it('enforces zero tolerance for critical regressions in promotion gate', () => {
    const verdict = evaluateAgentPromotionGate({
      candidateReport: null,
      baselineReport: null,
      totalCases: 10,
      completedCases: 10,
      criticalRegressions: 1, // Critical regression on identity/image rights!
      nonCriticalRegressions: 0,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('critical_regressions_detected'))).toBe(true);
  });

  it('orchestrates paired evaluation and creates granular case experiment rows', async () => {
    const baseline = ensureBaselineVersion(wsId);
    const candidate = createCandidateSnapshot(wsId, {
      parentVersionId: baseline.snapshot.id,
      instructions: [],
      fewShotExamples: [],
      createdBy: 'operator',
      changeSummary: 'Candidate test',
    });

    // Create a mini benchmark dataset with 2 cases
    const ds = createDataset(wsId, 'test-eval-ds', 'random', 42);
    const sku1 = '076280014028';
    const sku2 = '011111222222';

    const gold1 = {
      identity: { exactProduct: true, exactVariant: true },
      expectedTitle: 'Blue Buffalo Canned Dog Food 12.5 oz',
      requiredFacts: [],
      expectedEvidence: [],
      expectedImage: { identityMatch: 'exact' as const, rightsStatus: 'approved' as const },
      expectedClassification: { productType: 'Dog Food', attributes: [], categoryPages: [] },
      misleadingSources: [],
      difficultyTags: [],
    };

    const gold2 = {
      identity: { exactProduct: true, exactVariant: true },
      expectedTitle: 'Purina Pro Plan Dog Food 30 lb',
      requiredFacts: [],
      expectedEvidence: [],
      expectedImage: { identityMatch: 'exact' as const, rightsStatus: 'approved' as const },
      expectedClassification: { productType: 'Dog Food', attributes: [], categoryPages: [] },
      misleadingSources: [],
      difficultyTags: [],
    };

    insertExample(ds.id, sku1, null, 'test', JSON.stringify({ gtin: sku1 }), JSON.stringify(gold1));
    insertExample(ds.id, sku2, null, 'test', JSON.stringify({ gtin: sku2 }), JSON.stringify(gold2));
    markFamilyReviewComplete(ds.id, 'operator');
    freezeDataset(ds.id, 'operator');

    // Create baseline and candidate runs for both SKUs
    // Case 1: Baseline failed (wrong variant), candidate fixed (exact match)
    const baseRun1 = createPiRun({
      id: 'run-base-1',
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: sku1 }),
      policyJson: '{}',
      configSnapshotId: 'snap-1',
      configSnapshotHash: 'hash-1',
      extensionVersionsJson: '[]',
      agentVersionSnapshotId: baseline.snapshot.id,
    });
    transitionPiRunStatus(baseRun1.id, 'completed');
    insertPiResult({
      runId: baseRun1.id,
      schemaVersion: 1,
      result: {
        identity: { status: 'wrong_variant', canonicalName: 'Wrong Variant 12-pack', confidence: 0.9 },
      },
      disposition: 'submitted',
    });

    const candRun1 = createPiRun({
      id: 'run-cand-1',
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: sku1 }),
      policyJson: '{}',
      configSnapshotId: 'snap-1',
      configSnapshotHash: 'hash-1',
      extensionVersionsJson: '[]',
      agentVersionSnapshotId: candidate.snapshot.id,
    });
    transitionPiRunStatus(candRun1.id, 'completed');
    insertPiResult({
      runId: candRun1.id,
      schemaVersion: 1,
      result: {
        identity: { status: 'exact', canonicalName: 'Blue Buffalo Canned Dog Food 12.5 oz', confidence: 0.95 },
      },
      disposition: 'submitted',
    });

    // Case 2: Both passed (unchanged)
    const baseRun2 = createPiRun({
      id: 'run-base-2',
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: sku2 }),
      policyJson: '{}',
      configSnapshotId: 'snap-1',
      configSnapshotHash: 'hash-1',
      extensionVersionsJson: '[]',
      agentVersionSnapshotId: baseline.snapshot.id,
    });
    transitionPiRunStatus(baseRun2.id, 'completed');
    insertPiResult({
      runId: baseRun2.id,
      schemaVersion: 1,
      result: {
        identity: { status: 'exact', canonicalName: 'Purina Pro Plan Dog Food 30 lb', confidence: 0.95 },
      },
      disposition: 'submitted',
    });

    const candRun2 = createPiRun({
      id: 'run-cand-2',
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: sku2 }),
      policyJson: '{}',
      configSnapshotId: 'snap-1',
      configSnapshotHash: 'hash-1',
      extensionVersionsJson: '[]',
      agentVersionSnapshotId: candidate.snapshot.id,
    });
    transitionPiRunStatus(candRun2.id, 'completed');
    insertPiResult({
      runId: candRun2.id,
      schemaVersion: 1,
      result: {
        identity: { status: 'exact', canonicalName: 'Purina Pro Plan Dog Food 30 lb', confidence: 0.95 },
      },
      disposition: 'submitted',
    });

    const result = await runPairedEvaluation(wsId, {
      candidateVersionId: candidate.snapshot.id,
      baselineVersionId: baseline.snapshot.id,
      datasetId: ds.id,
      splitGroup: 'test',
    });

    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.scorecard.totalCases).toBe(2);
    expect(result.snapshot.scorecard.completedCases).toBe(2);
    expect(result.snapshot.scorecard.fixedCount).toBe(1);
    expect(result.snapshot.scorecard.regressedCount).toBe(0);
    expect(result.snapshot.scorecard.unchangedCount).toBe(1);
    expect(result.cases.length).toBe(2);

    const case1 = result.cases.find((c) => c.productSku === sku1);
    expect(case1?.deltaClass).toBe('fixed');
    expect(case1?.criticalRegression).toBe(false);

    const case2 = result.cases.find((c) => c.productSku === sku2);
    expect(case2?.deltaClass).toBe('unchanged');
  });
});
