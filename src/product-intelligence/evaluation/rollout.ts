/**
 * PI-9 rollout gates: staged enablement of Product Intelligence backed by
 * MEASURED evaluation metrics (never model-reported confidence alone), plus
 * the global kill switch that returns every workspace to the normal
 * pipeline.
 *
 * Stages (ordered): shadow_only → manual_agent_lab → reviewed_import →
 * optional_onboarding → automatic. Thresholds are documented config; the
 * gate denies advancement on insufficient samples.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { getDb } from '../../db/connection';
import { getProductIntelligenceFlags } from '../flags';
import type { PiAggregateReport } from './metrics';

export const ROLLOUT_STAGES = ['shadow_only', 'manual_agent_lab', 'reviewed_import', 'optional_onboarding', 'automatic'] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number];

export interface RolloutGateThreshold {
  /** Metric key in PiAggregateReport.rates (e.g. 'identity.exactProductHit'). */
  metric: string;
  min: number | null;
  max: number | null;
  minSampleSize: number;
}

export interface RolloutConfig {
  stage: RolloutStage;
  thresholds: RolloutGateThreshold[];
  documentedBy: string;
  updatedAt: string;
}

export const DEFAULT_ROLLOUT_THRESHOLDS: Record<RolloutStage, RolloutGateThreshold[]> = {
  shadow_only: [],
  manual_agent_lab: [],
  reviewed_import: [
    { metric: 'identity.exactProductHit', min: 0.9, max: null, minSampleSize: 30 },
    { metric: 'identity.abstentionCorrect', min: 0.8, max: null, minSampleSize: 30 },
    { metric: 'unsupportedClaims', min: null, max: 0.1, minSampleSize: 30 },
  ],
  optional_onboarding: [
    { metric: 'identity.exactProductHit', min: 0.9, max: null, minSampleSize: 30 },
    { metric: 'identity.abstentionCorrect', min: 0.8, max: null, minSampleSize: 30 },
    { metric: 'unsupportedClaims', min: null, max: 0.1, minSampleSize: 30 },
    { metric: 'classification.productTypeAccurate', min: 0.85, max: null, minSampleSize: 30 },
  ],
  automatic: [
    { metric: 'identity.exactProductHit', min: 0.9, max: null, minSampleSize: 30 },
    { metric: 'identity.abstentionCorrect', min: 0.8, max: null, minSampleSize: 30 },
    { metric: 'unsupportedClaims', min: null, max: 0.1, minSampleSize: 30 },
    { metric: 'classification.productTypeAccurate', min: 0.85, max: null, minSampleSize: 30 },
    { metric: 'identity.exactVariantHit', min: 0.9, max: null, minSampleSize: 50 },
  ],
};

const CONFIG_KEY = 'pi_rollout_config';

function readConfigRow(): { value: string } | undefined {
  try {
    return getDb().query('SELECT value FROM app_meta WHERE key = ?').get(CONFIG_KEY) as { value: string } | undefined;
  } catch {
    return undefined;
  }
}

export function getRolloutConfig(): RolloutConfig {
  const row = readConfigRow();
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as RolloutConfig;
      if (ROLLOUT_STAGES.includes(parsed.stage) && Array.isArray(parsed.thresholds)) {
        return parsed;
      }
    } catch {
      // fall through to default
    }
  }
  return {
    stage: 'shadow_only',
    thresholds: DEFAULT_ROLLOUT_THRESHOLDS.shadow_only,
    documentedBy: 'system',
    updatedAt: '',
  };
}

export function setRolloutConfig(config: {
  stage: RolloutStage;
  documentedBy: string;
  thresholds?: RolloutGateThreshold[];
}): RolloutConfig {
  if (!ROLLOUT_STAGES.includes(config.stage)) {
    throw new Error(`Invalid rollout stage '${String(config.stage)}'`);
  }
  if (!config.documentedBy || config.documentedBy.trim() === '') {
    throw new Error('documentedBy is required: thresholds must be documented before a rollout stage');
  }
  const thresholds = config.thresholds ?? DEFAULT_ROLLOUT_THRESHOLDS[config.stage];
  const full: RolloutConfig = {
    stage: config.stage,
    thresholds,
    documentedBy: config.documentedBy,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .query(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(CONFIG_KEY, JSON.stringify(full));
  return full;
}

export interface RolloutGateResult {
  stage: RolloutStage;
  allowed: boolean;
  reasons: string[];
}

/**
 * Evaluate one stage's gate against a measured aggregate report. Gates NEVER
 * use model-reported confidence — only measured rates with a minimum sample.
 */
export function evaluateRolloutGate(stage: RolloutStage, report: PiAggregateReport | null): RolloutGateResult {
  const config = getRolloutConfig();
  const reasons: string[] = [];

  if (ROLLOUT_STAGES.indexOf(stage) > ROLLOUT_STAGES.indexOf(config.stage)) {
    return { stage, allowed: false, reasons: [`current rollout stage is '${config.stage}'`] };
  }
  if (stage === 'shadow_only') return { stage, allowed: true, reasons: [] };
  if (stage === 'manual_agent_lab') return { stage, allowed: true, reasons: [] };
  if (!report) {
    return { stage, allowed: false, reasons: ['insufficient_sample: no evaluation data'] };
  }

  for (const threshold of config.thresholds) {
    if (report.sampleSize < threshold.minSampleSize) {
      reasons.push(`insufficient_sample: ${threshold.metric} n=${report.sampleSize} < ${threshold.minSampleSize}`);
      continue;
    }
    const rate = report.rates[threshold.metric];
    if (rate == null) {
      reasons.push(`no_data: ${threshold.metric}`);
      continue;
    }
    if (threshold.min != null && rate < threshold.min) {
      reasons.push(`threshold_not_met: ${threshold.metric} ${rate.toFixed(3)} < ${threshold.min}`);
    }
    if (threshold.max != null && rate > threshold.max) {
      reasons.push(`threshold_exceeded: ${threshold.metric} ${rate.toFixed(3)} > ${threshold.max}`);
    }
  }
  return { stage, allowed: reasons.length === 0, reasons };
}

/** Global kill switch: env var OR flags.killSwitch. Returns every workspace to the normal pipeline. */
export function isPiKillSwitchEnabled(): boolean {
  return process.env.BAYSTATE_CMS_PI_KILL_SWITCH === 'true' || getProductIntelligenceFlags().killSwitch;
}

export interface RolloutState {
  killSwitch: boolean;
  stage: RolloutStage;
  thresholds: RolloutGateThreshold[];
  gates: RolloutGateResult[];
}

export function currentRolloutState(report: PiAggregateReport | null = null): RolloutState {
  const config = getRolloutConfig();
  return {
    killSwitch: isPiKillSwitchEnabled(),
    stage: config.stage,
    thresholds: config.thresholds,
    gates: ROLLOUT_STAGES.filter((s) => s !== 'shadow_only').map((s) => evaluateRolloutGate(s, report)),
  };
}
