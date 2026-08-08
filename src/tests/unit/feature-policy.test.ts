import { describe, it, expect } from 'vitest';
import {
  evaluateFeaturePolicy,
  evaluateAllFeatures,
  ALL_ML_FEATURES,
} from '../../classification/feature-policy';
import type { ModelPolicyConfigV2 } from '../../shared/schemas/classification';

function policyWith(featureState: 'disabled' | 'evaluation_only' | 'qualified' | 'enabled', extra: Partial<ModelPolicyConfigV2['mlFeatures']['productionRetrieval']> = {}): ModelPolicyConfigV2 {
  const basePolicy = { state: featureState as any, qualificationReceiptDigest: null, activatedBy: null, activatedAt: null, ...extra };
  return {
    defaultProvider: 'ollama',
    defaultModel: 'qwen2.5vl:latest',
    providerLocalities: { ollama: 'local' },
    stageOverrides: {},
    imageDataSharing: 'local_only',
    textDataSharing: 'local_only',
    mlFeatures: {
      productionRetrieval: { ...basePolicy },
      pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
    },
  };
}

const RECEIPT = '1'.repeat(64);

describe('Feature policy (fail closed)', () => {
  it('disabled config → disabled for both scopes', () => {
    const policy = policyWith('disabled');
    const production = evaluateFeaturePolicy(policy, { feature: 'productionRetrieval', scope: 'production' });
    const evaluation = evaluateFeaturePolicy(policy, { feature: 'productionRetrieval', scope: 'evaluation', evaluationRequestToken: 't' });
    expect(production.state).toBe('disabled');
    expect(evaluation.state).toBe('disabled');
  });

  it('evaluation_only is gated behind an explicit request', () => {
    const policy = policyWith('evaluation_only');
    const production = evaluateFeaturePolicy(policy, { feature: 'productionRetrieval', scope: 'production' });
    const evaluationNoToken = evaluateFeaturePolicy(policy, { feature: 'productionRetrieval', scope: 'evaluation' });
    const evaluationExplicit = evaluateFeaturePolicy(policy, { feature: 'productionRetrieval', scope: 'evaluation', evaluationRequestToken: 'req-1' });

    expect(production.state).toBe('disabled');
    expect(evaluationNoToken.state).toBe('disabled');
    expect(evaluationExplicit.state).toBe('evaluation_only');
  });

  it('qualified with a verified receipt but no activation audit stays disabled', () => {
    const policy = policyWith('qualified', { qualificationReceiptDigest: RECEIPT });
    const decision = evaluateFeaturePolicy(policy, { feature: 'productionRetrieval', scope: 'production' }, {
      verifiedReceiptDigests: new Set([RECEIPT]),
    });
    expect(decision.state).toBe('disabled');
    expect(decision.reason).toMatch(/activation audit/);
  });

  it('qualified with a receipt and activation audit → enabled', () => {
    const policy = policyWith('qualified', {
      qualificationReceiptDigest: RECEIPT,
      activatedBy: 'operator-1',
      activatedAt: '2026-08-04T00:00:00.000Z',
    });
    const decision = evaluateFeaturePolicy(policy, { feature: 'productionRetrieval', scope: 'production' }, {
      verifiedReceiptDigests: new Set([RECEIPT]),
    });
    expect(decision.state).toBe('enabled');
    expect(decision.receiptDigest).toBe(RECEIPT);
  });

  it('qualified but unverified receipt digest → disabled (never guesses verification)', () => {
    const policy = policyWith('qualified', {
      qualificationReceiptDigest: RECEIPT,
      activatedBy: 'operator-1',
      activatedAt: '2026-08-04T00:00:00.000Z',
    });
    const decision = evaluateFeaturePolicy(policy, { feature: 'productionRetrieval', scope: 'production' }, {
      verifiedReceiptDigests: new Set(['2'.repeat(64)]),
    });
    expect(decision.state).toBe('disabled');
    expect(decision.reason).toMatch(/not independently verified/);
  });

  it('enabled config still requires receipt + audit (never auto-enables)', () => {
    const policy = policyWith('enabled', { qualificationReceiptDigest: RECEIPT, activatedBy: 'op', activatedAt: '2026-08-04T00:00:00.000Z' });
    // Without the verified receipt set, enabled config still resolves disabled.
    const decision = evaluateFeaturePolicy(policy, { feature: 'productionRetrieval', scope: 'production' });
    expect(decision.state).toBe('disabled');
  });

  it('evaluateAllFeatures returns a decision for every feature', () => {
    const policy = policyWith('disabled');
    const decisions = evaluateAllFeatures(policy, 'production');
    expect(Object.keys(decisions).sort()).toEqual([...ALL_ML_FEATURES].sort());
    for (const decision of Object.values(decisions)) {
      expect(decision.state).toBe('disabled');
    }
  });
});
