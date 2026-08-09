import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { Database } from '../../db/driver';

const CLI = path.resolve(import.meta.dir, '../../../scripts/classification-integrity.ts');
const BUN = process.execPath;

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(BUN, [CLI, ...args], { encoding: 'utf-8' });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function buildOrphanDb(dbPath: string, orphanId: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE classification_runs (id TEXT PRIMARY KEY);
    CREATE TABLE classification_proposals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
    CREATE TABLE onboarding_items (id TEXT PRIMARY KEY, upc TEXT, existing_sku TEXT, curation_data_json TEXT, status TEXT NOT NULL DEFAULT 'imported');
  `);
  db.run(`INSERT INTO classification_runs VALUES ('run-ok')`);
  db.run(`INSERT INTO classification_proposals VALUES ('prop-ok', 'run-ok')`);
  db.run(`INSERT INTO classification_proposals VALUES (?, 'run-ghost')`, [orphanId]);
  db.close();
}

describe('Classification integrity CLI (Issue #17 C1/C2)', () => {
  it('audits readonly, backs up, and repairs the reviewed deletion set (happy path)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-cli-ok-'));
    const dbPath = path.join(dir, 'app.db');
    const backup = path.join(dir, 'backup.db');
    buildOrphanDb(dbPath, 'orphan-reviewed');

    const audit = runCli(['audit', '--db', dbPath]);
    expect(audit.status).toBe(0);
    const report = JSON.parse(audit.stdout) as { audit: { isClean: boolean }; sha256: string };
    expect(report.audit.isClean).toBe(false);
    const expectedHash = report.sha256;

    const backupRun = runCli(['backup', '--db', dbPath, '--backup', backup]);
    expect(backupRun.status).toBe(0);

    // Repair without --execute refuses.
    const noExecute = runCli(['repair', '--db', dbPath, '--backup-manifest', `${backup}.manifest.json`, '--expected-audit-hash', expectedHash]);
    expect(noExecute.status).toBe(1);
    expect(noExecute.stderr).toMatch(/requires --execute/i);

    // Correct reviewed hash repairs and leaves a clean post-audit.
    const repair = runCli(['repair', '--db', dbPath, '--execute', '--backup-manifest', `${backup}.manifest.json`, '--expected-audit-hash', expectedHash]);
    expect(repair.status).toBe(0);
    const post = JSON.parse(repair.stdout) as { postAuditClean: boolean };
    expect(post.postAuditClean).toBe(true);

    const postAudit = runCli(['audit', '--db', dbPath]);
    expect(JSON.parse(postAudit.stdout).audit.isClean).toBe(true);
  });

  it('aborts repair with zero changes when a reviewed orphan is swapped for a same-count replacement', () => {
    // Blocker 2 CLI-level: the expected audit hash binds the exact deletion
    // identities. reviewed-orphan-A swapped for unreviewed-orphan-B (same
    // class/count) must abort with nothing deleted.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-cli-swap-'));
    const dbPath = path.join(dir, 'app.db');
    const backup = path.join(dir, 'backup.db');
    buildOrphanDb(dbPath, 'reviewed-orphan-A');

    const audit = runCli(['audit', '--db', dbPath]);
    const expectedHash = (JSON.parse(audit.stdout) as { sha256: string }).sha256;
    const backupRun = runCli(['backup', '--db', dbPath, '--backup', backup]);
    expect(backupRun.status).toBe(0);

    // Swap the orphan identity (same orphan class, same count).
    const db = new Database(dbPath);
    db.run(`DELETE FROM classification_proposals WHERE id = 'reviewed-orphan-A'`);
    db.run(`INSERT INTO classification_proposals VALUES ('unreviewed-orphan-B', 'run-ghost')`);
    db.close();

    const repair = runCli(['repair', '--db', dbPath, '--execute', '--backup-manifest', `${backup}.manifest.json`, '--expected-audit-hash', expectedHash]);
    expect(repair.status).toBe(1);
    expect(repair.stderr).toMatch(/hash mismatch|content has changed/i);

    // Nothing was deleted: the unreviewed replacement remains.
    const check = new Database(dbPath, { readonly: true });
    const remaining = (check.query("SELECT COUNT(*) c FROM classification_proposals WHERE id = 'unreviewed-orphan-B'").get() as { c: number }).c;
    const reviewed = (check.query("SELECT COUNT(*) c FROM classification_proposals WHERE id = 'reviewed-orphan-A'").get() as { c: number }).c;
    check.close();
    expect(remaining).toBe(1);
    expect(reviewed).toBe(0);
  });

  it('rejects repair when the live database drifted from the backup (count parity)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-cli-drift-'));
    const dbPath = path.join(dir, 'app.db');
    const backup = path.join(dir, 'backup.db');
    buildOrphanDb(dbPath, 'orphan-drift');

    const audit = runCli(['audit', '--db', dbPath]);
    const expectedHash = (JSON.parse(audit.stdout) as { sha256: string }).sha256;
    const backupRun = runCli(['backup', '--db', dbPath, '--backup', backup]);
    expect(backupRun.status).toBe(0);

    // Add a row to a covered table after the backup (count drift).
    const db = new Database(dbPath);
    db.run(`INSERT INTO classification_proposals VALUES ('prop-extra', 'run-ok')`);
    db.close();

    const repair = runCli(['repair', '--db', dbPath, '--execute', '--backup-manifest', `${backup}.manifest.json`, '--expected-audit-hash', expectedHash]);
    expect(repair.status).toBe(1);
    expect(repair.stderr).toMatch(/count drift|hash mismatch|content has changed/i);

    // The reviewed orphan is untouched.
    const check = new Database(dbPath, { readonly: true });
    expect((check.query("SELECT COUNT(*) c FROM classification_proposals WHERE id = 'orphan-drift'").get() as { c: number }).c).toBe(1);
    check.close();
  });
});
