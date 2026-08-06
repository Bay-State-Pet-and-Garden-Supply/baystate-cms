/**
 * PI-10 per-category retention policies (issue #27): tool-call metadata,
 * sources, assets, raw fetched-content refs, model request/response artifact
 * refs, and run metadata each expire independently; child rows are purged
 * before run metadata, and deleting sources must never orphan assets (SET
 * NULL keeps them).
 *
 * DB-backed (bun test).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/27
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createPiRun, getPiRun, insertPiSource, insertPiToolCall } from '../../db/repositories/product-intelligence-repo';
import {
  applyPiRetention,
  getPiRetentionPolicy,
  olderThanDaysPolicy,
  setPiRetentionPolicy,
} from '../../product-intelligence/retention';

const workspaceId = 'ws-pi-retention-test';
const OTHER_WS = 'ws-pi-retention-other';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

function makeRun(ws = workspaceId, startedAtIso?: string): string {
  const run = createPiRun({
    workspaceId: ws,
    mode: 'shadow',
    executor: 'pi',
    inputJson: JSON.stringify({ gtin: '085000079585' }),
    policyJson: JSON.stringify({ configId: 'c' }),
    configSnapshotId: 'c',
    configSnapshotHash: 'c',
  });
  if (startedAtIso) {
    getDb().run(`UPDATE product_intelligence_runs SET started_at = ?, completed_at = ? WHERE id = ?`, [
      startedAtIso,
      startedAtIso,
      run.id,
    ]);
  }
  return run.id;
}

/** Rewrite a row's timestamp column so it is "older" than any cutoff. */
function ageTable(column: 'started_at' | 'created_at', table: string, runId: string, iso: string) {
  getDb().run(`UPDATE ${table} SET ${column} = ? WHERE run_id = ?`, [iso, runId]);
}

const OLD = '2020-01-01T00:00:00.000Z';
const NOW_ISH = new Date().toISOString();

