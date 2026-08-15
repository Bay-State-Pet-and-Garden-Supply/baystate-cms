import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createCandidateSnapshot,
  createCorrection,
  ensureBaselineVersion,
  getActiveVersion,
  getVersionSnapshot,
  promoteCandidateVersion,
  recordTeachingEvent,
  updateCandidateLifecycleStatus,
} from '../../db/repositories/agent-version-repo';
import { createDataset } from '../../db/repositories/benchmark-repo';
import { createPiRun } from '../../db/repositories/product-intelligence-repo';
import { findWorkspace, insertWorkspace } from '../../db/repositories/workspace-repo';

describe('agent-version-repo', () => {
  let wsId: string;

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    const ws = findWorkspace();
    if (!ws) {
      wsId = 'test-ws-' + Date.now();
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
    } else {
      wsId = ws.id;
    }
  });

  afterEach(() => {
    closeDb();
  });

  it('ensures and retrieves baseline v1 version for workspace', () => {
    const baseline = ensureBaselineVersion(wsId);
    expect(baseline).toBeDefined();
    expect(baseline.snapshot.versionNumber).toBe(1);
    expect(baseline.snapshot.revisionNumber).toBe(1);
    expect(baseline.snapshot.compilerVersion).toBe('compiler_v1');
    expect(baseline.state.lifecycleStatus).toBe('active');

    const active = getActiveVersion(wsId);
    expect(active?.snapshot.id).toBe(baseline.snapshot.id);
  });

  it('creates immutable candidate snapshots with incremented revisions', () => {
    const baseline = ensureBaselineVersion(wsId);

    const cand1 = createCandidateSnapshot(wsId, {
      parentVersionId: baseline.snapshot.id,
      instructions: [
        {
          id: 'rule-1',
          category: 'facts',
          rule: 'Do not extrapolate multipacks from case UPCs.',
          createdAt: new Date().toISOString(),
        },
      ],
      fewShotExamples: [],
      createdBy: 'operator',
      changeSummary: 'First revision',
    });

    expect(cand1.snapshot.versionNumber).toBe(2);
    expect(cand1.snapshot.revisionNumber).toBe(1);
    expect(cand1.state.lifecycleStatus).toBe('draft');
    expect(cand1.snapshot.instructions.length).toBe(1);

    const cand2 = createCandidateSnapshot(wsId, {
      parentVersionId: cand1.snapshot.id,
      instructions: [
        ...cand1.snapshot.instructions,
        {
          id: 'rule-2',
          category: 'identity',
          rule: 'GTIN-14 normalization required.',
          createdAt: new Date().toISOString(),
        },
      ],
      fewShotExamples: [],
      createdBy: 'operator',
      changeSummary: 'Second revision',
    });

    expect(cand2.snapshot.versionNumber).toBe(2);
    expect(cand2.snapshot.revisionNumber).toBe(2);
    expect(cand2.snapshot.parentVersionId).toBe(cand1.snapshot.id);
  });

  it('records human corrections and links teaching events', () => {
    const baseline = ensureBaselineVersion(wsId);

    const run = createPiRun({
      id: 'run-123',
      workspaceId: wsId,
      mode: 'interactive',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: '076280014028' }),
      policyJson: JSON.stringify({ allowedTools: [] }),
      configSnapshotId: 'snap-1',
      configSnapshotHash: 'hash-1',
      extensionVersionsJson: '[]',
    });

    const correction = createCorrection(wsId, {
      runId: run.id,
      versionId: baseline.snapshot.id,
      originalResultHash: 'res-hash-1',
      correctedFields: {
        title: 'Correct Title 12.5 oz',
        packCount: 1,
      },
      failureMode: 'wrong_size_retailer',
      notes: 'Picked 12-pack instead of single can',
      createdBy: 'operator',
    });

    expect(correction.id).toBeDefined();
    expect(correction.failureMode).toBe('wrong_size_retailer');

    const cand = createCandidateSnapshot(wsId, {
      parentVersionId: baseline.snapshot.id,
      instructions: [
        {
          id: 'rule-mp',
          category: 'facts',
          rule: 'Check unit price vs MSRP.',
          motivationCorrectionId: correction.id,
          createdAt: new Date().toISOString(),
        },
      ],
      fewShotExamples: [],
      createdBy: 'operator',
      changeSummary: 'Taught from correction',
    });

    const teachEvent = recordTeachingEvent(wsId, {
      correctionId: correction.id,
      resultingVersionId: cand.snapshot.id,
      actions: [
        {
          type: 'add_rule',
          category: 'facts',
          rule: 'Check unit price vs MSRP.',
        },
      ],
      rationale: 'Prevent single can misattribution to case multipack',
      createdBy: 'operator',
    });

    expect(teachEvent.id).toBeDefined();
    expect(teachEvent.resultingVersionId).toBe(cand.snapshot.id);
  });

  it('promotes candidate version atomically after verifying evaluation gate', () => {
    const baseline = ensureBaselineVersion(wsId);

    const cand = createCandidateSnapshot(wsId, {
      parentVersionId: baseline.snapshot.id,
      instructions: [],
      fewShotExamples: [],
      createdBy: 'operator',
      changeSummary: 'Ready for promotion',
    });

    const db = getDb();
    const evalId = 'eval-promotion-123';
    const nowIso = new Date().toISOString();
    const ds = createDataset(wsId, 'promotion-eval-ds', 'random', 42);

    // 1. Insert a passing evaluation snapshot on promotion_test split
    db.query(`
      INSERT INTO agent_evaluation_snapshots (
        id, workspace_id, candidate_version_id, baseline_version_id,
        dataset_id, dataset_hash, split_group, scorecard_json,
        promotion_gate_verdict_json, status, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evalId,
      wsId,
      cand.snapshot.id,
      baseline.snapshot.id,
      ds.id,
      'hash1',
      'promotion_test',
      JSON.stringify({ totalCases: 10, completedCases: 10 }),
      JSON.stringify({ allowed: true, complete: true, reasons: [] }),
      'passed',
      nowIso,
      nowIso,
    );

    // Test rejection on wrong candidate ID
    expect(() => {
      promoteCandidateVersion(wsId, baseline.snapshot.id, 'operator', evalId);
    }).toThrow(/does not match/);

    // Test rejection on wrong split (e.g. 'train')
    const trainEvalId = 'eval-train-456';
    db.query(`
      INSERT INTO agent_evaluation_snapshots (
        id, workspace_id, candidate_version_id, baseline_version_id,
        dataset_id, dataset_hash, split_group, scorecard_json,
        promotion_gate_verdict_json, status, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trainEvalId,
      wsId,
      cand.snapshot.id,
      baseline.snapshot.id,
      ds.id,
      'hash1',
      'train',
      JSON.stringify({ totalCases: 10, completedCases: 10 }),
      JSON.stringify({ allowed: true, complete: true, reasons: [] }),
      'passed',
      nowIso,
      nowIso,
    );
    expect(() => {
      promoteCandidateVersion(wsId, cand.snapshot.id, 'operator', trainEvalId);
    }).toThrow(/promotion_test/);

    // Promote successfully with valid promotion_test evaluation
    const promoted = promoteCandidateVersion(wsId, cand.snapshot.id, 'operator', evalId);
    expect(promoted.state.lifecycleStatus).toBe('active');
    expect(promoted.state.activeEvaluationId).toBe(evalId);

    // Verify baseline was retired
    const oldBaseline = getVersionSnapshot(wsId, baseline.snapshot.id);
    expect(oldBaseline?.state.lifecycleStatus).toBe('retired');
    expect(oldBaseline?.state.retiredAt).toBeDefined();

    // Verify active version is now the promoted candidate
    const currentActive = getActiveVersion(wsId);
    expect(currentActive?.snapshot.id).toBe(cand.snapshot.id);
  });
});
