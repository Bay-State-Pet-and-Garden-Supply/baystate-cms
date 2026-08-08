import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { getDb } from '../../db/connection';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { sha256Hex } from '../../shared/stable-id';
import {
  previewPageImport,
  activatePageImportFromRecords,
  NoopPageParserAdapter,
  noopPageParserAdapter,
  validateRecordsForActivation,
  getActiveVerifiedPageIds,
  resolveVerifiedPageRefs,
  type PageParserAdapter,
} from '../../shopsite/page-import-service';
import {
  getActivePageImport,
  listPageImports,
  getActiveImportRecords,
} from '../../db/repositories/page-import-repo';
import { listVerifiedPageOptions, listPages } from '../../db/repositories/page-repo';
import type { PageRecord } from '../../shared/schemas/page';

/** Fake normalized adapter — synthetic verified records, no XML parsing. */
class FakeAdapter implements PageParserAdapter {
  readonly name = 'fake';
  constructor(private readonly records: PageRecord[]) {}
  parsePagesXml(): PageRecord[] {
    return this.records;
  }
}

const workspaceId = 'ws-page-import-test';

function verifiedRecord(
  key: string,
  name: string,
  parentRef: string | null = null,
  availability: 'available' | 'unavailable' = 'available',
): PageRecord {
  return {
    identity: { kind: 'exported_guid', key, status: 'verified' },
    name,
    parentRef,
    availability,
  };
}

function nameOnlyRecord(name: string): PageRecord {
  return {
    identity: { kind: 'unverified_name_only', key: name, status: 'unverified' },
    name,
    parentRef: null,
    availability: 'unavailable',
  };
}

