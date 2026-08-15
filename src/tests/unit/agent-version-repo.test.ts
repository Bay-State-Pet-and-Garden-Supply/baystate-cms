import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../db/connection';
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

  it('promotes candidate version atomically retiring the old active version', () => {
    const baseline = ensureBaselineVersion(wsId);

    const cand = createCandidateSnapshot(wsId, {
      parentVersionId: baseline.snapshot.id,
      instructions: [],
      fewShotExamples: [],
      createdBy: 'operator',
      changeSummary: 'Ready for promotion',
    });

    updateCandidateLifecycleStatus(wsId, cand.snapshot.id, 'qualified', 'eval-789');

    const promoted = promoteCandidateVersion(wsId, cand.snapshot.id, 'operator', 'eval-789');
    expect(promoted.state.lifecycleStatus).toBe('active');

    // Verify baseline was retired
    const oldBaseline = getVersionSnapshot(wsId, baseline.snapshot.id);
    expect(oldBaseline?.state.lifecycleStatus).toBe('retired');
    expect(oldBaseline?.state.retiredAt).toBeDefined();

    // Verify active version is now the promoted candidate
    const currentActive = getActiveVersion(wsId);
    expect(currentActive?.snapshot.id).toBe(cand.snapshot.id);
  });
});
