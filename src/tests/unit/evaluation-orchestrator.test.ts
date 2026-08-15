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
  insertPiEvidence,
  insertPiSource,
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
      instructions: [
        {
          id: 'rule-cand',
          category: 'facts',
          rule: 'Candidate test rule for product research',
          createdAt: new Date().toISOString(),
        },
      ],
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

    insertExample(ds.id, sku1, null, 'promotion_test', JSON.stringify({ gtin: sku1, registerName: 'BLUE BUFF CAN DOG 12.5OZ' }), JSON.stringify(gold1));
    insertExample(ds.id, sku2, null, 'promotion_test', JSON.stringify({ gtin: sku2, registerName: 'PURINA PRO PLAN 30LB' }), JSON.stringify(gold2));
    markFamilyReviewComplete(ds.id, 'operator');
    freezeDataset(ds.id, 'operator');

    const mockExecutor = {
      name: 'mock_eval_executor',
      version: '1.0.0',
      async startResearch(input: any, context: any, sink: any) {
        sink.emit('session_created', { data: { piVersion: '0.83.0' } });
        const isCandidate = Boolean(context.compiledPrompt?.includes('Candidate test rule'));
        const isSku1 = input.gtin === sku1;
        const isExact = isCandidate || !isSku1;

        const src = insertPiSource({
          runId: context.runId,
          url: 'https://example.com/product',
          domain: 'example.com',
          sourceType: 'manufacturer',
          gtinMatchStatus: 'exact',
          variantMatchStatus: 'exact',
        });

        const ev = insertPiEvidence({
          runId: context.runId,
          sourceId: src.id,
          targetField: 'identity',
          value: {
            name: isExact
              ? (isSku1 ? 'Blue Buffalo Canned Dog Food 12.5 oz' : 'Purina Pro Plan Dog Food 30 lb')
              : 'Wrong Variant',
          },
          directSupport: true,
        });

        const submission = {
          schemaVersion: 1,
          gtin: input.gtin,
          inputName: input.registerName,
          identity: {
            status: isExact ? 'exact_match' : 'wrong_variant',
            brand: 'Test Brand',
            canonicalName: isExact
              ? (isSku1 ? 'Blue Buffalo Canned Dog Food 12.5 oz' : 'Purina Pro Plan Dog Food 30 lb')
              : 'Wrong Variant',
            variant: null,
            manufacturer: null,
            netContent: null,
            packCount: null,
            evidenceIds: [ev.id],
          },
          commerceFacts: [],
          classificationProposals: [],
          imageCandidates: [],
          conflicts: [],
          disposition: isExact ? 'research_complete' : 'needs_review',
        };

        return {
          runId: context.runId,
          executor: 'mock_eval_executor',
          executorVersion: '1.0.0',
          piVersion: '0.83.0',
          schemaVersion: 1,
          outcome: 'submitted' as const,
          submission,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          wallClockMs: 10,
        };
      },
    };

    const result = await runPairedEvaluation(wsId, {
      candidateVersionId: candidate.snapshot.id,
      baselineVersionId: baseline.snapshot.id,
      datasetId: ds.id,
      splitGroup: 'promotion_test',
      executor: mockExecutor as any,
    });

    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.splitGroup).toBe('promotion_test');
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
