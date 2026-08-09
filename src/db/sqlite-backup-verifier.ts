/**
 * SQLite backup creation and verification (Issue #17 C1/C2).
 *
 * A backup is a plain copy of a SQLite database file plus a sidecar manifest
 * recording source path, SHA-256, size, schema/user version, and critical
 * row counts. `verifySqliteBackup` rejects missing, stale, corrupt,
 * wrong-source, or count-mismatched backups before any repair/activation
 * maintenance proceeds.
 *
 * The backup path and manifest are created with mode 0600 and never
 * overwrite an existing destination.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { Database } from './driver';
import { sha256Hex } from '../shared/stable-id';

export const BACKUP_MANIFEST_FORMAT = 'baystate-sqlite-backup';
export const BACKUP_MANIFEST_VERSION = 1;

export interface BackupManifest {
  format: string;
  version: number;
  sourceDbPath: string;
  backupPath: string;
  sha256: string;
  sizeBytes: number;
  schemaVersion: number;
  userVersion: number;
  /** Critical row counts keyed by table name (fixed allowlist at creation). */
  counts: Record<string, number>;
  createdAt: string;
}

export interface BackupVerificationResult {
  ok: boolean;
  errors: string[];
}

/** Tables captured in a backup manifest when they exist. */
const CRITICAL_COUNT_TABLES = [
  'onboarding_items',
  'onboarding_batches',
  'classification_runs',
  'classification_proposals',
  'classification_evidence',
  'classification_stage_results',
  'page_index',
  'product_index',
] as const;

export function buildBackupManifest(
  sourceDbPath: string,
  backupPath: string,
  db: Database,
  sha256: string,
  sizeBytes: number,
): BackupManifest {
  const counts: Record<string, number> = {};
  for (const table of CRITICAL_COUNT_TABLES) {
    const exists = !!db.query('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
    if (exists) {
      counts[table] = (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    }
  }
  return {
    format: BACKUP_MANIFEST_FORMAT,
    version: BACKUP_MANIFEST_VERSION,
    sourceDbPath: path.resolve(sourceDbPath),
    backupPath: path.resolve(backupPath),
    sha256,
    sizeBytes,
    schemaVersion: (db.query('PRAGMA schema_version').get() as { schema_version: number }).schema_version,
    userVersion: (db.query('PRAGMA user_version').get() as { user_version: number }).user_version,
    counts,
    createdAt: new Date().toISOString(),
  };
}

function copySidecars(sourceDbPath: string, backupPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const src = `${sourceDbPath}${suffix}`;
    const dst = `${backupPath}${suffix}`;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o600);
    }
  }
}

/**
 * Create a verified backup of `sourceDbPath` at `backupPath` (mode 0600).
 * Refuses to overwrite an existing backup file. Returns the written manifest.
 * The source DB should be quiescent (writers stopped) during a maintenance
 * window; the sidecar files are copied when present so the backup is a
 * consistent snapshot.
 */
export function createSqliteBackup(sourceDbPath: string, backupPath: string): BackupManifest {
  const resolvedBackup = path.resolve(backupPath);
  if (fs.existsSync(resolvedBackup)) {
    throw new Error(`Backup destination already exists and will not be overwritten: ${resolvedBackup}`);
  }
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source database does not exist: ${sourceDbPath}`);
  }
  const dir = path.dirname(resolvedBackup);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.copyFileSync(sourceDbPath, resolvedBackup);
  fs.chmodSync(resolvedBackup, 0o600);
  copySidecars(sourceDbPath, resolvedBackup);

  const sizeBytes = fs.statSync(resolvedBackup).size;
  const sha256 = sha256Hex(fs.readFileSync(resolvedBackup));

  const db = new Database(sourceDbPath, { readonly: true });
  try {
    const manifest = buildBackupManifest(sourceDbPath, resolvedBackup, db, sha256, sizeBytes);
    fs.writeFileSync(`${resolvedBackup}.manifest.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return manifest;
  } finally {
    db.close();
  }
}

export function readBackupManifest(manifestPath: string): BackupManifest {
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  const parsed = JSON.parse(raw) as BackupManifest;
  if (parsed.format !== BACKUP_MANIFEST_FORMAT || parsed.version !== BACKUP_MANIFEST_VERSION) {
    throw new Error(`Unsupported backup manifest format/version: ${parsed.format}/${parsed.version}`);
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
 * provided, the backup is additionally checked for staleness and
 * wrong-source (schema/user version regression or source path mismatch).
 */
export async function verifySqliteBackup(
  dbPath: string,
  manifest: BackupManifest,
  options: { sourceDbPath?: string } = {},
): Promise<BackupVerificationResult> {
  const errors: string[] = [];
  const resolvedDb = path.resolve(dbPath);

  if (manifest.format !== BACKUP_MANIFEST_FORMAT || manifest.version !== BACKUP_MANIFEST_VERSION) {
    errors.push(`Unsupported manifest format/version: ${manifest.format}/${manifest.version}`);
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

  if (options.sourceDbPath && fs.existsSync(options.sourceDbPath)) {
    const resolvedSource = path.resolve(options.sourceDbPath);
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
      if (sourceUserVersion > manifest.userVersion) {
        errors.push(
          `Stale backup: source user_version ${sourceUserVersion} is newer than backup ${manifest.userVersion}`,
        );
      }
      if (sourceSchemaVersion > manifest.schemaVersion) {
        errors.push(
          `Stale backup: source schema_version ${sourceSchemaVersion} is newer than backup ${manifest.schemaVersion}`,
        );
      }
    } catch {
      // If the source cannot be opened read-only, we cannot complete the
      // stale/source checks — fail closed.
      errors.push(`Source database could not be opened for stale/source verification: ${options.sourceDbPath}`);
    } finally {
      sourceDb?.close();
    }
  }

  return { ok: errors.length === 0, errors };
}
