/**
 * SQLite backup creation and verification (Issue #17 C1/C2).
 *
 * A backup is a CONSISTENT STANDALONE SNAPSHOT produced by SQLite's
 * `VACUUM INTO` (SQLite >= 3.27; bun bundles a current SQLite). This
 * absorbs all WAL/SHM content into a single standalone database file, so the
 * artifact needs no sidecars and its SHA-256 fully attests its logical
 * contents — a WAL-only change can never be hidden from verification. The
 * manifest records source path, SHA-256, size, schema/user version, critical
 * row counts, and a content-addressed SOURCE identity hash.
 *
 * `verifySqliteBackup` fails closed: it rejects missing, corrupt, stale,
 * wrong-source, schema-mismatched, count-mismatched, replaced-source, and
 * missing-source backups before any repair/activation maintenance proceeds.
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
/** v2: VACUUM INTO standalone snapshot + source identity hash. */
export const BACKUP_MANIFEST_VERSION = 2;

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
   * kept separate because `VACUUM INTO` inflates the snapshot's own
   * schema_version).
   */
  sourceSchemaVersion: number;
  sourceUserVersion: number;
  /** Critical row counts keyed by table name (fixed allowlist at creation). */
  counts: Record<string, number>;
  /**
   * Content-addressed identity of the SOURCE at backup time (user/schema
   * version + counts + per-table row digests of repair targets and key
   * parents). Verification recomputes it on the current source and rejects a
   * replaced source at the same path, even with identical schema and counts.
   */
  sourceIdentityHash: string;
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
 * Content digest of EVERY table's rows (canonical JSON, sorted) for the
 * source identity hash. Iterating `sqlite_master` means no table can hide a
 * same-count content change from the replaced-source check; internal
 * `sqlite_%` tables are excluded. Deterministic for a fixed schema. This is
 * a maintenance-gated operation (the backup itself is a full copy), so the
 * added read cost is acceptable.
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
    const rows = db.query(`SELECT * FROM ${quoted}`).all() as unknown[];
    digests[name] = sha256Hex(canonicalJsonStringify(rows.map(r => canonicalJsonStringify(r)).sort()));
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
    sourceIdentityHash: computeSourceIdentityHash(sourceDb),
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
 * Uses SQLite `VACUUM INTO` so the backup is a consistent standalone
 * snapshot of the source at that instant (WAL/SHM content absorbed, no
 * sidecar artifacts), then stream-hashes the complete artifact.
 *
 * Refuses to overwrite ANY existing artifact (main file, manifest, or
 * sidecar paths) and chmods every created artifact to 0600. The source DB
 * should be quiescent (writers stopped) during a maintenance window; the
 * repair-time verification recomputes the source identity so any later
 * change is detected.
 */
export function createSqliteBackup(sourceDbPath: string, backupPath: string): BackupManifest {
  const resolvedBackup = path.resolve(backupPath);
  const manifestPath = `${resolvedBackup}.manifest.json`;
  const artifactPaths = [resolvedBackup, manifestPath, `${resolvedBackup}-wal`, `${resolvedBackup}-shm`];
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

  // Consistent standalone snapshot: `VACUUM INTO` requires the destination
  // to not already exist (guaranteed above) and absorbs WAL/SHM content.
  const sourceWriter = new Database(sourceDbPath);
  try {
    sourceWriter.exec(`VACUUM INTO '${escapeSingleQuotes(resolvedBackup)}'`);
  } catch (err) {
    // Remove any partially-created artifact so a failed backup never leaves a
    // half-written file that could later be mistaken for a complete one.
    if (fs.existsSync(resolvedBackup)) {
      fs.rmSync(resolvedBackup, { force: true });
    }
    throw err;
  } finally {
    sourceWriter.close();
  }
  fs.chmodSync(resolvedBackup, 0o600);

  const sizeBytes = fs.statSync(resolvedBackup).size;
  const sha256 = sha256FileSync(resolvedBackup);

  const snapshotDb = new Database(resolvedBackup, { readonly: true });
  const sourceDb = new Database(sourceDbPath, { readonly: true });
  try {
    const manifest = buildBackupManifest(sourceDbPath, resolvedBackup, snapshotDb, sourceDb, sha256, sizeBytes);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.chmodSync(manifestPath, 0o600);
    return manifest;
  } finally {
    snapshotDb.close();
    sourceDb.close();
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
  if (!fs.existsSync(resolvedDb)) {
    errors.push(`Backup file missing: ${resolvedDb}`);
    return { ok: false, errors };
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
