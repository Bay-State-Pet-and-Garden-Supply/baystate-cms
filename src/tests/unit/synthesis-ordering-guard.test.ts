/**
 * PR8 C3 (issue #30, DECISION-C): the fail-closed synthesis ordering guard.
 *
 * Description/search-keyword synthesis in `curateItemWithPipeline` is strictly
 * post-pipeline. In active cohort mode `assertCohortSynthesisOrdering` fails
 * closed when a required stage SILENTLY produced no terminal output — a
 * succeeded stage contributes a `stageOutputs` entry, an abstained stage
 * contributes a `reviewable_abstention` proposal; a stage with neither means
 * the member must fail rather than synthesize a partial draft.
 */
import { describe, expect, it } from 'bun:test';
import {
  assertCohortSynthesisOrdering,
  COHORT_SYNTHESIS_REQUIRED_STAGES,
} from '../../onboarding/product-curator';
import type { PipelineRunResult, StageOutput } from '../../classification/types';

function stageOutput(name: string): StageOutput {
  return {
    evidence: [],
    proposals: [],
    abstained: false,
    message: `${name} succeeded`,
    metadata: { [name]: true },
  };
}

/** A fully-successful pipeline result (every required stage produced output). */
function completeResult(): PipelineRunResult {
  const stageOutputs: PipelineRunResult['stageOutputs'] = {};
  for (const stageName of COHORT_SYNTHESIS_REQUIRED_STAGES) {
    stageOutputs[stageName] = stageOutput(stageName);
  }
  return { evidence: [], proposals: [], stageOutputs };
}

describe('PR8 C3 — assertCohortSynthesisOrdering (DECISION-C)', () => {
  it('passes when every required stage produced a terminal stage output', () => {
    expect(() => assertCohortSynthesisOrdering(completeResult())).not.toThrow();
  });

  it('passes when a required stage abstained (its reviewable_abstention proposal is a terminal outcome)', () => {
    const result = completeResult();
    delete result.stageOutputs.category_page_proposals;
    result.proposals.push({
      id: 'abstention-1',
      runId: 'run-1',
      productSku: 'SKU1',
      proposalType: 'reviewable_abstention',
      targetId: 'category_page_proposals',
      proposedValue: { reason: 'stored abstained page output' },
      confidence: 0,
      evidenceIds: [],
      status: 'pending',
      isBulkAcceptable: false,
      isStale: false,
      stalenessReason: null,
      snapshotHash: null,
      createdAt: new Date().toISOString(),
    });
    expect(() => assertCohortSynthesisOrdering(result)).not.toThrow();
  });

  it('fails closed when a required stage silently produced no output (no stageOutputs entry, no abstention proposal)', () => {
    const result = completeResult();
    delete result.stageOutputs.product_attribute_proposals;
    expect(() => assertCohortSynthesisOrdering(result)).toThrow(/product_attribute_proposals/);
    expect(() => assertCohortSynthesisOrdering(result)).toThrow(/failing closed — no partial draft/);
  });

  it('fails closed when the silent stage is the draft projection itself', () => {
    const result = completeResult();
    delete result.stageOutputs.product_draft_projection;
    expect(() => assertCohortSynthesisOrdering(result)).toThrow(/product_draft_projection/);
  });
});
