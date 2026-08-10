import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertRegistryEntry, clearProjectionStale } from '../../db/repositories/field-registry-repo';
import { scanCatalogEvidence, readLiveCatalogFields } from '../../classification/catalog-evidence';

let root: string;
let workspaceId: string;

function now(): string {
  return new Date().toISOString();
}

function writeProduct(): void {
  fs.writeFileSync(
    path.join(root, 'products', 'SKU-A.json'),
    JSON.stringify({ sku: 'SKU-A', customFields: { ProductField16: 'Kong' } }),
    'utf-8',
  );
}

function seedR1(xmlFields: string[]): void {
  for (const field of xmlFields) {
    upsertRegistryEntry({
      id: randomUUID(),
      workspaceId,
      xmlField: field,
      label: field,
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: 'Custom Fields',
      sampleValuesJson: null,
      createdAt: now(),
      updatedAt: now(),
    });
  }
}

function writeR2(xmlFields: string[]): void {
  fs.writeFileSync(
    path.join(root, 'store', 'field-registry.json'),
    JSON.stringify({ schemaVersion: 1, entries: xmlFields.map(xmlField => ({ xmlField, label: xmlField })) }),
    'utf-8',
  );
}

function readR2(): string[] {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'store', 'field-registry.json'), 'utf-8')) as {
    entries?: Array<{ xmlField?: unknown }>;
  };
  return (raw.entries ?? []).map(entry => String(entry.xmlField ?? ''));
}

beforeAll(() => {
  workspaceId = randomUUID();
  root = fs.mkdtempSync(path.join(os.tmpdir(), `catalog-evidence-freshness-${workspaceId.slice(0, 8)}`));
  fs.mkdirSync(path.join(root, 'products'), { recursive: true });
  fs.mkdirSync(path.join(root, 'store'), { recursive: true });
  initDb(path.join(root, '.shopsite-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: root,
    gitPath: '',
    createdAt: now(),
    updatedAt: now(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

afterAll(() => closeDb());

describe('catalog-evidence freshness gate (F2, issue #31 cleanup)', () => {
  it('scanCatalogEvidence repairs a stale-but-repairable R2 and proceeds (projection = R1)', async () => {
    clearProjectionStale(workspaceId);
    writeProduct();
    seedR1(['ProductField16', 'ProductField17']);
    // Stale R2: diverges from R1 (carries a field R1 does not have).
    writeR2(['ProductField16', 'ProductField99']);

    const evidence = await scanCatalogEvidence(root, workspaceId);

    // The scan proceeded AFTER repairing R2 from R1.
    expect(evidence.fieldRegistry.xmlFields).toEqual(['ProductField16', 'ProductField17']);
    // The R2 file was rewritten to match R1.
    expect(readR2()).toEqual(['ProductField16', 'ProductField17']);
  });

  it('scanCatalogEvidence fails closed when R2 is stale and repair fails (field_registry_projection_stale)', async () => {
    writeProduct();
    seedR1(['ProductField16', 'ProductField17']);
    writeR2(['ProductField16', 'ProductField99']);
    const registryFile = path.join(root, 'store', 'field-registry.json');
    fs.chmodSync(registryFile, 0o444); // repair write fails
    try {
      await expect(scanCatalogEvidence(root, workspaceId)).rejects.toThrow(/field_registry_projection_stale/);
    } finally {
      fs.chmodSync(registryFile, 0o644);
      // Restore a consistent attestation for later tests.
      fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, entries: [{ xmlField: 'ProductField16', label: 'ProductField16' }, { xmlField: 'ProductField17', label: 'ProductField17' }] }), 'utf-8');
      clearProjectionStale(workspaceId);
    }
  });

  it('readLiveCatalogFields repairs a stale-but-repairable R2 and returns the R1 set', () => {
    clearProjectionStale(workspaceId);
    seedR1(['ProductField16', 'ProductField17']);
    writeR2(['ProductField16']); // stale: missing ProductField17

    const fields = readLiveCatalogFields(root, workspaceId);
    expect(fields).toEqual(['ProductField16', 'ProductField17']);
    expect(readR2()).toEqual(['ProductField16', 'ProductField17']);
  });

  it('readLiveCatalogFields fails closed when R2 is stale and repair fails (field_registry_projection_stale)', () => {
    seedR1(['ProductField16', 'ProductField17']);
    writeR2(['ProductField16', 'ProductField99']);
    const registryFile = path.join(root, 'store', 'field-registry.json');
    fs.chmodSync(registryFile, 0o444);
    try {
      expect(() => readLiveCatalogFields(root, workspaceId)).toThrow(/field_registry_projection_stale/);
    } finally {
      fs.chmodSync(registryFile, 0o644);
      fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, entries: [{ xmlField: 'ProductField16', label: 'ProductField16' }, { xmlField: 'ProductField17', label: 'ProductField17' }] }), 'utf-8');
      clearProjectionStale(workspaceId);
    }
  });

  it('readLiveCatalogFields keeps path-only behavior (no DB) unchanged', () => {
    // No workspace id: the gate is skipped; a missing file returns [].
    expect(readLiveCatalogFields(root)).toEqual(['ProductField16', 'ProductField17']);
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-evidence-freshness-empty-'));
    try {
      expect(readLiveCatalogFields(emptyRoot)).toEqual([]);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
