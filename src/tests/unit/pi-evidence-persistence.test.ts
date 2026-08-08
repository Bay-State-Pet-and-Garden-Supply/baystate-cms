/**
 * PI smoke-fix tests: durable per-tool evidence persistence (finding A),
 * source dedupe, the metadata evidence-id query, the terminal citation
 * reconciliation, and replay cloning of evidence rows.
 *
 * DB-backed (bun test).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/19
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createPiRun,
  insertPiResult,
  listPiEvidence,
  listPiEvidenceByToolEvidenceId,
  listPiSources,
  transitionPiRunStatus,
} from '../../db/repositories/product-intelligence-repo';
import { PersistingExecutionEventSink, persistToolEvidence, replayPiRun } from '../../product-intelligence/run-service';
import { buildDefaultPiPolicy } from '../../product-intelligence/run-service';
import type { ProductIntelligencePolicy } from '../../product-intelligence/contracts';

const workspaceId = 'ws-pi-evidence-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

function makeRun(executor = 'pi'): string {
  const policy: ProductIntelligencePolicy = buildDefaultPiPolicy();
  const run = createPiRun({
    workspaceId,
    mode: 'shadow',
    executor,
    inputJson: JSON.stringify({ gtin: '085000079585', registerName: 'TEST' }),
    policyJson: JSON.stringify(policy),
    configSnapshotId: policy.configId,
    configSnapshotHash: policy.configId,
  });
  return run.id;
}

const EVIDENCE = [
  {
    id: 'ev-search-1',
    kind: 'search_lead',
    url: 'https://brand.example.com/p/product',
    domain: 'brand.example.com',
    method: 'search_upc',
    snippet: 'product page',
  },
  {
    id: 'ev-gtin-1',
    kind: 'gtin_evidence',
    url: 'https://brand.example.com/p/product',
    domain: 'brand.example.com',
    method: 'verify_candidate_page',
    snippet: 'gtin present',
  },
];

describe('PI per-tool evidence persistence (smoke finding A)', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-evidence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('persists tool evidence durably through the sink and dedupes sources by url', () => {
    const runId = makeRun();
    const sink = new PersistingExecutionEventSink(runId);

    sink.emit('tool_call_started', { toolName: 'search_upc', data: { callIndex: 1 } });
    sink.emit('tool_call_finished', { toolName: 'search_upc', evidence: EVIDENCE as never });
    // Second call with the same URL — the source must not duplicate.
    sink.emit('tool_call_started', { toolName: 'verify_candidate_page', data: { callIndex: 2 } });
    sink.emit('tool_call_finished', { toolName: 'verify_candidate_page', evidence: [EVIDENCE[1]] as never });

    const sources = listPiSources(runId);
    const evidence = listPiEvidence(runId);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe('https://brand.example.com/p/product');
    expect(evidence).toHaveLength(2);
    const ids = evidence.map((row) => (JSON.parse(row.metadataJson ?? '{}') as { toolEvidenceId?: string }).toolEvidenceId).sort();
    expect(ids).toEqual(['ev-gtin-1', 'ev-search-1']);
    expect(evidence.every((row) => row.sourceId === sources[0].id)).toBe(true);
  });

  it('skips evidence without a source URL (never dangles) and is idempotent', () => {
    const runId = makeRun();
    const sink = new PersistingExecutionEventSink(runId);
    sink.emit('tool_call_finished', {
      toolName: 'validate_gtin',
      evidence: [{ id: 'ev-no-url', kind: 'gtin_evidence', method: 'validate_gtin' }] as never,
    });
    expect(listPiEvidence(runId)).toHaveLength(0);
    // Re-emitting the same evidence id is a no-op.
    sink.emit('tool_call_finished', { toolName: 'x', evidence: EVIDENCE as never });
    sink.emit('tool_call_finished', { toolName: 'x', evidence: EVIDENCE as never });
    expect(listPiEvidence(runId)).toHaveLength(2);
  });

  it('resolves cited evidence ids via listPiEvidenceByToolEvidenceId', () => {
    const runId = makeRun();
    const sink = new PersistingExecutionEventSink(runId);
    sink.emit('tool_call_finished', { toolName: 'x', evidence: EVIDENCE as never });
    const rows = listPiEvidenceByToolEvidenceId(runId, ['ev-gtin-1']);
    expect(rows).toHaveLength(1);
    expect((JSON.parse(rows[0].metadataJson!) as { toolEvidenceId?: string }).toolEvidenceId).toBe('ev-gtin-1');
    expect(listPiEvidenceByToolEvidenceId(runId, [])).toHaveLength(0);
    expect(listPiEvidenceByToolEvidenceId(runId, ['missing'])).toHaveLength(0);
  });

  it('persistToolEvidence works on failed runs (deadline runs still leave a trail)', () => {
    const runId = makeRun();
    transitionPiRunStatus(runId, 'failed', { errorCode: 'deadline_exceeded', errorMessage: 'timeout' });
    const events: Array<{ type: string; payload: unknown }> = [];
    persistToolEvidence(runId, EVIDENCE, (type, payload) => events.push({ type, payload }));
    expect(listPiSources(runId)).toHaveLength(1);
    expect(listPiEvidence(runId)).toHaveLength(2);
    expect(events.some((e) => e.type === 'source.added')).toBe(true);
  });

  it('deterministic replay clones sources and evidence rows with preserved metadata', async () => {
    const originId = makeRun();
    const sink = new PersistingExecutionEventSink(originId);
    sink.emit('tool_call_finished', { toolName: 'x', evidence: EVIDENCE as never });
    const policy: ProductIntelligencePolicy = buildDefaultPiPolicy();
    transitionPiRunStatus(originId, 'completed', {});
    insertPiResult({
      runId: originId,
      schemaVersion: 1,
      disposition: 'submitted',
      result: {
        runId: originId,
        outcome: 'submitted',
        executor: 'pi',
        executorVersion: '1.0.0',
        extensionVersions: [],
        configId: policy.configId,
        durationMs: 1,
        submission: null,
        failure: null,
        events: [],
      },
    });

    const replay = await replayPiRun(originId, { mode: 'deterministic' });
    const originSources = listPiSources(originId);
    const replaySources = listPiSources(replay.run.id);
    const replayEvidence = listPiEvidence(replay.run.id);
    expect(replaySources).toHaveLength(originSources.length);
    expect(replayEvidence).toHaveLength(2);
    expect(
      replayEvidence.map((row) => (JSON.parse(row.metadataJson ?? '{}') as { toolEvidenceId?: string }).toolEvidenceId).sort(),
    ).toEqual(['ev-gtin-1', 'ev-search-1']);
  });

  it('persists FIELD-LEVEL evidence as per-field rows with value + method + path (P1-4)', () => {
    const runId = makeRun();
    const sink = new PersistingExecutionEventSink(runId);
    sink.emit('tool_call_finished', {
      toolName: 'extract_product_page',
      evidence: [
        {
          id: 'extract_product_page:abc:title:def',
          field: 'title',
          value: 'Feline Wormeze Liquid 4oz',
          method: 'json_ld',
          path: 'jsonLd.name',
          snippet: 'Feline Wormeze Liquid 4oz',
          url: 'https://brand.example.com/p/product',
          domain: 'brand.example.com',
        },
        {
          id: 'extract_product_page:abc:size:ghij',
          field: 'size',
          value: '16 oz',
          method: 'json_ld',
          path: 'jsonLd.offers.size',
          snippet: '16 oz',
          url: 'https://brand.example.com/p/product',
          domain: 'brand.example.com',
        },
        {
          id: 'extract_product_page:abc:gtin:klm',
          field: 'gtin',
          value: '745801105447',
          method: 'json_ld.gtin',
          path: 'json_ld.gtin',
          snippet: '745801105447',
          url: 'https://brand.example.com/p/product',
          domain: 'brand.example.com',
        },
      ] as never,
    });

    const evidence = listPiEvidence(runId);
    expect(evidence).toHaveLength(3);
    const byField = Object.fromEntries(evidence.map((row) => [row.targetField, row]));
    expect(Object.keys(byField).sort()).toEqual(['gtin', 'size', 'title']);

    // Each row carries the ACTUAL extracted value (not the coarse id wrapper).
    expect(JSON.parse(byField['size'].valueJson)).toBe('16 oz');
    expect(JSON.parse(byField['title'].valueJson)).toBe('Feline Wormeze Liquid 4oz');
    expect(JSON.parse(byField['gtin'].valueJson)).toBe('745801105447');

    // Method + snippet persisted.
    expect(byField['size'].extractionMethod).toBe('json_ld');
    expect(byField['gtin'].extractionMethod).toBe('json_ld.gtin');
    expect(byField['title'].snippet).toBe('Feline Wormeze Liquid 4oz');

    // Field-specific durable ids in metadata (UNIQUE per field).
    const toolIds = evidence.map((row) => (JSON.parse(row.metadataJson ?? '{}') as { toolEvidenceId?: string }).toolEvidenceId);
    expect(new Set(toolIds).size).toBe(3);
    expect(toolIds).toContain('extract_product_page:abc:size:ghij');
  });

  it('reconstructs field = value supported by path from persisted rows alone (P1-4)', () => {
    const runId = makeRun();
    const sink = new PersistingExecutionEventSink(runId);
    sink.emit('tool_call_finished', {
      toolName: 'extract_product_page',
      evidence: [
        {
          id: 'epp:url:size:abc',
          field: 'size',
          value: '16 oz',
          method: 'json_ld',
          path: 'jsonLd.offers.size',
          url: 'https://brand.example.com/p/product',
          domain: 'brand.example.com',
        },
      ] as never,
    });

    const rows = listPiEvidence(runId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const meta = JSON.parse(row.metadataJson ?? '{}') as { toolEvidenceId?: string; path?: string };
    // The reviewer can reconstruct the full claim from the durable row alone:
    // field = value supported by path.
    expect(row.targetField).toBe('size');
    expect(JSON.parse(row.valueJson)).toBe('16 oz');
    expect(row.extractionMethod).toBe('json_ld');
    expect(meta.path).toBe('jsonLd.offers.size');
    expect(meta.toolEvidenceId).toBe('epp:url:size:abc');
    expect(`${row.targetField} = ${JSON.parse(row.valueJson)} supported by ${meta.path}`).toBe(
      'size = 16 oz supported by jsonLd.offers.size',
    );
    // And it resolves through the tool-evidence-id query used by citations.
    const cited = listPiEvidenceByToolEvidenceId(runId, ['epp:url:size:abc']);
    expect(cited).toHaveLength(1);
    expect(cited[0].targetField).toBe('size');
  });

  it('keeps legacy page-level evidence behavior intact alongside field entries (P1-4)', () => {
    const runId = makeRun();
    const sink = new PersistingExecutionEventSink(runId);
    // Legacy entry (kind-based, coarse value wrapper) + field entry in one event.
    sink.emit('tool_call_finished', {
      toolName: 'extract_product_page',
      evidence: [
        {
          id: 'ev-page-agg',
          kind: 'search_lead',
          url: 'https://brand.example.com/p/product',
          domain: 'brand.example.com',
          method: 'ladder',
          snippet: 'page-level',
        },
        {
          id: 'epp:url:brand:x',
          field: 'brand',
          value: 'Farnam',
          method: 'json_ld',
          path: 'jsonLd.brand.name',
          url: 'https://brand.example.com/p/product',
          domain: 'brand.example.com',
        },
      ] as never,
    });

    const evidence = listPiEvidence(runId);
    expect(evidence).toHaveLength(2);
    const legacy = evidence.find((row) => row.targetField === 'search_lead')!;
    const fieldRow = evidence.find((row) => row.targetField === 'brand')!;
    // Legacy: kind -> targetField, coarse { evidenceId, snippet } value.
    expect(legacy.extractionMethod).toBe('ladder');
    const legacyValue = JSON.parse(legacy.valueJson) as { evidenceId?: string; snippet?: string };
    expect(legacyValue.evidenceId).toBe('ev-page-agg');
    expect(legacyValue.snippet).toBe('page-level');
    // Field entry: actual value + path metadata.
    expect(JSON.parse(fieldRow.valueJson)).toBe('Farnam');
    expect((JSON.parse(fieldRow.metadataJson ?? '{}') as { path?: string }).path).toBe('jsonLd.brand.name');
  });

  it('dedupes field-level entries by id (idempotent re-emission, P1-4)', () => {
    const runId = makeRun();
    const sink = new PersistingExecutionEventSink(runId);
    const fieldEvidence = [
      {
        id: 'epp:url:size:abc',
        field: 'size',
        value: '16 oz',
        method: 'json_ld',
        path: 'jsonLd.offers.size',
        url: 'https://brand.example.com/p/product',
        domain: 'brand.example.com',
      },
    ] as never;
    sink.emit('tool_call_finished', { toolName: 'x', evidence: fieldEvidence });
    sink.emit('tool_call_finished', { toolName: 'x', evidence: fieldEvidence });
    const evidence = listPiEvidence(runId);
    expect(evidence).toHaveLength(1);
    expect(JSON.parse(evidence[0].valueJson)).toBe('16 oz');
    const sources = listPiSources(runId);
    expect(sources).toHaveLength(1);
  });

  it('persists OCR field-level evidence bound to the exact downloaded image bytes (round-4)', () => {
    const runId = makeRun();
    const sink = new PersistingExecutionEventSink(runId);
    const contentHash = 'sha256-of-image-a';
    const ocrEvidence = [
      {
        id: 'extract_packaging_evidence:hash:productName:h1',
        field: 'productName',
        value: 'Feline Wormeze Liquid',
        method: 'image_ocr',
        url: 'https://cdn.example.com/wormeze.jpg',
        domain: 'cdn.example.com',
        contentHash,
      },
      {
        id: 'extract_packaging_evidence:hash:size:h2',
        field: 'size',
        value: '4 oz',
        method: 'image_ocr',
        url: 'https://cdn.example.com/wormeze.jpg',
        domain: 'cdn.example.com',
        contentHash,
      },
    ] as never;
    sink.emit('tool_call_finished', { toolName: 'extract_packaging_evidence', evidence: ocrEvidence });
    const rows = listPiEvidence(runId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const meta = JSON.parse(row.metadataJson ?? '{}') as { toolEvidenceId?: string; contentHash?: string };
      expect(row.extractionMethod).toBe('image_ocr');
      expect(meta.contentHash).toBe(contentHash);
      expect(meta.toolEvidenceId).toContain('extract_packaging_evidence:');
    }
    // The citation path resolves them by the agent-visible deterministic id.
    const byField = Object.fromEntries(rows.map((r) => [r.targetField, r]));
    expect(JSON.parse(byField['productName'].valueJson)).toBe('Feline Wormeze Liquid');
    expect(JSON.parse(byField['size'].valueJson)).toBe('4 oz');
    // Both rows share one deduped source row for the image URL.
    expect(listPiSources(runId)).toHaveLength(1);
  });
});
