#!/usr/bin/env bun
/**
 * Classification integrity CLI (Issue #17 C1/C2).
 *
 * Modes:
 *   audit   (default) — read-only audit; prints the deterministic manifest
 *                       JSON and its SHA-256 (optionally --report <path>).
 *   backup            — create a verified backup outside the repositories
 *                       (mode 0600, refuses overwrite) + sidecar manifest.
 *   repair            — requires --execute, --backup-manifest <path>,
 *                       --expected-audit-hash <hash>. Verifies the backup,
 *                       re-audits, aborts unless the audit hash matches the
 *                       reviewed dry-run hash AND counts match the backup
 *                       manifest, then repairs in ONE transaction with a
 *                       clean post-audit requirement.
 *
 * Fail-closed: unknown FK classes, invalid curation JSON, count drift,
 * active writers, insufficient disk, or audit-hash mismatch all abort
 * before any row changes. This tool NEVER writes to the live database
 * outside an explicit repair invocation, and it never runs as a migration.
 *
 * No live-DB mutation is performed by C1: `audit` and `backup` are
 * read-only/file-copy operations. `repair` is the C2 maintenance gate.
 */
import fs from 'fs';
import { Database } from '../src/db/driver';
import {
  auditClassificationIntegrity,
  buildIntegrityManifest,
  repairClassificationIntegrity,
} from '../src/classification/integrity-audit';
import {
  createSqliteBackup,
  readBackupManifest,
  verifySqliteBackup,
} from '../src/db/sqlite-backup-verifier';

