/**
 * SQLite backup creation and verification (Issue #17 C1/C2).
 *
 * A backup is a CONSISTENT STANDALONE SNAPSHOT produced by SQLite's
 * `VACUUM INTO` (SQLite >= 3.27; bun bundles a current SQLite). This
 * absorbs all WAL/SHM content into a single standalone database file, so the
 * artifact needs no sidecars and its SHA-256 fully attests its logical
 * contents — a WAL-only change can never be hidden from verification.
 *
 * Verification opens the artifact IMMUTABLY (`file:...?immutable=1`) and
 * REJECTS any sidecar/hot-journal file next to it, so a copied `-wal`/`-shm`
 * can never participate in the logical database that `integrity_check` and
 * count checks inspect (issue #17 pass 6c blocker 1).
 *
 * Creation binds the SOURCE identity to the snapshot: the source content
 * identity is captured BEFORE `VACUUM INTO` and again AFTER; any drift during
 * snapshot creation aborts and removes every artifact this operation created
 * (issue #17 pass 6c blocker 2). Artifact creation is atomic: the manifest
 * path is reserved exclusively (`wx`) before the snapshot and the manifest is
 * emitted by renaming over that reservation, so no other process's file can
 * be overwritten (blocker 5).
 *
 * Row digests use a deterministic typed SQLite-value encoding (BLOBs become
 * `{t:'blob', b: base64}`) and stream one row at a time via `iterate()`, so
 * BLOB tables such as `product_embeddings.embedding_blob` are supported
 * without materializing the whole table (blocker 4).
 *
 * The backup path and manifest are created with mode 0600 and never
 * overwrite any existing artifact (main file, manifest, or sidecar paths).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { Database } from './driver';
import { sha256Hex, canonicalJsonStringify } from '../shared/stable-id';

export const BACKUP_MANIFEST_FORMAT = 'baystate-sqlite-backup';
/**
 * v3: source identity is captured BEFORE the snapshot and bound to it
 * (`sourceIdentityHash` + `sourceIdentityHashAfter`), row digests use the
 * typed BLOB-safe encoding, verification opens immutably and rejects
 * sidecars, and artifact creation is atomic ('wx' manifest reservation).
 */
export const BACKUP_MANIFEST_VERSION = 3;

export interface BackupManifest {
  format: string;
  version: number;
  sourceDbPath: string;
  backupPath: string;
  sha256: string;
  sizeBytes: number;
  /** Schema/user version OF THE BACKUP SNAPSHOT (for its own parity check). */
  schemaVersion: number;
  userVersion: number;
  /**
   * Schema/user version OF THE SOURCE at backup time (for the stale check;
   * kept separate because the snapshot's own versions are its own).
   */
  sourceSchemaVersion: number;
  sourceUserVersion: number;
  /** Critical row counts keyed by table name (fixed allowlist at creation). */
  counts: Record<string, number>;
  /**
   * Content-addressed identity of the SOURCE captured BEFORE the VACUUM
   * snapshot (user/schema version + counts + per-table typed row digests).
   * Verification recomputes it on the current source and rejects a replaced
   * source at the same path, even with identical schema and counts.
   */
  sourceIdentityHash: string;
  /**
   * Source identity captured AFTER the snapshot. Creation aborts when this
   * differs from `sourceIdentityHash` (the snapshot and its recorded source
   * identity must be the SAME database moment).
   */
  sourceIdentityHashAfter: string;
  createdAt: string;
}

export interface BackupVerificationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Tables captured in a backup manifest when they exist. Covers every repair
 * target plus the protected parent/business tables so the live-vs-backup
 * count parity gate can never be bypassed by an uncovered table.
 */
const CRITICAL_COUNT_TABLES = [
  'onboarding_items',
  'onboarding_batches',
  'onboarding_sources',
  'onboarding_extractions',
  'profile_generations',
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
  'product_index',
  'classification_config_snapshots',
  'products',
] as const;

/** Sidecar/hot-journal artifact suffixes that must never accompany a backup. */
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

