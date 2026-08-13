import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { listRegistry, upsertRegistryEntry, markProjectionStale, clearProjectionStale, isProjectionStale } from '../../db/repositories/field-registry-repo';
import { ensureAttestationFresh } from '../../server/services/field-metadata-service';
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

function readAttestationRaw(): { schemaVersion: number; entries: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(path.join(root, 'store', 'field-registry.json'), 'utf-8');
  return JSON.parse(raw) as { schemaVersion: number; entries: Array<Record<string, unknown>> };
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

  it('repair: POST /api/field-registry/repair rebuilds the R2 attestation from R1 after the JSON file is deleted', async () => {
    const app = makeApp();

    // Simulate a stale/missing attestation: R1 is authoritative, R2 is gone.
    fs.rmSync(path.join(root, 'store', 'field-registry.json'), { force: true });
    expect(fs.existsSync(path.join(root, 'store', 'field-registry.json'))).toBe(false);

    const res = await app.request('/api/field-registry/repair', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; entryCount?: number };
    expect(body.success).toBe(true);
    expect(body.entryCount).toBeGreaterThanOrEqual(3);

    // The rebuilt projection is byte-identical to repairAttestation's: every
    // R1 row round-trips under { schemaVersion: 1, entries }.
    const raw = fs.readFileSync(path.join(root, 'store', 'field-registry.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { schemaVersion: number; entries: unknown[] };
    const registry = listRegistry(workspaceId);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.entries).toEqual(JSON.parse(JSON.stringify(registry)));
  });

  it('repair fallback: GET /api/field-registry lazily rebuilds R2 when the JSON file is missing', async () => {
    const app = makeApp();
    fs.rmSync(path.join(root, 'store', 'field-registry.json'), { force: true });

    const res = await app.request('/api/field-registry');
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: Array<{ xmlField: string }> };
    expect(body.entries.length).toBeGreaterThanOrEqual(3);
    // The GET call repaired the attestation file as a side effect.
    const attested = readAttestationEntries();
    expect(attested.length).toBe(body.entries.length);
  });

  it('F1 regression: a canonical PATCH of uiGroup to null clears the DB row AND the R2 JSON', async () => {
    const app = makeApp();

    // ProductField25 starts with a non-null uiGroup in the seeded setup.
    const before = listRegistry(workspaceId).find(entry => entry.xmlField === 'ProductField25')!;
    expect(before.uiGroup).not.toBeNull();

    const res = await app.request(`/api/field-registry/${before.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uiGroup: null }),
    });
    expect(res.status).toBe(200);

    // R1 (DB row) is null AND the property is recorded as curated (D2).
    const dbRow = listRegistry(workspaceId).find(entry => entry.xmlField === 'ProductField25')!;
    expect(dbRow.uiGroup).toBeNull();
    expect(JSON.parse(dbRow.curatedFieldsJson ?? '[]')).toContain('uiGroup');

    // R2 (attestation projection rewritten from R1) is null too.
    const attested = readAttestationRaw().entries.find(entry => entry.xmlField === 'ProductField25');
    expect(attested?.uiGroup).toBeNull();
  });

  it('F4 regression: PUT creating a new row records the supplied patch properties as curated', async () => {
    const app = makeApp();
    const newId = randomUUID();

    const res = await app.request(`/api/field-registry/${newId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xmlField: 'ProductField30', label: 'Operator Label' }),
    });
    expect(res.status).toBe(200);

    // Operator-created row: the supplied patch properties ARE the curation
    // (never observed-only), so a later sync cannot overwrite them.
    const created = listRegistry(workspaceId).find(entry => entry.xmlField === 'ProductField30')!;
    expect(created.label).toBe('Operator Label');
    expect(JSON.parse(created.curatedFieldsJson ?? '[]')).toEqual(['label']);
  });

  it('F2: stale-projection marker round-trip (mark → isProjectionStale → clear → false)', () => {
    expect(isProjectionStale(workspaceId)).toBe(false);
    markProjectionStale(workspaceId, new Date().toISOString());
    expect(isProjectionStale(workspaceId)).toBe(true);
    clearProjectionStale(workspaceId);
    expect(isProjectionStale(workspaceId)).toBe(false);
  });

  it('F2: ensureAttestationFresh repairs a stale R2 (file rewritten, repaired: true, marker absent)', () => {
    // Baseline: R2 currently matches R1 (fresh).
    const fresh = ensureAttestationFresh({ id: workspaceId, workspacePath: root });
    expect(fresh.fresh).toBe(true);
    expect(fresh.repaired).toBeUndefined();

    // Simulate a stale attestation: R2 carries an extra field R1 does not have.
    const stale = readAttestationRaw();
    stale.entries.push({ xmlField: 'ProductField31', label: 'Ghost' } as unknown as Record<string, unknown>);
    fs.writeFileSync(path.join(root, 'store', 'field-registry.json'), JSON.stringify(stale), 'utf-8');

    const result = ensureAttestationFresh({ id: workspaceId, workspacePath: root });
    expect(result.fresh).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.removed).toContain('ProductField31');
    // The file was rewritten from R1 and the marker is absent.
    const rewritten = readAttestationRaw();
    expect(rewritten.entries.some(entry => entry.xmlField === 'ProductField31')).toBe(false);
    expect(isProjectionStale(workspaceId)).toBe(false);
  });

  it('F2: GET /api/field-registry and POST /api/field-registry/repair surface projectionStale when the marker is set after a failed repair', async () => {
    const app = makeApp();

    // Make R2 genuinely stale AND unwritable: the freshness gate's repair
    // keeps failing, so the durable marker stays set and the routes surface it.
    const registryFile = path.join(root, 'store', 'field-registry.json');
    const staleR2 = readAttestationRaw();
    staleR2.entries.push({ xmlField: 'ProductField99', label: 'Ghost' } as unknown as Record<string, unknown>);
    fs.writeFileSync(registryFile, JSON.stringify(staleR2), 'utf-8');
    fs.chmodSync(registryFile, 0o444);
    try {
      // GET: the gate's repair attempt fails, the marker survives, and the
      // response surfaces projectionStale + condition (the request still
      // succeeds — R1 remains authoritative for listing).
      const getRes = await app.request('/api/field-registry');
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as { projectionStale?: boolean; condition?: string };
      expect(getBody.projectionStale).toBe(true);
      expect(getBody.condition).toBe('field_registry_projection_stale');
      expect(isProjectionStale(workspaceId)).toBe(true);

      // POST repair fails the same way and surfaces the marker in the 500.
      const postRes = await app.request('/api/field-registry/repair', { method: 'POST' });
      expect(postRes.status).toBe(500);
      const postBody = await postRes.json() as { projectionStale?: boolean; condition?: string };
      expect(postBody.projectionStale).toBe(true);
      expect(postBody.condition).toBe('field_registry_projection_stale');
    } finally {
      fs.chmodSync(registryFile, 0o644);
      clearProjectionStale(workspaceId);
      // Restore a consistent attestation for any later tests.
      try {
        const okRes = await app.request('/api/field-registry/repair', { method: 'POST' });
        expect(okRes.status).toBe(200);
      } catch { /* non-fatal */ }
    }
  });

  it('F2: a successful POST /api/field-registry/repair clears the marker and reports projectionStale: false', async () => {
    const app = makeApp();
    markProjectionStale(workspaceId, new Date().toISOString());
    expect(isProjectionStale(workspaceId)).toBe(true);

    // R2 is fresh (previous tests repaired it): the repair succeeds, clears
    // the marker, and reports projectionStale: false.
    const res = await app.request('/api/field-registry/repair', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; projectionStale?: boolean };
    expect(body.success).toBe(true);
    expect(body.projectionStale).toBe(false);
    expect(isProjectionStale(workspaceId)).toBe(false);
  });
});
