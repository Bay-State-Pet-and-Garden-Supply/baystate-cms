/**
 * Milestone 5 — Lossless imported identity migration tests.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById, listItemsByBatch } from '../../db/repositories/onboarding-item-repo';
import { captureImportedIdentity, IDENTITY_NORMALIZER_VERSION, computeIdentityProvenanceHash } from '../../onboarding/imported-identity';
import { applyColumnMapping } from '../../onboarding/spreadsheet-parser';
import type { ColumnMapping } from '../../shared/schemas/onboarding';

let workspaceId: string;
let workspacePath: string;

function makeWorkspace() {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `ws-identity-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

describe('imported identity migration — lossless capture', () => {
  beforeEach(() => makeWorkspace());

  it('migration adds 4 columns to onboarding_items', () => {
    const cols = getDb().query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    expect(names.has('raw_identity_json')).toBe(true);
    expect(names.has('normalized_identity_json')).toBe(true);
    expect(names.has('identity_normalizer_version')).toBe(true);
    expect(names.has('identity_provenance_hash')).toBe(true);
  });

  it('raw vs normalized differ on glue case LGHARVEST', () => {
    const rawRow: Record<string, string> = {
      upc: '123',
      name: 'BEEKEEPING GLOVES LGHARVEST LANE',
      brand: 'Harvest Lane',
    };
    const mapping: ColumnMapping = {
      upc: 'upc',
      name: 'name',
      nameMergeWith: null,
      price: null,
      quantity: null,
      brand: 'brand',
      department: null,
      sourceUrl: null,
    };
    const captured = captureImportedIdentity(rawRow, mapping);
    expect(captured.raw_identity_json).not.toBeNull();
    expect(captured.normalized_identity_json).not.toBeNull();
    const raw = JSON.parse(captured.raw_identity_json!);
    const norm = JSON.parse(captured.normalized_identity_json!);
    // Raw envelope preserves exact fragments with LGHARVEST fused, normalized envelope is split and brand-fronted
    const rawFragments = raw.nameFragments ?? [];
    const rawJoined = rawFragments.map((f: any) => f.value).join('');
    expect(rawJoined).toContain('LGHARVEST');
    // Raw fragments should have exact column/value/boundary
    expect(rawFragments[0].column).toBe('name');
    expect(raw.version).toBe(1);
    expect(raw.mappingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(norm.name).not.toContain('LGHARVEST');
    expect(norm.name).toContain('LG');
    expect(norm.name.toUpperCase()).toContain('HARVEST');
    // Normalized should have ordered transformations
    expect(norm.transformations.length).toBeGreaterThanOrEqual(1);
    expect(norm.transformations[0].code).toBe('split_glued_size');
    expect(captured.identity_normalizer_version).toBe(IDENTITY_NORMALIZER_VERSION);
    expect(captured.identity_provenance_hash).toBeTruthy();
    expect(captured.identity_provenance_hash!.length).toBe(64);
  });

  it('capture retains raw brandHint and preserves mergeWith with boundary', () => {
    const rawRow: Record<string, string> = {
      upc: '999',
      name: 'Test Product',
      desc2: ' Extra',
      brand: '  Acme  ',
    };
    const mapping: ColumnMapping = {
      upc: 'upc',
      name: 'name',
      nameMergeWith: 'desc2',
      price: null,
      quantity: null,
      brand: 'brand',
      department: null,
      sourceUrl: null,
    };
    const captured = captureImportedIdentity(rawRow, mapping);
    const raw = JSON.parse(captured.raw_identity_json!);
    expect(raw.nameFragments.length).toBe(2);
    expect(raw.nameFragments[0].column).toBe('name');
    expect(raw.nameFragments[0].value).toBe('Test Product');
    expect(raw.nameFragments[1].column).toBe('desc2');
    expect(raw.nameFragments[1].value).toBe(' Extra');
    // Boundary should be space because second fragment has leading space
    expect(raw.nameFragments[0].boundary).toBe('space');
    expect(raw.brandHint).toBe('  Acme  ');
    const norm = JSON.parse(captured.normalized_identity_json!);
    expect(norm.brandHint).toBe('Acme');
    // With explicit boundary whitespace, normalized joins with single space
    expect(norm.name).toContain('Test Product');
    expect(norm.name).toContain('Extra');
    expect(norm.name).toBe('Test Product Extra');
    // Also verify merge without explicit space concatenates (LAV+ENDER case)
    const raw2: Record<string, string> = { upc: '1', name: 'LAV', desc2: 'ENDER', brand: 'Test' };
    const cap2 = captureImportedIdentity(raw2, mapping);
    const raw2p = JSON.parse(cap2.raw_identity_json!);
    expect(raw2p.nameFragments[0].boundary).toBe('concatenated');
    const norm2 = JSON.parse(cap2.normalized_identity_json!);
    expect(norm2.name).toBe('LAVENDER');
  });

  it('provenance hash deterministic for same input', () => {
    const rawRow: Record<string, string> = { upc: '1', name: 'Foo', brand: 'Bar' };
    const mapping: ColumnMapping = { upc: 'upc', name: 'name', nameMergeWith: null, price: null, quantity: null, brand: 'brand', department: null, sourceUrl: null };
    const a = captureImportedIdentity(rawRow, mapping);
    const b = captureImportedIdentity(rawRow, mapping);
    expect(a.identity_provenance_hash!).toBe(b.identity_provenance_hash!);
    // Direct compute
    const h = computeIdentityProvenanceHash(a.raw_identity_json!, a.normalized_identity_json!);
    expect(h).toBe(a.identity_provenance_hash!);
  });

  it('backfill for legacy rows produces lossy null raw but valid normalized via real migration', () => {
    // Insert legacy row simulating pre-migration state (columns exist but NULL — legacy data)
    const batch = createBatch({ workspaceId, name: 'Legacy', fileName: 'legacy.csv', totalItems: 0 });
    const id = randomUUID();
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, brand_hint, row_number, status, stage, stage_status, created_at, updated_at) VALUES (?, ?, 'LEGACY1', 'Legacy Product', 'LegacyBrand', 1, 'imported', 'sourcing', 'pending', ?, ?)`,
      [id, batch.id, now, now],
    );
    // Reset migration marker to force upgrade path, then invoke real runMigrations()
    getDb().run("DELETE FROM app_meta WHERE key = 'imported_identity_schema_version'");
    runMigrations();
    const row = getDb().query('SELECT raw_identity_json, normalized_identity_json, identity_normalizer_version, identity_provenance_hash FROM onboarding_items WHERE id = ?').get(id) as any;
    expect(row.raw_identity_json).toBeNull(); // lossy — never fabricate raw fragments
    expect(row.normalized_identity_json).not.toBeNull();
    const norm = JSON.parse(row.normalized_identity_json);
    // Normalized envelope should be version 0, contain operational name/brand, source legacy
    expect(norm.version).toBe(0);
    expect(norm.name).toBe('Legacy Product');
    expect(norm.brandHint).toBe('LegacyBrand');
    expect(norm.parserProvenance?.source ?? norm.source ?? 'legacy_operational_backfill').toContain('legacy');
    expect(row.identity_normalizer_version).toBe(0);
    expect(row.identity_provenance_hash).toBeTruthy();
    expect(row.identity_provenance_hash.length).toBe(64);
    // Verify hash is truthful: hash(version0 + normalized + legacy_operational_backfill + lossy)
    const { canonicalJsonStringify } = require('../../shared/stable-id');
    const expectedHash = require('node:crypto').createHash('sha256').update(
      canonicalJsonStringify({ version: 0, normalized: row.normalized_identity_json, source: 'legacy_operational_backfill', lossy: true, raw: null }),
      'utf8'
    ).digest('hex');
    expect(row.identity_provenance_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.identity_provenance_hash).toBe(expectedHash);
  });

  it('applyColumnMapping attaches identity fields and insert persists them', () => {
    const mapping: ColumnMapping = { upc: 'upc', name: 'name', nameMergeWith: null, price: null, quantity: null, brand: 'brand', department: null, sourceUrl: null };
    const rawRows = [{ upc: 'U1', name: 'BEEKEEPING GLOVES LGHARVEST LANE', brand: 'Harvest Lane' }];
    const { valid } = applyColumnMapping(rawRows, mapping);
    expect(valid.length).toBe(1);
    const row = valid[0] as any;
    expect(row.rawIdentityJson).toBeTruthy();
    expect(row.normalizedIdentityJson).toBeTruthy();
    expect(row.identityNormalizerVersion).toBe(IDENTITY_NORMALIZER_VERSION);
    expect(row.identityProvenanceHash).toBeTruthy();

    const batch = createBatch({ workspaceId, name: 'Import', fileName: 'import.csv', totalItems: 0 });
    const inserted = insertItems(batch.id, valid as any, 'sourcing', 1);
    const fetched = findItemById(inserted[0].id) as any;
    expect(fetched.rawIdentityJson).toBe(row.rawIdentityJson);
    expect(fetched.normalizedIdentityJson).toBe(row.normalizedIdentityJson);
    expect(fetched.identityNormalizerVersion).toBe(IDENTITY_NORMALIZER_VERSION);
    expect(fetched.identityProvenanceHash).toBe(row.identityProvenanceHash);
  });

  it('evidence projection v3 uses normalized identity but retains raw for audit', () => {
    expect(IDENTITY_NORMALIZER_VERSION).toBe(1);
    const rawRow: Record<string, string> = { upc: 'U2', name: 'BEEKEEPING GLOVES LGHARVEST LANE', brand: 'Harvest Lane' };
    const mapping: ColumnMapping = { upc: 'upc', name: 'name', nameMergeWith: null, price: null, quantity: null, brand: 'brand', department: null, sourceUrl: null };
    const captured = captureImportedIdentity(rawRow, mapping);
    const raw = JSON.parse(captured.raw_identity_json!);
    const norm = JSON.parse(captured.normalized_identity_json!);
    const rawJoined = raw.nameFragments.map((f: any) => f.value).join('');
    expect(rawJoined).toContain('LGHARVEST');
    expect(norm.name).not.toContain('LGHARVEST');
    expect(captured.raw_identity_json).toBeTruthy();
    expect(captured.normalized_identity_json).toBeTruthy();
    // V3 provenance hash should be deterministic
    expect(captured.identity_provenance_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('row schemas accept valid V0 tuple with omitted lossy (inferred true) and reject malformed inner version/source', () => {
    const { SpreadsheetRowSchema, OnboardingItemSchema } = require('../../shared/schemas/onboarding');
    const { canonicalJsonStringify } = require('../../shared/stable-id');
    const { computeLegacyProvenanceHash } = require('../../onboarding/imported-identity');
    // Build truthful V0 normalized envelope via legacy backfill shape
    const normalizedEnvelope = {
      version: 0,
      upc: 'V0MIG',
      name: 'Legacy Migrated Product',
      brandHint: 'LegacyBrand',
      departmentHint: null,
      price: null,
      quantity: null,
      sourceUrl: null,
      rowNumber: 1,
      mappingHash: require('node:crypto').createHash('sha256').update('legacy', 'utf8').digest('hex'),
      transformations: [],
      parserProvenance: { source: 'legacy_operational_backfill', parserVersion: 0 },
    };
    const normalizedJson = canonicalJsonStringify(normalizedEnvelope);
    const provenanceHash = computeLegacyProvenanceHash(normalizedJson);
    // Valid V0 with omitted lossy should succeed via inferred true
    const validRow = {
      upc: 'V0MIG',
      name: 'Legacy Migrated Product',
      rowNumber: 1,
      rawIdentityJson: null,
      normalizedIdentityJson: normalizedJson,
      identityNormalizerVersion: 0,
      identityProvenanceHash: provenanceHash,
      // identityLossy omitted intentionally — V0 infers true
    };
    const parsedRow = SpreadsheetRowSchema.safeParse(validRow);
    expect(parsedRow.success, parsedRow.success ? '' : JSON.stringify(parsedRow.error?.format())).toBe(true);
    const validItem = {
      id: randomUUID(),
      batchId: randomUUID(),
      upc: 'V0MIG',
      name: 'Legacy Migrated Product',
      price: null,
      quantity: null,
      brandHint: 'LegacyBrand',
      departmentHint: null,
      sourceUrl: null,
      expectedName: null,
      coordinatedTitle: null,
      sourceType: 'official_page',
      acceptedEvidenceAttemptIds: [],
      acceptedEvidenceAttemptId: null,
      sourcingDecision: null,
      stage: 'sourcing',
      stageStatus: 'pending',
      isHeld: false,
      heldReason: null,
      status: 'imported',
      errorMessage: null,
      retryCount: 0,
      isDuplicate: false,
      existingSku: null,
      extractionData: null,
      curationData: null,
      rawIdentityJson: null,
      normalizedIdentityJson: normalizedJson,
      identityNormalizerVersion: 0,
      identityProvenanceHash: provenanceHash,
      rowNumber: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const parsedItem = OnboardingItemSchema.safeParse(validItem);
    expect(parsedItem.success, parsedItem.success ? '' : JSON.stringify(parsedItem.error?.format())).toBe(true);
    // Malformed inner version: V0 wrapper but normalized inner version 1 should fail
    const badVersionEnvelope = { ...normalizedEnvelope, version: 1 };
    const badVersionJson = canonicalJsonStringify(badVersionEnvelope);
    const badVersionHash = computeLegacyProvenanceHash(badVersionJson);
    const badVersionRow = { ...validRow, normalizedIdentityJson: badVersionJson, identityProvenanceHash: badVersionHash };
    expect(SpreadsheetRowSchema.safeParse(badVersionRow).success).toBe(false);
    expect(OnboardingItemSchema.safeParse({ ...validItem, normalizedIdentityJson: badVersionJson, identityProvenanceHash: badVersionHash }).success).toBe(false);
    // Malformed source: V0 with spreadsheet source should fail (must be legacy_operational_backfill)
    const badSourceEnvelope = { ...normalizedEnvelope, parserProvenance: { source: 'spreadsheet', parserVersion: 1 } };
    const badSourceJson = canonicalJsonStringify(badSourceEnvelope);
    const badSourceHash = computeLegacyProvenanceHash(badSourceJson);
    const badSourceRow = { ...validRow, normalizedIdentityJson: badSourceJson, identityProvenanceHash: badSourceHash };
    expect(SpreadsheetRowSchema.safeParse(badSourceRow).success).toBe(false);
    expect(OnboardingItemSchema.safeParse({ ...validItem, normalizedIdentityJson: badSourceJson, identityProvenanceHash: badSourceHash }).success).toBe(false);
  });
});
