/**
 * Store Manager image repair hardening tests (epic #42, #36).
 *
 * DB-backed (bun test): exercises the single hardened service with injected
 * resolver/fetch/decode/clock seams against a disposable DB and temp
 * workspace directories. No network, no real provider, no live workspace DB.
 */
import { randomUUID } from 'node:crypto';
import {
  unlinkSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createChangeSet, updateChangeSetStatus, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, updateItemExtractionData } from '../../db/repositories/onboarding-item-repo';
import {
  repairChangeSetImagesForWorkspace,
  IMAGE_REPAIR_POLICY,
  redactUrl,
  type ImageRepairDeps,
} from '../../server/services/store-manager-image-repair';
import { createStoreManagerTools } from '../../server/services/store-manager-tools';
import exportRoutes from '../../server/routes/export-routes';

// 1x1 transparent PNG.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const okDecode: ImageRepairDeps['decodeImage'] = async () => ({ ok: true, jpeg: Buffer.from('jpeg-data') });
const corruptDecode: ImageRepairDeps['decodeImage'] = async () => ({ ok: false, reason: 'invalid_image' });
const tooLargeDecode: ImageRepairDeps['decodeImage'] = async () => ({ ok: false, reason: 'too_large' });

function makeResponse(
  status: number,
  body: string | Uint8Array,
  contentType = 'image/jpeg',
  headers: Record<string, string> = {},
): Response {
  return new Response(body as unknown as BodyInit, {
    status,
    headers: { 'content-type': contentType, ...headers },
  });
}

function makeDraftJson(sku: string, brand = 'Test Brand', primary: string | null = null): string {
  return JSON.stringify({
    sku,
    core: { name: 'Test Product', media: { primary } },
    customFields: { ProductField16: brand },
  });
}

function seedWorkspaceRow(workspaceId: string, workspacePath: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [workspaceId, 'Repair Test Store', workspacePath, `${workspacePath}/.git`, now, now, 'complete'],
  );
}

function createOnboardingExtraction(workspaceId: string, sku: string, extractionData: unknown) {
  const batch = createBatch({
    workspaceId,
    name: 'repair-test-batch',
    fileName: 'repair-test.csv',
    totalItems: 1,
  });
  const inserted = insertItems(batch.id, [
    {
      upc: sku,
      name: 'Test Product',
      rowNumber: 1,
      stage: 'extraction',
      stageStatus: 'complete',
    } as any,
  ]);
  // insertItems stores extraction_data_json as NULL; set it through the repo
  // so findExtractionDataByUpc can serve it.
  for (const item of inserted) {
    updateItemExtractionData(item.id, JSON.stringify(extractionData));
  }
}

