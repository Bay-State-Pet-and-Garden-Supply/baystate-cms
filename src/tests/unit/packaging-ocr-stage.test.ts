/**
 * P2-T2 (packaging-OCR overhaul) — the `packaging_ocr` classification stage.
 *
 * Covers: flag-off inertness (byte-identical legacy state), active non-shadow
 * persistence (data + both hashes through the repo), distributor/null-image
 * skip-not-fail, shadow-mode isolation (live keys untouched,
 * `shadowPackagingOcrData` only), run-bound plan-compat denial as a CODED
 * failure (never a throw), durable audit-row lifecycle
 * (insertModelCallStart/completeModelCall), and evidence_extraction consuming
 * fresh stage output.
 *
 * DB-backed (bun:test) because the stage transitively imports bun:sqlite
 * repositories (same reason packaging-ocr-attempt.test.ts runs under
 * `bun test`, not vitest).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import {
  generateCandidate,
} from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, computeOcrExecutionDigest } from '../../classification/runtime-snapshot';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  overrideOcrStageFlags,
  resetOcrStageFlagsOverride,
} from '../../classification/ocr-stage-flags';
import { packagingOcrStage, getAuthoritativePackagingOcrStageOutput } from '../../classification/stages/packaging-ocr-stage';
import { evidenceExtractionStage } from '../../classification/stages/evidence-extraction';
import type { StageContext, StageInput } from '../../classification/types';

let tmpDir: string;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HB_EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

/** Local Ollama-native /api/chat stand-in returning a fixed OCR JSON payload. */
function startOllamaServer(ocrJson: Record<string, unknown>): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { content: JSON.stringify(ocrJson) } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

const STAGE_OCR_JSON = {
  productName: 'Stage Kibble',
  brand: 'Acme',
  species: ['dog'],
  weight: '5 lb',
  visibleTextLines: ['STAGE KIBBLE', 'NET WT 5 LB'],
  confidenceByField: { productName: 0.95, weight: 0.9 },
};

let workspaceId: string;
let workspacePath: string;