function fail(message: string): never {
  console.error(`classification-integrity: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out[key] = next;
          i += 1;
        } else {
          out[key] = true;
        }
      }
    }
  }
  return out;
}

function openDb(dbPath: string): Database {
  if (!dbPath) fail('--db <path> is required.');
  if (!fs.existsSync(dbPath)) fail(`database does not exist: ${dbPath}`);
  const db = new Database(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

function assertNoActiveWriters(dbPath: string): void {
  // A second connection that cannot acquire an EXCLUSIVE lock means another
  // process holds the database — abort repair.
  try {
    const probe = new Database(dbPath);
    try {
      probe.exec('BEGIN EXCLUSIVE');
      probe.exec('ROLLBACK');
    } finally {
      probe.close();
    }
  } catch {
    fail(`active writer detected on ${dbPath}; stop API/worker processes before repair.`);
  }
}

function assertSufficientDisk(dbPath: string, minBytes: number): void {
  try {
    const stats = fs.statfsSync(dbPath);
    const free = (stats as { bavail?: number; bfree?: number }).bavail
      ? (stats as { bavail: number; bfree: number }).bavail * (stats as { bsize: number }).bsize
      : Number.POSITIVE_INFINITY;
    if (Number.isFinite(free) && free < minBytes) {
      fail(`insufficient disk space: ${free} bytes free, ${minBytes} required.`);
    }
  } catch {
    // statfsSync unavailable — the verifier still enforces count/schema
    // parity; disk checks are best-effort on platforms without statfs.
  }
}

function printReport(report: unknown): void {
  console.log(JSON.stringify(report, null, 2));
}

function modeAudit(args: Record<string, string | boolean>): void {
  const db = openDb(String(args.db ?? ''));
  try {
    const audit = auditClassificationIntegrity(db);
    const manifestResult = buildIntegrityManifest(db, audit);
    const report = { audit, manifest: manifestResult.manifest, sha256: manifestResult.sha256 };
    if (typeof args.report === 'string') {
      fs.writeFileSync(args.report, `${manifestResult.json}\n`, { mode: 0o600 });
      console.log(`audit manifest written to ${args.report} (${manifestResult.sha256})`);
    }
    printReport(report);
    if (!audit.isClean) {
      console.error(
        `classification-integrity: audit is NOT clean (${audit.foreignKeyViolations} FK violation(s), ` +
          `${audit.danglingEmbeddedProposals.length} dangling embedded proposal(s)).`,
      );
    }
  } finally {
    db.close();
  }
}

async function modeBackup(args: Record<string, string | boolean>): Promise<void> {
  const dbPath = String(args.db ?? '');
  const backupPath = String(args.backup ?? '');
  if (!backupPath) fail('--backup <path> is required.');
  if (!dbPath) fail('--db <path> is required.');
  const manifest = createSqliteBackup(dbPath, backupPath);
  const verification = await verifySqliteBackup(backupPath, manifest);
  printReport({ backupPath, manifest, verification });
  if (!verification.ok) {
    fail(`backup verification failed: ${verification.errors.join('; ')}`);
  }
  console.log(`backup created and verified: ${backupPath}`);
}

async function modeRepair(args: Record<string, string | boolean>): Promise<void> {
  if (args.execute !== true) {
    fail('repair requires --execute (dry-run review comes first).');
  }
  const dbPath = String(args.db ?? '');
  const backupManifestPath = String(args['backup-manifest'] ?? '');
  const expectedAuditHash = String(args['expected-audit-hash'] ?? '');
  if (!backupManifestPath) fail('--backup-manifest <path> is required.');
  if (!expectedAuditHash) fail('--expected-audit-hash <hash> is required.');

  // 1. Verify the backup + manifest (stale/corrupt/wrong-source/count drift).
  const manifest = readBackupManifest(backupManifestPath);
  const verification = await verifySqliteBackup(manifest.backupPath, manifest, { sourceDbPath: dbPath });
  if (!verification.ok) {
    fail(`backup verification failed: ${verification.errors.join('; ')}`);
  }

  // 2. No active writers; enough disk for the DB + WAL + backup + temp work.
  assertNoActiveWriters(dbPath);
  const sizeBytes = fs.statSync(dbPath).size;
  assertSufficientDisk(dbPath, sizeBytes * 3 + 1024 * 1024);

  // 3. Re-audit; the manifest hash must match the reviewed dry-run hash.
  const db = openDb(dbPath);
  try {
    const audit = auditClassificationIntegrity(db);
    const manifestResult = buildIntegrityManifest(db, audit);
    if (manifestResult.sha256 !== expectedAuditHash) {
      fail(
        `audit hash mismatch: expected ${expectedAuditHash}, found ${manifestResult.sha256}. ` +
          `The reviewed dry-run no longer matches the database; no rows were changed.`,
      );
    }
    // 4. Count drift check against the backup manifest (taken at gate start):
    //    the database must not have changed since the backup was taken.
    for (const [table, expected] of Object.entries(manifest.counts)) {
      const exists = !!db
        .query('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
        .get('table', table);
      const current = exists
        ? (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
        : 0;
      if (current !== expected) {
        fail(`count drift for ${table}: backup ${expected}, live ${current}. Aborting repair.`);
      }
    }
    // 5. Execute the single-transaction repair with a clean post-audit gate.
    const result = repairClassificationIntegrity(db, { dryRun: false });
    const postAudit = result.postAudit;
    const report = { result, postAuditClean: postAudit.isClean };
    printReport(report);
    if (!postAudit.isClean) {
      fail('post-repair audit is not clean; the transaction rolled back.');
    }
    console.log(
      `integrity repair complete: ${result.repairedStageResults} stage results, ` +
        `${result.repairedEvidence} evidence, ${result.repairedProposals} proposals, ` +
        `${result.repairedOnboardingSources} onboarding sources, ` +
        `${result.repairedOnboardingExtractions} onboarding extractions, ` +
        `${result.repairedProfileGenerationRevisions} profile revisions, ` +
        `${result.repairedEmbeddedProposals} dangling embedded proposals.`,
    );
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const positional = process.argv.find(a => a === 'audit' || a === 'backup' || a === 'repair');
  const resolvedMode = positional ?? (typeof args.mode === 'string' ? args.mode : 'audit');

  switch (resolvedMode) {
    case 'audit':
      modeAudit(args);
      break;
    case 'backup':
      await modeBackup(args);
      break;
    case 'repair':
      await modeRepair(args);
      break;
    default:
      fail(`unknown mode: ${resolvedMode} (expected audit | backup | repair).`);
  }
}

void main().catch(err => {
  console.error('classification-integrity:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
