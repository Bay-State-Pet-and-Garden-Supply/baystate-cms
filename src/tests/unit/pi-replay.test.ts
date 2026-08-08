/**
 * PI-10 replay modes (issue #27): deterministic replay reconstructs the
 * terminal result from stored rows with no external calls, same-configuration
 * rerun launches a real execution carrying the original immutable config, and
 * both create a NEW run linked to the origin (origin_run_id + replay_depth).
 * Originals stay immutable; comparison reruns record a pi_run baseline.
 *
 * DB-backed (bun test).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/27
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createPiRun, getPiResult, getPiRun, insertPiResult, listPiComparisons, setRunToolsJson, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
import { seedDefaultApprovedPolicy, getActiveDefaultApprovedPolicy } from '../../db/repositories/pi-approved-policy-repo';
import { replayPiRun } from '../../product-intelligence/run-service';
import { assertReducingOverride, computePolicyConfigId } from '../../product-intelligence/policy';
import { validBundle } from './product-intelligence/test-helpers';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../product-intelligence/executor';
import { ProductIntelligencePolicySchema, type ProductIntelligencePolicy } from '../../product-intelligence/contracts';

const workspaceId = 'ws-pi-replay-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

// The rerun path re-verifies the immutable snapshot (PI-5); the default
// policy is self-hashed so its configId matches its content.
import { buildDefaultPiPolicy } from '../../product-intelligence/run-service';
const TEST_POLICY: ProductIntelligencePolicy = buildDefaultPiPolicy();

function makeTerminalRun(executorName: 'pi' | 'legacy' = 'pi'): string {
  const run = createPiRun({
    workspaceId,
    mode: 'shadow',
    executor: executorName,
    inputJson: JSON.stringify({ gtin: '085000079585', registerName: 'STELLA CHKN BROTH 16OZ' }),
    policyJson: JSON.stringify(TEST_POLICY),
    configSnapshotId: TEST_POLICY.configId,
    configSnapshotHash: TEST_POLICY.configId,
    promptHash: 'prompt-hash-1',
    piVersion: '0.83.0',
  });
  insertPiResult({
    runId: run.id,
    schemaVersion: 1,
    disposition: 'submitted',
    result: {
      runId: run.id,
      outcome: 'submitted',
      executor: 'pi',
      executorVersion: '1.0.0',
      piVersion: '0.83.0',
      extensionVersions: [],
      configId: TEST_POLICY.configId,
      durationMs: 10,
      submission: null,
      failure: null,
      events: [],
      schemaVersion: 1,
      gtin: '085000079585',
      inputName: 'STELLA CHKN BROTH 16OZ',
      identity: { gtinMatch: 'exact' },
      evidenceItems: [],
      evidenceSources: [],
      productProposal: { fields: [{ field: 'title', value: 'Replayed Title' }] },
      abstention: false,
    },
  });
  transitionPiRunStatus(run.id, 'completed', {});
  return run.id;
}

/**
 * Create a completed origin run exactly as the route would (review finding
 * 7): base approved policy + strictly-reducing override -> resolved policy
 * whose configId has NO approved-policy row, with the lineage persisted on
 * the run. Returns the origin id + the resolved policy configId.
 */
function makeOverrideTerminalRun(): { id: string; policyConfigId: string } {
  const baseRow = getActiveDefaultApprovedPolicy(workspaceId)!;
  const base = ProductIntelligencePolicySchema.parse(JSON.parse(baseRow.policyJson));
  const overrides: Partial<ProductIntelligencePolicy> = { maxToolCalls: 20 };
  const resolved = computePolicyConfigId(ProductIntelligencePolicySchema.parse(assertReducingOverride(base, overrides)));
  const run = createPiRun({
    workspaceId,
    mode: 'shadow',
    executor: 'pi',
    inputJson: JSON.stringify({ gtin: '085000079585', registerName: 'STELLA CHKN BROTH 16OZ' }),
    policyJson: JSON.stringify(resolved),
    configSnapshotId: resolved.configId,
    configSnapshotHash: resolved.configId,
    promptHash: 'prompt-hash-1',
    piVersion: '0.83.0',
    // Round-3 atomicity: lineage is set at insert, never post-hoc.
    basePolicyId: baseRow.id,
    basePolicyVersion: baseRow.version,
    policyOverridesJson: JSON.stringify(overrides),
  });
  insertPiResult({
    runId: run.id,
    schemaVersion: 1,
    disposition: 'submitted',
    result: {
      runId: run.id,
      outcome: 'submitted',
      executor: 'pi',
      executorVersion: '1.0.0',
      piVersion: '0.83.0',
      extensionVersions: [],
      configId: resolved.configId,
      durationMs: 10,
      submission: null,
      failure: null,
      events: [],
    },
  });
  transitionPiRunStatus(run.id, 'completed', {});
  return { id: run.id, policyConfigId: resolved.configId };
}

