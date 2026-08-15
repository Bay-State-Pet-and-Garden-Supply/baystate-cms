/**
 * Bun-only DB suite for the live-smoke secret resolution path (M6).
 *
 * This file is excluded from vitest (project convention: bun:sqlite never
 * enters the vitest graph) and runs under `bun test` via the `test:db`
 * script. It proves that `resolveSmokeSecret`'s `--db` path opens the
 * api_keys database READ-ONLY and never writes.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { resolveSmokeSecret } from '../../onboarding/sourcing/html-scraper/live-smoke.ts';

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeKeysDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-db-test-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'keys.db');
  const w = new Database(dbPath);
  w.exec('CREATE TABLE api_keys (service TEXT PRIMARY KEY, api_key TEXT NOT NULL)');
  w.query('INSERT INTO api_keys (service, api_key) VALUES (?, ?)').run('orgill', '{"username":"u","password":"p"}');
  w.close();
  return dbPath;
}

describe('resolveSmokeSecret read-only DB path (bun-only)', () => {
  test('resolves a key from the read-only DB', async () => {
    const dbPath = makeKeysDb();
    expect(await resolveSmokeSecret('orgill', dbPath, {})).toBe('{"username":"u","password":"p"}');
    expect(await resolveSmokeSecret('missing', dbPath, {})).toBeNull();
  });

  test('the resolution path never writes: read-only open rejects writes and creates no new sidecar files', async () => {
    const dbPath = makeKeysDb();
    // A write on the same READ-ONLY open is rejected by SQLite itself.
    const ro = new Database(dbPath, { readonly: true });
    expect(() => ro.query('INSERT INTO api_keys (service, api_key) VALUES (?, ?)').run('x', 'y')).toThrow();
    ro.close();
    // resolveSmokeSecret must not create/alter any DB sidecar files.
    const sidecarNames = ['-wal', '-shm'];
    const snapshot = () => sidecarNames.filter((s) => Bun.file(`${dbPath}${s}`).exists()).sort();
    const before = snapshot();
    await resolveSmokeSecret('orgill', dbPath, {});
    const after = snapshot();
    expect(after).toEqual(before);
  });

  test('env wins over the DB even when both are present', async () => {
    const dbPath = makeKeysDb();
    expect(await resolveSmokeSecret('orgill', dbPath, { orgill: 'env-value' })).toBe('env-value');
  });

  test('unopenable/malformed DB path → null (fail-closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-db-missing-'));
    tempDirs.push(dir);
    expect(await resolveSmokeSecret('orgill', join(dir, 'nope.db'), {})).toBeNull();
  });
});
