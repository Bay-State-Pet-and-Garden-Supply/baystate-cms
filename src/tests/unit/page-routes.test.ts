import { beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { sha256Hex } from '../../shared/stable-id';
import pageRoutes from '../../server/routes/page-routes';

const workspaceId = 'ws-page-routes';

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', pageRoutes);
  return app;
}

function verifiedRecord(key: string, name: string) {
  return {
    identity: { kind: 'exported_guid', key, status: 'verified' },
    name,
    parentRef: null,
    availability: 'available',
  };
}

function nameOnlyRecord(name: string) {
  return {
    identity: { kind: 'unverified_name_only', key: name, status: 'unverified' },
    name,
    parentRef: null,
    availability: 'unavailable',
  };
}

beforeEach(() => {
  const workspacePath = path.join(os.tmpdir(), `page-routes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
});

describe('page routes — preview/activation seam, disabled legacy mutations', () => {
  it('returns pages and exposes verified options', async () => {
    const app = makeApp();
    const empty = await app.request('/api/pages');
    expect(empty.status).toBe(200);

    const options = await app.request('/api/pages/verified-options');
    expect(options.status).toBe(200);
    const body = (await options.json()) as { pages: unknown[] };
    expect(body.pages).toEqual([]);
  });

  it('disables the legacy unrestricted upsert/delete endpoints (410)', async () => {
    const app = makeApp();
    const upsert = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Synthetic Page' }),
    });
    expect(upsert.status).toBe(410);

    const del = await app.request('/api/pages/whatever-id', { method: 'DELETE' });
    expect(del.status).toBe(410);
  });

  it('import preview returns counts and warnings with NO database effect', async () => {
    const app = makeApp();
    const before = (getDb().query('SELECT COUNT(*) AS c FROM page_imports').get() as { c: number }).c;

    const res = await app.request('/api/pages/import/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceHash: sha256Hex('src'),
        parserFormatVersion: 'pages-xml-1',
        records: [verifiedRecord('guid-1', 'Dog Food'), nameOnlyRecord('Name Only')],
      }),
    });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as {
      import: { status: string; counts: { total: number; verified: number; nameOnly: number } };
      warnings: string[];
    };
    expect(preview.import.status).toBe('previewed');
    expect(preview.import.counts.total).toBe(2);
    expect(preview.warnings.length).toBe(1);

    const after = (getDb().query('SELECT COUNT(*) AS c FROM page_imports').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('activates an import atomically and surfaces verified options', async () => {
    const app = makeApp();
    const res = await app.request('/api/pages/import/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceHash: sha256Hex('src-a'),
        parserFormatVersion: 'pages-xml-1',
        records: [verifiedRecord('guid-1', 'Dog Food'), verifiedRecord('guid-2', 'Cat Food')],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; import: { status: string } };
    expect(body.success).toBe(true);
    expect(body.import.status).toBe('active');

    const optionsRes = await app.request('/api/pages/verified-options');
    const optionsBody = (await optionsRes.json()) as { pages: Array<{ name: string; identityStatus: string }> };
    expect(optionsBody.pages.map(p => p.name)).toEqual(['Cat Food', 'Dog Food']);
    expect(optionsBody.pages.every(p => p.identityStatus === 'verified')).toBe(true);
  });

  it('rejects activation containing name-only identities', async () => {
    const app = makeApp();
    const res = await app.request('/api/pages/import/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceHash: sha256Hex('src-a'),
        parserFormatVersion: 'pages-xml-1',
        records: [verifiedRecord('guid-1', 'Dog Food'), nameOnlyRecord('Name Only')],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('unverified name-only');
  });

  it('refuses product page assignment for unverified names (409)', async () => {
    const app = makeApp();
    await app.request('/api/pages/import/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceHash: sha256Hex('src-a'),
        parserFormatVersion: 'pages-xml-1',
        records: [verifiedRecord('guid-1', 'Dog Food')],
      }),
    });

    const res = await app.request('/api/products/SKU-1/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages: ['Name Only'] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Refusing to assign unverified page identity');

    // Verified names still assign.
    const ok = await app.request('/api/products/SKU-1/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages: ['Dog Food'] }),
    });
    expect(ok.status).toBe(200);
    const pagesRes = await app.request('/api/products/SKU-1/pages');
    const pagesBody = (await pagesRes.json()) as { pages: string[] };
    expect(pagesBody.pages).toEqual(['Dog Food']);
  });
});
