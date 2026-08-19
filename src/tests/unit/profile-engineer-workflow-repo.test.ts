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
  profileEngineerWorkflowLock,
} from '../../db/repositories/profile-engineer-workflow-repo';
import { ProfileEngineerSpecialist } from '../../product-intelligence/specialists/profile-engineer';

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

  it('permits v2 repair claim when v1 is completed and deduplicates concurrent v2 claims', () => {
    // 1. Initial v1 workflow completes
    const v1 = claimProfileEngineerWorkflow('workspace-v2', 'repair.example', 'run-v1', { targetVersion: 1 });
    expect(v1.acquired).toBe(true);
    expect(completeProfileEngineerWorkflow(v1.workflow.id, 'run-v1', '{"v1":true}').applied).toBe(true);

    // 2. Normal un-versioned claim is rejected because completed
    const normal = claimProfileEngineerWorkflow('workspace-v2', 'repair.example', 'run-v1-again');
    expect(normal.acquired).toBe(false);
    expect(normal.reason).toBe('domain_workflow_already_completed');

    // 3. Stale/incompatible profile triggers v2 repair claim with needsRepair: true & targetVersion: 2
    const v2Repair = claimProfileEngineerWorkflow('workspace-v2', 'repair.example', 'run-v2', {
      needsRepair: true,
      targetVersion: 2,
    });
    expect(v2Repair.acquired).toBe(true);
    expect(v2Repair.workflow.targetVersion).toBe(2);

    // 4. Concurrent attempt to claim v2 repair while v2 is running is deduplicated
    const concurrentV2 = claimProfileEngineerWorkflow('workspace-v2', 'repair.example', 'run-v2-concurrent', {
      needsRepair: true,
      targetVersion: 2,
    });
    expect(concurrentV2.acquired).toBe(false);
    expect(concurrentV2.reason).toBe('domain_workflow_in_progress');

    // 5. Complete v2
    expect(completeProfileEngineerWorkflow(v2Repair.workflow.id, 'run-v2', '{"v2":true}').applied).toBe(true);
    expect(findProfileEngineerWorkflow('workspace-v2', 'repair.example')?.targetVersion).toBe(2);

    // 6. After v2 completes, another caller seeing stale v1 requesting targetVersion: 2 is deduped/reused, NOT regenerated
    const duplicateV2 = claimProfileEngineerWorkflow('workspace-v2', 'repair.example', 'run-v2-stale-caller', {
      needsRepair: true,
      targetVersion: 2,
    });
    expect(duplicateV2.acquired).toBe(false);
    expect(duplicateV2.reason).toBe('domain_workflow_already_completed');
    expect(duplicateV2.workflow.targetVersion).toBe(2);

    // 7. But a future v3 repair (targetVersion: 3) can be acquired
    const v3Repair = claimProfileEngineerWorkflow('workspace-v2', 'repair.example', 'run-v3', {
      needsRepair: true,
      targetVersion: 3,
    });
    expect(v3Repair.acquired).toBe(true);
    expect(v3Repair.workflow.targetVersion).toBe(3);
  });

  it('preserves sourceProfileVersion and distinguishes repair needs across timestamp profile versions without collapsing into v2', () => {
    // 1. Timestamp A fails -> repair claims target v2 and completes
    const repairA = claimProfileEngineerWorkflow('workspace-ts', 'timestamp.example', 'run-ts-a', {
      needsRepair: true,
      targetVersion: 2,
      sourceProfileVersion: '2026-08-19T01:00:00.000Z',
    });
    expect(repairA.acquired).toBe(true);
    expect(repairA.workflow.sourceProfileVersion).toBe('2026-08-19T01:00:00.000Z');
    expect(completeProfileEngineerWorkflow(repairA.workflow.id, 'run-ts-a', '{"repairedA":true}').applied).toBe(true);

    // 2. Timestamp A fails again -> deduplicated and reused (already repaired)
    const reuseA = claimProfileEngineerWorkflow('workspace-ts', 'timestamp.example', 'run-ts-a2', {
      needsRepair: true,
      targetVersion: 2,
      sourceProfileVersion: '2026-08-19T01:00:00.000Z',
    });
    expect(reuseA.acquired).toBe(false);
    expect(reuseA.reason).toBe('domain_workflow_already_completed');
    expect(reuseA.workflow.sourceProfileVersion).toBe('2026-08-19T01:00:00.000Z');

    // 3. Timestamp B (genuinely newer profile timestamp) fails -> ACQUIRES A NEW REPAIR LEASE with next generation!
    const repairB = claimProfileEngineerWorkflow('workspace-ts', 'timestamp.example', 'run-ts-b', {
      needsRepair: true,
      targetVersion: 2,
      sourceProfileVersion: '2026-08-19T04:00:00.000Z',
    });
    expect(repairB.acquired).toBe(true);
    expect(repairB.workflow.sourceProfileVersion).toBe('2026-08-19T04:00:00.000Z');
    expect(repairB.workflow.targetVersion).toBe(3); // Next generation (v3)!
  });

  it('forwards sourceProfileVersion through production lock adapter and aligns ProfileEngineer proposal generation', async () => {
    const lock = profileEngineerWorkflowLock();
    const specialist = new ProfileEngineerSpecialist({ workflow: lock });

    const sample1 = {
      url: 'https://adapter.example/p1',
      artifactRefs: ['art-1'],
      expectedName: 'ACME Dog Food 10lb',
      signals: { jsonLd: false, shopify: false, woocommerce: false, embeddedState: false, selectorOnly: false, changedMarkup: false, wrongVariant: false },
      selectorHints: { titleSelector: 'h1.product-title' },
      observedFields: { product_name: 'ACME Dog Food 10lb' },
    };
    const sample2 = {
      url: 'https://adapter.example/p2',
      artifactRefs: ['art-2'],
      expectedName: 'ACME Cat Food 5lb',
      signals: { jsonLd: false, shopify: false, woocommerce: false, embeddedState: false, selectorOnly: false, changedMarkup: false, wrongVariant: false },
      selectorHints: { titleSelector: 'h1.product-title' },
      observedFields: { product_name: 'ACME Cat Food 5lb' },
    };

    const context = {
      runId: 'run-adapter-1',
      workspaceId: 'workspace-adapter',
      workspacePath: '/tmp/test',
      seq: 1,
      policy: {
        configId: 'policy-adapter',
        deadlineMs: 30_000,
        maxToolCalls: 10,
        maxCostUsd: 1.0,
      } as any,
    };

    // 1. Repair timestamp A -> claims target v2 and emits proposal v2
    const resA = await specialist.execute(
      {
        schemaVersion: 1,
        domain: 'adapter.example',
        repairOf: {
          profileId: 'prof-a',
          version: '2026-08-19T01:00:00.000Z',
          sourceProfileVersion: '2026-08-19T01:00:00.000Z',
          targetVersion: 2,
        },
        samples: [sample1, sample2],
        requiredFields: ['titleSelector'],
      },
      context,
    );

    expect(resA.outcome).toBe('succeeded');
    if (resA.outcome !== 'succeeded' || !resA.output) throw new Error('expected proposal A');
    expect((resA.output as any).payload.proposedVersion).toBe(2);

    // 2. Timestamp A fails again -> adapter returns already completed -> specialist abstains
    const resA2 = await specialist.execute(
      {
        schemaVersion: 1,
        domain: 'adapter.example',
        repairOf: {
          profileId: 'prof-a',
          version: '2026-08-19T01:00:00.000Z',
          sourceProfileVersion: '2026-08-19T01:00:00.000Z',
          targetVersion: 2,
        },
        samples: [sample1, sample2],
        requiredFields: ['titleSelector'],
      },
      { ...context, runId: 'run-adapter-2' },
    );
    expect(resA2.outcome).toBe('abstained');
    if (resA2.outcome === 'abstained') {
      expect(resA2.abstention?.reason).toBe('domain_workflow_already_completed');
    }

    // 3. Timestamp B (new failure need) -> adapter claims v3 -> proposal generation is dynamically aligned to v3!
    const resB = await specialist.execute(
      {
        schemaVersion: 1,
        domain: 'adapter.example',
        repairOf: {
          profileId: 'prof-b',
          version: '2026-08-19T04:00:00.000Z',
          sourceProfileVersion: '2026-08-19T04:00:00.000Z',
          targetVersion: 2,
        },
        samples: [sample1, sample2],
        requiredFields: ['titleSelector'],
      },
      { ...context, runId: 'run-adapter-3' },
    );

    expect(resB.outcome).toBe('succeeded');
    if (resB.outcome !== 'succeeded' || !resB.output) throw new Error('expected proposal B');
    expect((resB.output as any).payload.proposedVersion).toBe(3); // Accurately bumped to v3 through adapter!
  });
});
