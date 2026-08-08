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

  it('throws when a verified row source hash is NULL (no NULL exemption)', () => {
    activate([verifiedRecord('1', 'Dog Food')]);
    const db = getDb();
    // An activated verified row must carry the authoritative non-null import
    // hash; NULL is drift and must fail closed.
    db.run('UPDATE page_index SET source_hash = NULL WHERE identity_key = ?', ['1']);
    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/source hash mismatch/i);
  });

  it('throws when an UNAVAILABLE verified row has a tampered parent (any-availability drift)', () => {
    activate([
      verifiedRecord('1', 'Dog Food'),
      verifiedRecord('2', 'Hidden Parent', null, 'unavailable'),
    ]);
    const db = getDb();
    // Give the unavailable verified row a parent it must not have: parent
    // validation applies to ALL verified rows before availability filtering.
    const row1 = db.query('SELECT id FROM page_index WHERE identity_key = ?').get('1') as { id: string };
    db.run('UPDATE page_index SET parent_id = ? WHERE identity_key = ?', [row1.id, '2']);
    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/unexpected parent/i);
  });

  it('throws on duplicate identity-key rows (strict 1:1 even without the unique index)', () => {
    activate([verifiedRecord('1', 'Dog Food')]);
    const db = getDb();
    // Simulate an older database where the unique identity index is absent:
    // the in-code Set-based check must still reject duplicates.
    db.exec('DROP INDEX IF EXISTS idx_page_index_identity_unique');
    const existing = db.query('SELECT * FROM page_index WHERE identity_key = ?').get('1') as Record<string, any>;
    // Insert a second verified row with the SAME identity key (bypassing the
    // unique index, e.g. on an older database that predates it).
    db.run(
      `INSERT INTO page_index
       (id, name, file_name, parent_id, page_hash, workspace_id, import_id, identity_kind, identity_key, identity_status, source_hash, availability, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, 'available', 'imported', ?, ?)`,
      [
        'duplicate-extra-row',
        existing.name,
        existing.file_name,
        existing.parent_id,
        existing.page_hash,
        existing.workspace_id,
        existing.import_id,
        existing.identity_kind,
        existing.identity_key,
        existing.source_hash,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/duplicate page_index rows/i);
  });

  it('exposes the same records for both run boundaries via the shared builder', () => {
    activate([verifiedRecord('1', 'Dog Food')]);
    const snap = captureVerifiedPageSnapshot(workspaceId);
    expect(UNAVAILABLE_PAGE_SNAPSHOT.pageImportId).toBeNull();
    // Re-capture must be deterministic.
    const snap2 = captureVerifiedPageSnapshot(workspaceId);
    expect(JSON.stringify(snap)).toBe(JSON.stringify(snap2));
  });

  it('throws on duplicate identity records in records_json even with equal counts and distinct rows (strict bijection)', () => {
    // Exact reviewer counterexample: records_json identities [A,A] while the
    // verified child rows are [A,B]. Counts match (2 == 2) and no child-row
    // key is duplicated, but the authoritative records contain a duplicate
    // identity that would alias row A twice and leave row B unconsumed.
    activate([verifiedRecord('1', 'Dog Food'), verifiedRecord('2', 'Dog Toys')]);
    const db = getDb();
    const records = JSON.parse(
      (db.query('SELECT records_json FROM page_imports WHERE workspace_id = ?').get(workspaceId) as { records_json: string }).records_json,
    ) as PageRecord[];
    // Tamper records_json: replace the second record's identity key '2' with
    // '1' so identities are [A,A] while child rows remain [A,B].
    const tampered = JSON.parse(JSON.stringify(records));
    tampered[1].identity.key = '1';
    tampered[1].name = tampered[0].name;
    db.run('UPDATE page_imports SET records_json = ? WHERE workspace_id = ?', [
      JSON.stringify(tampered),
      workspaceId,
    ]);
    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/duplicate identity records/i);
  });

  it('throws on duplicate identity records in records_json even when child rows are also duplicated (counts match)', () => {
    // records [A,A] + child rows [A,A]: the duplicate-record check must fire
    // (not silently pass because the duplicate-row check catches it first).
    activate([verifiedRecord('1', 'Dog Food'), verifiedRecord('2', 'Dog Toys')]);
    const db = getDb();
    const records = JSON.parse(
      (db.query('SELECT records_json FROM page_imports WHERE workspace_id = ?').get(workspaceId) as { records_json: string }).records_json,
    ) as PageRecord[];
    const tampered = JSON.parse(JSON.stringify(records));
    tampered[1].identity.key = '1';
    tampered[1].name = tampered[0].name;
    db.run('UPDATE page_imports SET records_json = ? WHERE workspace_id = ?', [
      JSON.stringify(tampered),
      workspaceId,
    ]);
    // Also duplicate the child row (simulating an older DB without the
    // unique index) so both checks are exercised on the same fixture.
    db.exec('DROP INDEX IF EXISTS idx_page_index_identity_unique');
    const existing = db.query('SELECT * FROM page_index WHERE identity_key = ?').get('1') as Record<string, any>;
    db.run(
      `INSERT INTO page_index
       (id, name, file_name, parent_id, page_hash, workspace_id, import_id, identity_kind, identity_key, identity_status, source_hash, availability, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, 'available', 'imported', ?, ?)`,
      [
        'dup-record-row-a',
        existing.name,
        existing.file_name,
        existing.parent_id,
        existing.page_hash,
        existing.workspace_id,
        existing.import_id,
        existing.identity_kind,
        existing.identity_key,
        existing.source_hash,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    expect(() => captureVerifiedPageSnapshot(workspaceId)).toThrow(/duplicate identity records/i);
  });
});