function seedWorkspace(): void {
  workspaceId = randomUUID();
  workspacePath = path.join(tmpDir, 'ws');
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  insertWorkspace({
    id: workspaceId,
    name: 'stage-test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

/** >1KiB local image so loadImageWithReason resolves it from disk (no network). */
function seedLocalImage(): string {
  const imgPath = path.join(workspacePath, 'img-primary.bin');
  fs.writeFileSync(imgPath, Buffer.alloc(2048, 0x64));
  return imgPath;
}

interface ItemSpec {
  batchId?: string;
  ext?: Record<string, unknown>;
  sourceType?: 'official_page' | 'distributor_record';
  upc?: string;
}

function seedItem(spec: ItemSpec = {}) {
  const batchId = spec.batchId ?? createBatch({ workspaceId, name: 'B', fileName: 'b.xlsx', totalItems: 1 }).id;
  const [item] = insertItems(batchId, [
    { upc: spec.upc ?? randomUUID().slice(0, 13), name: 'Test Product', brandHint: 'Acme', rowNumber: 1 },
  ]);
  if (spec.ext) {
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?')
      .run(JSON.stringify(spec.ext), item.id);
  }
  if (spec.sourceType) {
    getDb().query('UPDATE onboarding_items SET source_type = ? WHERE id = ?')
      .run(spec.sourceType, item.id);
  }
  return findItemById(item.id)!;
}

/**
 * Run-bound (schema-v2) snapshot whose FROZEN local VLM route points at the
 * given loopback base URL — captured at snapshot-build time exactly like the
 * freeze engine (`captureLocalVlmConfig`).
 */
function makeSnapshot(vlmBaseUrl: string | null) {
  if (vlmBaseUrl) {
    upsertApiKey('ollama_vlm', 'enabled', vlmBaseUrl, 'stage-test-vlm');
  }
  const candidate = generateCandidate(BayStatePetGardenSeed, HB_EVIDENCE);
  return buildRuntimeSnapshot({
    workspaceId,
    workspacePath,
    productSku: 'SKU-STAGE',
    authority: { kind: 'v2' as const, bundle: candidate.bundle },
    configSnapshotRef: {
      id: candidate.bundle.manifest.bundleHash,
      hash: candidate.bundle.manifest.bundleHash,
      sourceCommit: null,
      createdAt: new Date().toISOString(),
    },
    sourceProductHash: '',
  });
}

function makeContext(overrides: Partial<StageContext> = {}, snapshot?: ReturnType<typeof makeSnapshot> | null): StageContext {
  return {
    workspacePath,
    workspaceId,
    configSnapshotRef: { id: 'ctx-snap', hash: 'ctx-snap-hash', sourceCommit: null, createdAt: new Date().toISOString() },
    // A REAL persisted run row — model-call audit rows carry an FK on it.
    runId: String(createRun(workspaceId, 'SKU-STAGE', null, null, { sourceKind: 'onboarding' }).id),
    // Native transport — immune to cross-file globalThis.fetch stubs.
    modelFetchFn: ((globalThis as any).Bun?.fetch ?? globalThis.fetch) as StageContext['modelFetchFn'],
    ...(snapshot ? { snapshot } : {}),
    ...overrides,
  } as StageContext;
}

function makeInput(itemId: string): StageInput {
  return { sku: 'SKU-STAGE', onboardingItemId: itemId, sourceKind: 'catalog_product', evidence: [], acceptedProposals: [], allProposals: [] };
}

function readExtRaw(itemId: string): string | null {
  const row = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(itemId) as { extraction_data_json: string | null } | undefined;
  return row?.extraction_data_json ?? null;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-stage-'));
  initDb(path.join(tmpDir, '.baystate-cms', 'app.db'));
  runMigrations();
  resetOcrStageFlagsOverride();
});

afterEach(() => {
  closeDb();
  resetOcrStageFlagsOverride();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('packaging_ocr stage — flag-off inertness', () => {
  it('writes NOTHING and makes no transport when the stage flag is off', async () => {
    overrideOcrStageFlags({ packagingOcrStageEnabled: false });
    seedWorkspace();
    const img = seedLocalImage();
    const legacyExt = {
      title: 'Web Title',
      primaryImage: img,
      packagingOcrData: { productName: 'Legacy Name', confidenceByField: {} },
      ocrOutcome: { status: 'succeeded', model: 'legacy-vlm', imageCount: 1 },
    };
    const item = seedItem({ ext: legacyExt });
    const before = readExtRaw(item.id);

    const result = await packagingOcrStage.execute(makeInput(item.id), makeContext());

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect(result.output.evidence.length).toBe(0);
      expect(result.output.proposals.length).toBe(0);
      expect(result.output.metadata?.skipped).toBe(true);
    }
    // Byte-identical legacy extraction_data_json.
    expect(readExtRaw(item.id)).toBe(before);
    // No model-call rows at all.
    const calls = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(calls.cnt).toBe(0);
  });
});

describe('packaging_ocr stage — active non-shadow mode', () => {
  it('persists data + BOTH hashes through the repo and writes the audit lifecycle', async () => {
    const { server, port } = await startOllamaServer(STAGE_OCR_JSON);
    try {
      seedWorkspace();
      const img = seedLocalImage();
      // Freeze the local VLM route into the snapshot BEFORE the stage runs.
      const snapshot = makeSnapshot(`http://127.0.0.1:${port}`);
      const item = seedItem({ ext: { title: 'Web Title', primaryImage: img } });
      overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: false });
      const context = makeContext({}, snapshot);

      const result = await packagingOcrStage.execute(makeInput(item.id), context);

      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') return;
      const meta = result.output.metadata as Record<string, any>;
      expect(meta.shadowOnly).toBe(false);
      expect((meta.packagingOcrData as any).productName).toBe('Stage Kibble');

      const stored = JSON.parse(readExtRaw(item.id)!) as Record<string, any>;
      expect(stored.packagingOcrData.productName).toBe('Stage Kibble');
      expect(stored.packagingTitle).toBe('Stage Kibble');
      expect(stored.ocrOutcome.status).toBe('succeeded');
      // Input hash bound EXACTLY like cohort-curator.computeOcrInputHash.
      expect(stored.ocrInputHash).toBe(hashCanonicalJson({
        sourceUrl: item.sourceUrl ?? null,
        extractionSourceUrl: null,
        primaryImage: img,
        additionalImages: [],
      }));
      expect(stored.ocrExecutionDigest).toBe(computeOcrExecutionDigest(snapshot));

      // Audit-row lifecycle: exactly ONE durable started→success call row.
      const calls = getDb().query(
        'SELECT status, run_id, model FROM classification_model_calls WHERE run_id = ?',
      ).all(context.runId) as Array<Record<string, any>>;
      expect(calls.length).toBe(1);
      expect(String(calls[0].status)).toBe('success');
      expect(String(calls[0].model)).toBe('stage-test-vlm');
    } finally {
      server.close();
    }
  });
});

describe('packaging_ocr stage — skip-not-fail', () => {
  it('SUCCEEDS with a coded skipped outcome for distributor-record items (no writes)', async () => {
    overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: false });
    seedWorkspace();
    const item = seedItem({ sourceType: 'distributor_record', ext: { title: 'Distributor Title' } });
    const before = readExtRaw(item.id);

    const result = await packagingOcrStage.execute(makeInput(item.id), makeContext());

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect((result.output.metadata as any).ocrOutcome.status).toBe('skipped');
    }
    expect(readExtRaw(item.id)).toBe(before);
  });

  it('SUCCEEDS with a coded no_image outcome for items without a primary image', async () => {
    overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: false });
    seedWorkspace();
    const item = seedItem({ ext: { title: 'No Image Item' } });

    const result = await packagingOcrStage.execute(makeInput(item.id), makeContext());

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect((result.output.metadata as any).ocrOutcome.status).toBe('no_image');
    }
    const stored = JSON.parse(readExtRaw(item.id)!) as Record<string, any>;
    expect(stored.ocrOutcome.status).toBe('no_image');
    expect(stored.packagingOcrData).toBeNull();
    expect(stored.shadowPackagingOcrData).toBeUndefined();
  });
});

