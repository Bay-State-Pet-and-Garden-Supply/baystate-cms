import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { Database } from '../../db/driver';
import {
  computeContentIdentityHash,
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

  it('binds the source identity to the snapshot (pre/post identities equal and recorded)', async () => {
    // Blocker 2: the manifest records the source identity captured BEFORE the
    // snapshot and the identity captured AFTER; creation aborts if they ever
    // differ, so the artifact and its recorded source identity always describe
    // the SAME database moment.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-identity-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    expect(manifest.sourceIdentityHash).toBeTruthy();
    expect(manifest.sourceIdentityHashAfter).toBe(manifest.sourceIdentityHash);
    // The identity covers the source content: changing a value later makes
    // verification against the source fail (bound to the snapshot).
    const db = new Database(source);
    db.exec("UPDATE onboarding_items SET name = 'LATER' WHERE id = 'i2'");
    db.close();
    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /content has changed/i.test(e))).toBe(true);
  });

  it('rejects a backup with an unexpected WAL/SHM sidecar (immutable verification)', async () => {
    // Blocker 1: a valid copied -wal/-shm beside the artifact changes the
    // logical database WITHOUT changing the attested main SHA. Verification
    // must reject the sidecar and open the artifact immutably so the SHA
    // always covers the inspected logical contents.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-sidecar-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    const originalSha = manifest.sha256;

    // Clone the standalone artifact, enable WAL on the clone, commit a
    // same-count change with the writer LEFT OPEN (so the change lives only
    // in the WAL), then copy the clone's valid WAL/SHM beside the ORIGINAL.
    const clone = path.join(dir, 'clone.db');
    fs.copyFileSync(backup, clone);
    const writer = new Database(clone);
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec("UPDATE onboarding_items SET name = 'tampered-via-copied-wal' WHERE id = 'i1'");
    fs.copyFileSync(`${clone}-wal`, `${backup}-wal`);
    fs.copyFileSync(`${clone}-shm`, `${backup}-shm`);
    writer.close();

    // The main artifact SHA is unchanged (the logical change is only in the
    // sidecar) — so without the sidecar rejection the verification would
    // falsely pass.
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(backup));
    expect(hash.digest('hex')).toBe(originalSha);

    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /sidecar/i.test(e))).toBe(true);

    // After removing the sidecars, the artifact verifies cleanly (immutable
    // open reads only the main file).
    fs.rmSync(`${backup}-wal`);
    fs.rmSync(`${backup}-shm`);
    const clean = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(clean.ok).toBe(true);
  });

  it('backs up and verifies a source with BLOB columns (typed identity encoding)', async () => {
    // Blocker 4: product_embeddings.embedding_blob BLOB values must be
    // canonicalized deterministically (typed encoding) so a production DB with
    // embeddings can pass the backup gate with a complete artifact + manifest.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-blob-'));
    const source = path.join(dir, 'blob-source.db');
    const db = new Database(source);
    db.exec('CREATE TABLE product_embeddings (id TEXT PRIMARY KEY, embedding_blob BLOB NOT NULL);');
    db.exec("INSERT INTO product_embeddings VALUES ('e1', X'0102030405')");
    db.exec("INSERT INTO product_embeddings VALUES ('e2', X'FFFFFFFF')");
    db.close();

    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.existsSync(`${backup}.manifest.json`)).toBe(true);
    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(true);
    expect(verification.errors).toEqual([]);
  });

  it('leaves no artifacts on failure and allows a clean retry', () => {
    // Blocker 5/4: creation failure removes ONLY artifacts this operation
    // created (never another file), and a retry is not blocked by leftovers.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-cleanup-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifestPath = `${backup}.manifest.json`;
    // A DIRECTORY at the manifest path makes the exclusive 'wx' reservation
    // fail before any snapshot work; no artifact may be left behind.
    fs.mkdirSync(manifestPath);
    expect(() => createSqliteBackup(source, backup)).toThrow();
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.statSync(manifestPath).isDirectory()).toBe(true);
    fs.rmdirSync(manifestPath);

    // Retry succeeds — no leftover main file blocks it.
    const manifest = createSqliteBackup(source, backup);
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(manifest.sizeBytes).toBe(fs.statSync(backup).size);
  });

  // ── Issue #17 pass 6d regression tests ──────────────────────────────────

  it('rejects a manifest whose sourceIdentityHashAfter violates the recorded invariant (pass 6d)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-inv-6d-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);

    // Tamper sourceIdentityHashAfter independently: verification must fail
    // even though the main file, SHA, counts, and current source all match.
    const tampered: BackupManifest = {
      ...manifest,
      sourceIdentityHashAfter: '0'.repeat(64),
    };
    const verification = await verifySqliteBackup(backup, tampered, { sourceDbPath: source });
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /source identity invariant/i.test(e))).toBe(true);
  });

  it('detects any intervening commit via the monotonic data_version counter (ABA catcher, pass 6d)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-dv-6d-'));
    const source = path.join(dir, 's.db');
    const db = new Database(source);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'a\');');
    const read = () =>
      (db.query('PRAGMA data_version').get() as { data_version: number }).data_version;
    const before = read();
    // A second connection commits — data_version must change even if the
    // content is later reverted (ABA is still detected).
    const w = new Database(source);
    w.exec("UPDATE t SET v = 'b';");
    const after = read();
    expect(after).not.toBe(before);
    w.exec("UPDATE t SET v = 'a';");
    const afterAba = read();
    expect(afterAba).not.toBe(before);
    db.close();
    w.close();
  });

  it('row digests are order-independent (XOR combiner, pass 6d)', async () => {
    // Two databases with identical rows inserted in DIFFERENT orders must
    // produce identical source identities (the row-combiner is order
    // independent), while a real content change still differs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-xor-6d-'));
    const a = path.join(dir, 'a.db');
    const b = path.join(dir, 'b.db');
    const make = (p: string, rows: Array<[string, string]>) => {
      const db = new Database(p);
      db.exec('CREATE TABLE t (k TEXT, v TEXT);');
      for (const [k, v] of rows) {
        db.exec(`INSERT INTO t (k, v) VALUES ('${k}', '${v}');`);
      }
      db.close();
    };
    make(a, [['1', 'x'], ['2', 'y'], ['3', 'z']]);
    make(b, [['3', 'z'], ['1', 'x'], ['2', 'y']]);
    const ma = createSqliteBackup(a, path.join(dir, 'ba.db'));
    const mb = createSqliteBackup(b, path.join(dir, 'bb.db'));
    expect(ma.sourceIdentityHash).toBe(mb.sourceIdentityHash);
    // Content change still differs.
    const c = path.join(dir, 'c.db');
    make(c, [['1', 'x'], ['2', 'DIFFERENT'], ['3', 'z']]);
    const mc = createSqliteBackup(c, path.join(dir, 'bc.db'));
    expect(mc.sourceIdentityHash).not.toBe(ma.sourceIdentityHash);
    // And each backup still verifies against its own source.
    expect((await verifySqliteBackup(path.join(dir, 'ba.db'), ma, { sourceDbPath: a })).ok).toBe(true);
    expect((await verifySqliteBackup(path.join(dir, 'bb.db'), mb, { sourceDbPath: b })).ok).toBe(true);
  });

  // ── Issue #17 pass 6e regression tests ──────────────────────────────────

  it('aborts when a sentinel appears at the manifest destination in the final gap (pass 6e)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-gap-6e-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifestPath = `${backup}.manifest.json`;
    // TEST-ONLY hook: after the backup is published, another process creates
    // a sentinel at the manifest destination. The no-clobber link must fail
    // (EEXIST) and abort creation — the sentinel is NEVER overwritten — and
    // the published backup must be removed (it is ours).
    expect(() =>
      createSqliteBackup(source, backup, {
        __afterSnapshot: () => {
          fs.writeFileSync(manifestPath, 'RACE SENTINEL');
        },
      }),
    ).toThrow(/aborting/i);
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe('RACE SENTINEL');
    fs.rmSync(manifestPath);
  });

  it('aborts when a foreign file appears at the backup destination before publish (pass 6e)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-fdest-6e-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    // TEST-ONLY hook: after the VACUUM snapshot (into the unique temp) but
    // before the no-clobber publish, another process creates a foreign file
    // at the FINAL backup destination. The link must fail (EEXIST) without
    // creating-over the foreign file, and cleanup must not delete it.
    expect(() =>
      createSqliteBackup(source, backup, {
        __beforePostCheck: () => {
          fs.writeFileSync(backup, 'FOREIGN FILE');
        },
      }),
    ).toThrow(/aborting/i);
    expect(fs.readFileSync(backup, 'utf-8')).toBe('FOREIGN FILE');
    expect(fs.existsSync(`${backup}.manifest.json`)).toBe(false);
    fs.rmSync(backup);
  });

  it('detects ABA drift via the held-connection commit counter (pass 6e)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-aba-6e-'));
    const source = path.join(dir, 's.db');
    {
      const db = new Database(source);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'before\');');
      db.close();
    }
    const backup = path.join(dir, 'backup.db');
    const w = new Database(source);
    // Deterministic ABA schedule: an intervening commit BEFORE the snapshot
    // (so VACUUM captures 'intermediate') and a revert AFTER the snapshot
    // (back to 'before') — the content identity returns to its original
    // value, but the monotonic data_version counter observed by the SAME
    // held connection advances 2->3->4 and creation MUST abort.
    expect(() =>
      createSqliteBackup(source, backup, {
        __beforeSnapshot: () => {
          w.exec("UPDATE t SET v = 'intermediate';");
        },
        __beforePostCheck: () => {
          w.exec("UPDATE t SET v = 'before';");
        },
      }),
    ).toThrow(/changed during backup/i);
    w.close();
    // Zero artifacts left; the source keeps its original content.
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(`${backup}.manifest.json`)).toBe(false);
    const db = new Database(source, { readonly: true });
    expect((db.query('SELECT v FROM t').get() as { v: string }).v).toBe('before');
    db.close();
  });

  it('rejects a manifest missing the required source identity fields (pass 6e)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-missid-6e-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);

    // Deleting the post-snapshot identity field must fail verification
    // immediately (the field is REQUIRED, never fail-open).
    const { sourceIdentityHashAfter: _dropped, ...withoutAfter } = manifest;
    const tampered = withoutAfter as unknown as BackupManifest;
    const verification = await verifySqliteBackup(backup, tampered, { sourceDbPath: source });
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /missing required source identity/i.test(e))).toBe(true);

    // Same for the pre-snapshot field.
    const { sourceIdentityHash: _dropped2, ...withoutBefore } = manifest;
    const tampered2 = withoutBefore as unknown as BackupManifest;
    const verification2 = await verifySqliteBackup(backup, tampered2, { sourceDbPath: source });
    expect(verification2.ok).toBe(false);
    expect(verification2.errors.some(e => /missing required source identity/i.test(e))).toBe(true);
  });

  it('cleans every artifact on a real mid-VACUUM disk I/O failure and allows a retry (RLIMIT, pass 6d)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-rlimit-6d-'));
    // A source large enough that VACUUM INTO exceeds the child file-size
    // limit (macOS ulimit -f units are 512-byte blocks: 1024 => 512 KB).
    const source = path.join(dir, 'big.db');
    {
      const db = new Database(source);
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, payload BLOB);');
      const blob = Buffer.alloc(4096, 0x41);
      const ins = db.query('INSERT INTO t (payload) VALUES (?)');
      for (let i = 0; i < 1200; i++) {
        ins.run(blob);
      }
      db.close();
    }
    const backup = path.join(dir, 'backup.db');
    const report = path.join(dir, 'report.json');
    const fixture = path.join(dir, 'vacuum-fail-fixture.ts');
    fs.writeFileSync(
      fixture,
      `import { createSqliteBackup } from '${path
        .resolve(__dirname, '../../db/sqlite-backup-verifier')
        .replace(/\\/g, '\\\\')}';
import fs from 'fs';
const [source, backup, reportPath] = process.argv.slice(2);
try {
  createSqliteBackup(source, backup);
  fs.writeFileSync(reportPath, JSON.stringify({ threw: false }));
} catch (e) {
  fs.writeFileSync(reportPath, JSON.stringify({
    threw: true,
    backupExists: fs.existsSync(backup),
    manifestExists: fs.existsSync(backup + '.manifest.json'),
  }));
}
`,
    );
    const res = Bun.spawnSync([
      'bash',
      '-c',
      `trap '' XFSZ; ulimit -f 1024; bun '${fixture}' '${source}' '${backup}' '${report}'`,
    ]);
    expect(res.exitCode).toBe(0);
    const result = JSON.parse(fs.readFileSync(report, 'utf-8'));
    expect(result.threw).toBe(true);
    // Zero artifacts left: the destination was tracked before VACUUM ran and
    // cleanup removed it; the reservation is our empty file and is removed.
    expect(result.backupExists).toBe(false);
    expect(result.manifestExists).toBe(false);

    // Retry from a clean slate succeeds in the unconstrained parent process.
    const manifest = createSqliteBackup(source, backup);
    expect(fs.existsSync(backup)).toBe(true);
    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(true);
  }, 15000);

  it('backs up a table containing non-finite REAL values (Infinity/-Infinity/NaN, pass 6d)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-nf-6d-'));
    const source = path.join(dir, 'nf.db');
    const db = new Database(source);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v REAL);');
    db.exec("INSERT INTO t (v) VALUES (9e999), (-9e999), (0.0/0.0);");
    db.close();
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    const snap = new Database(backup, { readonly: true });
    expect((snap.query('SELECT COUNT(*) c FROM t').get() as { c: number }).c).toBe(3);
    snap.close();
    const verification = await verifySqliteBackup(backup, manifest, { sourceDbPath: source });
    expect(verification.ok).toBe(true);
    expect(verification.errors).toEqual([]);
  });

  // ── Issue #17 pass 6f regression tests ──────────────────────────────────

  it('aborts when the published snapshot is swapped for a foreign same-schema/count DB (pass 6f)', async () => {
    // Blocker 1: the published backup's content is bound to the recorded
    // source identity. A foreign same-schema/same-count snapshot swapped in
    // after publication must abort creation with zero artifacts left (and the
    // foreign file preserved).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-foreign-snap-6f-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');

    // A foreign database with the SAME schema and SAME row counts but
    // different row content.
    const foreign = makeSourceDb(dir, 'foreign-source.db');
    {
      const fdb = new Database(foreign);
      fdb.exec("UPDATE onboarding_items SET name = 'FOREIGN-CONTENT' WHERE id = 'i1'");
      fdb.close();
    }
    const foreignBytes = fs.readFileSync(foreign);

    expect(() =>
      createSqliteBackup(source, backup, {
        __afterSnapshot: () => {
          // Swap the published backup for the foreign artifact.
          fs.rmSync(backup);
          fs.copyFileSync(foreign, backup);
        },
      }),
    ).toThrow(/snapshot content does not match/i);
    // The foreign artifact is preserved (we do not delete files we did not
    // create) and no manifest/reservation remains.
    expect(fs.readFileSync(backup)).toEqual(foreignBytes);
    expect(fs.existsSync(`${backup}.manifest.json`)).toBe(false);
    expect(fs.existsSync(`${backup}.manifest.json.reservation`)).toBe(false);
    fs.rmSync(backup);
  });

  it('binds the artifact content identity for self-consistent verification (pass 6f)', async () => {
    // Blocker 1 verification half: the manifest records the snapshot's own
    // content identity, so verification is self-consistent — a foreign
    // artifact at the backup path fails even without the source, and a clean
    // backup verifies.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-self-cons-6f-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifest = createSqliteBackup(source, backup);
    expect(typeof manifest.snapshotContentIdentity).toBe('string');
    expect(manifest.snapshotContentIdentity.length).toBeGreaterThan(0);

    // Without the source: a clean artifact still verifies.
    const noSource = await verifySqliteBackup(backup, manifest);
    expect(noSource.ok).toBe(true);

    // A foreign same-schema/count artifact at the path fails the content
    // identity check even with a valid SHA replacement and no source.
    const foreign = makeSourceDb(dir, 'foreign2.db');
    {
      const fdb = new Database(foreign);
      fdb.exec("UPDATE onboarding_items SET name = 'OTHER-CONTENT' WHERE id = 'i2'");
      fdb.close();
    }
    fs.rmSync(backup);
    fs.copyFileSync(foreign, backup);
    const tamperedSha = await (async () => {
      const hash = crypto.createHash('sha256');
      hash.update(fs.readFileSync(backup));
      return hash.digest('hex');
    })();
    const verification = await verifySqliteBackup(backup, { ...manifest, sha256: tamperedSha });
    expect(verification.ok).toBe(false);
    expect(verification.errors.some(e => /content identity does not match/i.test(e))).toBe(true);
  });

  it('never deletes a foreign file replaced at the backup destination in the link->verify window (pass 6f)', async () => {
    // Blocker 2: ownership inode is captured from the temp BEFORE the hard
    // link, so a foreign file replaced at the destination between the link
    // and the ownership verification is NOT treated as ours and cleanup
    // leaves it byte-identical.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-own-6f-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    expect(() =>
      createSqliteBackup(source, backup, {
        __beforeBackupLinkVerify: () => {
          fs.rmSync(backup);
          fs.writeFileSync(backup, 'FOREIGN REPLACEMENT');
        },
      }),
    ).toThrow(/replaced by another process/i);
    expect(fs.readFileSync(backup, 'utf-8')).toBe('FOREIGN REPLACEMENT');
    expect(fs.existsSync(`${backup}.manifest.json`)).toBe(false);
    expect(fs.existsSync(`${backup}.manifest.json.reservation`)).toBe(false);
    fs.rmSync(backup);
  });

  it('fails when the manifest is replaced after publication and never returns a foreign manifest (pass 6f)', async () => {
    // Blocker 3: the manifest's ownership inode is captured from the temp
    // before the link; a foreign file replaced at the manifest path after the
    // link is detected and creation FAILS with the foreign content untouched
    // (never returned as a successful manifest).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-manifest-own-6f-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifestPath = `${backup}.manifest.json`;
    expect(() =>
      createSqliteBackup(source, backup, {
        __beforeManifestLinkVerify: () => {
          fs.rmSync(manifestPath);
          fs.writeFileSync(manifestPath, 'FOREIGN MANIFEST');
        },
      }),
    ).toThrow(/replaced by another process/i);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe('FOREIGN MANIFEST');
    // The published backup is ours and is removed; the foreign manifest stays.
    expect(fs.existsSync(backup)).toBe(false);
    fs.rmSync(manifestPath);
  });

  it('fails on the success path when a published artifact is replaced before return (pass 6f)', async () => {
    // Blocker 3 success re-check: even after all publication work completes, a
    // foreign file replaced at the manifest path before return must fail
    // creation (never return success with foreign content at the path).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-return-6f-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifestPath = `${backup}.manifest.json`;
    expect(() =>
      createSqliteBackup(source, backup, {
        __beforeReturn: () => {
          fs.rmSync(manifestPath);
          fs.writeFileSync(manifestPath, 'RACE BEFORE RETURN');
        },
      }),
    ).toThrow(/replaced by another process/i);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe('RACE BEFORE RETURN');
    // Our artifacts are removed (the foreign replacement is left untouched).
    expect(fs.existsSync(backup)).toBe(false);
    fs.rmSync(manifestPath);
  });

  // ── Issue #17 pass 6g regression tests ──────────────────────────────────

  it('distinguishes duplicate-pair row content (collision-resistant combiner, pass 6g)', async () => {
    // Blocker 1 (critical): the OLD XOR-only row combiner cancelled duplicate
    // pairs ([A,A] and [B,B] both XOR to 0), so different same-schema/
    // same-count foreign content could share the source identity and be
    // accepted + verified. The new combiner adds modular sums over two
    // Mersenne primes, so two copies of A and two copies of B produce
    // DIFFERENT content identities and the swap aborts.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-dup-6g-'));
    const source = path.join(dir, 'source.db');
    const foreign = path.join(dir, 'foreign.db');
    const makeDup = (p: string, v: string) => {
      const db = new Database(p);
      db.exec('CREATE TABLE t (v TEXT);');
      db.exec(`INSERT INTO t (v) VALUES ('${v}'), ('${v}');`);
      db.close();
    };
    makeDup(source, 'AAAA');
    makeDup(foreign, 'BBBB');

    // Same schema, same row count (2), duplicate pairs — the identities MUST
    // differ (XOR alone would have equated them).
    const srcDb = new Database(source, { readonly: true });
    const forDb = new Database(foreign, { readonly: true });
    const srcIdentity = computeContentIdentityHash(srcDb);
    const forIdentity = computeContentIdentityHash(forDb);
    srcDb.close();
    forDb.close();
    expect(forIdentity).not.toBe(srcIdentity);

    // A swap of the published backup for the foreign artifact after
    // publication must abort; the foreign bytes are preserved.
    const backup = path.join(dir, 'backup.db');
    expect(() =>
      createSqliteBackup(source, backup, {
        __afterSnapshot: () => {
          fs.rmSync(backup);
          fs.copyFileSync(foreign, backup);
        },
      }),
    ).toThrow(/snapshot content does not match/i);
    expect(fs.readFileSync(backup)).toEqual(fs.readFileSync(foreign));
    expect(fs.existsSync(`${backup}.manifest.json`)).toBe(false);
    expect(fs.existsSync(`${backup}.manifest.json.reservation`)).toBe(false);
    fs.rmSync(backup);
  });

  it('restores a foreign file at the backup path during cleanup (quarantine, pass 6g)', async () => {
    // Blocker 2 (high): cleanup must never delete a foreign inode. The backup
    // path is atomically renamed to a private quarantine name, the
    // quarantined inode is checked, and a foreign replacement is renamed BACK
    // byte-identical — never deleted.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-cleanup-6g-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    // __beforeContentCheck fires after the inode ownership re-check but
    // before the content attestation: a new-inode foreign file armed at the
    // BACKUP path makes the backup content-identity check fail, and cleanup
    // must restore the foreign file (our manifest is removed).
    expect(() =>
      createSqliteBackup(source, backup, {
        __beforeContentCheck: () => {
          fs.rmSync(backup);
          fs.writeFileSync(backup, 'FOREIGN AT BACKUP PATH');
        },
      }),
    ).toThrow(/content changed after publication|snapshot content does not match/i);
    // The foreign file survives byte-for-byte; our manifest is removed.
    expect(fs.readFileSync(backup, 'utf-8')).toBe('FOREIGN AT BACKUP PATH');
    expect(fs.existsSync(`${backup}.manifest.json`)).toBe(false);
    fs.rmSync(backup);
  });

  it('detects a same-inode overwrite of the published manifest (content attestation, pass 6g)', async () => {
    // Blocker 3 (high): the final check must attest CONTENT, not just inode.
    // A foreign process writing THROUGH our inode retains dev+ino, so the
    // inode ownership check passes — the content-attested re-read of the
    // manifest bytes must fail and never return a foreign manifest as success.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-sameinode-6g-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifestPath = `${backup}.manifest.json`;
    expect(() =>
      createSqliteBackup(source, backup, {
        __beforeReturn: () => {
          fs.writeFileSync(manifestPath, 'FOREIGN SAME INODE');
        },
      }),
    ).toThrow(/Manifest content changed/i);
    // Our artifacts are removed (the manifest inode is ours even though
    // foreign bytes were written through it; the backup is ours).
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it('detects a replacement of the manifest after the final inode stat (pass 6g)', async () => {
    // Blocker 3 (high): a new-inode replacement performed after the final
    // inode stat (but before that result is consumed) must be caught by the
    // content-attested re-read of the manifest bytes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-poststat-6g-'));
    const source = makeSourceDb(dir);
    const backup = path.join(dir, 'backup.db');
    const manifestPath = `${backup}.manifest.json`;
    expect(() =>
      createSqliteBackup(source, backup, {
        __beforeContentCheck: () => {
          fs.rmSync(manifestPath);
          fs.writeFileSync(manifestPath, 'FOREIGN POST-STAT');
        },
      }),
    ).toThrow(/Manifest content changed/i);
    // The foreign manifest survives (cleanup restores it via quarantine); our
    // backup is removed.
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe('FOREIGN POST-STAT');
    expect(fs.existsSync(backup)).toBe(false);
    fs.rmSync(manifestPath);
  });
});
