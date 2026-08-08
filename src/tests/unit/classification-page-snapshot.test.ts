import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { sha256Hex } from '../../shared/stable-id';
import type { PageRecord } from '../../shared/schemas/page';
import {
  captureVerifiedPageSnapshot,
  toPageSnapshotState,
  UNAVAILABLE_PAGE_SNAPSHOT,
} from '../../classification/page-snapshot';
import { getActivePageImport } from '../../db/repositories/page-import-repo';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';

const workspaceId = 'ws-page-snapshot-test';

function verifiedRecord(
  key: string,
  name: string,
  parentRef: string | null = null,
  availability: 'available' | 'unavailable' = 'available',
): PageRecord {
  return {
    identity: { kind: 'exported_guid', key, status: 'verified' },
    name,
    parentRef,
    availability,
  };
}

function freshDb(): string {
  const wsPath = path.join(os.tmpdir(), `page-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  const dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
  initDb(dbPath);
  runMigrations();
  insertWorkspace({ id: workspaceId, name: 'test', workspacePath: wsPath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  return wsPath;
}

function activate(
  records: PageRecord[],
  source = 'source-snapshot-a',
): { sourceHash: string } {
  const sourceHash = sha256Hex(source);
  activatePageImportFromRecords({
    workspaceId,
    sourceHash,
    parserFormatVersion: 'pages-xml-1',
    records,
    activatedBy: 'test',
  });
  return { sourceHash };
}

describe('captureVerifiedPageSnapshot (issue #17 D1)', () => {
  beforeEach(() => {
    freshDb();
  });

  it('is unavailable when no active import exists', () => {
    const snap = captureVerifiedPageSnapshot(workspaceId);
    expect(snap.pageImportId).toBeNull();
    expect(snap.records).toEqual([]);
    expect(snap.verifiedPageIds).toEqual([]);
    expect(toPageSnapshotState(snap, [{ pageId: 'X', pageName: 'X', verified: false }])).toEqual({
      state: 'no_verified_page_catalog',
      nameOnlyRecords: [{ pageId: 'X', pageName: 'X', verified: false }],
    });
  });

  it('returns verified+available records with parent metadata and import id/hash, excluding unavailable rows and legacy name-only rows', () => {
    activate([
      verifiedRecord('1', 'Dog Food', null),
      verifiedRecord('2', 'Dog Toys', '1'), // parent = Page 1
      verifiedRecord('3', 'Hidden', null, 'unavailable'),
    ]);
    // Simulate a legacy name-only row (post-migration review context): it
    // must never appear in the verified snapshot.
    getDb().run(
      `INSERT INTO page_index (id, name, page_hash, identity_kind, identity_key, identity_status, availability, created_at, updated_at)
       VALUES (?, ?, ?, 'unverified_name_only', ?, 'unverified', 'unavailable', ?, ?)`,
      ['legacy-row-1', 'Legacy Row', 'legacy-hash', 'Legacy Row', new Date().toISOString(), new Date().toISOString()],
    );

    const snap = captureVerifiedPageSnapshot(workspaceId);
    const active = getActivePageImport(workspaceId);

    expect(snap.pageImportId).toBe(active!.id);
    expect(snap.pageImportHash).toBe(active!.sourceHash);
    expect(snap.records).toHaveLength(2);

    const names = snap.records.map(r => r.pageName).sort();
    expect(names).toEqual(['Dog Food', 'Dog Toys']);
    expect(snap.records.every(r => r.verified === true)).toBe(true);
    expect(snap.records.every(r => r.identityKind === 'exported_guid')).toBe(true);

    const toys = snap.records.find(r => r.pageName === 'Dog Toys')!;
    expect(toys.parentPageId).not.toBeNull();
    expect(toys.parentPageName).toBe('Dog Food');

    // Verified options and snapshot agree on identity.
    const verifiedRows = listVerifiedPageOptions(workspaceId);
    expect(snap.verifiedPageIds.sort()).toEqual(verifiedRows.map(r => r.id).sort());

    // toPageSnapshotState is verified with the import binding.
    expect(toPageSnapshotState(snap)).toEqual({ state: 'verified', records: snap.records });
  });

  it('is unavailable when the active import has no usable verified records', () => {
    activate([verifiedRecord('1', 'Unavailable Only', null, 'unavailable')]);
    const snap = captureVerifiedPageSnapshot(workspaceId);
    expect(snap.pageImportId).toBeNull();
    expect(snap.records).toEqual([]);
  });

  it('throws when an import record has no matching verified page_index row (import/row drift)', () => {
    // Activate with records, then remove the page_index rows directly to
    // simulate drift between the import records and the verified rows.
    activate([verifiedRecord('1', 'Dog Food')]);
    const db = getDb();
    db.run('DELETE FROM page_index WHERE identity_kind = ? AND identity_key = ?', ['exported_guid', '1']);

    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/changed during capture|no page_index row/i);
  });

  it('keeps the frozen snapshot byte-stable after page_index mutation post-capture', () => {
    activate([
      verifiedRecord('1', 'Dog Food'),
      verifiedRecord('2', 'Dog Toys', '1'),
    ]);
    const snapA = captureVerifiedPageSnapshot(workspaceId);

    // Mutate page_index rows AFTER capture: the frozen snapshot object must
    // not change (a run already holds it), and a re-capture under drift either
    // reflects new rows or fails closed — never a partial catalog.
    const db = getDb();
    db.run('UPDATE page_index SET name = ? WHERE identity_key = ?', ['Renamed Food', '1']);
    db.run('UPDATE page_index SET availability = ? WHERE identity_key = ?', ['unavailable', '2']);

    expect(snapA.records.map(r => r.pageName).sort()).toEqual(['Dog Food', 'Dog Toys']);
    expect(snapA.pageImportId).not.toBeNull();
    // A fresh capture now fails closed because record '2' lost its verified row.
    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/changed during capture|no page_index row/i);
  });

  it('distinguishes duplicate display names by stable Page ID', () => {
    activate([
      verifiedRecord('11', 'Same Name'),
      verifiedRecord('22', 'Same Name'),
    ]);
    const snap = captureVerifiedPageSnapshot(workspaceId);
    const ids = snap.records.map(r => r.pageId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(2);
    const names = snap.records.map(r => r.pageName);
    expect(new Set(names).size).toBe(1);
  });

  it('throws when a child row parent_id is tampered (row/import drift)', () => {
    activate([
      verifiedRecord('1', 'Dog Food'),
      verifiedRecord('2', 'Dog Toys', '1'),
    ]);
    const db = getDb();
    // Give the parentless record '1' a parent row it must not have: the FK
    // accepts an existing row id, but capture must reject the drift.
    const row2 = db.query('SELECT id FROM page_index WHERE identity_key = ?').get('2') as { id: string };
    db.run('UPDATE page_index SET parent_id = ? WHERE identity_key = ?', [row2.id, '1']);
    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/unexpected parent/i);
  });

  it('throws when records_json is emptied while verified rows remain (import/row drift)', () => {
    activate([verifiedRecord('1', 'Dog Food')]);
    const db = getDb();
    db.run('UPDATE page_imports SET records_json = ? WHERE workspace_id = ?', ['[]', workspaceId]);
    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/changed during capture/);
  });

  it('throws on name mismatch between import records and page_index rows', () => {
    activate([verifiedRecord('1', 'Dog Food')]);
    const db = getDb();
    db.run('UPDATE page_index SET name = ? WHERE identity_key = ?', ['Renamed Food', '1']);
    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/name mismatch/i);
  });

  it('exposes the same records for both run boundaries via the shared builder', () => {
    activate([verifiedRecord('1', 'Dog Food')]);
    const snap = captureVerifiedPageSnapshot(workspaceId);
    expect(UNAVAILABLE_PAGE_SNAPSHOT.pageImportId).toBeNull();
    // Re-capture must be deterministic.
    const snap2 = captureVerifiedPageSnapshot(workspaceId);
    expect(JSON.stringify(snap)).toBe(JSON.stringify(snap2));
  });
});