describe('packaging_ocr stage — shadow-mode isolation', () => {
  it('leaves ALL live keys untouched and writes ONLY shadowPackagingOcrData', async () => {
    const { server, port } = await startOllamaServer(STAGE_OCR_JSON);
    try {
      seedWorkspace();
      const img = seedLocalImage();
      const snapshot = makeSnapshot(`http://127.0.0.1:${port}`);
      const legacyExt = {
        title: 'Web Title',
        primaryImage: img,
        packagingOcrData: { productName: 'Legacy Name', brand: 'Acme', confidenceByField: { productName: 0.9 } },
        packagingTitle: 'Legacy Name',
        ocrOutcome: { status: 'succeeded', model: 'legacy-vlm', imageCount: 1 },
        ocrInputHash: 'legacy-hash',
        ocrExecutionDigest: 'legacy-digest',
      };
      const item = seedItem({ ext: legacyExt });
      overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: true });

      const result = await packagingOcrStage.execute(makeInput(item.id), makeContext({}, snapshot));

      expect(result.status).toBe('succeeded');
      if (result.status === 'succeeded') {
        expect((result.output.metadata as any).shadowOnly).toBe(true);
        expect((result.output.metadata as any).packagingOcrData).toBeDefined();
      }
      const stored = JSON.parse(readExtRaw(item.id)!) as Record<string, any>;
      // Live authority keys byte-for-byte untouched.
      expect(stored.packagingOcrData).toEqual(legacyExt.packagingOcrData);
      expect(stored.packagingTitle).toBe('Legacy Name');
      expect(stored.ocrOutcome).toEqual(legacyExt.ocrOutcome);
      expect(stored.ocrInputHash).toBe('legacy-hash');
      expect(stored.ocrExecutionDigest).toBe('legacy-digest');
      // Shadow-only namespaced key carries the FRESH stage output.
      expect((stored.shadowPackagingOcrData as any).productName).toBe('Stage Kibble');

      server.close();
    } finally {
      server.close();
    }
  });

  it('shadow output never becomes authoritative for evidence_extraction', () => {
    expect(getAuthoritativePackagingOcrStageOutput({
      packaging_ocr: { evidence: [], proposals: [], abstained: false, metadata: { packagingOcrData: { productName: 'X' }, shadowOnly: true } },
    })).toBeNull();
    expect(getAuthoritativePackagingOcrStageOutput(undefined)).toBeNull();
  });
});