describe('Store Manager image repair service (epic #42, #36)', () => {
  const dbPath = path.join(os.tmpdir(), `baystate-cms-image-repair-${process.pid}.db`);
  const wsPath = path.join(os.tmpdir(), `baystate-cms-image-repair-ws-${process.pid}`);
  const wsPathB = path.join(os.tmpdir(), `baystate-cms-image-repair-ws-b-${process.pid}`);
  const workspaceId = randomUUID();
  const workspaceIdB = randomUUID();

  beforeAll(() => {
    try {
      resetDb();
    } catch {
      /* ok */
    }
    initDb(dbPath);
    runMigrations();
    mkdirSync(path.join(wsPath, 'products', 'images'), { recursive: true });
    mkdirSync(path.join(wsPathB, 'products', 'images'), { recursive: true });
    seedWorkspaceRow(workspaceId, wsPath);
    seedWorkspaceRow(workspaceIdB, wsPathB);
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(dbPath);
    } catch {
      /* ok */
    }
    try {
      rmSync(wsPath, { recursive: true, force: true });
      rmSync(wsPathB, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  function makeApprovedChangeSet(sku: string, extractionData: unknown, overrides?: { status?: string; changeSetId?: string; draftJson?: string }) {
    const cs = createChangeSet({
      workspaceId,
      title: 'Repair Test CS',
      description: null,
      baseCommit: 'head',
    });
    updateChangeSetStatus(cs.id, overrides?.status ?? 'approved');
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku,
      operation: 'update',
      draftJson: overrides?.draftJson ?? makeDraftJson(sku),
      baseJson: null,
      draftHash: 'draft-hash',
    });
    createOnboardingExtraction(workspaceId, sku, extractionData);
    return cs.id;
  }

  const publicFetch = (_input: string | URL | Request) => Promise.resolve(makeResponse(200, ONE_PX_PNG));
  const publicResolver = async () => ['93.184.216.34'];

  it('refuses a non-approved change set before any side effect (zero fetch/decode/write)', async () => {
    let fetched = 0;
    let decoded = 0;
    const cs = createChangeSet({ workspaceId, title: 'Draft CS', description: null, baseCommit: 'head' });
    updateChangeSetStatus(cs.id, 'draft');
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: 'SKU-DRAFT',
      operation: 'update',
      draftJson: makeDraftJson('SKU-DRAFT'),
      baseJson: null,
      draftHash: 'h',
    });
    createOnboardingExtraction(workspaceId, 'SKU-DRAFT', { primaryImage: 'https://cdn.example.com/a.jpg' });

    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: cs.id },
      {
        fetchFn: async () => {
          fetched++;
          return makeResponse(200, ONE_PX_PNG);
        },
        decodeImage: async () => {
          decoded++;
          return okDecode(Buffer.alloc(0));
        },
      },
    );

    expect(result.status).toBe('policy_denied');
    expect(fetched).toBe(0);
    expect(decoded).toBe(0);
    // No brand directory may have been created for the item.
    expect(existsSync(path.join(wsPath, 'products', 'images', 'test-brand'))).toBe(false);
  });

  it('returns not_found for a change set owned by another workspace (zero side effects)', async () => {
    let fetched = 0;
    // Create the change set in workspace A.
    makeApprovedChangeSet('SKU-A', { primaryImage: 'https://cdn.example.com/a.jpg' });
    const foreignId = createChangeSet({ workspaceId: workspaceIdB, title: 'B CS', description: null, baseCommit: 'head' }).id;
    updateChangeSetStatus(foreignId, 'approved');

    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: foreignId },
      {
        fetchFn: async () => {
          fetched++;
          return makeResponse(200, ONE_PX_PNG);
        },
      },
    );

    expect(result.status).toBe('not_found');
    expect(fetched).toBe(0);
  });

  it('returns not_found for a missing change set', async () => {
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: randomUUID() },
      { fetchFn: publicFetch, resolveHostname: publicResolver },
    );
    expect(result.status).toBe('not_found');
  });

  it('returns error when the change set has no items', async () => {
    const cs = createChangeSet({ workspaceId, title: 'Empty CS', description: null, baseCommit: 'head' });
    updateChangeSetStatus(cs.id, 'approved');
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: cs.id },
      { fetchFn: publicFetch, resolveHostname: publicResolver },
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error).toContain('no items');
  });

  it('denies direct loopback destinations (policy_denied, no fetch)', async () => {
    const csId = makeApprovedChangeSet('SKU-LOOP', { primaryImage: 'http://127.0.0.1/secret.jpg' });
    let fetched = 0;
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        fetchFn: async () => {
          fetched++;
          return makeResponse(200, ONE_PX_PNG);
        },
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(fetched).toBe(0);
    expect(result.summary.results[0].entries[0].status).toBe('policy_denied');
    expect(result.summary.results[0].error).toContain('policy_denied');
  });

  it('denies private/link-local DNS results (SSRF floor)', async () => {
    const csId = makeApprovedChangeSet('SKU-SSRF', { primaryImage: 'http://internal.corp/image.jpg' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        fetchFn: publicFetch,
        resolveHostname: async () => ['10.0.0.5'],
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('policy_denied');
  });

  it('denies public-to-private redirect tunnels (per-hop revalidation)', async () => {
    const csId = makeApprovedChangeSet('SKU-REDIR', { primaryImage: 'https://public.example.com/img.jpg' });
    let fetches = 0;
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: async (hostname) => (hostname === '169.254.169.254' ? ['169.254.169.254'] : ['93.184.216.34']),
        fetchFn: async (url) => {
          fetches++;
          const u = new URL(String(url));
          if (u.hostname === 'public.example.com') {
            return makeResponse(302, '', 'text/html', { location: 'http://169.254.169.254/latest/meta-data' });
          }
          return makeResponse(200, ONE_PX_PNG);
        },
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('policy_denied');
    // Only the first (public) hop was fetched; the private hop was denied pre-fetch.
    expect(fetches).toBe(1);
  });

  it('denies too many redirects', async () => {
    const csId = makeApprovedChangeSet('SKU-REDIRECTS', { primaryImage: 'https://public.example.com/start.jpg' });
    let fetches = 0;
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: async () => ['93.184.216.34'],
        fetchFn: async (url) => {
          fetches++;
          const u = new URL(String(url));
          const n = Number(u.searchParams.get('hop') ?? '1');
          return makeResponse(302, '', 'text/html', { location: `https://public.example.com/next.jpg?hop=${n + 1}` });
        },
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('policy_denied');
    expect(fetches).toBe(IMAGE_REPAIR_POLICY.maxRedirects + 1);
  });

  it('rejects oversized bodies with too_large (stream cap)', async () => {
    const csId = makeApprovedChangeSet('SKU-BIG', { primaryImage: 'https://public.example.com/big.jpg' });
    const chunk = new Uint8Array(4 * 1024 * 1024); // 4 MiB
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: publicResolver,
        fetchFn: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < 3; i++) controller.enqueue(chunk);
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'image/jpeg' } },
          ),
        decodeImage: okDecode,
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('too_large');
  });

  it('rejects non-image content types as invalid_image', async () => {
    const csId = makeApprovedChangeSet('SKU-HTML', { primaryImage: 'https://public.example.com/page.html' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: publicResolver,
        fetchFn: async () => makeResponse(200, '<html>', 'text/html'),
        decodeImage: okDecode,
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('invalid_image');
  });

  it('rejects corrupt images as invalid_image and never writes raw bytes', async () => {
    const csId = makeApprovedChangeSet('SKU-CORRUPT', { primaryImage: 'https://public.example.com/corrupt.jpg' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: publicResolver,
        fetchFn: async () => makeResponse(200, 'not-an-image'),
        decodeImage: corruptDecode,
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('invalid_image');
    // No file may exist for the SKU in the brand folder.
    const brandDir = path.join(wsPath, 'products', 'images', 'test-brand');
    const files = existsSync(brandDir) ? readdirSync(brandDir).filter((f) => !f.startsWith('.')) : [];
    expect(files).toEqual([]);
  });

  it('rejects extreme-dimension payloads as too_large', async () => {
    const csId = makeApprovedChangeSet('SKU-DIM', { primaryImage: 'https://public.example.com/huge.jpg' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: publicResolver,
        fetchFn: async () => makeResponse(200, ONE_PX_PNG),
        decodeImage: tooLargeDecode,
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('too_large');
  });

  it('reports timeout when the bounded request aborts', async () => {
    const csId = makeApprovedChangeSet('SKU-TIMEOUT', { primaryImage: 'https://public.example.com/slow.jpg' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: publicResolver,
        timeouts: { perRequestMs: 30 },
        fetchFn: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('timeout');
  });

  it('bounds URLs per SKU (maxUrlsPerSku)', async () => {
    const csId = makeApprovedChangeSet('SKU-MANYURLS', {
      primaryImage: 'https://cdn.example.com/0.jpg',
      additionalImages: Array.from({ length: 12 }, (_, i) => `https://cdn.example.com/${i + 1}.jpg`),
    });
    let fetched = 0;
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: publicResolver,
        fetchFn: async () => {
          fetched++;
          return makeResponse(200, ONE_PX_PNG);
        },
        decodeImage: okDecode,
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries.length).toBe(IMAGE_REPAIR_POLICY.maxUrlsPerSku);
    expect(fetched).toBe(IMAGE_REPAIR_POLICY.maxUrlsPerSku);
  });

  it('blocks traversal and absolute local references (policy_denied, no write)', async () => {
    const csId = makeApprovedChangeSet('SKU-TRAV', { primaryImage: '../../../../etc/passwd' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      { decodeImage: okDecode },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('policy_denied');
  });

  it('blocks absolute-path local references', async () => {
    const csId = makeApprovedChangeSet('SKU-ABS', { primaryImage: '/etc/passwd' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      { decodeImage: okDecode },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('policy_denied');
  });

  it('blocks sibling-prefix escapes', async () => {
    const csId = makeApprovedChangeSet('SKU-SIB', { primaryImage: '../images-other/x.jpg' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      { decodeImage: okDecode },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('policy_denied');
  });

  it('blocks symlink escapes via realpath containment', async () => {
    // Create an outside directory with a file, then a symlink inside the
    // images root that points at it.
    const outside = path.join(os.tmpdir(), `baystate-cms-image-repair-outside-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.jpg'), 'secret');
    const linkDir = path.join(wsPath, 'products', 'images', 'link-escape');
    try {
      symlinkSync(outside, linkDir, 'dir');
    } catch {
      rmSync(linkDir, { recursive: true, force: true });
      symlinkSync(outside, linkDir, 'dir');
    }

    const csId = makeApprovedChangeSet('SKU-SYMLINK', { primaryImage: 'link-escape/secret.jpg' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      { decodeImage: okDecode },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('policy_denied');
    try {
      rmSync(linkDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  it('reports missing local references as no_source', async () => {
    const csId = makeApprovedChangeSet('SKU-NOLOCAL', { primaryImage: 'brandfolder/does-not-exist.jpg' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      { decodeImage: okDecode },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('no_source');
  });

  it('counts a valid contained local image as already_present', async () => {
    // Drop a real decodable image inside the workspace image root.
    const brandDir = path.join(wsPath, 'products', 'images', 'test-brand');
    mkdirSync(brandDir, { recursive: true });
    writeFileSync(path.join(brandDir, 'real.png'), ONE_PX_PNG);

    const csId = makeApprovedChangeSet('SKU-LOCAL', { primaryImage: 'test-brand/real.png' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      { decodeImage: okDecode },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const skuResult = result.summary.results[0];
    expect(skuResult.imagesDownloaded).toBe(1);
    expect(skuResult.entries[0].status).toBe('already_present');
    expect(skuResult.error).toBeUndefined();
  });

  it('atomically writes a decoded download and leaves no temp files', async () => {
    const csId = makeApprovedChangeSet('SKU-DL', { primaryImage: 'https://cdn.example.com/sku-dl.jpg' });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: publicResolver,
        fetchFn: publicFetch,
        decodeImage: async () => ({ ok: true as const, jpeg: Buffer.from('final-jpeg-bytes') }),
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const skuResult = result.summary.results[0];
    expect(skuResult.imagesDownloaded).toBe(1);
    expect(skuResult.entries[0].status).toBe('downloaded');

    // Unique stem applies because an earlier test already wrote test-product.jpg.
    const dest = path.join(wsPath, 'products', 'images', 'test-brand', 'test-product-SKU-DL.jpg');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toBe('final-jpeg-bytes');
    // No temp sibling files left behind.
    const brandDir = path.join(wsPath, 'products', 'images', 'test-brand');
    const leftovers = readdirSync(brandDir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('reports one-of-many partial failures honestly', async () => {
    const csId = makeApprovedChangeSet('SKU-PARTIAL', {
      primaryImage: 'https://cdn.example.com/ok.jpg',
      additionalImages: ['https://cdn.example.com/bad.jpg'],
    });
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: csId },
      {
        resolveHostname: publicResolver,
        fetchFn: async (url) => {
          if (String(url).includes('bad')) return makeResponse(200, 'corrupt', 'image/jpeg');
          return makeResponse(200, ONE_PX_PNG);
        },
        decodeImage: async (buf) => {
          if (buf.toString() === 'corrupt') return { ok: false as const, reason: 'invalid_image' as const };
          return { ok: true as const, jpeg: Buffer.from('jpeg-' + Math.random()) };
        },
      },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const skuResult = result.summary.results[0];
    expect(skuResult.imagesDownloaded).toBe(1);
    expect(skuResult.entries.map((e) => e.status)).toEqual(['downloaded', 'invalid_image']);
    expect(skuResult.error).toBeUndefined();
    // Summary is honest about the partial failure.
    expect(result.summary.success).toBe(true);
  });

  it('reports no_source when extraction data is missing entirely', async () => {
    const cs = createChangeSet({ workspaceId, title: 'No Extraction', description: null, baseCommit: 'head' });
    updateChangeSetStatus(cs.id, 'approved');
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: 'SKU-NOEXTRACT',
      operation: 'update',
      draftJson: makeDraftJson('SKU-NOEXTRACT'),
      baseJson: null,
      draftHash: 'h',
    });
    // No onboarding row for this SKU.
    const result = await repairChangeSetImagesForWorkspace(
      { workspaceId, workspacePath: wsPath, changeSetId: cs.id },
      { fetchFn: publicFetch, resolveHostname: publicResolver },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.summary.results[0].entries[0].status).toBe('no_source');
    expect(result.summary.results[0].error).toContain('No extraction data');
  });

  it('redacts URLs to origin + bounded path', () => {
    expect(redactUrl('https://cdn.example.com/a/b/c/d.jpg?token=secret&x=1')).toBe(
      'https://cdn.example.com/a/b/c',
    );
    expect(redactUrl('not a url')).toBe('<unparseable-url>');
  });
});

describe('Store Manager repair callers delegate to the single service', () => {
  const dbPath = path.join(os.tmpdir(), `baystate-cms-image-repair-route-${process.pid}.db`);
  const wsPath = path.join(os.tmpdir(), `baystate-cms-image-repair-route-ws-${process.pid}`);
  const wsPathB = path.join(os.tmpdir(), `baystate-cms-image-repair-route-ws-b-${process.pid}`);
  const workspaceId = randomUUID();
  const workspaceIdB = randomUUID();

  beforeAll(() => {
    try {
      resetDb();
    } catch {
      /* ok */
    }
    initDb(dbPath);
    runMigrations();
    mkdirSync(path.join(wsPath, 'products', 'images', 'test-brand'), { recursive: true });
    mkdirSync(path.join(wsPathB, 'products', 'images', 'test-brand'), { recursive: true });
    writeFileSync(path.join(wsPath, 'products', 'images', 'test-brand', 'real.png'), ONE_PX_PNG);
    seedWorkspaceRow(workspaceId, wsPath);
    seedWorkspaceRow(workspaceIdB, wsPathB);
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(dbPath);
    } catch {
      /* ok */
    }
    try {
      rmSync(wsPath, { recursive: true, force: true });
      rmSync(wsPathB, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  it('POST /export/change-set/:id/repair-images delegates and enforces workspace + approved state', async () => {
    // Approved change set in the active workspace with a valid local image.
    const cs = createChangeSet({ workspaceId, title: 'Route CS', description: null, baseCommit: 'head' });
    updateChangeSetStatus(cs.id, 'approved');
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: 'SKU-ROUTE',
      operation: 'update',
      draftJson: makeDraftJson('SKU-ROUTE'),
      baseJson: null,
      draftHash: 'h',
    });
    const batch = createBatch({ workspaceId, name: 'route-batch', fileName: 'r.csv', totalItems: 1 });
    const inserted = insertItems(batch.id, [
      {
        upc: 'SKU-ROUTE',
        name: 'Route Product',
        rowNumber: 1,
        stage: 'extraction',
        stageStatus: 'complete',
      } as any,
    ]);
    for (const item of inserted) {
      updateItemExtractionData(item.id, JSON.stringify({ primaryImage: 'test-brand/real.png' }));
    }

    const res = await exportRoutes.request(`/export/change-set/${cs.id}/repair-images`, { method: 'POST' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.results[0].sku).toBe('SKU-ROUTE');
    expect(body.results[0].imagesDownloaded).toBe(1);
  });

  it('POST repair-images returns 404 for a change set not in the workspace', async () => {
    const foreign = createChangeSet({ workspaceId: workspaceIdB, title: 'Foreign', description: null, baseCommit: 'head' });
    updateChangeSetStatus(foreign.id, 'approved');
    const res = await exportRoutes.request(`/export/change-set/${foreign.id}/repair-images`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST repair-images returns 409 for a non-approved change set', async () => {
    const cs = createChangeSet({ workspaceId, title: 'Draft Route CS', description: null, baseCommit: 'head' });
    updateChangeSetStatus(cs.id, 'reviewing');
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: 'SKU-DRAFT-ROUTE',
      operation: 'update',
      draftJson: makeDraftJson('SKU-DRAFT-ROUTE'),
      baseJson: null,
      draftHash: 'h',
    });
    const res = await exportRoutes.request(`/export/change-set/${cs.id}/repair-images`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('approved');
  });

  it('the gated agent tool delegates to the service once with a valid approval', async () => {
    const cs = createChangeSet({ workspaceId, title: 'Tool CS', description: null, baseCommit: 'head' });
    updateChangeSetStatus(cs.id, 'approved');
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: 'SKU-TOOL',
      operation: 'update',
      draftJson: makeDraftJson('SKU-TOOL'),
      baseJson: null,
      draftHash: 'h',
    });
    const batch = createBatch({ workspaceId, name: 'tool-batch', fileName: 't.csv', totalItems: 1 });
    const inserted = insertItems(batch.id, [
      {
        upc: 'SKU-TOOL',
        name: 'Tool Product',
        rowNumber: 1,
        stage: 'extraction',
        stageStatus: 'complete',
      } as any,
    ]);
    for (const item of inserted) {
      updateItemExtractionData(item.id, JSON.stringify({ primaryImage: 'test-brand/real.png' }));
    }

    const tools = createStoreManagerTools({
      workspaceId,
      workspacePath: wsPath,
      executionId: 'exec-route-1',
      approvalExpiresAt: Date.now() + 60_000,
    });
    const toolDef = tools.repairChangeSetImages as unknown as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };

    const toolCallInput = { changeSetId: cs.id };
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-repair-1', toolName: 'repairChangeSetImages', input: toolCallInput },
          { type: 'tool-approval-request', approvalId: 'ap-repair-1', toolCallId: 'call-repair-1' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'ap-repair-1', approved: true }],
      },
    ] as unknown[];

    const result = (await toolDef.execute(toolCallInput, { toolCallId: 'call-repair-1', messages })) as {
      success: boolean;
      summary?: string;
      results?: Array<{ sku: string; imagesDownloaded: number; error?: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.results?.[0].imagesDownloaded).toBe(1);
    expect(result.results?.[0].error).toBeUndefined();
  });

  it('transitive source guard: repair callers own no raw fetch/SQL/image-write capability', () => {
    const toolSource = readFileSync(
      path.join(import.meta.dirname, '..', '..', 'server', 'services', 'store-manager-tools.ts'),
      'utf-8',
    );
    const routeSource = readFileSync(
      path.join(import.meta.dirname, '..', '..', 'server', 'routes', 'export-routes.ts'),
      'utf-8',
    );
    const serviceSource = readFileSync(
      path.join(import.meta.dirname, '..', '..', 'server', 'services', 'store-manager-image-repair.ts'),
      'utf-8',
    );

    for (const [name, source] of [
      ['store-manager-tools.ts', toolSource],
      ['export-routes.ts', routeSource],
    ] as const) {
      expect(source, `${name} must not fetch()`).not.toMatch(/fetch\s*\(/);
      expect(source, `${name} must not hand-roll onboarding/change-set SQL`).not.toContain('onboarding_items');
      expect(source, `${name} must not hand-roll change-set SQL`).not.toContain('change_set_items');
      expect(source, `${name} must not write image files directly`).not.toMatch(/writeFileSync/);
    }

    // The service owns those capabilities (the single seam).
    expect(serviceSource).toContain('fetchFn');
    expect(serviceSource).toContain('writeFileSync');
    expect(serviceSource).toContain('findExtractionDataByUpc');
    expect(serviceSource).toContain('findChangeSetByWorkspaceId');
  });
});