class FakeLegacyExecutor implements ProductIntelligenceExecutor {
  readonly name = 'legacy';
  readonly version = '1.0.0';
  calls = 0;

  async startResearch(
    _input: { gtin: string },
    context: { runId: string; policy: { configId: string }; signal?: AbortSignal },
    _events: ExecutionEventSink,
  ): Promise<import('../../product-intelligence/contracts').ProductResearchResult> {
    this.calls += 1;
    return {
      runId: context.runId,
      outcome: 'unavailable',
      executor: this.name,
      executorVersion: this.version,
      piVersion: '0.83.0',
      extensionVersions: [],
      configId: context.policy.configId,
      durationMs: 1,
      submission: null,
      failure: null,
      events: [],
    };
  }
}

class FakeExecutor implements ProductIntelligenceExecutor {
  readonly name = 'pi';
  readonly version = '1.0.0';
  calls = 0;

  async startResearch(
    input: { gtin: string },
    context: { runId: string; policy: { configId: string }; signal?: AbortSignal },
    events: ExecutionEventSink,
  ): Promise<import('../../product-intelligence/contracts').ProductResearchResult> {
    this.calls += 1;
    events.emit('run_started', { message: `rerunning ${input.gtin}` });
    events.emit('submission_received', { data: { schemaVersion: 1 } });
    events.emit('run_completed', { data: { outcome: 'submitted' } });
    return {
      runId: context.runId,
      outcome: 'submitted',
      executor: this.name,
      executorVersion: this.version,
      piVersion: '0.83.0',
      extensionVersions: [],
      configId: context.policy.configId,
      durationMs: 1,
      submission: validBundle(),
      failure: null,
      events: events.snapshot(),
    };
  }
}

