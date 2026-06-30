import { getDb } from './connection';
import fs from 'fs';
import path from 'path';

const SCHEMA_PATH = path.resolve(import.meta.dirname, 'schema.sql');
const ONBOARDING_MIGRATION_PATH = path.resolve(import.meta.dirname, 'onboarding-migration.sql');

export function runMigrations(): void {
  const db = getDb();
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);

  // Run onboarding migration if not already applied
  const onboardingVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('onboarding_schema_version') as
    | { value: string }
    | undefined;
  if (!onboardingVersion) {
    const onboardingSql = fs.readFileSync(ONBOARDING_MIGRATION_PATH, 'utf-8');
    db.exec(onboardingSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('onboarding_schema_version', '1');");
  }

  // Ensure product_index has parent_sku and search columns (migration support for existing databases)
  try {
    const columns = db.query('PRAGMA table_info(product_index)').all() as Array<{ name: string }>;
    if (!columns.some(col => col.name === 'parent_sku')) {
      db.exec('ALTER TABLE product_index ADD COLUMN parent_sku TEXT REFERENCES product_index(sku);');
    }
    if (!columns.some(col => col.name === 'description')) {
      db.exec('ALTER TABLE product_index ADD COLUMN description TEXT;');
    }
    if (!columns.some(col => col.name === 'search_keywords')) {
      db.exec('ALTER TABLE product_index ADD COLUMN search_keywords TEXT;');
    }
    if (!columns.some(col => col.name === 'custom_fields')) {
      db.exec('ALTER TABLE product_index ADD COLUMN custom_fields TEXT;');
    }
  } catch (e) {
    console.error('Failed to update product_index columns:', e);
  }

  // Ensure onboarding_items table has curation_data_json column
  try {
    const columns = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some(col => col.name === 'curation_data_json')) {
      db.exec('ALTER TABLE onboarding_items ADD COLUMN curation_data_json TEXT;');
    }
  } catch (e) {
    console.error('Failed to update onboarding_items columns:', e);
  }

  // Ensure extractor_profiles table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS extractor_profiles (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL UNIQUE,
        title_selector TEXT,
        price_selector TEXT,
        description_selector TEXT,
        brand_selector TEXT,
        images_selector TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_extractor_profiles_domain ON extractor_profiles(domain);
    `);
  } catch (e) {
    console.error('Failed to create extractor_profiles table:', e);
  }

  // Ensure domain_status table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_status (
        domain TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        reason TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_domain_status_status ON domain_status(status);
    `);
  } catch (e) {
    console.error('Failed to create domain_status table:', e);
  }

  // Verify migration ran
  const row = db.query('SELECT value FROM app_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!row) {
    throw new Error('Schema migration did not create app_meta');
  }
}

export function getSchemaVersion(): string {
  const db = getDb();
  const row = db.query('SELECT value FROM app_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  return row?.value ?? '0';
}
