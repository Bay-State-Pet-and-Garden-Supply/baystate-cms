import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from '../../db/driver';
import {
  createSqliteBackup,
  readBackupManifest,
  verifySqliteBackup,
  type BackupManifest,
} from '../../db/sqlite-backup-verifier';
import { sha256Hex } from '../../shared/stable-id';

function makeSourceDb(dir: string, name = 'source.db'): string {
  const dbPath = path.join(dir, name);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE onboarding_items (
      id TEXT PRIMARY KEY,
      upc TEXT,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'imported',
      curation_data_json TEXT
    );
    CREATE TABLE classification_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      product_sku TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO onboarding_items (id, upc, name, status) VALUES
      ('i1', 'UPC1', 'A', 'imported'),
      ('i2', 'UPC2', 'B', 'imported'),
      ('i3', 'UPC3', 'C', 'imported');
    INSERT INTO classification_runs VALUES
      ('r1', 'ws-1', 'SKU-1', 'completed'),
      ('r2', 'ws-1', 'SKU-2', 'completed');
  `);
  db.close();
  return dbPath;
}

describe('SQLite backup verifier (Issue #17 C1)', () => {
  it('creates and verifies a valid backup (manifest + file, mode 0600)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-ok-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');

    const manifest = createSqliteBackup(source, backup);
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.existsSync(`${backup}.manifest.json`)).toBe(true);
    expect((fs.statSync(backup).mode & 0o777)).toBe(0o600);

    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(true);
    expect(verification.errors).toEqual([]);

    const reread = readBackupManifest(`${backup}.manifest.json`);
    expect(reread.sha256).toBe(manifest.sha256);
    expect(reread.counts.onboarding_items).toBe(3);
    expect(reread.counts.classification_runs).toBe(2);
  });

  it('refuses to overwrite an existing backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-noover-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    createSqliteBackup(source, backup);
    expect(() => createSqliteBackup(source, backup)).toThrow(/already exists/);
  });

  it('rejects a missing backup file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-missing-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    fs.rmSync(backup);
    const verification = await verifySqliteBackup(backup, manifest);
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /missing/i.test(e))).toBe(true);
  });

  it('rejects a corrupt backup (SHA-256 mismatch)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-corrupt-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    const buf = fs.readFileSync(backup);
    buf[0] = (buf[0]! ^ 0xff) as number; // corrupt the header
    fs.writeFileSync(backup, buf);
    const verification = await verifySqliteBackup(backup, manifest);
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /SHA-256/i.test(e))).toBe(true);
  });

  it('rejects a count-mismatched backup manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-count-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    const tampered: BackupManifest = { ...manifest, counts: { ...manifest.counts, t1: 999 } };
    const verification = await verifySqliteBackup(backup, tampered);
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /count mismatch for t1/i.test(e))).toBe(true);
  });

  it('rejects a wrong-source manifest when the source differs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-source-'));
    const sourceA = makeSourceDb(dir, 'a.db');
    const sourceB = makeSourceDb(dir, 'b.db');
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(sourceA, backup);
    // Verify against a DIFFERENT source path.
    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: sourceB });
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /Wrong source/i.test(e))).toBe(true);
  });

  it('rejects a stale backup (source schema newer than the backup)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-stale-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    // Advance the SOURCE schema so the backup is stale relative to it.
    const db = new Database(source);
    db.exec('CREATE TABLE new_schema (id TEXT PRIMARY KEY);');
    db.close();
    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /stale|newer/i.test(e))).toBe(true);
  });

  it('rejects a backup whose content does not match the manifest hash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-badhash-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    const tampered: BackupManifest = { ...manifest, sha256: '0'.repeat(64) };
    const verification = await verifySqliteBackup(backup, tampered);
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /SHA-256/i.test(e))).toBe(true);
  });

  it('rejects a manifest whose backupPath does not match', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-path-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    const tampered: BackupManifest = { ...manifest, backupPath: '/some/other/path.db' };
    const verification = await verifySqliteBackup(backup, tampered);
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /backupPath/i.test(e))).toBe(true);
  });

  it('produces a deterministic manifest sha256 for identical inputs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-det-'));
    const source = makeSourceDb(dir);
    const backup1 = path.join(dir, 'b1.db');
    const backup2 = path.join(dir, 'b2.db');
    const m1 = createSqliteBackup(source, backup1);
    const m2 = createSqliteBackup(source, backup2);
    expect(m1.sha256).toBe(m2.sha256);
    expect(m1.counts).toEqual(m2.counts);
    expect(sha256Hex(fs.readFileSync(backup1))).toBe(m1.sha256);
  });
});