describe('PI-10 replay modes', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('deterministic replay creates a completed linked run with a copied result', async () => {
    const origin = makeTerminalRun();
    const originRowBefore = getPiRun(origin)!;
    const { run, mode } = await replayPiRun(origin, { mode: 'deterministic' });

    expect(mode).toBe('deterministic');
    expect(run.id).not.toBe(origin);
    expect(run.status).toBe('completed');
    expect(run.originRunId).toBe(origin);
    expect(run.replayDepth).toBe(originRowBefore.replayDepth + 1);
    // Same immutable config + input carried over.
    expect(run.inputJson).toBe(originRowBefore.inputJson);
    expect(run.policyJson).toBe(originRowBefore.policyJson);
    expect(run.configSnapshotId).toBe(originRowBefore.configSnapshotId);
    // Result reconstructed from the stored row.
    const copied = getPiResult(run.id);
    expect(copied).toBeDefined();
    expect(JSON.parse(copied!.resultJson)).toMatchObject({ gtin: '085000079585' });
    // The original is untouched (still its own rows, still terminal).
    expect(getPiRun(origin)).toMatchObject({ id: origin, status: 'completed', replayDepth: 0 });
    expect(getPiResult(origin)!.resultHash).toBe(copied!.resultHash);
  });

  it('deterministic replay records a replay event and supports comparison', async () => {
    const origin = makeTerminalRun();
    const { run } = await replayPiRun(origin, { mode: 'deterministic', compare: true });
    const events = getDb()
      .query(`SELECT type, payload_json AS p FROM product_intelligence_events WHERE run_id = ?`)
      .all(run.id) as Array<{ type: string; p: string }>;
    expect(events.some((e) => e.type === 'replay' && JSON.parse(e.p).mode === 'deterministic')).toBe(true);
    const comparisons = listPiComparisons(run.id);
    expect(comparisons.length).toBe(1);
    expect(comparisons[0].baselineType).toBe('pi_run');
    expect(comparisons[0].baselineRef).toBe(origin);
  });

  it('same-configuration rerun launches a real execution with the origin config', async () => {
    const origin = makeTerminalRun();
    // P0-2/P0-4: a rerun requires the origin policy to be an active approved record.
    seedDefaultApprovedPolicy(workspaceId, JSON.stringify(TEST_POLICY), TEST_POLICY.configId);
    const executor = new FakeExecutor();
    const { run, mode } = await replayPiRun(origin, { mode: 'rerun', executor });

    expect(mode).toBe('rerun');
    expect(executor.calls).toBe(1);
    expect(run.originRunId).toBe(origin);
    expect(run.replayDepth).toBe(1);
    expect(run.inputJson).toBe(getPiRun(origin)!.inputJson);
    expect(run.policyJson).toBe(getPiRun(origin)!.policyJson);
    const result = getPiResult(run.id);
    expect(result).toBeDefined();
    expect(JSON.parse(result!.resultJson)).toMatchObject({
      submission: { gtin: '085000079585', disposition: 'research_complete' },
    });
  });

  it('refuses to replay a running run', async () => {
    const running = createPiRun({
      workspaceId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: '085000079585' }),
      policyJson: JSON.stringify(TEST_POLICY),
      configSnapshotId: TEST_POLICY.configId,
      configSnapshotHash: TEST_POLICY.configId,
    });
    await expect(replayPiRun(running.id, { mode: 'deterministic' })).rejects.toThrow(/running/);
  });

  it('a replay of a replay deepens the chain without touching either ancestor', async () => {
    const origin = makeTerminalRun();
    const first = await replayPiRun(origin, { mode: 'deterministic' });
    const second = await replayPiRun(first.run.id, { mode: 'deterministic' });

    expect(second.run.originRunId).toBe(first.run.id);
    expect(second.run.replayDepth).toBe(2);
    expect(getPiRun(origin)!.replayDepth).toBe(0);
    expect(getPiRun(first.run.id)!.replayDepth).toBe(1);
  });

  it('rerun without an executor is refused', async () => {
    const origin = makeTerminalRun();
    await expect(replayPiRun(origin, { mode: 'rerun' })).rejects.toThrow(/executor/);
  });

  it('refuses a Pi rerun when the current resolution is not Pi (kill-switch dominance, P0-4)', async () => {
    const origin = makeTerminalRun('pi');
    const legacy = new FakeLegacyExecutor();
    await expect(replayPiRun(origin, { mode: 'rerun', executor: legacy })).rejects.toThrow(
      /Pi is disabled; rerun unavailable/,
    );
    expect(legacy.calls).toBe(0);
  });

  it('refuses a rerun that changes executor family (P0-4)', async () => {
    const origin = makeTerminalRun('legacy');
    const pi = new FakeExecutor();
    await expect(replayPiRun(origin, { mode: 'rerun', executor: pi })).rejects.toThrow(
      /same executor family/,
    );
    expect(pi.calls).toBe(0);
  });

  it('refuses a rerun whose origin policy is no longer approved (P0-4 + P0-2)', async () => {
    const origin = makeTerminalRun('pi');
    // No approved-policy record seeded for the workspace → configId inactive.
    const pi = new FakeExecutor();
    await expect(replayPiRun(origin, { mode: 'rerun', executor: pi })).rejects.toThrow(
      /origin policy is no longer approved/,
    );
    expect(pi.calls).toBe(0);
  });

  it('reruns successfully when the origin policy is an active approved record (P0-4 happy path)', async () => {
    const origin = makeTerminalRun('pi');
    seedDefaultApprovedPolicy(workspaceId, JSON.stringify(TEST_POLICY), TEST_POLICY.configId);
    const executor = new FakeExecutor();
    const { run, mode } = await replayPiRun(origin, { mode: 'rerun', executor });
    expect(mode).toBe('rerun');
    expect(executor.calls).toBe(1);
    expect(run.originRunId).toBe(origin);
  });

  it('reauthorizes an override run by its BASE approved record (review finding 7)', async () => {
    seedDefaultApprovedPolicy(workspaceId, JSON.stringify(TEST_POLICY), TEST_POLICY.configId);
    const origin = makeOverrideTerminalRun();
    // Round-3 atomicity: the override run was BORN with its lineage (no
    // post-insert UPDATE) — the row carries it from creation.
    const originRow = getPiRun(origin.id)!;
    expect(originRow.basePolicyId).toBeTruthy();
    expect(originRow.policyOverridesJson).toContain('maxToolCalls');
    const executor = new FakeExecutor();
    const { run, mode } = await replayPiRun(origin.id, { mode: 'rerun', executor });
    expect(mode).toBe('rerun');
    expect(executor.calls).toBe(1);
    // The replay run inherits the origin's base lineage (rerun-of-rerun
    // reauthorizes the same base record).
    const lineage = getDb().query('SELECT base_policy_id AS basePolicyId FROM product_intelligence_runs WHERE id = ?').get(run.id) as
      | { basePolicyId: string | null }
      | undefined;
    expect(lineage?.basePolicyId).toBeTruthy();
  });

  it('deterministic replay inherits the origin lineage atomically at insert', async () => {
    seedDefaultApprovedPolicy(workspaceId, JSON.stringify(TEST_POLICY), TEST_POLICY.configId);
    const origin = makeOverrideTerminalRun();
    const { run } = await replayPiRun(origin.id, { mode: 'deterministic' });
    const originRow = getPiRun(origin.id)!;
    const replayRow = getPiRun(run.id)!;
    // The replayed run is born with the origin's base lineage (no UPDATE).
    expect(replayRow.basePolicyId).toBe(originRow.basePolicyId);
    expect(replayRow.policyOverridesJson).toBe(originRow.policyOverridesJson);
  });

  it('refuses an override run whose BASE policy record is revoked (review finding 7)', async () => {
    seedDefaultApprovedPolicy(workspaceId, JSON.stringify(TEST_POLICY), TEST_POLICY.configId);
    const origin = makeOverrideTerminalRun();
    // Revoke the base record (operator superseded/revoked it).
    getDb().run('UPDATE pi_approved_policies SET active = 0 WHERE workspace_id = ?', [workspaceId]);
    const executor = new FakeExecutor();
    await expect(replayPiRun(origin.id, { mode: 'rerun', executor })).rejects.toThrow(/origin policy is no longer approved/);
    expect(executor.calls).toBe(0);
  });

  it('deterministic replay stays available with no active approved policy (P0-4)', async () => {
    const origin = makeTerminalRun('pi');
    const { run, mode } = await replayPiRun(origin, { mode: 'deterministic' });
    expect(mode).toBe('deterministic');
    expect(run.status).toBe('completed');
    expect(getPiResult(run.id)).toBeDefined();
  });

  it('refuses deterministic replay of an origin without a stored result', async () => {
    // Failed/cancelled origins have no result row to reconstruct — replaying
    // them would fabricate a misleading 'completed' run (PI-10-MINOR-6).
    const failed = createPiRun({
      workspaceId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: '085000079585' }),
      policyJson: JSON.stringify(TEST_POLICY),
      configSnapshotId: TEST_POLICY.configId,
      configSnapshotHash: TEST_POLICY.configId,
    });
    transitionPiRunStatus(failed.id, 'failed', { errorCode: 'session_error', errorMessage: 'boom' });
    await expect(replayPiRun(failed.id, { mode: 'deterministic' })).rejects.toThrow(/no stored result/);
  });

  it('refuses replays beyond the maximum chain depth', async () => {
    // The origin FK must point at a real run row.
    const origin = makeTerminalRun();
    const deep = createPiRun({
      workspaceId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: '085000079585' }),
      policyJson: JSON.stringify(TEST_POLICY),
      configSnapshotId: TEST_POLICY.configId,
      configSnapshotHash: TEST_POLICY.configId,
      originRunId: origin,
      replayDepth: 16,
      status: 'completed',
    });
    await expect(replayPiRun(deep.id, { mode: 'deterministic' })).rejects.toThrow(/too deep/);
  });

  it('persists the session\'s effective tool versions/schema hashes on the run (round-8 P1)', () => {
    const run = makeTerminalRun();
    expect(getPiRun(run)!.toolsJson).toBeNull();
    const tools = [
      { name: 'verify_image_candidate', version: '2.0.0', schemaHash: 'a'.repeat(64) },
      { name: 'search_upc', version: '1.2.0', schemaHash: 'b'.repeat(64) },
    ];
    setRunToolsJson(run, tools);
    expect(JSON.parse(getPiRun(run)!.toolsJson!)).toEqual(tools);
  });
});
