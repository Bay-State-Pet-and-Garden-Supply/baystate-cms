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

  it('produces a consistent standalone snapshot (WAL content absorbed, no sidecars)', async () => {
    // Blockers 1: the backup must be a single consistent artifact whose
    // SHA-256 attests ALL logical content — WAL-committed rows included —
    // and it must have no mutable sidecars.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-wal-'));
    const source = path.join(dir, 'src.db');
    const writer = new Database(source);
    writer.exec('PRAGMA journal_mode = WAL;');
    writer.exec('CREATE TABLE t(id TEXT PRIMARY KEY, v TEXT)');
    writer.exec("INSERT INTO t VALUES ('a', 'one')");
    // Leave the writer open with uncheckpointed WAL content.
    writer.exec("INSERT INTO t VALUES ('b', 'two')");

    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);

    // Standalone artifact: no -wal/-shm sidecars exist for the backup.
    expect(fs.existsSync(`${backup}-wal`)).toBe(false);
    expect(fs.existsSync(`${backup}-shm`)).toBe(false);

    // The snapshot absorbed the WAL-committed row.
    const snap = new Database(backup, { readonly: true });
    expect((snap.query('SELECT COUNT(*) c FROM t').get() as { c: number }).c).toBe(2);
    snap.close();

    writer.close();
    // The standalone artifact is fully attested by its own hash.
    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(true);
    expect(verification.errors).toEqual([]);
  });

  it('rejects a manifest whose schemaVersion does not match the backup', async () => {
    // Blocker 4a: the backup's ACTUAL schema version must match the manifest.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-schema-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    const tampered: BackupManifest = { ...manifest, schemaVersion: manifest.schemaVersion + 100 };
    const verification = await verifySqliteBackup(backup, tampered);
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /schema_version/i.test(e))).toBe(true);
  });

  it('rejects a source replaced at the same path (content differs, schema/count unchanged)', async () => {
    // Blocker 4b: a same-path database replaced with different content (even
    // with identical schema and counts) must be rejected via the source
    // identity hash.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-replaced-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);

    // Same schema, same row COUNT — only a value changes.
    const db = new Database(source);
    db.exec("UPDATE onboarding_items SET name = 'CHANGED' WHERE id = 'i1'");
    db.close();

    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /content has changed/i.test(e))).toBe(true);
  });

  it('rejects a missing explicitly-supplied source', async () => {
    // Blocker 4c: an explicitly-supplied source that is missing is fail-closed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-missing-src-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    fs.rmSync(source);
    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /Source database missing/i.test(e))).toBe(true);
  });

  it('refuses to overwrite ANY backup artifact and chmods all artifacts to 0600', async () => {
    // Blocker 5: an existing manifest (or any sidecar path) blocks creation,
    // and every created artifact is mode 0600 (existing files included).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-artifacts-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifestPath = `${backup}.manifest.json`;
    fs.writeFileSync(manifestPath, 'DO NOT OVERWRITE', { mode: 0o644 });
    expect(() => createSqliteBackup(source, backup)).toThrow(/already exists/);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe('DO NOT OVERWRITE');
    expect((fs.statSync(manifestPath).mode & 0o777)).toBe(0o644);

    // Clean slate: all created artifacts are 0600.
    fs.rmSync(manifestPath);
    const manifest = createSqliteBackup(source, backup);
    expect((fs.statSync(backup).mode & 0o777)).toBe(0o600);
    expect((fs.statSync(`${backup}.manifest.json`).mode & 0o777)).toBe(0o600);
    expect(manifest.sizeBytes).toBe(fs.statSync(backup).size);
  });

  it('records counts for every repair target and protected table that exists', async () => {
    // Blocker 2 (count allowlist): the manifest must cover every repair
    // target + protected parent/business table so live-vs-backup count
    // parity can never be bypassed by an uncovered table.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-allowlist-'));
    const source = path.join(dir, 'src.db');
    const db = new Database(source);
    db.exec(`
      CREATE TABLE onboarding_items (id TEXT PRIMARY KEY);
      CREATE TABLE onboarding_sources (id TEXT PRIMARY KEY);
      CREATE TABLE onboarding_extractions (id TEXT PRIMARY KEY);
      CREATE TABLE profile_generations (id TEXT PRIMARY KEY);
      CREATE TABLE profile_generation_revisions (id TEXT PRIMARY KEY);
      CREATE TABLE classification_runs (id TEXT PRIMARY KEY);
      CREATE TABLE classification_stage_results (id TEXT PRIMARY KEY);
      CREATE TABLE classification_evidence (id TEXT PRIMARY KEY);
      CREATE TABLE classification_proposals (id TEXT PRIMARY KEY);
      CREATE TABLE classification_proposal_decisions (id TEXT PRIMARY KEY);
      CREATE TABLE classification_proposal_evidence (proposal_id TEXT, evidence_id TEXT);
      CREATE TABLE classification_proposal_decision_evidence (decision_id TEXT, evidence_id TEXT);
      CREATE TABLE classification_model_calls (id TEXT PRIMARY KEY);
      CREATE TABLE page_imports (id TEXT PRIMARY KEY);
      CREATE TABLE page_index (id TEXT PRIMARY KEY);
      CREATE TABLE classification_config_snapshots (id TEXT PRIMARY KEY);
    `);
    db.exec(`INSERT INTO onboarding_items VALUES ('i1')`);
    db.exec(`INSERT INTO classification_runs VALUES ('r1')`);
    db.close();
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    for (const table of [
      'onboarding_items',
      'onboarding_sources',
      'onboarding_extractions',
      'profile_generation_revisions',
      'classification_runs',
      'classification_stage_results',
      'classification_evidence',
      'classification_proposals',
      'classification_proposal_decisions',
      'classification_proposal_evidence',
      'classification_proposal_decision_evidence',
      'classification_model_calls',
      'page_imports',
      'page_index',
      'classification_config_snapshots',
    ]) {
      expect(manifest.counts).toHaveProperty(table);
    }
    expect(manifest.counts.onboarding_items).toBe(1);
    expect(manifest.counts.classification_runs).toBe(1);
  });
});
