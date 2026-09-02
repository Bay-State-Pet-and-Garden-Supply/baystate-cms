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
 * identity AND its monotonic `PRAGMA data_version` commit counter are read
 * BEFORE and AFTER `VACUUM INTO` from the SAME held connection (issue #17
 * pass 6e blocker 1) — any intervening commit by ANY connection (including
 * an ABA schedule that reverts content) advances the counter, so the
 * recorded source identity always describes the same database moment as the
 * snapshot. Any drift aborts creation and removes every artifact this
 * operation created (blocker 2).
 *
 * Artifact creation is atomic NO-CLOBBER (pass 6e blockers 3 + 4):
 * - The backup is produced by `VACUUM INTO` to a UNIQUE private temp name
 *   and published to the final destination with `fs.link` (a hard link that
 *   FAILS with EEXIST if any file — including a raced foreign file —
 *   occupies the destination), then the temp is unlinked. A foreign file at
 *   the destination is never created-over.
 * - The manifest is written to a unique private temp file (fsync) and
 *   published with the same no-clobber `fs.link`, then the temp is
 *   unlinked. A sentinel raced in at the manifest path aborts creation
 *   without ever being overwritten.
 * - A dedicated reservation file (`<manifest>.reservation`) is created
 *   exclusively (`wx`) up front as the operation claim; it is removed
 *   (inode-checked) on both success and failure.
 * - Failure cleanup removes ONLY files this operation created: unique temp
 *   names (ours by construction) plus published files whose current path
 *   inode matches the inode this operation created. Another process's file
 *   is never deleted.
 *
 * Row digests use a deterministic typed SQLite-value encoding (BLOBs become
 * `{t:'blob', b: base64}`) and stream one row at a time via `iterate()`, so
 * BLOB tables such as `product_embeddings.embedding_blob` are supported
 * without materializing the whole table (blocker 4). The per-table row
 * combiner is collision-resistant (XOR + modular sums over two Mersenne
 * primes, see `tableRowDigests`) so duplicate-pair content can never share
 * an identity (pass 6g blocker 1).
 *
 * The backup path and manifest are created with mode 0600 and never
 * overwrite any existing artifact (main file, manifest, reservation, or
 * sidecar paths).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { Database } from './driver';
import { sha256Hex, canonicalJsonStringify } from '../shared/stable-id';

const BACKUP_MANIFEST_FORMAT = 'baystate-sqlite-backup';
/**
 * v4: the published snapshot's OWN content identity (`snapshotContentIdentity`)
 * is bound to the recorded source identity and recorded in the manifest, so
 * verification is self-consistent (artifact content must match the manifest
 * even without the source), and artifact ownership inodes are captured from
 * the private temps BEFORE publication (a foreign file replaced in the
 * link->stat window is never treated as owned).
 */
const BACKUP_MANIFEST_VERSION = 4;

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
  /**
   * Content identity (counts + typed row digests, EXCLUDING the version
   * numbers, because VACUUM INTO rewrites the snapshot's own schema_version)
   * of the PUBLISHED backup artifact, recorded at creation. Verification
   * recomputes it on the artifact (immutably) and requires it to match — the
   * backup is self-consistent even without the source. This is the binding
   * that rejects a foreign snapshot swapped in during creation.
   */
  snapshotContentIdentity: string;
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

const MERSENNE_61 = (1n << 61n) - 1n; // 2^61 - 1 (prime)
const MERSENNE_31 = (1n << 31n) - 1n; // 2^31 - 1 (prime)

