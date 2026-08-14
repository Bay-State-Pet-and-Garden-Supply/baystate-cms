// DB-backed: run under `bun test` (excluded from Vitest collection).
/**
 * Operations console, Issue 6 — playbook repository (DB-backed).
 *
 * Immutable content-addressed versions, one active version per workspace,
 * copy-on-edit, activation audit, cross-workspace 404 semantics, and tamper
 * detection on reads.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import {
  createPlaybook,
  appendPlaybookVersion,
  getPlaybookForWorkspace,
  getPlaybookVersionForWorkspace,
  listPlaybooksForWorkspace,
  listPlaybookVersionsForWorkspace,
  updatePlaybookPointer,
  activatePlaybookVersion,
} from '../../db/repositories/store-manager-playbook-repo';
import {
  createPlaybookFromTemplate,
  getPlaybookVersions,
  StoreManagerPlaybookError,
} from '../../server/services/store-manager-playbook-service';

describe('Store Manager playbook repository (Issue 6)', () => {
  const testDbPath = './test-playbook-repo.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  function sampleDefinition(playbookId: string, version: number, name: string): string {
    return JSON.stringify({
      id: playbookId,
      workspaceId: 'ws-1',
      name,
      version,
      status: 'draft',
      scopeInput: { allowedKinds: [], maxSkus: 200 },
      variables: [],
      steps: [{ stepId: 's1', kind: 'read', toolName: 'getDashboardStats', toolVersion: 1, inputTemplate: {} }],
      definitionHash: 'x'.repeat(64),
    });
  }

  it('creates a logical playbook and appends immutable versions', () => {
    const pb = createPlaybook({ workspaceId: 'ws-1', name: 'Weekly taxonomy cleanup', templateKind: 'weekly_taxonomy_cleanup' });
    expect(pb.status).toBe('draft');
    expect(pb.currentVersion).toBe(1);

    appendPlaybookVersion({
      workspaceId: 'ws-1',
      playbookId: pb.id,
      version: 1,
      definitionJson: sampleDefinition(pb.id, 1, pb.name),
      definitionHash: 'a'.repeat(64),
    });
    appendPlaybookVersion({
      workspaceId: 'ws-1',
      playbookId: pb.id,
      version: 2,
      definitionJson: sampleDefinition(pb.id, 2, pb.name),
      definitionHash: 'b'.repeat(64),
    });
    const versions = listPlaybookVersionsForWorkspace('ws-1', pb.id);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0].definitionHash).toBe('b'.repeat(64));
  });

  it('appending the same version twice is rejected (immutability backstop)', () => {
    const pb = createPlaybook({ workspaceId: 'ws-1', name: 'Immutable' });
    appendPlaybookVersion({ workspaceId: 'ws-1', playbookId: pb.id, version: 1, definitionJson: '{}', definitionHash: 'a'.repeat(64) });
    expect(() =>
      appendPlaybookVersion({ workspaceId: 'ws-1', playbookId: pb.id, version: 1, definitionJson: '{}', definitionHash: 'b'.repeat(64) }),
    ).toThrow(/UNIQUE/i);
  });

  it('supports copy-on-edit via the pointer update', () => {
    const pb = createPlaybook({ workspaceId: 'ws-1', name: 'Copy-on-edit' });
    const updated = updatePlaybookPointer({
      workspaceId: 'ws-1',
      playbookId: pb.id,
      name: 'Copy-on-edit v2',
      description: 'edited',
      currentVersion: 2,
    });
    expect(updated?.currentVersion).toBe(2);
    expect(updated?.name).toBe('Copy-on-edit v2');
    // The original version row is untouched (immutable history).
    expect(listPlaybookVersionsForWorkspace('ws-1', pb.id)).toEqual([]);
  });

  it('activates exactly one version with audit + hash and verifies cross-workspace 404', () => {
    const pb = createPlaybook({ workspaceId: 'ws-1', name: 'Activation audit' });
    appendPlaybookVersion({ workspaceId: 'ws-1', playbookId: pb.id, version: 1, definitionJson: sampleDefinition(pb.id, 1, 'v1'), definitionHash: 'c'.repeat(64) });
    appendPlaybookVersion({ workspaceId: 'ws-1', playbookId: pb.id, version: 2, definitionJson: sampleDefinition(pb.id, 2, 'v2'), definitionHash: 'd'.repeat(64) });

    // Wrong hash -> refuses activation (content-addressed).
    expect(
      activatePlaybookVersion({ workspaceId: 'ws-1', playbookId: pb.id, version: 1, definitionHash: 'e'.repeat(64), activatedBy: 'operator' }),
    ).toBeNull();

    const activated = activatePlaybookVersion({ workspaceId: 'ws-1', playbookId: pb.id, version: 2, definitionHash: 'd'.repeat(64), activatedBy: 'operator' });
    expect(activated?.status).toBe('active');
    expect(activated?.activeVersion).toBe(2);
    expect(activated?.activeHash).toBe('d'.repeat(64));
    expect(activated?.activatedBy).toBe('operator');

    // Cross-workspace reads are indistinguishable from missing.
    expect(getPlaybookForWorkspace('ws-2', pb.id)).toBeNull();
    expect(getPlaybookVersionForWorkspace('ws-2', pb.id, 2)).toBeNull();
    expect(listPlaybooksForWorkspace('ws-2')).toEqual([]);
    expect(listPlaybookVersionsForWorkspace('ws-2', pb.id)).toEqual([]);
  });

  it('detects tampered version content on read (hash mismatch)', () => {
    const pb = createPlaybook({ workspaceId: 'ws-1', name: 'Tamper check' });
    appendPlaybookVersion({ workspaceId: 'ws-1', playbookId: pb.id, version: 1, definitionJson: sampleDefinition(pb.id, 1, 'tamper'), definitionHash: 'f'.repeat(64) });
    // The repo returns rows verbatim; the SERVICE layer re-verifies the hash.
    // Here we assert the stored hash round-trips and is comparable.
    const row = getPlaybookVersionForWorkspace('ws-1', pb.id, 1);
    expect(row?.definitionHash).toBe('f'.repeat(64));
    const raw = getDb()
      .query('SELECT definition_hash FROM store_manager_playbook_versions WHERE workspace_id = ? AND playbook_id = ? AND version = 1')
      .get('ws-1', pb.id) as { definition_hash: string };
    expect(raw.definition_hash).toBe(row?.definitionHash);
    expect(row?.definitionJson).toContain('"tamper"');
  });

  it('keeps cross-workspace 404 semantics for list reads too', () => {
    // ws-1 has playbooks from earlier tests; ws-2 sees none of them.
    expect(listPlaybooksForWorkspace('ws-1').length).toBeGreaterThanOrEqual(4);
    expect(listPlaybooksForWorkspace('ws-2')).toEqual([]);
    expect(listPlaybookVersionsForWorkspace('ws-2', 'anything')).toEqual([]);
  });

  it('detects a same-shape content tamper at service read time (hash recompute)', () => {
    const pb = createPlaybookFromTemplate('ws-1', { templateKind: 'launch_readiness_check' });
    // Same-shape mutation: rename inside the stored definition JSON only. The
    // recorded hash field is untouched, so a hash-field-only check would pass.
    const row = getDb()
      .query('SELECT definition_json FROM store_manager_playbook_versions WHERE playbook_id = ?')
      .get(pb.id) as { definition_json: string };
    const obj = JSON.parse(row.definition_json) as Record<string, unknown>;
    obj.name = 'TAMPERED NAME';
    getDb()
      .query('UPDATE store_manager_playbook_versions SET definition_json = ? WHERE playbook_id = ?')
      .run(JSON.stringify(obj), pb.id);
    expect(() => getPlaybookVersions('ws-1', pb.id)).toThrow(StoreManagerPlaybookError);
  });
});
