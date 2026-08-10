import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { listRegistry, upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import fieldRegistryRoutes from '../../server/routes/field-registry-routes';
import catalogRoutes from '../../server/routes/catalog-routes';

let root: string;
let workspaceId: string;
let fieldId: string;

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', fieldRegistryRoutes);
  app.route('/api', catalogRoutes);
  return app;
}

function readAttestationEntries(): Array<{ xmlField: string; label: string }> {
  const raw = fs.readFileSync(path.join(root, 'store', 'field-registry.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { schemaVersion: number; entries: Array<{ xmlField: string; label: string }> };
  return parsed.entries;
}

beforeAll(() => {
  workspaceId = randomUUID();
  fieldId = randomUUID();
  root = fs.mkdtempSync(path.join(os.tmpdir(), `field-registry-routes-${workspaceId.slice(0, 8)}`));
  fs.mkdirSync(path.join(root, 'store'), { recursive: true });

  initDb(path.join(root, '.shopsite-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: root,
    gitPath: path.join(root, '.git'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });

  upsertRegistryEntry({
    id: fieldId,
    workspaceId,
    xmlField: 'ProductField24',
    label: 'Old Label',
    kind: 'custom',
    dataType: 'string',
    editable: true,
    required: false,
    uiGroup: 'Custom Fields',
    sampleValuesJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  upsertRegistryEntry({
    id: randomUUID(),
    workspaceId,
    xmlField: 'ProductField25',
    label: 'ProductField25',
    kind: 'custom',
    dataType: 'string',
    editable: true,
    required: false,
    uiGroup: 'Custom Fields',
    sampleValuesJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});
afterAll(() => closeDb());

describe('field registry routes (canonical field-metadata authority)', () => {
  it('I1: a label edit through the canonical path converges DB, R2 JSON, and the catalog fields view', async () => {
    const app = makeApp();

    const res = await app.request(`/api/field-registry/${fieldId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New Label' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; entry?: { xmlField: string; label: string } };
    expect(body.success).toBe(true);
    expect(body.entry?.label).toBe('New Label');

    // R1 (DB row)
    const dbRow = listRegistry(workspaceId).find(entry => entry.xmlField === 'ProductField24');
    expect(dbRow?.label).toBe('New Label');
    // The patched property is recorded as curated (D2 provenance).
    expect(JSON.parse(dbRow?.curatedFieldsJson ?? '[]')).toContain('label');

    // R2 (attestation projection rewritten from R1)
    const attested = readAttestationEntries().find(entry => entry.xmlField === 'ProductField24');
    expect(attested?.label).toBe('New Label');

    // Catalog fields view (reads R1)
    const fieldsRes = await app.request('/api/catalog/fields');
    expect(fieldsRes.status).toBe(200);
    const fieldsBody = await fieldsRes.json() as { fields: Array<{ xmlField: string; label: string }> };
    expect(fieldsBody.fields.find(f => f.xmlField === 'ProductField24')?.label).toBe('New Label');
  });

  it('C4 regression: a partial payload ({ label } only) with a valid id succeeds and never creates an empty xmlField row', async () => {
    const app = makeApp();
    const targetId = randomUUID();
    upsertRegistryEntry({
      id: targetId,
      workspaceId,
      xmlField: 'ProductField26',
      label: 'ProductField26',
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: 'Custom Fields',
      sampleValuesJson: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await app.request(`/api/field-registry/${targetId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Drawer Label' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    const registry = listRegistry(workspaceId);
    expect(registry.find(entry => entry.xmlField === 'ProductField26')?.label).toBe('Drawer Label');
    // The C4 bug inserted xml_field='' (UNIQUE conflict → 500). Never again.
    expect(registry.some(entry => entry.xmlField === '')).toBe(false);
    // R2 stays in lockstep with R1.
    const attested = readAttestationEntries().find(entry => entry.xmlField === 'ProductField26');
    expect(attested?.label).toBe('Drawer Label');
  });

  it('returns 404 for an unknown registry id instead of inserting a phantom row', async () => {
    const app = makeApp();
    const res = await app.request(`/api/field-registry/${randomUUID()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'No Such Row' }),
    });
    expect(res.status).toBe(404);
    expect(listRegistry(workspaceId).some(entry => entry.label === 'No Such Row')).toBe(false);
  });
});
