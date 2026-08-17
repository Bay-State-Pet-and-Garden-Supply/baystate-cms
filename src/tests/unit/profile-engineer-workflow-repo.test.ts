import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  claimProfileEngineerWorkflow,
  completeProfileEngineerWorkflow,
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
    const first = claimProfileEngineerWorkflow('www.lock.example', 'run-a');
    const second = claimProfileEngineerWorkflow('lock.example', 'run-b');
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe('domain_workflow_in_progress');
    failProfileEngineerWorkflow(first.workflow.id, 'run-a', 'validation failed');
    const retry = claimProfileEngineerWorkflow('lock.example', 'run-c');
    expect(retry.acquired).toBe(true);
    expect(completeProfileEngineerWorkflow(retry.workflow.id, 'run-c', '{"artifact":"proposal"}')).toBe(true);
    expect(findProfileEngineerWorkflow('lock.example')?.artifactJson).toBe('{"artifact":"proposal"}');
    const completed = claimProfileEngineerWorkflow('lock.example', 'run-d');
    expect(completed.acquired).toBe(false);
    expect(completed.reason).toBe('domain_workflow_already_completed');
  });
});
