import { describe, it, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';

// This suite requires bun:sqlite — must run under `bun test` (test:db), not vitest.
// vitest.config.ts excludes it; package.json test:db runs it.

describe('variant resolution migration (real runMigrations)', () => {
  it('fresh DB creates table, app_meta marker, indexes and is idempotent via runMigrations()', async () => {
    const dbPath = `/tmp/baystate-variant-mig-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    try {
      initDb(dbPath);
      runMigrations();
      const db = getDb();
      // app_meta marker
      const marker = db.query("SELECT value FROM app_meta WHERE key='onboarding_variant_resolution_schema_version'").get() as any;
      expect(marker?.value).toBe('1');
      // table exists
      const has = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_variant_resolutions'").get() as any;
      expect(has?.name).toBe('onboarding_variant_resolutions');
      // indexes
      const idx1 = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_variant_res_item'").get() as any;
      const idx2 = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_variant_res_item_hash'").get() as any;
      const idx3 = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_variant_res_status'").get() as any;
      expect(idx1?.name).toBe('idx_variant_res_item');
      expect(idx2?.name).toBe('idx_variant_res_item_hash');
      expect(idx3?.name).toBe('idx_variant_res_status');
      // FK check
      const fk = db.query('PRAGMA foreign_key_check').all();
      expect(fk).toEqual([]);
      // second run idempotent
      runMigrations();
      const marker2 = db.query("SELECT value FROM app_meta WHERE key='onboarding_variant_resolution_schema_version'").get() as any;
      expect(marker2?.value).toBe('1');
      const has2 = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_variant_resolutions'").get() as any;
      expect(has2?.name).toBe('onboarding_variant_resolutions');
    } finally {
      try { closeDb(); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    }
  });

  it('upgrade from prior schema: existing DB without table gets migrated via runMigrations()', async () => {
    const dbPath = `/tmp/baystate-variant-mig-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    try {
      // Create prior-schema DB via full migrations, then simulate missing variant table
      initDb(dbPath);
      runMigrations();
      const db = getDb();
      // Drop variant table and marker to simulate prior DB
      db.exec('DROP TABLE IF EXISTS onboarding_variant_resolutions');
      db.exec("DELETE FROM app_meta WHERE key='onboarding_variant_resolution_schema_version'");
      // Verify dropped
      const missing = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_variant_resolutions'").get() as any;
      expect(missing).toBeFalsy();
      // Re-run migrations should recreate
      runMigrations();
      const has = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_variant_resolutions'").get() as any;
      expect(has?.name).toBe('onboarding_variant_resolutions');
      const marker = db.query("SELECT value FROM app_meta WHERE key='onboarding_variant_resolution_schema_version'").get() as any;
      expect(marker?.value).toBe('1');
      // idempotent second run
      runMigrations();
      const has2 = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_variant_resolutions'").get() as any;
      expect(has2?.name).toBe('onboarding_variant_resolutions');
    } finally {
      try { closeDb(); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    }
  });
});