function tableExists(db: Database, name: string): boolean {
  return !!db.query('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
}

function readCriticalCounts(db: Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of CRITICAL_COUNT_TABLES) {
    if (tableExists(db, table)) {
      counts[table] = (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    }
  }
  return counts;
}

/**
 * Deterministic typed encoding of a SQLite column value for canonical
 * digests. Plain-object/JSON-only canonicalization rejects BLOB values
 * (typed arrays/Buffer), so BLOBs are encoded as `{t:'blob', b: base64}`;
 * strings/numbers/null are tagged so no two types collide.
 */
function encodeSqliteValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    // SQLite can store non-finite REAL values (Infinity/-Infinity/NaN); the
    // canonical serializer rejects non-finite numbers, so encode them as
    // deterministic strings ('Infinity', '-Infinity', 'NaN').
    return { t: 'num', v: Number.isFinite(value) ? value : String(value) };
  }
  if (typeof value === 'bigint') return { t: 'big', v: value.toString() };
  if (typeof value === 'string') return { t: 'str', v: value };
  if (typeof value === 'boolean') return { t: 'bool', v: value };
  if (value instanceof ArrayBuffer) {
    return { t: 'blob', b: Buffer.from(value).toString('base64') };
  }
  if (ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { t: 'blob', b: Buffer.from(bytes).toString('base64') };
  }
  return { t: 'other', v: String(value) };
}

/**
 * Content digest of EVERY table's rows (typed canonical encoding, streamed
 * one row at a time so a large live database is never materialized in
 * memory). Iterating `sqlite_master` means no table can hide a same-count
 * content change from the replaced-source check; internal `sqlite_%` tables
 * are excluded. Deterministic for a fixed schema. Row `rowid` is excluded
 * from each row's content (a VACUUM reassignment is not a content change).
 *
 * Memory is O(1) in row count: each row's SHA-256 digest is XOR-ed into a
 * fixed 32-byte accumulator (an order-independent combiner — the digest does
 * not depend on row order), alongside a row count. No per-row array is
 * retained.
 */
function tableRowDigests(db: Database): Record<string, string> {
  const digests: Record<string, string> = {};
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const stmt = db.query(`SELECT * FROM ${quoted}`);
    const iter = (stmt as unknown as { iterate(): Iterable<Record<string, unknown>> }).iterate();
    // Order-independent O(1)-memory combiner: XOR every per-row SHA-256
    // digest into a fixed vector, plus the row count.
    const acc = Buffer.alloc(32);
    let rowCount = 0;
    for (const row of iter) {
      const encoded: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        encoded[k] = encodeSqliteValue(v);
      }
      const rowHash = Buffer.from(sha256Hex(canonicalJsonStringify(encoded)), 'hex');
      for (let i = 0; i < 32; i++) {
        acc[i] ^= rowHash[i]!;
      }
      rowCount += 1;
    }
    digests[name] = sha256Hex(
      canonicalJsonStringify({ rowCount, xor: Buffer.from(acc).toString('hex') }),
    );
  }
  return digests;
}

