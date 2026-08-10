import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { listRegistry, upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { bootstrapFromXml } from '../../server/services/sync-service';
import { updateFieldMetadata } from '../../server/services/field-metadata-service';
import type { Workspace } from '../../shared/types';

let root: string;
let workspaceId: string;

const XML = `<SHOP-SITE>
  <PRODUCTLIST>
    <Product>
      <SKU>LABEL-TEST-1</SKU>
      <Name>Label Test Product</Name>
      <ProductField24>Dog Food</ProductField24>
      <ProductField25>Dry Dog Food</ProductField25>
    </Product>
  </PRODUCTLIST>
</SHOP-SITE>`;

describe('bootstrapFromXml label preservation (Extra Fields mirror)', () => {
  beforeAll(() => {
    workspaceId = randomUUID();
    root = fs.mkdtempSync(path.join(os.tmpdir(), `bootstrap-labels-${workspaceId.slice(0, 8)}`));
    fs.mkdirSync(path.join(root, 'products'), { recursive: true });
    fs.mkdirSync(path.join(root, 'store'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '', 'utf-8');

    initDb(path.join(root, '.shopsite-cms', 'app.db'));
    runMigrations();
    // bootstrapFromXml commits the pull to the nested catalog repository.
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
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
  });
  afterAll(() => closeDb());

  it('preserves curated ShopSite-side labels for ProductFieldN across a fresh pull', () => {
    // A previously curated label (the CMS mirror of ShopSite's Extra Fields
    // config) exists in the registry before the pull.
    upsertRegistryEntry({
      id: randomUUID(),
      workspaceId,
      xmlField: 'ProductField24',
      label: 'Facet - Category',
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: 'Custom Fields',
      sampleValuesJson: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = bootstrapFromXml(
      { id: workspaceId, workspacePath: root, name: 'test' } as Workspace,
      XML,
      'xml_text',
    );
    expect(result.success).toBe(true);

    const registry = listRegistry(workspaceId);
    const field24 = registry.find(entry => entry.xmlField === 'ProductField24');
    const field25 = registry.find(entry => entry.xmlField === 'ProductField25');

    // Curated label survives the pull.
    expect(field24?.label).toBe('Facet - Category');
    // A field with no curated label falls back to its tag name (unchanged behavior).
    expect(field25?.label).toBe('ProductField25');
  });

  it('round-trips the pulled ProductField values into the product file', () => {
    const filePath = path.join(root, 'products', 'LABEL-TEST-1.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const product = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { customFields: Record<string, string> };
    expect(product.customFields['ProductField24']).toBe('Dog Food');
    expect(product.customFields['ProductField25']).toBe('Dry Dog Food');
  });

  it('I2: property-level merge — curated metadata survives, observed metadata refreshes, absent fields are kept', () => {
    const ws: Workspace = { id: workspaceId, workspacePath: root, name: 'test' } as Workspace;

    // Seed curated metadata through the canonical field-metadata service so
    // curated_fields_json marks label/uiGroup/dataType as curated (D2).
    updateFieldMetadata({ id: workspaceId, workspacePath: root }, 'ProductField24', {
      label: 'Facet - Category',
      uiGroup: 'Curated Group',
      dataType: 'html',
    });
    // Make the NON-curated properties differ from the incoming normalizer
    // defaults WITHOUT curating them (raw upsert keeps curated_fields_json).
    const seeded = listRegistry(workspaceId).find(entry => entry.xmlField === 'ProductField24')!;
    upsertRegistryEntry({ ...seeded, required: true, editable: false, sampleValuesJson: null });

    // A field present in the DB but absent from the pull must survive the
    // sync (no clearRegistry — sync can never silently delete registry rows).
    updateFieldMetadata({ id: workspaceId, workspacePath: root }, 'ProductField99', { label: 'Ghost Field' });

    const result = bootstrapFromXml(ws, XML, 'xml_text');
    expect(result.success).toBe(true);

    const field24 = listRegistry(workspaceId).find(entry => entry.xmlField === 'ProductField24')!;
    // Curated properties preserved from the DB value.
    expect(field24.label).toBe('Facet - Category');
    expect(field24.uiGroup).toBe('Curated Group');
    expect(field24.dataType).toBe('html');
    // curated_fields_json preserved across the pull.
    expect(JSON.parse(field24.curatedFieldsJson ?? '[]')).toEqual(['dataType', 'label', 'uiGroup']);
    // Non-curated properties refreshed from the incoming observation.
    expect(field24.required).toBe(false);
    expect(field24.editable).toBe(true);
    expect(field24.kind).toBe('custom');
    // sampleValuesJson is always refreshed (observed, never curated).
    expect(JSON.parse(field24.sampleValuesJson ?? '[]')).toEqual(['Dog Food']);

    // A field absent from the pull is kept, with its curated label intact.
    const field99 = listRegistry(workspaceId).find(entry => entry.xmlField === 'ProductField99');
    expect(field99).toBeDefined();
    expect(field99?.label).toBe('Ghost Field');
  });
});