/**
 * Content digest of EVERY table's rows (typed canonical encoding, streamed
 * one row at a time so a large live database is never materialized in
 * memory). Iterating `sqlite_master` means no table can hide a same-count
 * content change from the replaced-source check; internal `sqlite_%` tables
 * are excluded. Deterministic for a fixed schema. Row `rowid` is excluded
 * from each row's content (a VACUUM reassignment is not a content change).
 *
 * Memory is O(1) in row count: each row's SHA-256 digest is combined into a
 * fixed accumulator set (no per-row array is retained). The combiner is
 * ORDER-INDEPENDENT and COLLISION-RESISTANT (pass 6g blocker 1):
 *
 * - XOR of every per-row SHA-256 digest into a fixed 32-byte vector
 *   (order-independent, but ALONE cancellable by duplicate pairs:
 *   h XOR h = 0, so [A,A] and [B,B] would collide);
 * - modular sums of the digest (interpreted as a 256-bit big-endian
 *   integer) over the Mersenne primes 2^61-1 and 2^31-1. Modular addition
 *   is commutative (order-independent) and a duplicate pair doubles the
 *   residue, so two copies of A and two copies of B differ unless
 *   A ≡ B mod BOTH primes;
 * - a per-table salt derived from the table name.
 *
 * Collision bound: two different row multisets collide only if their digest
 * residues agree modulo BOTH primes (the XOR is then a weaker fifth
 * condition), i.e. probability ~1/((2^61-1)(2^31-1)) ≈ 2^-92 per candidate
 * pair. Different insertion orders never collide (XOR and modular addition
 * are commutative).
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
    // Order-independent, collision-resistant, O(1)-memory combiner: XOR every
    // per-row SHA-256 digest into a fixed vector, plus modular sums over two
    // Mersenne primes, plus the row count and a per-table salt.
    const salt = sha256Hex(`backup-table-salt:${name}`);
    const acc = Buffer.alloc(32);
    let sum61 = 0n;
    let sum31 = 0n;
    let rowCount = 0;
    for (const row of iter) {
      const encoded: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        encoded[k] = encodeSqliteValue(v);
      }
      const rowHash = Buffer.from(sha256Hex(canonicalJsonStringify(encoded)), 'hex');
      for (let i = 0; i < 32; i++) {
        acc[i]! ^= rowHash[i]!;
      }
      const h = BigInt(`0x${rowHash.toString('hex')}`);
      sum61 = (sum61 + h) % MERSENNE_61;
      sum31 = (sum31 + h) % MERSENNE_31;
      rowCount += 1;
    }
    digests[name] = sha256Hex(
      canonicalJsonStringify({
        salt,
        rowCount,
        xor: acc.toString('hex'),
        sum61: sum61.toString(16),
        sum31: sum31.toString(16),
      }),
    );
  }
  return digests;
}

/**
 * Content identity of a database EXCLUDING the user/schema version numbers:
 * critical counts + per-table typed row digests. Used to bind the VACUUM INTO
 * snapshot to the source (the snapshot's own schema_version is rewritten by
 * VACUUM, so only counts + row digests are comparable) and to give the
 * published artifact a self-consistent identity in the manifest.
 */
