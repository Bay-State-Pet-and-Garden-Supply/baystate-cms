/**
 * PI-9 rollout gates + kill switch tests (issue #26).
 *
 * DB-backed (bun test): staged enablement requires DOCUMENTED thresholds and
 * MEASURED metrics with a minimum sample (never model confidence), and the
 * kill switch forces the legacy pipeline everywhere.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  evaluateRolloutGate,
  getRolloutConfig,
  isPiKillSwitchEnabled,
  isLegacyRemovalAllowed,
  setRolloutConfig,
  currentRolloutState,
} from '../../product-intelligence/evaluation/rollout';
import { createExecutionRouter } from '../../product-intelligence/execution-router';
import { LegacyProductIntelligenceExecutor } from '../../product-intelligence/legacy-executor';
import {
  DEFAULT_PRODUCT_INTELLIGENCE_FLAGS,
  getProductIntelligenceFlags,
  overrideProductIntelligenceFlags,
} from '../../product-intelligence/flags';
import { importRunToOnboarding } from '../../product-intelligence/onboarding-import';
import { createPiRun, insertPiResult, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
import type { PiAggregateReport } from '../../product-intelligence/evaluation/metrics';

const workspaceId = 'ws-pi-rollout-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

function reportWith(sampleSize: number, rates: Record<string, number>): PiAggregateReport {
  return {
    sampleSize,
    sampleSizeWarning: sampleSize < 10 ? 'very_small' : sampleSize < 30 ? 'small' : 'none',
    rates: {
      'identity.exactProductHit': 0.9,
      'identity.exactVariantHit': 0.9,
      'identity.parentOnlyCorrect': null,
      'identity.wrongVariantCorrect': null,
      'identity.abstentionCorrect': 0.8,
      'image.exactProductCorrect': null,
      'image.exactVariantCorrect': null,
      'image.rightsRejectionCorrect': null,
      'classification.productTypeAccurate': 0.85,
      'classification.pageExactSet': null,
      'conflicts.detectedAny': null,
      'conflicts.falseConflict': null,
      unsupportedClaims: 0.05,
      ...rates,
    },
    confidence: {},
    outcomeDistribution: { submitted: 1, abstained: 0, parent_product_only: 0, wrong_variant: 0, failed: 0, policy_denied: 0, not_configured: 0, cancelled: 0, unavailable: 0 },
    ops: { avgDurationMs: 100, totalCostUsd: 0, avgToolCalls: 5, avgDeniedToolCalls: 0 },
  };
}

describe('PI-9 rollout gates', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-rollout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
    delete process.env.BAYSTATE_CMS_PI_KILL_SWITCH;
    overrideProductIntelligenceFlags(DEFAULT_PRODUCT_INTELLIGENCE_FLAGS);
  });

  afterEach(() => {
    delete process.env.BAYSTATE_CMS_PI_KILL_SWITCH;
    overrideProductIntelligenceFlags(DEFAULT_PRODUCT_INTELLIGENCE_FLAGS);
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('defaults to shadow_only with documented thresholds required for advancement', () => {
    expect(getRolloutConfig().stage).toBe('shadow_only');
    expect(() => setRolloutConfig({ stage: 'reviewed_import', documentedBy: '' })).toThrow(/documentedBy/);
  });

  it('denies gates without evaluation data or with insufficient samples', () => {
    // Stage not reached yet: shadow_only is the default.
    const notReached = evaluateRolloutGate('reviewed_import', null);
    expect(notReached.allowed).toBe(false);
    expect(notReached.reasons.join(' ')).toContain('current rollout stage');
    // At the reviewed_import stage, a null report denies on insufficient data.
    setRolloutConfig({ stage: 'reviewed_import', documentedBy: 'test-run' });
    const noData = evaluateRolloutGate('reviewed_import', null);
    expect(noData.allowed).toBe(false);
    expect(noData.reasons.join(' ')).toContain('insufficient_sample');
    const small = evaluateRolloutGate('reviewed_import', reportWith(5, {}));
    expect(small.allowed).toBe(false);
    expect(small.reasons.join(' ')).toContain('insufficient_sample');
  });

  it('allows a gate when measured metrics clear documented thresholds', () => {
    setRolloutConfig({ stage: 'reviewed_import', documentedBy: 'test-run' });
    const gate = evaluateRolloutGate('reviewed_import', reportWith(40, {}));
    expect(gate.allowed).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  it('denies when a metric misses its threshold', () => {
    setRolloutConfig({ stage: 'reviewed_import', documentedBy: 'test-run' });
    const gate = evaluateRolloutGate('reviewed_import', reportWith(40, { 'identity.exactProductHit': 0.7 }));
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.join(' ')).toContain('threshold_not_met');
  });

  it('denies stages beyond the configured stage', () => {
    setRolloutConfig({ stage: 'reviewed_import', documentedBy: 'test-run' });
    const gate = evaluateRolloutGate('automatic', reportWith(60, {}));
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.join(' ')).toContain('current rollout stage');
  });

  it('kill switch: env var forces legacy execution and blocks import', async () => {
    const legacy = new LegacyProductIntelligenceExecutor();
    const router = createExecutionRouter({
      legacy,
      pi: null,
      flags: () => ({ ...getProductIntelligenceFlags(), productIntelligenceEnabled: true, piEnabled: true, killSwitch: false }),
    });
    expect((await router.resolveExecutor()).name).toBe('legacy'); // no pi executor present
    const withPi = createExecutionRouter({
      legacy,
      pi: legacy, // stand-in: any executor works for selection testing
      flags: () => ({ ...getProductIntelligenceFlags(), productIntelligenceEnabled: true, piEnabled: true, killSwitch: false }),
    });
    // Without the switch, Pi would be selected (pi present).
    expect((await withPi.resolveExecutor()).name).toBe('pi');

    process.env.BAYSTATE_CMS_PI_KILL_SWITCH = 'true';
    expect(isPiKillSwitchEnabled()).toBe(true);
    expect((await withPi.resolveExecutor()).name).toBe('legacy');
    expect((await withPi.resolveExecutor()).reason).toContain('kill_switch');

    // Import is blocked under the kill switch even with import enabled.
    overrideProductIntelligenceFlags({ ...DEFAULT_PRODUCT_INTELLIGENCE_FLAGS, productIntelligenceEnabled: true, piEnabled: true, shadowOnly: false, allowOnboardingImport: true, killSwitch: false });
    const run = createPiRun({
      workspaceId, mode: 'shadow', executor: 'pi',
      inputJson: JSON.stringify({ gtin: '085000079585', registerName: 'X' }),
      policyJson: '{}', configSnapshotId: 'c', configSnapshotHash: 'c',
    });
    insertPiResult({ runId: run.id, schemaVersion: 1, disposition: 'submitted', result: { schemaVersion: 1, gtin: '085000079585', inputName: 'X', identity: { gtinMatch: 'exact' }, evidenceItems: [], evidenceSources: [], productProposal: { fields: [] }, abstention: false } });
    transitionPiRunStatus(run.id, 'completed', {});
    process.env.BAYSTATE_CMS_PI_KILL_SWITCH = 'true';
    expect(() => importRunToOnboarding(run.id, { mode: 'create' })).toThrow(/kill switch/);
  });

  it('isLegacyRemovalAllowed is false before default-on stabilization (ADR 0029)', () => {
    setRolloutConfig({ stage: 'manual_agent_lab', documentedBy: 'test-run' });
    expect(isLegacyRemovalAllowed(null)).toBe(false);
    setRolloutConfig({ stage: 'reviewed_import', documentedBy: 'test-run' });
    expect(isLegacyRemovalAllowed(null)).toBe(false);
    // Automatic stage but no measured metrics -> still not allowed.
    setRolloutConfig({ stage: 'automatic', documentedBy: 'test-run' });
    expect(isLegacyRemovalAllowed(null)).toBe(false);
    // Automatic stage with passing measured metrics -> allowed.
    expect(isLegacyRemovalAllowed(reportWith(50, {}))).toBe(true);
    // Kill switch overrides everything.
    process.env.BAYSTATE_CMS_PI_KILL_SWITCH = 'true';
    expect(isLegacyRemovalAllowed(reportWith(50, {}))).toBe(false);
    delete process.env.BAYSTATE_CMS_PI_KILL_SWITCH;
  });

  it('currentRolloutState reflects kill switch + configured stage', () => {
    setRolloutConfig({ stage: 'manual_agent_lab', documentedBy: 'test-run' });
    const state = currentRolloutState(null);
    expect(state.stage).toBe('manual_agent_lab');
    expect(state.killSwitch).toBe(false);
    expect(state.gates.length).toBe(4);
    // manual_agent_lab is a manual stage (allowed); metric-gated stages deny
    // without evaluation data.
    const byStage = Object.fromEntries(state.gates.map((g) => [g.stage, g.allowed]));
    expect(byStage.manual_agent_lab).toBe(true);
    expect(byStage.reviewed_import).toBe(false);
    expect(byStage.optional_onboarding).toBe(false);
    expect(byStage.automatic).toBe(false);
  });
});
