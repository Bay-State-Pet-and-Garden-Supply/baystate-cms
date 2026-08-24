/**
 * P1-T1 structured OCR attempt results — coded failure taxonomy, bounded
 * transport retry, and circuit-breaker wiring in runPackagingOcrAttempt.
 *
 * DB-backed (bun:test) because src/onboarding/packaging-ocr.ts transitively
 * imports bun:sqlite repositories (same reason packaging-ocr.test.ts and
 * vlm-client.test.ts run under `bun test`, not vitest).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  extractPackagingOcr,
  runPackagingOcrAttempt,
} from '../../onboarding/packaging-ocr';
import {
  buildCircuitBreakerKey,
  recordTransportFailure,
  resetCircuitBreakers,
  getCircuitBreakerStats,
} from '../../onboarding/vlm-circuit-breaker';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import {
  overrideOcrStageFlags,
  resetOcrStageFlagsOverride,
} from '../../classification/ocr-stage-flags';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, requireModelCallContext } from '../../classification/runtime-snapshot';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import type { CatalogEvidence } from '../../classification/catalog-evidence';

let tmpDir: string;

const LEGACY_BASE = 'http://localhost:11434';
const LEGACY_MODEL = 'qwen2.5vl:latest';

function seedLegacyVlm() {
  upsertApiKey('ollama_vlm', 'enabled', LEGACY_BASE, LEGACY_MODEL);
}

/** Local >1KiB image so no remote image fetch is needed. */
function seedLocalImage(): string {
  const imgPath = path.join(tmpDir, 'img.bin');
  fs.writeFileSync(imgPath, Buffer.alloc(2048, 0x64));
  return imgPath;
}

type TransportMock = {
  fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: () => number;
};