/** Content-addressed identity of a database (user/schema version + counts + row digests). */
export function computeSourceIdentityHash(db: Database): string {
  const payload = {
    userVersion: (db.query('PRAGMA user_version').get() as { user_version: number }).user_version,
    schemaVersion: (db.query('PRAGMA schema_version').get() as { schema_version: number }).schema_version,
    counts: readCriticalCounts(db),
    tableDigests: tableRowDigests(db),
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

export function buildBackupManifest(
  sourceDbPath: string,
  backupPath: string,
  snapshotDb: Database,
  sourceDb: Database,
  sourceIdentityHash: string,
  sourceIdentityHashAfter: string,
  sha256: string,
  sizeBytes: number,
): BackupManifest {
  return {
    format: BACKUP_MANIFEST_FORMAT,
    version: BACKUP_MANIFEST_VERSION,
    sourceDbPath: path.resolve(sourceDbPath),
    backupPath: path.resolve(backupPath),
    sha256,
    sizeBytes,
    schemaVersion: (snapshotDb.query('PRAGMA schema_version').get() as { schema_version: number }).schema_version,
    userVersion: (snapshotDb.query('PRAGMA user_version').get() as { user_version: number }).user_version,
    sourceSchemaVersion: (sourceDb.query('PRAGMA schema_version').get() as { schema_version: number }).schema_version,
    sourceUserVersion: (sourceDb.query('PRAGMA user_version').get() as { user_version: number }).user_version,
    counts: readCriticalCounts(snapshotDb),
    sourceIdentityHash,
    sourceIdentityHashAfter,
    createdAt: new Date().toISOString(),
  };
}

function sha256FileSync(dbPath: string): string {
  // Memory-bounded synchronous streaming hash (works for multi-GB backups).
  const fd = fs.openSync(dbPath, 'r');
  const hash = crypto.createHash('sha256');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Create a verified backup of `sourceDbPath` at `backupPath` (mode 0600).
 *
 * Uses SQLite `VACUUM INTO` so the backup is a consistent standalone
 * snapshot of the source (WAL/SHM content absorbed, no sidecar artifacts),
 * then stream-hashes the complete artifact. The source identity AND its
 * `PRAGMA data_version` (a monotonic commit counter) are captured BEFORE and
 * AFTER the snapshot; any drift aborts creation (the artifact and its
 * manifest always describe the SAME source moment).
 *
 * `VACUUM INTO` cannot run inside a SQLite transaction, so a held write
 * lock cannot span the snapshot; instead, the monotonic `data_version`
 * counter bounds the window: ANY commit by ANY connection between the two
 * reads changes the counter, so ABA drift (an intervening write that
 * reverts to the original state) is detected exactly — before/after
 * equality of BOTH the identity and the counter proves no commit occurred
 * during the snapshot window. The C2 maintenance window still requires
 * app/API/worker writers to be stopped.
 *
 * Artifact creation is atomic:
 * - The manifest path is reserved exclusively (`wx`) BEFORE the snapshot and
 *   the open descriptor's dev/ino identity is retained. The final emit only
 *   replaces that owned inode (a sentinel raced in at the path aborts
 *   creation), and failure cleanup only unlinks the path when it still
 *   refers to the owned inode (another process's file is never deleted).
 * - `VACUUM INTO` itself requires the destination to not exist (atomic
 *   exclusive creation); the destination is added to the created-set BEFORE
 *   the call so a real mid-VACUUM I/O failure is cleaned up and a retry is
 *   possible.
 * - On ANY failure, ONLY files created by this operation are removed.
 *
 * Refuses to overwrite ANY existing artifact (main file, manifest, or
 * sidecar paths).
 */
export function createSqliteBackup(
  sourceDbPath: string,
  backupPath: string,
  testHooks?: { __afterSnapshot?: () => void },
): BackupManifest {
  const resolvedBackup = path.resolve(backupPath);
  const manifestPath = `${resolvedBackup}.manifest.json`;
  const artifactPaths = [
    resolvedBackup,
    manifestPath,
    ...SIDECAR_SUFFIXES.map(suffix => `${resolvedBackup}${suffix}`),
  ];
  for (const artifact of artifactPaths) {
    if (fs.existsSync(artifact)) {
      throw new Error(
        `Backup destination already exists and will not be overwritten: ${artifact}`,
      );
    }
  }
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source database does not exist: ${sourceDbPath}`);
  }
  const dir = path.dirname(resolvedBackup);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Files created by THIS operation (removed on any failure). */
  const created: string[] = [];
  let manifestReservationFd: number | null = null;
  let reservationStat: fs.Stats | null = null;

  /**
   * True when `p` still refers to the reservation inode we own AND its
   * content is untouched (size unchanged — we never write to the
   * reservation, so any content change means another process modified it).
   */
  const pathIsReservation = (p: string): boolean => {
    if (!reservationStat) return false;
    try {
      const s = fs.statSync(p);
      return (
        s.dev === reservationStat.dev &&
        s.ino === reservationStat.ino &&
        s.size === reservationStat.size
      );
    } catch {
      return false;
    }
  };

  try {
    // Atomic reservation of the manifest path. This file is exclusively
    // OURS ('wx' fails if anything exists). We retain the open descriptor
    // and its dev/ino/size so the final emit and failure cleanup act only on
    // the inode we own with unchanged content — never truncating or deleting
    // another process's file.
    manifestReservationFd = fs.openSync(manifestPath, 'wx', 0o600);
    reservationStat = fs.fstatSync(manifestReservationFd);

    // Pre-snapshot source identity + commit counter. data_version is
    // monotonic across EVERY committed write by ANY connection.
    const preSourceDb = new Database(sourceDbPath, { readonly: true });
    let sourceIdentityHash: string;
    let preDataVersion: number;
    try {
      sourceIdentityHash = computeSourceIdentityHash(preSourceDb);
      preDataVersion = (preSourceDb.query('PRAGMA data_version').get() as { data_version: number })
        .data_version;
    } finally {
      preSourceDb.close();
    }

    // Consistent standalone snapshot. The destination is tracked BEFORE the
    // call so a real mid-VACUUM failure (disk full, RLIMIT_FSIZE, I/O error)
    // is cleaned up and a retry is possible. `VACUUM INTO` requires the
    // destination to not already exist (atomic exclusive creation).
    created.push(resolvedBackup);
    const sourceWriter = new Database(sourceDbPath);
    try {
      sourceWriter.exec(`VACUUM INTO '${escapeSingleQuotes(resolvedBackup)}'`);
    } finally {
      sourceWriter.close();
    }
    fs.chmodSync(resolvedBackup, 0o600);

    // Post-snapshot source identity + commit counter: the source must be the
    // SAME database moment as the snapshot. Any drift (content OR a commit
    // counter change — which also catches ABA reverts) aborts creation and
    // removes every artifact this operation created.
    const postSourceDb = new Database(sourceDbPath, { readonly: true });
    let sourceIdentityHashAfter: string;
    let postDataVersion: number;
    try {
      sourceIdentityHashAfter = computeSourceIdentityHash(postSourceDb);
      postDataVersion = (postSourceDb.query('PRAGMA data_version').get() as { data_version: number })
        .data_version;
    } finally {
      postSourceDb.close();
    }
    if (sourceIdentityHashAfter !== sourceIdentityHash || postDataVersion !== preDataVersion) {
      throw new Error(
        'Source database changed during backup creation (source identity or commit-counter drift); ' +
          'aborting. Retry in a quiescent maintenance window.',
      );
    }

    // TEST-ONLY injection point (never supplied by production callers): lets
    // a regression test deterministically race the manifest reservation (write
    // into it or replace it) after the snapshot and before the inode check.
    testHooks?.__afterSnapshot?.();

    const sizeBytes = fs.statSync(resolvedBackup).size;
    const sha256 = sha256FileSync(resolvedBackup);

    const snapshotDb = new Database(resolvedBackup, { readonly: true });
    const sourceDb = new Database(sourceDbPath, { readonly: true });
    let manifest: BackupManifest;
    try {
      manifest = buildBackupManifest(
        sourceDbPath,
        resolvedBackup,
        snapshotDb,
        sourceDb,
        sourceIdentityHash,
        sourceIdentityHashAfter,
        sha256,
        sizeBytes,
      );
    } finally {
      snapshotDb.close();
      sourceDb.close();
    }

    // Emit the manifest by writing a private temp file and ATOMICALLY
    // renaming it over OUR OWN reservation. Before the rename, confirm the
    // manifest path still refers to the reserved inode: a file raced into
    // the path aborts creation instead of being overwritten.
    const tmpManifest = `${manifestPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const tmpFd = fs.openSync(tmpManifest, 'wx', 0o600);
    created.push(tmpManifest);
    try {
      fs.writeFileSync(tmpFd, JSON.stringify(manifest, null, 2));
    } finally {
      fs.closeSync(tmpFd);
    }
    if (!pathIsReservation(manifestPath)) {
      throw new Error(
        'Manifest reservation was replaced by another process; aborting backup.',
      );
    }
    fs.renameSync(tmpManifest, manifestPath);
    // Close the (now stale, unlinked) reservation descriptor and stop
    // tracking both emitted paths: they are ours and must survive cleanup.
    if (manifestReservationFd !== null) {
      try {
        fs.closeSync(manifestReservationFd);
      } catch {
        // already closed
      }
      manifestReservationFd = null;
      reservationStat = null;
    }
    created.splice(created.indexOf(tmpManifest), 1);
    fs.chmodSync(manifestPath, 0o600);

    return manifest;
  } catch (err) {
    // Remove ONLY files this operation created. The manifest reservation is
    // exclusively ours: unlink its path only when it still refers to the
    // inode we own (never delete another process's replacement), and always
    // close the descriptor (no fd leak on the failure path).
    if (manifestReservationFd !== null) {
      if (pathIsReservation(manifestPath)) {
        try {
          fs.rmSync(manifestPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }
      try {
        fs.closeSync(manifestReservationFd);
      } catch {
        // already closed
      }
    }
    for (const artifact of created) {
      try {
        fs.rmSync(artifact, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
    throw err;
  }
}

export function readBackupManifest(manifestPath: string): BackupManifest {
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  const parsed = JSON.parse(raw) as BackupManifest;
  if (parsed.format !== BACKUP_MANIFEST_FORMAT || parsed.version !== BACKUP_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported backup manifest format/version: ${parsed.format}/${parsed.version} ` +
        `(expected ${BACKUP_MANIFEST_FORMAT}/${BACKUP_MANIFEST_VERSION}).`,
    );
  }
  return parsed;
}

function sha256File(dbPath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(dbPath);
  return new Promise<string>((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * SQLite immutable URI for the attested artifact: `file:<path>?immutable=1`
 * tells SQLite the file is read-only and never-changing, so no sidecar can
 * participate in the logical database (a copied `-wal`/`-shm` beside the
 * artifact is ignored — the main file IS the database). Percent-encodes the
 * characters that would otherwise be parsed as URI syntax.
 */
function toImmutableUri(dbPath: string): string {
  const escaped = dbPath
    .replace(/%/g, '%25')
    .replace(/\?/g, '%3F')
    .replace(/#/g, '%23');
  return `file:${escaped}?immutable=1`;
}

/**
 * Verify a backup against its manifest. When `options.sourceDbPath` is
 * provided, the backup is additionally checked for staleness, wrong source,
 * and source-content replacement (a changed/replaced database at the same
 * path, even with identical schema and counts, is rejected). A missing
 * explicitly-supplied source is also rejected (fail closed).
 *
 * Verification REJECTS any sidecar/hot-journal file (`-wal`, `-shm`,
 * `-journal`) next to the artifact and opens the artifact IMMUTABLY, so the
 * SHA-256 always attests the exact logical database that `integrity_check`
 * and the count checks inspect.
 */
export async function verifySqliteBackup(
  dbPath: string,
  manifest: BackupManifest,
  options: { sourceDbPath?: string } = {},
): Promise<BackupVerificationResult> {
  const errors: string[] = [];
  const resolvedDb = path.resolve(dbPath);

  if (manifest.format !== BACKUP_MANIFEST_FORMAT || manifest.version !== BACKUP_MANIFEST_VERSION) {
    errors.push(
      `Unsupported manifest format/version: ${manifest.format}/${manifest.version}`,
    );
  }
  // Recorded source-identity invariant: the post-snapshot identity must
  // equal the pre-snapshot identity (both describe the same source moment).
  // Tampering either field independently is rejected.
  if (
    typeof manifest.sourceIdentityHashAfter === 'string' &&
    manifest.sourceIdentityHashAfter !== manifest.sourceIdentityHash
  ) {
    errors.push(
      `Manifest source identity invariant violated: sourceIdentityHashAfter differs from sourceIdentityHash.`,
    );
  }
  if (!fs.existsSync(resolvedDb)) {
    errors.push(`Backup file missing: ${resolvedDb}`);
    return { ok: false, errors };
  }
  // A sidecar next to the attested artifact would let WAL/SHM content
  // participate in the logical database without changing the main SHA.
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = `${resolvedDb}${suffix}`;
    if (fs.existsSync(sidecar)) {
      errors.push(
        `Backup has an unexpected sidecar/hot-journal file (${sidecar}); ` +
          `the artifact must be a standalone snapshot with no sidecars.`,
      );
    }
  }
  const stat = fs.statSync(resolvedDb);
  if (stat.size !== manifest.sizeBytes) {
    errors.push(`Backup size mismatch: expected ${manifest.sizeBytes}, found ${stat.size}`);
  }
  const actualSha = await sha256File(resolvedDb);
  if (actualSha !== manifest.sha256) {
    errors.push(`Backup SHA-256 mismatch (corrupt or stale content).`);
  }
  if (manifest.backupPath !== resolvedDb) {
    errors.push(`Manifest backupPath ${manifest.backupPath} does not match ${resolvedDb}`);
  }

  let db: Database | null = null;
  try {
    // IMMUTABLE open: reads only the main file; a sidecar can never
    // participate even if one races in between the check and the open.
    db = new Database(toImmutableUri(resolvedDb), { readonly: true });
    const integrity = (db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (integrity !== 'ok') {
      errors.push(`Backup integrity_check failed: ${integrity}`);
    }
    const userVersion = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (userVersion !== manifest.userVersion) {
      errors.push(`Backup user_version mismatch: expected ${manifest.userVersion}, found ${userVersion}`);
    }
    // The backup's ACTUAL schema version must match the manifest (the
    // manifest field is not trusted by itself).
    const schemaVersion = (db.query('PRAGMA schema_version').get() as { schema_version: number }).schema_version;
    if (schemaVersion !== manifest.schemaVersion) {
      errors.push(
        `Backup schema_version mismatch: expected ${manifest.schemaVersion}, found ${schemaVersion}`,
      );
    }
    for (const [table, expected] of Object.entries(manifest.counts)) {
      const exists = !!db.query('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
      const actual = exists
        ? (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
        : 0;
      if (actual !== expected) {
        errors.push(`Backup count mismatch for ${table}: expected ${expected}, found ${actual}`);
      }
    }
  } catch (err) {
    errors.push(`Backup could not be opened/verified: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db?.close();
  }

  if (options.sourceDbPath !== undefined) {
    const resolvedSource = path.resolve(options.sourceDbPath);
    if (!fs.existsSync(resolvedSource)) {
      errors.push(`Source database missing: ${resolvedSource}`);
    } else {
      if (resolvedSource !== path.resolve(manifest.sourceDbPath)) {
        errors.push(
          `Wrong source: manifest source ${manifest.sourceDbPath} does not match ${resolvedSource}`,
        );
      }
      let sourceDb: Database | null = null;
      try {
        sourceDb = new Database(resolvedSource, { readonly: true });
        const sourceUserVersion = (sourceDb.query('PRAGMA user_version').get() as { user_version: number })
          .user_version;
        const sourceSchemaVersion = (sourceDb.query('PRAGMA schema_version').get() as {
          schema_version: number;
        }).schema_version;
        if (sourceUserVersion > manifest.sourceUserVersion) {
          errors.push(
            `Stale backup: source user_version ${sourceUserVersion} is newer than backup ${manifest.sourceUserVersion}`,
          );
        }
        if (sourceSchemaVersion > manifest.sourceSchemaVersion) {
          errors.push(
            `Stale backup: source schema_version ${sourceSchemaVersion} is newer than backup ${manifest.sourceSchemaVersion}`,
          );
        }
        // Replaced-source detection: the current source content identity must
        // match the identity recorded at backup time. A same-path database
        // replaced with different content (even with identical schema and
        // counts) is rejected.
        const currentIdentity = computeSourceIdentityHash(sourceDb);
        if (currentIdentity !== manifest.sourceIdentityHash) {
          errors.push(
            `Source database content has changed since the backup was taken (identity hash mismatch). ` +
              `The backup is not the current source's snapshot.`,
          );
        }
      } catch {
        errors.push(
          `Source database could not be opened for stale/source verification: ${options.sourceDbPath}`,
        );
      } finally {
        sourceDb?.close();
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
