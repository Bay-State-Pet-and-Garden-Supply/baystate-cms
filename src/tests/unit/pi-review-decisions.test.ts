/**
 * P1-2 durable human review decisions (review remediation).
 *
 * Review decisions are append-only, bound to the exact stored result via
 * result_hash, chained via supersedes_decision_id; only the latest is
 * authoritative. Import requires a durable approval for the current stored
 * result (assertRunApprovedForImport). Replays NEVER clone decisions — a
 * replayed run is a NEW run that starts unreviewed (Replay invariant).
 *
 * DB-backed (bun test).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createPiRun, insertPiResult, getPiResult, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
import {
  createReviewDecision,
  getLatestReviewDecision,
  hasApprovalForResult,
  listReviewDecisions,
} from '../../db/repositories/pi-review-decision-repo';
import { replayPiRun } from '../../product-intelligence/run-service';
import { assertRunApprovedForImport, computeResultHash } from '../../product-intelligence/review-gate';
import { buildDefaultPiPolicy } from '../../product-intelligence/run-service';
import type { ProductIntelligencePolicy } from '../../product-intelligence/contracts';

const workspaceId = 'ws-pi-review-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

const TEST_POLICY: ProductIntelligencePolicy = buildDefaultPiPolicy();

function makeTerminalRun(): string {
  const run = createPiRun({
    workspaceId,
    mode: 'shadow',
    executor: 'pi',
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
      productProposal: { fields: [{ field: 'title', value: 'Reviewed Title' }] },
      abstention: false,
    },
  });
  transitionPiRunStatus(run.id, 'completed', {});
  return run.id;
}

describe('P1-2 durable review decisions', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('creates decisions and chains them via supersedes_decision_id', () => {
    const runId = makeTerminalRun();
    const stored = getPiResult(runId)!;
    const first = createReviewDecision({ runId, decision: 'reject', resultHash: stored.resultHash, reviewer: 'alice', note: 'wrong variant' });
    const second = createReviewDecision({ runId, decision: 'approve', resultHash: stored.resultHash, reviewer: 'bob' });
    expect(second.supersedesDecisionId).toBe(first.id);
    expect(getLatestReviewDecision(runId)?.id).toBe(second.id);
    expect(listReviewDecisions(runId)).toHaveLength(2);
  });

  it('concurrent decisions never fork the chain (transactional read-latest + insert)', async () => {
    const runId = makeTerminalRun();
    const stored = getPiResult(runId)!;
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => createReviewDecision({ runId, decision: 'approve', resultHash: stored.resultHash, reviewer: 'a' })),
      Promise.resolve().then(() => createReviewDecision({ runId, decision: 'reject', resultHash: stored.resultHash, reviewer: 'b' })),
    ]);
    const rows = listReviewDecisions(runId);
    // Exactly two rows and ONE linear supersede edge — no forked chain.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.supersedesDecisionId !== null)).toHaveLength(1);
    expect(a.supersedesDecisionId === b.id || b.supersedesDecisionId === a.id).toBe(true);
    const latest = getLatestReviewDecision(runId)!;
    expect([a.id, b.id]).toContain(latest.id);
    expect(latest.supersedesDecisionId).toBe(rows.find((r) => r.id !== latest.id)!.id);
  });

  it('hasApprovalForResult requires the latest decision to approve the exact hash', () => {
    const runId = makeTerminalRun();
    const stored = getPiResult(runId)!;
    expect(hasApprovalForResult(runId, stored.resultHash)).toBe(false);
    createReviewDecision({ runId, decision: 'approve', resultHash: stored.resultHash, reviewer: 'alice' });
    expect(hasApprovalForResult(runId, stored.resultHash)).toBe(true);
    // A hash mismatch (different stored result) is NOT approved.
    expect(hasApprovalForResult(runId, 'some-other-hash')).toBe(false);
  });

  it('reject then approve supersedes (latest approve wins)', () => {
    const runId = makeTerminalRun();
    const stored = getPiResult(runId)!;
    createReviewDecision({ runId, decision: 'reject', resultHash: stored.resultHash, reviewer: 'alice' });
    expect(hasApprovalForResult(runId, stored.resultHash)).toBe(false);
    createReviewDecision({ runId, decision: 'approve', resultHash: stored.resultHash, reviewer: 'bob' });
    expect(hasApprovalForResult(runId, stored.resultHash)).toBe(true);
    expect(getLatestReviewDecision(runId)?.decision).toBe('approve');
  });

  it('replay does NOT clone decisions (replayed run starts unreviewed)', async () => {
    const origin = makeTerminalRun();
    const stored = getPiResult(origin)!;
    createReviewDecision({ runId: origin, decision: 'approve', resultHash: stored.resultHash, reviewer: 'alice' });
    expect(hasApprovalForResult(origin, stored.resultHash)).toBe(true);

    const replay = await replayPiRun(origin, { mode: 'deterministic' });
    // The origin decision remains lineage for the origin only.
    expect(listReviewDecisions(origin)).toHaveLength(1);
    expect(listReviewDecisions(replay.run.id)).toHaveLength(0);
    expect(hasApprovalForResult(replay.run.id, stored.resultHash)).toBe(false);
  });

  it('assertRunApprovedForImport throws without approval and passes with matching approval', () => {
    const runId = makeTerminalRun();
    expect(() => assertRunApprovedForImport(runId)).toThrow('no durable approval');
    const stored = getPiResult(runId)!;
    createReviewDecision({ runId, decision: 'approve', resultHash: stored.resultHash, reviewer: 'alice' });
    expect(() => assertRunApprovedForImport(runId)).not.toThrow();
    // An approval bound to a DIFFERENT result hash still fails closed.
    const run2 = makeTerminalRun();
    createReviewDecision({ runId: run2, decision: 'approve', resultHash: 'stale-hash', reviewer: 'alice' });
    expect(() => assertRunApprovedForImport(run2)).toThrow('no durable approval');
  });

  it('assertRunApprovedForImport throws when the run has no stored result', () => {
    const run = createPiRun({
      workspaceId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: '085000079585' }),
      policyJson: JSON.stringify(TEST_POLICY),
      configSnapshotId: TEST_POLICY.configId,
      configSnapshotHash: TEST_POLICY.configId,
    });
    transitionPiRunStatus(run.id, 'failed', {});
    expect(() => assertRunApprovedForImport(run.id)).toThrow('no stored result');
  });

  it('computeResultHash is stable across key orderings and sensitive to values', () => {
    const a = computeResultHash({ a: 1, b: { c: [1, 2], d: 'x' } });
    const b = computeResultHash({ b: { d: 'x', c: [1, 2] }, a: 1 });
    expect(a).toBe(b);
    expect(computeResultHash({ a: 1, b: 2 })).not.toBe(computeResultHash({ a: 1, b: 3 }));
  });
});