export function computeContentIdentityHash(db: Database): string {
  const payload = {
    counts: readCriticalCounts(db),
    tableDigests: tableRowDigests(db),
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

function computeSourceIdentityHash(db: Database): string {
  const payload = {
    userVersion: (db.query('PRAGMA user_version').get() as { user_version: number }).user_version,
    schemaVersion: (db.query('PRAGMA schema_version').get() as { schema_version: number }).schema_version,
    counts: readCriticalCounts(db),
    tableDigests: tableRowDigests(db),
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

function buildBackupManifest(
  sourceDbPath: string,
  backupPath: string,
  snapshotDb: Database,
  sourceDb: Database,
  sourceIdentityHash: string,
  sourceIdentityHashAfter: string,
  snapshotContentIdentity: string,
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
    snapshotContentIdentity,
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

/**
 * Atomically remove `p` ONLY if it still refers to the owned inode, and
 * NEVER delete a foreign file (issue #17 pass 6g blocker 2).
 *
 * Plain stat-then-rm has a TOCTOU: a foreign file replaced between the stat
 * and the unlink is deleted. Instead, atomically RENAME the path to a unique
 * private quarantine name (rename moves whatever currently occupies the
 * path in one atomic syscall), then fstat the quarantined file: if its inode
 * matches the owned inode, unlink the quarantine (we removed OUR file); if
 * it does NOT (the rename moved a foreign file), rename it BACK to the
 * original path (best-effort restore) and leave it. A foreign inode is never
 * deleted.
 */
function quarantineRemove(p: string, ownedDev: number, ownedIno: number): void {
  const quarantine = `${p}.quarantine-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(p, quarantine);
  } catch {
    // Already gone or not movable — leave it.
    return;
  }
  let qStat: fs.Stats | null;
  try {
    qStat = fs.statSync(quarantine);
  } catch {
    // Gone between rename and stat — nothing to remove.
    return;
  }
  if (qStat.dev === ownedDev && qStat.ino === ownedIno) {
    try {
      fs.rmSync(quarantine, { force: true });
    } catch {
      // best-effort
    }
    return;
  }
  // We moved a foreign file: restore it (best-effort) and never delete it.
  try {
    fs.renameSync(quarantine, p);
  } catch {
    // Cannot restore — leave it at the quarantine name (still not deleted).
  }
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
 * `PRAGMA data_version` (a monotonic commit counter) are read BEFORE and
 * AFTER the snapshot FROM THE SAME HELD CONNECTION (pass 6e blocker 1):
 * `data_version` is connection-observed and advances on every committed
 * write by ANY connection, so ANY intervening commit — including an ABA
 * schedule that reverts content to the original state — is detected exactly.
 * Before/after equality of BOTH the identity and the counter proves no
 * commit occurred during the snapshot window, so the artifact and its
 * recorded source identity always describe the SAME source moment. The C2
 * maintenance window still requires app/API/worker writers to be stopped.
 *
 * Artifact creation is atomic NO-CLOBBER (pass 6e blockers 3 + 4):
 * - `VACUUM INTO` writes to a UNIQUE private temp name; the final
 *   destination is published with `fs.link` (a hard link that FAILS with
 *   EEXIST if any file occupies the destination — a raced foreign file is
 *   never created-over) and the temp is then unlinked.
 * - The manifest is written to a unique private temp file and published
 *   with the same no-clobber `fs.link`; a sentinel raced in at the manifest
 *   path aborts creation without being overwritten.
 * - A dedicated reservation file is created exclusively (`wx`) up front as
 *   the operation claim and removed (inode-checked) on success and failure.
 * - On ANY failure, ONLY files created by this operation are removed:
 *   unique temp names (ours by construction) and published files whose
 *   current path inode matches the inode this operation created. Another
 *   process's file is never deleted.
 *
 * Refuses to overwrite ANY existing artifact (main file, manifest,
 * reservation, or sidecar paths).
 */
export function createSqliteBackup(
  sourceDbPath: string,
  backupPath: string,
  testHooks?: {
    __afterSnapshot?: () => void;
    __beforeSnapshot?: () => void;
    __beforePostCheck?: () => void;
    /** Fires after linkSync(vacuumTmp, backup) but BEFORE the destination inode verification. */
    __beforeBackupLinkVerify?: () => void;
    /** Fires after linkSync(tmpManifest, manifestPath) but BEFORE the destination inode verification. */
    __beforeManifestLinkVerify?: () => void;
    /** Fires just before the final published-artifact ownership re-check on success. */
    __beforeReturn?: () => void;
    /** Fires after the final inode re-check but BEFORE the content-attested verification. */
    __beforeContentCheck?: () => void;
  },
): BackupManifest {
  const resolvedBackup = path.resolve(backupPath);
  const manifestPath = `${resolvedBackup}.manifest.json`;
  const reservationPath = `${manifestPath}.reservation`;
  const artifactPaths = [
    resolvedBackup,
    manifestPath,
    reservationPath,
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

  /** Unique private temp files created by THIS operation (removed by path). */
  const tempPaths: string[] = [];
  /** Files published via no-clobber link (removed only if inode still ours). */
  const published: Array<{ path: string; dev: number; ino: number }> = [];
  let reservationFd: number | null = null;
  let reservationStat: fs.Stats | null = null;

  /** True when `p` still refers to the recorded inode. */
  const isOwnedInode = (p: string, dev: number, ino: number): boolean => {
    try {
      const s = fs.statSync(p);
      return s.dev === dev && s.ino === ino;
    } catch {
      return false;
    }
  };

  try {
    // Upfront operation claim: a dedicated reservation marker created
    // exclusively ('wx' fails if anything — including a raced foreign file
    // or a leftover from a crashed run — occupies the path).
    reservationFd = fs.openSync(reservationPath, 'wx', 0o600);
    reservationStat = fs.fstatSync(reservationFd);

    // ONE held source connection for the whole operation: the monotonic
    // data_version counter and the content identity read BEFORE and AFTER
    // the VACUUM snapshot. A connection-local counter read from a fresh
    // connection would not see intervening commits; the held connection
    // observes every commit (ABA included) so pre/post equality is exact.
    const vacuumTmp = `${resolvedBackup}.vacuum-tmp-${process.pid}-${crypto.randomUUID()}`;
    tempPaths.push(vacuumTmp); // tracked BEFORE VACUUM (mid-failure cleanup)
    const sourceDb = new Database(sourceDbPath);
    let sourceIdentityHash: string;
    let sourceIdentityHashAfter: string;
    let sourceContentIdentity: string;
    let preDataVersion: number;
    let postDataVersion: number;
    try {
      preDataVersion = (sourceDb.query('PRAGMA data_version').get() as { data_version: number })
        .data_version;
      sourceIdentityHash = computeSourceIdentityHash(sourceDb);
      sourceContentIdentity = computeContentIdentityHash(sourceDb);

      // TEST-ONLY injection (never supplied by production callers): commits
      // an intervening write BEFORE the snapshot to deterministically prove
      // the held-connection counter catches it (ABA schedule).
      testHooks?.__beforeSnapshot?.();

      // Consistent standalone snapshot into the unique private temp. The
      // temp is tracked before the call so a real mid-VACUUM failure (disk
      // full, RLIMIT_FSIZE, I/O error) is cleaned up and a retry is possible.
      sourceDb.exec(`VACUUM INTO '${escapeSingleQuotes(vacuumTmp)}'`);
      fs.chmodSync(vacuumTmp, 0o600);

      // TEST-ONLY injection: a second intervening write (e.g. the ABA revert)
      // before the post reads.
      testHooks?.__beforePostCheck?.();

      postDataVersion = (sourceDb.query('PRAGMA data_version').get() as { data_version: number })
        .data_version;
      sourceIdentityHashAfter = computeSourceIdentityHash(sourceDb);
    } finally {
      sourceDb.close();
    }
    if (sourceIdentityHashAfter !== sourceIdentityHash || postDataVersion !== preDataVersion) {
      throw new Error(
        'Source database changed during backup creation (source identity or commit-counter drift); ' +
          'aborting. Retry in a quiescent maintenance window.',
      );
    }

    // Publish the backup atomically (no-clobber): link fails with EEXIST if
    // any file — including a foreign file raced in at the destination —
    // occupies the final path, so a foreign file is never created-over.
    //
    // Ownership is captured from the PRIVATE TEMP (which this operation
    // created by construction) BEFORE the hard link, and the destination is
    // verified to still resolve to that exact inode AFTER the link: a foreign
    // file replaced into the path in the link->verify window is detected and
    // never recorded as owned (cleanup therefore never deletes it). The temp
    // descriptor is closed on EVERY exit path (including a linkSync EEXIST
    // failure — pass 6f blocker 4 fd leak).
    const vacTmpFd = fs.openSync(vacuumTmp, 'r');
    let vacTmpStat: fs.Stats | null = null;
    try {
      vacTmpStat = fs.fstatSync(vacTmpFd);
      try {
        fs.linkSync(vacuumTmp, resolvedBackup);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(
            'Backup destination was created by another process; aborting backup.',
            { cause: err },
          );
        }
        throw err;
      }
      // TEST-ONLY injection: a foreign file replaced at the destination after
      // the link but before the ownership capture.
      testHooks?.__beforeBackupLinkVerify?.();
      const destStat = fs.statSync(resolvedBackup);
      if (!vacTmpStat || destStat.dev !== vacTmpStat.dev || destStat.ino !== vacTmpStat.ino) {
        throw new Error(
          'Backup destination was replaced by another process after publication; aborting.',
        );
      }
      published.push({ path: resolvedBackup, dev: vacTmpStat.dev, ino: vacTmpStat.ino });
    } finally {
      fs.closeSync(vacTmpFd);
    }
    // The vacuum temp is deliberately NOT unlinked here: its inode must stay
    // allocated for the whole operation so the quarantine/ownership inode
    // checks below are reliable. On Linux tmpfs, an unlinked inode number is
    // reused immediately by the next created file, so a foreign file swapped
    // into the backup path would land on the recorded inode and be mistaken
    // for ours (deleted) or hide a replacement. The temp is unlinked on the
    // success path (or by the failure-path temp cleanup).

    // TEST-ONLY injection point (never supplied by production callers): lets
    // a regression test deterministically race the manifest destination (a
    // sentinel written/replaced there) after the backup is published and
    // before the manifest's no-clobber link.
    testHooks?.__afterSnapshot?.();

    const sizeBytes = fs.statSync(resolvedBackup).size;
    const sha256 = sha256FileSync(resolvedBackup);

    const snapshotDb = new Database(resolvedBackup, { readonly: true });
    const manifestSourceDb = new Database(sourceDbPath, { readonly: true });
    let manifest: BackupManifest;
    try {
      // Bind the PUBLISHED snapshot's content to the recorded source content:
      // the pre/post checks above proved no source commit occurred during the
      // VACUUM window, so the artifact's content identity MUST equal the
      // source's content identity. A foreign same-schema/same-count snapshot
      // swapped in after publication hashes differently and aborts creation
      // with every artifact this operation created removed.
      const snapshotContentIdentity = computeContentIdentityHash(snapshotDb);
      if (snapshotContentIdentity !== sourceContentIdentity) {
        throw new Error(
          'Backup snapshot content does not match the recorded source content; aborting.',
        );
      }
      manifest = buildBackupManifest(
        sourceDbPath,
        resolvedBackup,
        snapshotDb,
        manifestSourceDb,
        sourceIdentityHash,
        sourceIdentityHashAfter,
        snapshotContentIdentity,
        sha256,
        sizeBytes,
      );
    } finally {
      snapshotDb.close();
      manifestSourceDb.close();
    }

    // Emit the manifest by writing a unique private temp file and publishing
    // it with the same atomic no-clobber link. A file raced in at the
    // manifest path (write into a stale file or a brand-new sentinel inode)
    // makes the link fail with EEXIST and aborts creation — the sentinel is
    // never overwritten. The exact bytes are captured once (they are also the
    // expected content for the pass-6g content-attested final check).
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
    const tmpManifest = `${manifestPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    tempPaths.push(tmpManifest);
    const tmpFd = fs.openSync(tmpManifest, 'wx', 0o600);
    let tmpStat: fs.Stats | null = null;
    try {
      fs.writeFileSync(tmpFd, manifestBytes);
      fs.fsyncSync(tmpFd);
      // Ownership captured from the fd we hold BEFORE publication: the temp
      // is this operation's file by construction, so the hard-linked
      // destination must resolve to this exact inode afterwards.
      tmpStat = fs.fstatSync(tmpFd);
      try {
        fs.linkSync(tmpManifest, manifestPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(
            'Manifest destination was created by another process; aborting backup.',
            { cause: err },
          );
        }
        throw err;
      }
      // TEST-ONLY injection: a foreign file replaced at the manifest path
      // after the link but before the ownership capture.
      testHooks?.__beforeManifestLinkVerify?.();
      const mDestStat = fs.statSync(manifestPath);
      if (!tmpStat || mDestStat.dev !== tmpStat.dev || mDestStat.ino !== tmpStat.ino) {
        throw new Error(
          'Manifest destination was replaced by another process after publication; aborting.',
        );
      }
      published.push({ path: manifestPath, dev: tmpStat.dev, ino: tmpStat.ino });
    } finally {
      fs.closeSync(tmpFd);
    }
    fs.chmodSync(manifestPath, 0o600);
    // Same inode-allocated-until-success discipline as the vacuum temp: the
    // manifest temp is unlinked only on success (or by failure-path cleanup).

    // TEST-ONLY injection: a foreign replacement at either published path
    // before the final ownership/content re-check.
    testHooks?.__beforeReturn?.();
    // Final ownership re-check on the success path: both published artifacts
    // must STILL resolve to the inodes this operation created. A foreign file
    // replaced in at the path means the operation did not succeed — fail
    // closed and never return a foreign manifest as our result (the catch
    // cleanup leaves foreign files untouched).
    for (const artifact of published) {
      if (!isOwnedInode(artifact.path, artifact.dev, artifact.ino)) {
        throw new Error(
          `Published artifact ${artifact.path} was replaced by another process; aborting.`,
        );
      }
    }
    // Content-attested final verification (pass 6g blocker 3): the inode
    // checks above prove PATH ownership, but a foreign process could overwrite
    // content THROUGH our inode (same-inode write), or replace the path after
    // the final stat. Immediately before returning, re-read BOTH published
    // artifacts and require their CONTENT to match what this operation wrote:
    // - the on-disk manifest bytes must equal the exact bytes we published;
    // - the backup artifact's content identity (immutable open) must equal the
    //   recorded snapshot content identity.
    // Any mismatch fails creation (cleanup below removes only OUR artifacts
    // via quarantine — foreign content/inodes are never deleted).
    testHooks?.__beforeContentCheck?.();
    const onDiskManifest = fs.readFileSync(manifestPath);
    if (
      onDiskManifest.length !== manifestBytes.length ||
      !onDiskManifest.equals(manifestBytes)
    ) {
      throw new Error('Manifest content changed after publication; aborting.');
    }
    {
      let finalDb: Database | null = null;
      try {
        finalDb = new Database(resolvedBackup, { readonly: true });
        const finalContent = computeContentIdentityHash(finalDb);
        if (finalContent !== manifest.snapshotContentIdentity) {
          throw new Error('Backup content changed after publication; aborting.');
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Backup content changed')) {
          throw err;
        }
        // A foreign replacement may not even be a SQLite database; fail closed
        // with a descriptive error either way.
        throw new Error(
          'Backup content changed after publication (published artifact could not be verified); aborting.',
          { cause: err },
        );
      } finally {
        finalDb?.close();
      }
    }

    // Success: the owned temp inodes are no longer needed (the published
    // paths still reference them). Unlink here — never before the final
    // checks — so a foreign file created during the operation can never
    // reuse the recorded inode numbers (Linux tmpfs reuses freed inodes
    // immediately, which would make the quarantine checks delete a foreign
    // file or miss a replacement).
    fs.unlinkSync(vacuumTmp);
    tempPaths.splice(tempPaths.indexOf(vacuumTmp), 1);
    fs.unlinkSync(tmpManifest);
    tempPaths.splice(tempPaths.indexOf(tmpManifest), 1);

    // Success: remove our reservation marker via quarantine (never another
    // process's file) and close the descriptor.
    if (reservationStat) {
      quarantineRemove(reservationPath, reservationStat.dev, reservationStat.ino);
    }
    if (reservationFd !== null) {
      try {
        fs.closeSync(reservationFd);
      } catch {
        // already closed
      }
    }
    reservationFd = null;
    reservationStat = null;

    return manifest;
  } catch (err) {
    // Remove ONLY files this operation created (pass 6g blocker 2: never
    // delete a foreign inode — every pathname removal goes through the
    // atomic quarantine rename + inode check + conditional unlink, so a
    // foreign replacement raced into the path is restored, not deleted):
    // - the reservation marker, when it refers to the inode we created;
    // - published files whose (quarantined) inode is the one this operation
    //   created;
    // - unique temp names, which are ours by construction (unlink by name).
    if (reservationFd !== null) {
      if (reservationStat) {
        quarantineRemove(reservationPath, reservationStat.dev, reservationStat.ino);
      }
      try {
        fs.closeSync(reservationFd);
      } catch {
        // already closed
      }
    }
    for (const artifact of published) {
      quarantineRemove(artifact.path, artifact.dev, artifact.ino);
    }
    for (const temp of tempPaths) {
      try {
        fs.rmSync(temp, { force: true });
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
  // Recorded source-identity invariant: both identity fields are REQUIRED
  // non-empty strings (a manifest with either field missing/undefined is
  // rejected immediately — never fail-open), and the post-snapshot identity
  // must equal the pre-snapshot identity (both describe the same source
  // moment). Tampering either field independently is rejected.
  const hasRequiredIdentityFields =
    typeof manifest.sourceIdentityHash === 'string' &&
    manifest.sourceIdentityHash.length > 0 &&
    typeof manifest.sourceIdentityHashAfter === 'string' &&
    manifest.sourceIdentityHashAfter.length > 0 &&
    typeof manifest.snapshotContentIdentity === 'string' &&
    manifest.snapshotContentIdentity.length > 0;
  if (!hasRequiredIdentityFields) {
    errors.push(
      `Manifest missing required source identity fields (sourceIdentityHash / sourceIdentityHashAfter / snapshotContentIdentity).`,
    );
  } else if (manifest.sourceIdentityHashAfter !== manifest.sourceIdentityHash) {
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
    // Readonly open of the main file. Sidecars are rejected above; the
    // artifact must be a standalone snapshot (no -wal/-shm can participate).
    db = new Database(resolvedDb, { readonly: true });
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
    // Self-consistent artifact identity: the artifact's OWN content identity
    // (counts + typed row digests, versions excluded — the VACUUM snapshot's
    // schema_version is its own) must match the manifest's recorded snapshot
    // content identity. A foreign snapshot with identical schema/counts but
    // different content cannot pass even WITHOUT the source present.
    if (hasRequiredIdentityFields) {
      const artifactContentIdentity = computeContentIdentityHash(db);
      if (artifactContentIdentity !== manifest.snapshotContentIdentity) {
        errors.push(
          `Backup content identity does not match the manifest snapshot content identity.`,
        );
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