function freshDb(): string {
  const wsPath = path.join(os.tmpdir(), `page-import-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  const dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
  initDb(dbPath);
  runMigrations();
  insertWorkspace({ id: workspaceId, name: 'test', workspacePath: wsPath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  return wsPath;
}

function sourceHashOf(text: string): string {
  return sha256Hex(text);
}

describe('page-import-service — preview, activation, and verified identity', () => {
  beforeEach(() => {
    // Fresh DB + migrations per test.
    freshDb();
  });

  it('preview has NO database effect and flags name-only records as warnings', () => {
    const db = getDb();
    const before = (db.query('SELECT COUNT(*) AS c FROM page_imports').get() as { c: number }).c;
    const beforeRows = (db.query('SELECT COUNT(*) AS c FROM page_index').get() as { c: number }).c;

    const preview = previewPageImport({
      workspaceId,
      sourceHash: sourceHashOf('source-a'),
      parserFormatVersion: 'pages-xml-1',
      records: [verifiedRecord('guid-1', 'Dog Food'), nameOnlyRecord('Name Only Page')],
    });

    expect(preview.import.status).toBe('previewed');
    expect(preview.records).toHaveLength(1);
    expect(preview.records[0].name).toBe('Dog Food');
    expect(preview.warnings.some(w => w.includes('Name Only Page'))).toBe(true);

    const after = (db.query('SELECT COUNT(*) AS c FROM page_imports').get() as { c: number }).c;
    const afterRows = (db.query('SELECT COUNT(*) AS c FROM page_index').get() as { c: number }).c;
    expect(after).toBe(before);
    expect(afterRows).toBe(beforeRows);
  });

  it('activates atomically with counts, verified status, and availability', () => {
    const adapter = new FakeAdapter([
      verifiedRecord('guid-1', 'Dog Food'),
      verifiedRecord('guid-2', 'Cat Food', 'guid-1'),
      verifiedRecord('guid-3', 'Treats', null, 'unavailable'),
    ]);
    const records = adapter.parsePagesXml();
    const imported = activatePageImportFromRecords({
      workspaceId,
      sourceHash: sourceHashOf('source-a'),
      parserFormatVersion: 'pages-xml-1',
      records,
    });

    expect(imported.status).toBe('active');
    expect(imported.counts.total).toBe(3);
    expect(imported.counts.verified).toBe(3);
    expect(imported.counts.withParent).toBe(1);
    expect(getActivePageImport(workspaceId)?.id).toBe(imported.id);

    // Unavailable records are still imported but are not verified options.
    const options = listVerifiedPageOptions(workspaceId);
    expect(options.map(p => p.name)).toEqual(['Cat Food', 'Dog Food']);
    expect(options.every(p => p.identityStatus === 'verified')).toBe(true);
    const catFood = options.find(p => p.name === 'Cat Food')!;
    expect(catFood.parentId).toBe(options.find(p => p.name === 'Dog Food')!.id);

    const all = listPages();
    const treats = all.find(p => p.name === 'Treats')!;
    expect(treats.identityStatus).toBe('verified');
    expect(treats.availability).toBe('unavailable');
    expect(treats.identityKey).toBe('guid-3');
  });

  it('supersedes the prior active import and marks its un-reactivated rows unavailable', () => {
    const first = activatePageImportFromRecords({
      workspaceId,
      sourceHash: sourceHashOf('source-a'),
      parserFormatVersion: 'pages-xml-1',
      records: [verifiedRecord('guid-1', 'Dog Food'), verifiedRecord('guid-3', 'Treats')],
    });

    const second = activatePageImportFromRecords({
      workspaceId,
      sourceHash: sourceHashOf('source-b'),
      parserFormatVersion: 'pages-xml-2',
      records: [verifiedRecord('guid-1', 'Dog Food'), verifiedRecord('guid-9', 'Birds')],
    });

    const imports = listPageImports(workspaceId);
    expect(imports).toHaveLength(2);
    const firstNow = imports.find(i => i.id === first.id)!;
    expect(firstNow.status).toBe('superseded');
    expect(firstNow.supersededAt).not.toBeNull();
    expect(second.status).toBe('active');

    const db = getDb();
    // guid-1 was re-activated: same row, now tied to the new import, available.
    const dogRow = db.query(
      'SELECT id, import_id, availability FROM page_index WHERE identity_key = ?',
    ).get('guid-1') as { id: string; import_id: string | null; availability: string };
    expect(dogRow.import_id).toBe(second.id);
    expect(dogRow.availability).toBe('available');

    // guid-3 was NOT re-activated: its row stays tied to the superseded
    // import and is no longer a verified option.
    const treatsRow = db.query(
      'SELECT id, import_id, availability FROM page_index WHERE identity_key = ?',
    ).get('guid-3') as { id: string; import_id: string | null; availability: string };
    expect(treatsRow.import_id).toBe(first.id);
    expect(treatsRow.availability).toBe('unavailable');

    expect(listVerifiedPageOptions(workspaceId).map(p => p.name)).toEqual(['Birds', 'Dog Food']);
  });

  it('preserves local row IDs across re-activation by verified identity key', () => {
    const first = activatePageImportFromRecords({
      workspaceId,
      sourceHash: sourceHashOf('source-a'),
      parserFormatVersion: 'pages-xml-1',
      records: [verifiedRecord('guid-1', 'Dog Food'), verifiedRecord('guid-2', 'Cat Food')],
    });
    const idsBefore = new Map(
      listVerifiedPageOptions(workspaceId).map(p => [p.name, p.id]),
    );
    void first;

    activatePageImportFromRecords({
      workspaceId,
      sourceHash: sourceHashOf('source-b'),
      parserFormatVersion: 'pages-xml-1',
      records: [verifiedRecord('guid-2', 'Cat Food'), verifiedRecord('guid-1', 'Dog Food')],
    });

    const idsAfter = new Map(
      listVerifiedPageOptions(workspaceId).map(p => [p.name, p.id]),
    );
    expect(idsAfter.get('Dog Food')).toBe(idsBefore.get('Dog Food'));
    expect(idsAfter.get('Cat Food')).toBe(idsBefore.get('Cat Food'));
    expect(idsAfter.size).toBe(2);
  });

  it('allows duplicate page names with distinct verified identity keys', () => {
    activatePageImportFromRecords({
      workspaceId,
      sourceHash: sourceHashOf('source-a'),
      parserFormatVersion: 'pages-xml-1',
      records: [verifiedRecord('guid-1', 'Dog Food'), verifiedRecord('guid-2', 'Dog Food')],
    });
    const options = listVerifiedPageOptions(workspaceId);
    expect(options.filter(p => p.name === 'Dog Food')).toHaveLength(2);
    expect(new Set(options.map(p => p.identityKey))).toHaveLength(2);
  });

  it('refuses to activate name-only identities', () => {
    expect(() =>
      activatePageImportFromRecords({
        workspaceId,
        sourceHash: sourceHashOf('source-a'),
        parserFormatVersion: 'pages-xml-1',
        records: [verifiedRecord('guid-1', 'Dog Food'), nameOnlyRecord('Name Only')],
      }),
    ).toThrow(/unverified name-only identity/);
    expect(getActivePageImport(workspaceId)).toBeNull();
  });

  it('rejects duplicate identity keys in one batch', () => {
    const validation = validateRecordsForActivation([
      verifiedRecord('guid-1', 'A'),
      verifiedRecord('guid-1', 'B'),
    ]);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.reason).toContain('Duplicate identity key');
  });

  it('NoopPageParserAdapter fails closed until a real parser exists', () => {
    const adapter: PageParserAdapter = noopPageParserAdapter;
    expect(adapter.name).toBe('noop');
    expect(() => adapter.parsePagesXml('<Pages></Pages>')).toThrow(/No ShopSite Pages XML parser is registered/);
    expect(() => new NoopPageParserAdapter().parsePagesXml('')).toThrow(/No ShopSite Pages XML parser/);
  });

  it('resolves verified page refs against the active import and refuses everything else', () => {
    activatePageImportFromRecords({
      workspaceId,
      sourceHash: sourceHashOf('source-a'),
      parserFormatVersion: 'pages-xml-1',
      records: [verifiedRecord('guid-1', 'Dog Food')],
    });
    const verifiedId = getActiveVerifiedPageIds(workspaceId).values().next().value as string;

    const { verified, unverified } = resolveVerifiedPageRefs(workspaceId, [
      { pageId: verifiedId, pageName: 'Dog Food' },
      { pageId: 'synthetic-uuid', pageName: 'Name Only' },
      { pageId: null, pageName: 'Also Name Only' },
    ]);
    expect(verified).toHaveLength(1);
    expect(verified[0].pageName).toBe('Dog Food');
    expect(unverified.map(u => u.pageName)).toEqual(['Name Only', 'Also Name Only']);
  });

  it('returns an empty verified catalog when no active import exists', () => {
    expect(getActiveImportRecords(workspaceId)).toEqual([]);
    expect(getActiveVerifiedPageIds(workspaceId).size).toBe(0);
    const { verified, unverified } = resolveVerifiedPageRefs(workspaceId, [
      { pageId: 'anything', pageName: 'Anything' },
    ]);
    expect(verified).toHaveLength(0);
    expect(unverified).toHaveLength(1);
  });
});
