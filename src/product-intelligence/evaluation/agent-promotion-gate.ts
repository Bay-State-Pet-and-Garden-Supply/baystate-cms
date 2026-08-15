/**
 * Agent Lab: Agent Promotion Gate.
 *
 * Dedicated promotion authority that reuses measured rollout thresholds
 * ('reviewed_import' or higher) and enforces strict completeness and
 * zero critical regression floors.
 */
import { evaluateRolloutGate, getRolloutConfig } from './rollout';
import type { PiAggregateReport } from './metrics';

export interface AgentPromotionGateOptions {
  candidateReport: PiAggregateReport | null;
  baselineReport: PiAggregateReport | null;
  totalCases: number;
  completedCases: number;
  criticalRegressions: number;
  nonCriticalRegressions: number;
}

export interface AgentPromotionGateResult {
  allowed: boolean;
  reasons: string[];
  complete: boolean;
  criticalRegressions: number;
  rolloutGateAllowed: boolean;
}

export function evaluateAgentPromotionGate(opts: AgentPromotionGateOptions): AgentPromotionGateResult {
  const reasons: string[] = [];

  // 1. Completeness Invariant
  const isComplete = opts.totalCases > 0 && opts.completedCases === opts.totalCases;
  if (!isComplete) {
    reasons.push(
      `incomplete_evaluation: ${opts.completedCases}/${opts.totalCases} cases completed (100% paired completion required)`,
    );
  }

  // 2. Critical Regression Floor (Zero Tolerance)
  if (opts.criticalRegressions > 0) {
    reasons.push(
      `critical_regressions_detected: ${opts.criticalRegressions} critical regression(s) on identity/variant/image rights`,
    );
  }

  // 3. Measured Rollout Gate (reusing established thresholds)
  const currentConfig = getRolloutConfig();
  // Evaluate at 'reviewed_import' floor (or current workspace stage if higher)
  const targetStage = currentConfig.stage === 'shadow_only' || currentConfig.stage === 'manual_agent_lab'
    ? 'reviewed_import'
    : currentConfig.stage;

  const rolloutResult = evaluateRolloutGate(targetStage, opts.candidateReport);
  if (!rolloutResult.allowed) {
    reasons.push(...rolloutResult.reasons);
  }

  // 4. Differential Regression Guard vs Active Baseline
  if (opts.candidateReport && opts.baselineReport) {
    const candHit = opts.candidateReport.rates['identity.exactProductHit'] ?? 0;
    const baseHit = opts.baselineReport.rates['identity.exactProductHit'] ?? 0;
    if (candHit < baseHit - 0.05) {
      reasons.push(
        `net_regression: candidate exactProductHit (${candHit.toFixed(3)}) regressed by >5% vs baseline (${baseHit.toFixed(3)})`,
      );
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    complete: isComplete,
    criticalRegressions: opts.criticalRegressions,
    rolloutGateAllowed: rolloutResult.allowed,
  };
}