/** Transport that always rejects like a VLM timeout. */
function timeoutTransport(): TransportMock {
  let calls = 0;
  return {
    calls: () => calls,
    fn: (async () => {
      calls += 1;
      const err = new Error('The operation was aborted.');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  };
}

/** Transport that resolves an Ollama-native chat response with given content. */
function contentTransport(content: string): TransportMock {
  let calls = 0;
  return {
    calls: () => calls,
    fn: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: { content } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  };
}

function httpStatusTransport(status: number, body: string): TransportMock {
  let calls = 0;
  return {
    calls: () => calls,
    fn: (async () => {
      calls += 1;
      return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  };
}

function makeParams(overrides: Record<string, unknown> = {}) {
  const imgPath = seedLocalImage();
  return {
    imageUrl: 'https://example.com/img.jpg',
    imageLocalPath: path.basename(imgPath),
    workspacePath: tmpDir,
    sku: 'SKU-ATTEMPT',
    modelFetchFn: undefined,
    ...overrides,
  } as Parameters<typeof runPackagingOcrAttempt>[0];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-attempt-'));
  initDb(path.join(tmpDir, '.baystate-cms', 'app.db'));
  runMigrations();
  resetCircuitBreakers();
});

afterEach(() => {
  closeDb();
  resetCircuitBreakers();
  resetOcrStageFlagsOverride();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED;
});

// ─── coded failures ────────────────────────────────────────────────────────────

describe('runPackagingOcrAttempt — coded failure taxonomy', () => {
  it('returns not_configured when the VLM is not configured (fresh DB)', async () => {
    const result = await runPackagingOcrAttempt(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('not_configured');
      expect(result.redactedMessage.length).toBeGreaterThan(0);
      expect(result.attempts).toBe(0);
    }
  });

  it('classifies a VLM timeout as timeout (default: no retry)', async () => {
    seedLegacyVlm();
    const transport = timeoutTransport();
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('timeout');
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('classifies HTTP 500 as http_error with the status encoded separately', async () => {
    seedLegacyVlm();
    const transport = httpStatusTransport(500, '{"error":"boom"}');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('http_error');
      expect(result.httpStatus).toBe(500);
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('classifies an empty VLM response as empty_response', async () => {
    seedLegacyVlm();
    const transport = contentTransport('');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('empty_response');
    }
    expect(transport.calls()).toBe(1);
  });

  it('classifies prose-only output as unparseable_json', async () => {
    seedLegacyVlm();
    const transport = contentTransport('This package appears to contain dog treats.');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('unparseable_json');
    }
    expect(transport.calls()).toBe(1);
  });

  it('classifies schema-invalid metadata as schema_coercion_failed', async () => {
    seedLegacyVlm();
    // imageSourceUrl is typed string|null but runtime JS allows a number —
    // it flows into metadata.imageSourceUrl and breaks PackagingOcrDataSchema.
    const result = await runPackagingOcrAttempt(
      makeParams({
        imageSourceUrl: 4242,
        modelFetchFn: contentTransport('{"productName":"Valid Name"}').fn,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('schema_coercion_failed');
    }
  });

  it('reports circuit_open with zero transport when the breaker is tripped for this route', async () => {
    seedLegacyVlm();
    const key = buildCircuitBreakerKey(LEGACY_BASE, LEGACY_MODEL);
    recordTransportFailure(key);
    recordTransportFailure(key);
    recordTransportFailure(key);
    const transport = contentTransport('{"productName":"Never Called"}');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('circuit_open');
    }
    expect(transport.calls()).toBe(0);
  });
});

// ─── success + legacy adapter ──────────────────────────────────────────────────

describe('runPackagingOcrAttempt success & extractPackagingOcr adapter', () => {
  it('returns coded success with data bound to a content hash', async () => {
    seedLegacyVlm();
    const result = await runPackagingOcrAttempt(
      makeParams({
        modelFetchFn: contentTransport('{"productName":"Feline Wormeze Liquid","species":["cat"]}').fn,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productName).toBe('Feline Wormeze Liquid');
      expect(result.data.species).toEqual(['cat']);
      expect(typeof result.data.contentHash).toBe('string');
      expect(result.data.contentHash!.length).toBe(64);
      expect(result.attempts).toBe(1);
    }
  });

  it('adapter extractPackagingOcr still returns null on failure and data on success', async () => {
    seedLegacyVlm();

    // Failure → null (HTTP 500).
    const failing = await extractPackagingOcr(
      makeParams({ modelFetchFn: httpStatusTransport(500, '{"error":"boom"}').fn }),
    );
    expect(failing).toBeNull();

    // Not configured → null.
    // (fresh route bucket needed after the 500 above fed the breaker once)
    resetCircuitBreakers();

    // Success → data with contentHash.
    const ok = await extractPackagingOcr(
      makeParams({
        modelFetchFn: contentTransport('{"productName":"Canine Wormeze Liquid"}').fn,
      }),
    );
    expect(ok).not.toBeNull();
    expect(ok!.productName).toBe('Canine Wormeze Liquid');
    expect(ok!.contentHash).not.toBeNull();
  });
});

// ─── bounded transport retry ───────────────────────────────────────────────────

describe('bounded transport retry (BAYSTATE_CMS_OCR_RETRIES_ENABLED)', () => {
  it('retries a transient timeout ONCE and succeeds (max 2 attempts total)', async () => {
    seedLegacyVlm();
    process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED = 'true';
    let calls = 0;
    const transport = (async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('The operation was aborted.');
        err.name = 'TimeoutError';
        throw err;
      }
      return new Response(JSON.stringify({ message: { content: '{"productName":"Retried OK"}' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productName).toBe('Retried OK');
      expect(result.attempts).toBe(2);
    }
    expect(calls).toBe(2);
  });

  it('gives up after 2 total attempts when both transient tries fail', async () => {
    seedLegacyVlm();
    process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED = 'true';
    const transport = timeoutTransport();
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('timeout');
      expect(result.attempts).toBe(2);
    }
    expect(transport.calls()).toBe(2);
  });

  it('NEVER retries deterministic parse failures even when retries are enabled', async () => {
    seedLegacyVlm();
    process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED = 'true';
    const transport = contentTransport('No JSON anywhere in this response.');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('unparseable_json');
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('does not retry at all when the flag is unset (default OFF)', async () => {
    seedLegacyVlm();
    const transport = timeoutTransport();
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('does not retry non-transient HTTP errors (e.g. 404) even when enabled', async () => {
    seedLegacyVlm();
    process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED = 'true';
    const transport = httpStatusTransport(404, '{"error":"missing"}');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('http_error');
      expect(result.httpStatus).toBe(404);
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('retry flag via in-memory OVERRIDE enables retries without any env (post-review fixup 7a)', async () => {
    seedLegacyVlm();
    delete process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED;
    overrideOcrStageFlags({ packagingOcrRetriesEnabled: true });
    let calls = 0;
    const transport = (async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('The operation was aborted.');
        err.name = 'TimeoutError';
        throw err;
      }
      return new Response(JSON.stringify({ message: { content: '{"productName":"Override Retry OK"}' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
    }
    expect(calls).toBe(2);
  });
});

// ─── circuit breaker determinism (post-review fixup 1) ───────────────────────

describe('circuit breaker ignores deterministic HTTP failures', () => {
  it('does NOT open the circuit after three consecutive HTTP 404 responses', async () => {
    seedLegacyVlm();
    const transport = httpStatusTransport(404, '{"error":"missing"}');

    // Three consecutive deterministic 404s — the OLD behavior fed each into
    // the breaker and tripped it (threshold = 3).
    for (let i = 0; i < 3; i++) {
      const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasonCode).toBe('http_error');
        expect(result.httpStatus).toBe(404);
      }
    }

    // Breaker stats unchanged: no failure streak recorded for the route.
    const key = buildCircuitBreakerKey(LEGACY_BASE, LEGACY_MODEL);
    const stats = getCircuitBreakerStats()[key];
    expect(stats === undefined || stats.state === 'closed').toBe(true);
    expect(stats?.consecutiveTransportFailures ?? 0).toBe(0);

    // The next attempt still REACHES the transport (no circuit_open short-circuit).
    const fourth = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.reasonCode).toBe('http_error');
    }
    expect(transport.calls()).toBe(4);
  });
});

// ─── loader containment (FIX-4) ───────────────────────────────────────────────

describe('loadImageWithReason workspace containment', () => {
  it('reads a basename local candidate inside the workspace (existing behavior kept)', async () => {
    seedLegacyVlm();
    const transport = contentTransport('{"productName":"Contained OK"}');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.productName).toBe('Contained OK');
    expect(transport.calls()).toBe(1);
  });

  it('rejects an ABSOLUTE imageLocalPath pointing outside the workspace', async () => {
    seedLegacyVlm();
    // A readable image OUTSIDE the workspace — the loader must never touch it.
    const outsidePath = path.join(path.dirname(tmpDir), `outside-${path.basename(tmpDir)}.bin`);
    fs.writeFileSync(outsidePath, Buffer.alloc(2048, 0x64));
    try {
      // Non-remote imageUrl ⇒ after both contained local strategies fail, the
      // attempt ends as a coded no_image WITHOUT any transport.
      const result = await runPackagingOcrAttempt(makeParams({
        imageUrl: 'definitely-missing-inside-workspace.bin',
        imageLocalPath: outsidePath,
        modelFetchFn: contentTransport('{"productName":"MUST NOT RUN"}').fn,
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('no_image');
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it('rejects a ../ traversal imageLocalPath that escapes the workspace', async () => {
    seedLegacyVlm();
    const result = await runPackagingOcrAttempt(makeParams({
      imageUrl: 'definitely-missing-inside-workspace.bin',
      // ../img.bin escapes tmpDir (the workspace) even though the target exists.
      imageLocalPath: `..${path.sep}${path.basename(seedLocalImage())}`,
      modelFetchFn: contentTransport('{"productName":"MUST NOT RUN"}').fn,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('no_image');
  });

  it('still normalizes interior .. segments that stay INSIDE the workspace', async () => {
    seedLegacyVlm();
    const imgName = path.basename(seedLocalImage());
    const transport = contentTransport('{"productName":"Interior DotDot OK"}');
    const result = await runPackagingOcrAttempt(makeParams({
      imageLocalPath: `sub${path.sep}..${path.sep}${imgName}`,
      modelFetchFn: transport.fn,
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.productName).toBe('Interior DotDot OK');
  });
});

// ─── heartbeat-loss propagation (post-review fixup 2) ─────────────────────────

/** Minimal catalog evidence fixture (mirrors cohort-freeze.test.ts). */
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

/** Build a run-bound (schema-v2) snapshot + child run + audit context so the
 *  transport writes durable started/terminal rows and honors `assertHeld`. */
function makeRunBoundContext(sku: string) {
  const HB_BASE = 'http://127.0.0.1:9'; // loopback ⇒ policy-permitted; transport is injected anyway
  upsertApiKey('ollama_vlm', 'enabled', HB_BASE, LEGACY_MODEL);
  const workspaceId = crypto.randomUUID();
  insertWorkspace({
    id: workspaceId,
    name: 'hb',
    workspacePath: tmpDir,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  const candidate = generateCandidate(BayStatePetGardenSeed, HB_EVIDENCE);
  const bundle = candidate.bundle;
  const snapshot = buildRuntimeSnapshot({
    workspaceId,
    workspacePath: tmpDir,
    productSku: sku,
    authority: { kind: 'v2' as const, bundle },
    configSnapshotRef: {
      id: bundle.manifest.bundleHash,
      hash: bundle.manifest.bundleHash,
      sourceCommit: null,
      createdAt: new Date().toISOString(),
    },
    sourceProductHash: '',
  });
  const run = createRun(workspaceId, sku, null, null, { sourceKind: 'onboarding' });
  const modelCall = requireModelCallContext(snapshot, String(run.id), 'evidence_extraction', 1);
  if (!modelCall) throw new Error('expected a compatible frozen plan for the heartbeat test');
  return { snapshot, modelCall };
}

describe('runPackagingOcrAttempt propagates HeartbeatLostError from the terminal write', () => {
  it('rejects with HeartbeatLostError when assertHeld throws during the terminal write after a transport failure', async () => {
    seedLegacyVlm();
    const { snapshot, modelCall } = makeRunBoundContext('SKU-HB-LOST');
    let terminalWriteAttempts = 0;
    const pending = runPackagingOcrAttempt(
      makeParams({
        modelCall,
        snapshot,
        modelFetchFn: httpStatusTransport(500, '{"error":"boom"}').fn,
        assertHeld: () => {
          terminalWriteAttempts += 1;
          throw new HeartbeatLostError('cohort lease lost to a reclaiming sibling');
        },
      }),
    );
    // The ownership loss must PROPAGATE out of the attempt (not be swallowed).
    await expect(pending).rejects.toBeInstanceOf(HeartbeatLostError);
    expect(terminalWriteAttempts).toBe(1);
  });

  it('still swallows non-ownership errors from the best-effort terminal write', async () => {
    seedLegacyVlm();
    const result = await runPackagingOcrAttempt(
      makeParams({
        modelFetchFn: httpStatusTransport(500, '{"error":"boom"}').fn,
        assertHeld: () => {
          throw new Error('some other durable-write failure');
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('http_error');
    }
  });
});
