import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  claimProfileEngineerWorkflow,
  completeProfileEngineerWorkflow,
  completeProfileEngineerWorkflowWithProposal,
  failProfileEngineerWorkflow,
  findProfileEngineerWorkflow,
} from '../../db/repositories/profile-engineer-workflow-repo';

const dbPath = 'src/tests/unit/profile-engineer-workflow-test.db';

describe('Profile Engineer domain workflow lease (#51)', () => {
  beforeAll(() => {
    resetDb();
    try { unlinkSync(dbPath); } catch { /* fresh test database */ }
    initDb(dbPath);
    runMigrations();
  });
  afterAll(() => { closeDb(); try { unlinkSync(dbPath); } catch { /* already removed */ } });

  it('deduplicates concurrent same-domain claims and permits failed retry', () => {
    const first = claimProfileEngineerWorkflow('workspace-a', 'www.lock.example', 'run-a');
    const second = claimProfileEngineerWorkflow('workspace-a', 'lock.example', 'run-b');
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe('domain_workflow_in_progress');
    expect(failProfileEngineerWorkflow(first.workflow.id, 'run-a', 'validation failed').applied).toBe(true);
    const retry = claimProfileEngineerWorkflow('workspace-a', 'lock.example', 'run-c');
    expect(retry.acquired).toBe(true);
    expect(completeProfileEngineerWorkflow(retry.workflow.id, 'run-c', '{"artifact":"proposal"}').applied).toBe(true);
    expect(findProfileEngineerWorkflow('workspace-a', 'lock.example')?.artifactJson).toBe('{"artifact":"proposal"}');
    const completed = claimProfileEngineerWorkflow('workspace-a', 'lock.example', 'run-d');
    expect(completed.acquired).toBe(false);
    expect(completed.reason).toBe('domain_workflow_already_completed');
  });

  it('isolates the same domain across workspaces and preserves ownership', () => {
    const first = claimProfileEngineerWorkflow('workspace-one', 'same.example', 'run-one');
    const second = claimProfileEngineerWorkflow('workspace-two', 'same.example', 'run-two');
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(findProfileEngineerWorkflow('workspace-one', 'same.example')?.runId).toBe('run-one');
    expect(findProfileEngineerWorkflow('workspace-two', 'same.example')?.runId).toBe('run-two');
    expect(findProfileEngineerWorkflow('workspace-three', 'same.example')).toBeNull();
  });

  it('links the workflow artifact to a governed generation and revision without activation', () => {
    const claimed = claimProfileEngineerWorkflow('workspace-link', 'linked.example', 'run-link');
    const artifact = JSON.stringify({ payload: {
      domain: 'linked.example',
      selectors: { titleSelector: 'h1' },
      validation: [{ url: 'https://linked.example/p1' }, { url: 'https://linked.example/p2' }],
      validationSummary: { sampleCount: 2, passingSamples: 2, failingSamples: 0, byField: {} },
    } });
    const completion = completeProfileEngineerWorkflowWithProposal(claimed.workflow.id, 'run-link', artifact);
    expect(completion).toMatchObject({ applied: true });
    const workflow = findProfileEngineerWorkflow('workspace-link', 'linked.example');
    expect(workflow?.generationId).toBeTruthy();
    expect(workflow?.revisionId).toBeTruthy();
    const generationId = workflow?.generationId;
    const revisionId = workflow?.revisionId;
    if (!generationId || !revisionId) throw new Error('expected durable generation linkage');
    expect(getDb().query('SELECT status FROM profile_generations WHERE id = ?').get(generationId) as { status: string }).toEqual({ status: 'proposed' });
    expect(getDb().query('SELECT status FROM profile_generation_revisions WHERE id = ?').get(revisionId) as { status: string }).toEqual({ status: 'draft' });
  });

  it('rejects completion after lease expiry and allows a new owner to reclaim', () => {
    const stale = claimProfileEngineerWorkflow('workspace-stale', 'stale.example', 'run-stale');
    getDb().query('UPDATE profile_engineer_domain_workflows SET lease_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), stale.workflow.id);
    expect(completeProfileEngineerWorkflow(stale.workflow.id, 'run-stale', '{"stale":true}')).toMatchObject({ applied: false, reason: 'workflow_lease_lost' });
    const reclaimed = claimProfileEngineerWorkflow('workspace-stale', 'stale.example', 'run-new');
    expect(reclaimed.acquired).toBe(true);
    expect(completeProfileEngineerWorkflow(reclaimed.workflow.id, 'run-new', '{"fresh":true}').applied).toBe(true);
    expect(findProfileEngineerWorkflow('workspace-stale', 'stale.example')?.runId).toBe('run-new');
  });
});