describe('PI-10 retention policies', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-retention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
    seedWorkspace(OTHER_WS, wsPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('defaults to keep-everything and persists round-trip', () => {
    expect(getPiRetentionPolicy(workspaceId)).toEqual({});
    setPiRetentionPolicy(workspaceId, { sourcesDays: 30, imagesDays: 90 });
    expect(getPiRetentionPolicy(workspaceId)).toEqual({ sourcesDays: 30, imagesDays: 90 });
  });

  it('olderThanDaysPolicy applies one age to every category', () => {
    expect(olderThanDaysPolicy(14)).toEqual({
      metadataDays: 14,
      toolCallsDays: 14,
      sourcesDays: 14,
      rawContentDays: 14,
      modelArtifactsDays: 14,
      imagesDays: 14,
    });
  });

  it('deletes old tool-call metadata while the run survives', () => {
    const run = makeRun();
    insertPiToolCall({ runId: run, stepId: null, sequence: 0, toolName: 'search_upc' });
    insertPiToolCall({ runId: run, stepId: null, sequence: 1, toolName: 'search_upc' });
    ageTable('started_at', 'product_intelligence_tool_calls', run, OLD);
    const result = applyPiRetention(workspaceId, { toolCallsDays: 30 });
    expect(result.toolCallsDeleted).toBe(2);
    expect((getDb().query('SELECT COUNT(*) AS c FROM product_intelligence_tool_calls').get() as { c: number }).c).toBe(0);
    expect(getPiRun(run)).toBeDefined(); // metadata kept
  });

  it('clears model request/response artifact refs without deleting the call', () => {
    const run = makeRun();
    insertPiToolCall({ runId: run, stepId: null, sequence: 0, toolName: 'search_upc' });
    ageTable('started_at', 'product_intelligence_tool_calls', run, OLD);
    getDb().run(`UPDATE product_intelligence_tool_calls SET artifact_ref = 'art://x' WHERE run_id = ?`, [run]);
    const result = applyPiRetention(workspaceId, { modelArtifactsDays: 30 });
    expect(result.toolArtifactRefsCleared).toBe(1);
    const row = getDb().query('SELECT artifact_ref AS a FROM product_intelligence_tool_calls WHERE run_id = ?').get(run) as { a: string | null };
    expect(row.a).toBeNull();
  });

  it('deletes old sources; assets survive via source_id SET NULL', () => {
    const run = makeRun();
    const source = insertPiSource({
      runId: run,
      url: 'https://example.com/a',
      domain: 'example.com',
      sourceType: 'retailer',
    });
    ageTable('created_at', 'product_intelligence_sources', run, OLD);
    // A durable asset row referencing the source (as PI-6 persists them).
    getDb().run(
      `INSERT INTO product_intelligence_assets
         (id, run_id, source_id, source_url, source_type, extraction_method, retrieved_at,
          original_content_hash, rights_status, quality_status, payload_json, created_at)
       VALUES ('asset-1', ?, ?, 'https://example.com/a', 'retailer', 'json_ld', ?,
          'abc123', 'approved', 'usable', '{}', ?)`,
      [run, source.id, NOW_ISH, NOW_ISH],
    );
    console.log('SRC-DEBUG sources:', JSON.stringify(getDb().query('SELECT id, created_at, run_id FROM product_intelligence_sources').all()));
    const result = applyPiRetention(workspaceId, { sourcesDays: 30 });
    console.log('FULL-RESULT', JSON.stringify(result), 'runs', JSON.stringify(getDb().query('SELECT COUNT(*) c FROM product_intelligence_runs').all()));
    expect(result.sourcesDeleted).toBe(1);
    const asset = getDb().query('SELECT source_id AS s FROM product_intelligence_assets WHERE id = ?').get('asset-1') as { s: string | null };
    expect(asset.s).toBeNull(); // SET NULL keeps the asset
  });

  it('clears raw fetched-content refs on old sources', () => {
    const run = makeRun();
    insertPiSource({ runId: run, url: 'https://example.com/b', domain: 'example.com', sourceType: 'retailer' });
    ageTable('created_at', 'product_intelligence_sources', run, OLD);
    getDb().run(`UPDATE product_intelligence_sources SET artifact_ref = 'art://raw', content_hash = 'h' WHERE run_id = ?`, [run]);
    const result = applyPiRetention(workspaceId, { rawContentDays: 7 });
    expect(result.sourceArtifactRefsCleared).toBe(1);
    const row = getDb().query('SELECT artifact_ref AS a, content_hash AS h FROM product_intelligence_sources WHERE run_id = ?').get(run) as {
      a: string | null;
      h: string | null;
    };
    expect(row.a).toBeNull();
    expect(row.h).toBeNull();
  });

  it('deletes old image/asset rows', () => {
    const run = makeRun();
    getDb().run(
      `INSERT INTO product_intelligence_assets
         (id, run_id, source_id, source_url, source_type, extraction_method, retrieved_at,
          original_content_hash, rights_status, quality_status, payload_json, created_at)
       VALUES ('asset-old', ?, NULL, 'https://example.com/img', 'retailer', 'json_ld', ?, 'abc', 'approved', 'usable', '{}', ?)`,
      [run, OLD, OLD],
    );
    getDb().run(
      `INSERT INTO product_intelligence_assets
         (id, run_id, source_id, source_url, source_type, extraction_method, retrieved_at,
          original_content_hash, rights_status, quality_status, payload_json, created_at)
       VALUES ('asset-new', ?, NULL, 'https://example.com/img2', 'retailer', 'json_ld', ?, 'abc', 'approved', 'usable', '{}', ?)`,
      [run, NOW_ISH, NOW_ISH],
    );
    const result = applyPiRetention(workspaceId, { imagesDays: 30 });
    expect(result.assetsDeleted).toBe(1);
    expect(getDb().query("SELECT id FROM product_intelligence_assets WHERE id = 'asset-old'").get()).toBeNull();
    expect(getDb().query("SELECT id FROM product_intelligence_assets WHERE id = 'asset-new'").get()).toBeDefined();
  });

  it('run-metadata cleanup removes old terminal runs (and only that workspace)', () => {
    makeRun(workspaceId, OLD); // old, terminal-ish (no status transition → running)…
    makeRun(OTHER_WS, OLD);
    // Only terminal runs are eligible; mark both old runs completed.
    getDb().run(`UPDATE product_intelligence_runs SET status = 'completed'`);
    const result = applyPiRetention(workspaceId, { metadataDays: 365 });
    expect(result.runsDeleted).toBe(1);
    expect(getDb().query('SELECT COUNT(*) AS c FROM product_intelligence_runs').get() as { c: number }).toMatchObject({ c: 1 });
  });

  it('applies nothing when every category is unset', () => {
    const run = makeRun();
    insertPiToolCall({ runId: run, stepId: null, sequence: 0, toolName: 'search_upc' });
    const result = applyPiRetention(workspaceId, {});
    expect(result).toEqual({
      toolCallsDeleted: 0,
      sourcesDeleted: 0,
      assetsDeleted: 0,
      runsDeleted: 0,
      toolArtifactRefsCleared: 0,
      sourceArtifactRefsCleared: 0,
    });
  });
});
