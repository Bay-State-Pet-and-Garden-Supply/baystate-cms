/**
 * Fail-Closed Feature Policy
 *
 * Evaluates the configuration's MlFeaturesPolicy into a concrete per-feature
 * decision. An ML feature is NEVER auto-enabled:
 * - disabled config → disabled;
 * - evaluation_only config → evaluation namespace only, and only with an
 *   explicit valid request;
 * - qualified/enabled config → production use additionally requires a verified
 *   qualification receipt digest AND an activation audit (activatedBy and
 *   activatedAt set on the config policy).
 *
 * The verified receipt set is supplied by the caller (e.g. from the persisted
 * benchmark_qualification_receipts table keyed by digest) — this module never
 * fabricates verification.
 */

import type {
  MlFeatureId,
  MlFeaturePolicy,
  ModelPolicyConfigV2,
  FeaturePolicyDecision,
} from '../shared/schemas/classification';

export type FeatureRequestScope = 'production' | 'evaluation';

export interface FeatureRequest {
  feature: MlFeatureId;
  scope: FeatureRequestScope;
  /** Explicit request marker required for evaluation-namespace access. */
  evaluationRequestToken?: string;
}

export const ALL_ML_FEATURES: MlFeatureId[] = [
  'productionRetrieval',
  'pageReranking',
  'confidenceCalibration',
  'productionEmbeddings',
];

export interface FeaturePolicyOptions {
  /** Digests of independently verified qualification receipts. */
  verifiedReceiptDigests?: ReadonlySet<string>;
  /** Persisted receipt records keyed by digest (for evaluation-only diagnostics). */
  receiptsByDigest?: ReadonlyMap<string, { digest: string; qualified: boolean }>;
}

function hasActivationAudit(policy: MlFeaturePolicy): boolean {
  return Boolean(policy.activatedBy) && Boolean(policy.activatedAt);
}

/**
 * Evaluate a single feature. Never returns 'enabled' unless the config policy
 * is qualified/enabled AND the receipt digest is verified AND the activation
 * audit is present. Any gap degrades the decision to 'disabled'.
 */
export function evaluateFeaturePolicy(
  modelPolicy: ModelPolicyConfigV2,
  request: FeatureRequest,
  options: FeaturePolicyOptions = {},
): FeaturePolicyDecision {
  const policy = modelPolicy.mlFeatures[request.feature];
  const reason = (state: 'disabled' | 'evaluation_only', message: string): FeaturePolicyDecision => ({
    feature: request.feature,
    state,
    reason: message,
    receiptDigest: null,
  });

  if (!policy) {
    return reason('disabled', `No policy configured for ${request.feature}.`);
  }

  const receiptDigest = policy.qualificationReceiptDigest;
  const verified = receiptDigest !== null && (options.verifiedReceiptDigests?.has(receiptDigest) ?? false);

  if (policy.state === 'disabled') {
    return reason('disabled', `${request.feature} is disabled in the configuration.`);
  }

  if (policy.state === 'evaluation_only') {
    if (request.scope === 'evaluation' && request.evaluationRequestToken) {
      return {
        feature: request.feature,
        state: 'evaluation_only',
        reason: `${request.feature} permitted for evaluation-only namespace (explicit request).`,
        receiptDigest: receiptDigest,
      };
    }
    return reason('disabled', `${request.feature} is evaluation-only; production access denied.`);
  }

  // state is 'qualified' or 'enabled': production use requires verification.
  if (request.scope === 'evaluation' && request.evaluationRequestToken) {
    return {
      feature: request.feature,
      state: 'evaluation_only',
      reason: `${request.feature} permitted for evaluation-only namespace (explicit request).`,
      receiptDigest: receiptDigest,
    };
  }

  if (!receiptDigest) {
    return reason('disabled', `${request.feature} has no qualification receipt digest.`);
  }
  if (!verified) {
    return reason('disabled', `${request.feature} receipt digest ${receiptDigest} is not independently verified.`);
  }
  if (!hasActivationAudit(policy)) {
    return reason('disabled', `${request.feature} is qualified but has no activation audit (activatedBy/activatedAt).`);
  }

  return {
    feature: request.feature,
    state: 'enabled',
    reason: `${request.feature} enabled: verified receipt ${receiptDigest.slice(0, 12)}… and activation audit present.`,
    receiptDigest,
  };
}

/**
 * Evaluate every configured ML feature. Returns a map keyed by feature id.
 */
export function evaluateAllFeatures(
  modelPolicy: ModelPolicyConfigV2,
  scope: FeatureRequestScope,
  options: FeaturePolicyOptions = {},
  evaluationRequestToken?: string,
): Record<MlFeatureId, FeaturePolicyDecision> {
  const decisions = {} as Record<MlFeatureId, FeaturePolicyDecision>;
  for (const feature of ALL_ML_FEATURES) {
    decisions[feature] = evaluateFeaturePolicy(modelPolicy, {
      feature,
      scope,
      evaluationRequestToken,
    }, options);
  }
  return decisions;
}