describe('packaging_ocr stage — run-bound plan-compat denial', () => {
  it('surfaces as a CODED failure outcome, never a throw', async () => {
    seedWorkspace();
    const img = seedLocalImage();
    // Snapshot built BEFORE the VLM is configured ⇒ frozen plan entry has NO
    // local VLM route; configuring afterwards keeps the local leg runnable so
    // the denial comes from the frozen-route guard itself.
    const snapshot = makeSnapshot(null);
    upsertApiKey('ollama_vlm', 'enabled', 'http://127.0.0.1:1', 'late-model');
    const item = seedItem({ ext: { title: 'Web Title', primaryImage: img } });
    overrideOcrStageFlags({ packagingOcrStageEnabled: true, packagingOcrStageShadowOnly: false });

    const result = await packagingOcrStage.execute(makeInput(item.id), makeContext({}, snapshot));

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      const outcome = (result.output.metadata as any).ocrOutcome;
      expect(outcome.status).toBe('failed');
      expect(outcome.localFailureReason).toBe('policy_denied');
    }
    // The denial was still durably observable (terminal preflight row).
    const denied = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_model_calls WHERE status = 'policy_denied'",
    ).get() as { cnt: number };
    expect(denied.cnt).toBeGreaterThan(0);
  });
});

describe('evidence_extraction consumes fresh packaging_ocr stage output', () => {
  it('materializes visual evidence from the stage output instead of inline OCR', async () => {
    seedWorkspace();
    const item = seedItem({
      ext: {
        title: 'Acme Web Title',
        brand: 'Acme',
        // A REMOTE image URL would force a network fetch if inline OCR ran —
        // consumption must suppress it entirely.
        primaryImage: 'https://img.example.com/primary.jpg',
      },
    });

    const result = await evidenceExtractionStage.execute(
      {
        ...makeInput(item.id),
        stageOutputs: {
          packaging_ocr: {
            evidence: [],
            proposals: [],
            abstained: false,
            metadata: {
              packagingOcrData: {
                productName: 'Stage Kibble',
                brand: 'Acme',
                confidenceByField: {},
                metadata: null,
              },
              ocrOutcome: { status: 'succeeded', model: 'stage-test-vlm', imageCount: 1 },
            },
          },
        },
      } as unknown as StageInput,
      makeContext(),
    );

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    const visual = result.output.evidence.filter(e => (e.metadata as any)?.provenance === 'packaging_ocr');
    expect(visual.length).toBeGreaterThan(0);
    expect(visual.some(e => e.sourceField === 'name' && e.value === 'Stage Kibble')).toBe(true);
    // The stage's outcome (not the extractor's image-less no_image) surfaces.
    expect((result.output.metadata as any)?.ocrOutcome?.model).toBe('stage-test-vlm');
    // Inline OCR was suppressed: zero model-call rows were created.
    const calls = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(calls.cnt).toBe(0);
  });
});
