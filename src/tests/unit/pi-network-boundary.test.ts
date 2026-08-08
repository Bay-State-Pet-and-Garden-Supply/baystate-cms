/**
 * P0-1 network boundary tests (review remediation): ONE enforced network
 * capability for every PI-initiated external side effect.
 *
 * Covers:
 *  - transitive call-graph: every network-capable research tool adapter's
 *    source references the policy-gateway seam (no raw legacy network path
 *    can be reached without a gateway check);
 *  - the search_query data-sharing gate: third-party search (Serper) is
 *    DENIED under local_only / cloud_models_only data-sharing policies;
 *  - SSRF floor: private/link-local destinations denied;
 *  - redirect re-validation: a public start URL cannot tunnel to a private
 *    destination;
 *  - tool-level behavior: discovery tools return policy_denied (never a
 *    crash) under restricted policies;
 *  - transport seams: platforms fetchPageHtml and managed-fallback registry
 *    accept injected (gateway-bound) fetch functions.
 *
 * DB-backed (bun test) so gateway audit rows can be asserted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createPiRun } from '../../db/repositories/product-intelligence-repo';
import { PolicyGateway } from '../../product-intelligence/policy/policy-gateway';
import { defaultPolicyGateway } from '../../product-intelligence/policy';
import { defaultToolRegistry } from '../../product-intelligence/tools';
import { discoveryTools } from '../../product-intelligence/tools/discovery-tools';
import { fetchPageHtml, HTTP_EXTRACTION_HEADERS } from '../../product-intelligence/extraction/platforms';
import { ManagedFallbackRegistry } from '../../product-intelligence/extraction/managed-fallback';
import { snapshotRequestFor } from '../../product-intelligence/extraction/wiring';
import { resolveDestinationAndCheck } from '../../extraction-worker/routes/snapshot';
import { policyDenied, type PiToolContext } from '../../product-intelligence/tools/contract';
import type { ProductIntelligencePolicy } from '../../product-intelligence/contracts';
import { sha256Hex } from '../../shared/stable-id';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { discoverSources } from '../../onboarding/source-discovery';
import { fetchOpenIcecatByGtin } from '../../crawler/importers/icecat';
import { callVlm } from '../../onboarding/vlm-client';
import { extractPackagingOcr } from '../../onboarding/packaging-ocr';

const workspaceId = 'ws-pi-network-boundary';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

function makePolicy(overrides: Record<string, unknown> = {}): ProductIntelligencePolicy {
  return {
    configId: 'config-network-test',
    allowedTools: [],
    researchTools: [],
    networkPolicy: 'allowlisted_remote',
    dataSharingPolicy: 'cloud_models_and_sources',
    allowedSourceDomains: [],
    maxResponseBytes: 5 * 1024 * 1024,
    maxToolCalls: 50,
    maxCostUsd: 1,
    deadlineMs: 300_000,
    modelRoute: { provider: 'openai', model: 'gpt-4o-mini', thinkingLevel: 'off' },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PiToolContext> = {}): PiToolContext {
  return {
    runId,
    workspaceId,
    workspacePath: '/tmp/pi-network-ws',
    policy: makePolicy(),
    signal: new AbortController().signal,
    remainingMs: 60_000,
    ...overrides,
  };
}

// The audit table FK-references product_intelligence_runs(id), so a real run
// row must exist for gateway decisions to persist (pi-budgets pattern).
let runId: string;

/** A gateway whose DNS resolver never touches the real network (IP literals
 *  resolve to themselves so the SSRF floor still fires). */
function stubGateway(policyOverrides: Record<string, unknown> = {}): PolicyGateway {
  void policyOverrides;
  return new PolicyGateway({
    resolveHostname: async (hostname) => {
      const ipLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
      return ipLiteral ? [hostname] : ['93.184.216.34'];
    },
  });
}

let wsPath: string;

beforeEach(() => {
  wsPath = path.join(os.tmpdir(), `pi-network-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
  runMigrations();
  seedWorkspace(workspaceId, wsPath);
  runId = createPiRun({
    workspaceId,
    mode: 'shadow',
    executor: 'pi',
    inputJson: JSON.stringify({ gtin: '745801105447' }),
    policyJson: JSON.stringify({ configId: 'c' }),
    configSnapshotId: 'c',
    configSnapshotHash: 'c',
  }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(wsPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Transitive call-graph: every network-capable tool adapter gates through the
// policy gateway.
// ---------------------------------------------------------------------------

describe('P0-1 transitive network boundary', () => {
  // Genuinely transitive: every network-capable adapter's transport function
  // must (a) accept an injected fetch, and (b) be called by the adapter with
  // a gateway-bound fetch. A preflight checkNetworkRequest alone is NOT
  // sufficient — the actual HTTP owner must be the injected gateway fetch.

  const TRANSPORT_SEAMS: Array<{ file: string; needle: string; note: string }> = [
    { file: 'src/onboarding/page-extractor.ts', needle: 'fetchFn: NetworkFetch = fetch', note: 'extractViaHttpDetailed' },
    { file: 'src/onboarding/sitemap-fetcher.ts', needle: 'fetchFn: NetworkFetch = fetch', note: 'fetchAndParseSitemap' },
    { file: 'src/onboarding/variant-url-resolver.ts', needle: 'fetchFn?: NetworkFetch', note: 'resolveVariantsForCandidates' },
    { file: 'src/crawler/importers/icecat.ts', needle: 'fetchFn: NetworkFetch = fetch', note: 'fetchOpenIcecatByGtin' },
    { file: 'src/onboarding/packaging-ocr.ts', needle: 'fetchFn?: NetworkFetch', note: 'extractPackagingOcr params' },
    { file: 'src/onboarding/source-discovery.ts', needle: 'networkFetch?: NetworkFetch', note: 'discoverSources/searchSerper/sitemap/variant chain' },
    { file: 'src/onboarding/vlm-client.ts', needle: 'fetchFn: NetworkFetch = fetch', note: 'callVlm model call' },
  ] as const;

  it('every network-owning transport accepts an injected fetch', () => {
    for (const seam of TRANSPORT_SEAMS) {
      const source = fs.readFileSync(seam.file, 'utf8');
      expect(source, `${seam.note} (${seam.file}) must accept an injected fetchFn`).toContain(seam.needle);
    }
  });

  it('every tool adapter binds its legacy transport to a gateway-built fetch', () => {
    const extraction = fs.readFileSync('src/product-intelligence/tools/extraction-tools.ts', 'utf8');
    expect(extraction).toContain('buildPiNetworkFetch');
    expect(extraction).toContain('extractViaHttpDetailed');
    expect(extraction).toContain('extractPackagingOcr');
    const identity = fs.readFileSync('src/product-intelligence/tools/identity-tools.ts', 'utf8');
    expect(identity).toContain('buildPiNetworkFetch');
    expect(identity).toContain('fetchOpenIcecatByGtin');
    const discovery = fs.readFileSync('src/product-intelligence/tools/discovery-tools.ts', 'utf8');
    expect(discovery).toContain('buildPiNetworkFetch');
    expect(discovery).toContain('fetchAndParseSitemap');
    expect(discovery).toContain('resolveVariantsForCandidates');
    // Round 3: the discovery chain (search_upc / search_product_name) is
    // bound end-to-end — discoverSources receives the gateway transport.
    expect(discovery).toContain('discoverSources');
    expect(discovery).toContain('discoveryNetworkFetch');
    expect(discovery).toContain('networkFetch: discoveryNetworkFetch(ctx)');
    // The worker payload schema carries the run's allowed source domains.
    const workerSchema = fs.readFileSync('src/shared/schemas/extraction-worker.ts', 'utf8');
    expect(workerSchema).toContain('sourcesAllowlist');
  });

  it('extract_structured_page_data drives the real fetch through the injected gateway fetch (spy)', async () => {
    const calls: string[] = [];
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
      // Contextually typed against the gateway's fetchFn so it satisfies
      // Bun's `typeof fetch` (the same pattern as the redirect test above).
      fetchFn: async (input, init) => {
        void init;
        calls.push(String(input));
        return new Response(
          '<html><body><script type="application/ld+json">{"@type":"Product","name":"Wormeze"}</script></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      },
    });
    const tool = defaultToolRegistry.get('extract_structured_page_data');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { url: 'https://shop.example.com/p' },
      makeCtx({
        gateway,
        policy: makePolicy({ dataSharingPolicy: 'cloud_models_and_sources', networkPolicy: 'allowlisted_remote' }),
      }),
    );
    // The spy — NOT a raw legacy fetch — performed the HTTP.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBe('https://shop.example.com/p');
    expect(['no_result', 'ok']).toContain(result.status);
  });

  it('lookup_structured_product_database is policy-gated (local_only denies before any network)', async () => {
    const tool = defaultToolRegistry.get('lookup_structured_product_database');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { gtin: '745801105447' },
      makeCtx({ policy: makePolicy({ networkPolicy: 'local_only' }) }),
    );
    expect(result.status).toBe('policy_denied');
    expect((result as { reason: string }).reason).toMatch(/icecat lookup denied/);
  });

  it('every discovery adapter individually is gateway-gated', () => {
    // Source-level per-adapter check for the discovery stack (the historical
    // bypass point per the review).
    const source = fs.readFileSync('src/product-intelligence/tools/discovery-tools.ts', 'utf8');
    for (const tool of discoveryTools) {
      const start = source.indexOf(`name: '${tool.name}'`);
      expect(start, `adapter ${tool.name} missing from source`).toBeGreaterThanOrEqual(0);
      // Adapter blocks end at the next "name: '" or the file end.
      const next = source.indexOf(`name: '`, start + 8);
      const block = next === -1 ? source.slice(start) : source.slice(start, next);
      const networkCapable = /(?<![a-z_])fetch\(|discoverSources|fetchAndParseSitemap|resolveVariantsForCandidates|extractPackagingOcr|searchSerper/.test(block);
      if (networkCapable) {
        expect(
          /checkNetworkRequest|gatewayFetch|buildPiNetworkFetch|policyDenied|discoveryNetworkFetch/.test(block),
          `discovery adapter ${tool.name} reaches the network without a gateway gate`,
        ).toBe(true);
      }
    }
  });

  it('the discovery chain rides the injected transport end-to-end (search_upc spy)', async () => {
    upsertApiKey('serper', 'test-serper-key');
    const calls: string[] = [];
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
      fetchFn: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    // search_upc under a permissive policy: the pre-check passes and the
    // DISCOVERY CHAIN's HTTP must ride the gateway's spy — never a raw fetch.
    const tool = defaultToolRegistry.get('search_upc');
    const result = await tool!.execute(
      { gtin: '745801105447', name: 'Feline Wormeze Liquid' },
      makeCtx({
        gateway,
        policy: makePolicy({ dataSharingPolicy: 'cloud_models_and_sources', networkPolicy: 'allowlisted_remote' }),
      }),
    );
    expect(calls.length).toBeGreaterThan(0);
    // The Serper query rode the gateway spy; every discovery-chain HTTP call
    // (Serper, candidate variant fetches) went through the spy — none raw.
    expect(calls[0]).toBe('https://google.serper.dev/search');
    expect(['no_result', 'ok', 'error']).toContain(result.status);
  });
});

// ---------------------------------------------------------------------------
// search_query data-sharing gate
// ---------------------------------------------------------------------------

describe('P0-1 search data-sharing gate', () => {
  const SERPER_URL = 'https://google.serper.dev/search';

  it('denies third-party search under local_only data-sharing', async () => {
    const gateway = stubGateway();
    const decision = await gateway.checkNetworkRequest(
      makeCtx({ policy: makePolicy({ dataSharingPolicy: 'local_only' }) }),
      SERPER_URL,
      'search_query',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('data_sharing_denies_search');
    // Audit row written (record() writes asynchronously — settle first).
    await new Promise((r) => setTimeout(r, 25));
    const row = getDb()
      .query('SELECT reason_code FROM product_intelligence_policy_decisions WHERE target = ?')
      .get(SERPER_URL) as { reason_code: string } | undefined;
    expect(row?.reason_code).toBe('data_sharing_denies_search');
  });

  it('denies third-party search under cloud_models_only data-sharing', async () => {
    const decision = await stubGateway().checkNetworkRequest(
      makeCtx({ policy: makePolicy({ dataSharingPolicy: 'cloud_models_only' }) }),
      SERPER_URL,
      'search_query',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('data_sharing_denies_search');
  });

  it('allows third-party search under cloud_models_and_sources', async () => {
    const decision = await stubGateway().checkNetworkRequest(
      makeCtx({ policy: makePolicy({ dataSharingPolicy: 'cloud_models_and_sources' }) }),
      SERPER_URL,
      'search_query',
    );
    expect(decision.allowed).toBe(true);
  });

  it('buildPiNetworkFetch produces a fetch that denies search queries under local_only', async () => {
    const gateway = stubGateway();
    const fetchFn = gateway.buildPiNetworkFetch(makeCtx({ policy: makePolicy({ dataSharingPolicy: 'local_only' }) }), {
      dataClassification: 'search_query',
    });
    await expect(fetchFn(SERPER_URL)).rejects.toThrow(/Policy denied: data_sharing_denies_search/);
  });
});

// ---------------------------------------------------------------------------
// SSRF floor + redirect re-validation
// ---------------------------------------------------------------------------

describe('P0-1 SSRF and redirect enforcement', () => {
  it('denies a private IPv4 destination', async () => {
    const decision = await defaultPolicyGateway.checkNetworkRequest(makeCtx(), 'http://127.0.0.1/admin');
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('private_network_destination');
  });

  it('denies a link-local destination', async () => {
    const decision = await defaultPolicyGateway.checkNetworkRequest(makeCtx(), 'http://169.254.169.254/latest/meta-data');
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('private_network_destination');
  });

  it('denies a redirect that tunnels a public start URL to a private destination', async () => {
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => {
        const ipLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
        return ipLiteral ? [hostname] : ['93.184.216.34'];
      },
      fetchFn: async (input) => {
        const target = String(input);
        if (target === 'https://shop.example.com/p') {
          return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } });
        }
        return new Response('ok', { status: 200 });
      },
    });
    await expect(
      gateway.gatewayFetch(makeCtx(), 'https://shop.example.com/p', {}, { maxResponseBytes: 1024 }),
    ).rejects.toThrow(/Policy denied: private_network_destination/);
  });

  it('records an audit row per denied network decision', async () => {
    await defaultPolicyGateway.checkNetworkRequest(makeCtx(), 'http://127.0.0.1/x');
    await new Promise((r) => setTimeout(r, 25));
    const row = getDb()
      .query('SELECT decision FROM product_intelligence_policy_decisions WHERE target = ?')
      .get('http://127.0.0.1/x') as { decision: string } | undefined;
    expect(row?.decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Tool-level behavior
// ---------------------------------------------------------------------------

describe('P0-1 discovery tools fail closed through the policy', () => {
  it('search_upc returns policy_denied under local_only (never a crash, never a query)', async () => {
    const tool = defaultToolRegistry.get('search_upc');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { gtin: '745801105447', name: 'Feline Wormeze Liquid' },
      makeCtx({ policy: makePolicy({ dataSharingPolicy: 'local_only', networkPolicy: 'allowlisted_remote' }) }),
    );
    expect(result.status).toBe('policy_denied');
    expect((result as { reason: string }).reason).toMatch(/web search denied/);
  });

  it('search_upc under local_only never invokes the transport (spy fetch uncalled)', async () => {
    const calls: string[] = [];
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
      fetchFn: async (input) => {
        calls.push(String(input));
        return new Response('{}', { status: 200 });
      },
    });
    const tool = defaultToolRegistry.get('search_upc');
    const result = await tool!.execute(
      { gtin: '745801105447', name: 'Feline Wormeze Liquid' },
      makeCtx({ gateway, policy: makePolicy({ dataSharingPolicy: 'local_only', networkPolicy: 'allowlisted_remote' }) }),
    );
    expect(result.status).toBe('policy_denied');
    // Round 3: the denied pre-check stops the call BEFORE the discovery
    // chain's transport can fire — zero bytes leave the process.
    expect(calls.length).toBe(0);
  });

  it('search_product_name returns policy_denied under local_only', async () => {
    const tool = defaultToolRegistry.get('search_product_name');
    const result = await tool!.execute({ name: 'Wormeze' }, makeCtx({ policy: makePolicy({ dataSharingPolicy: 'local_only' }) }));
    expect(result.status).toBe('policy_denied');
  });

  it('search_brand_sitemap denies a private domain', async () => {
    const tool = defaultToolRegistry.get('search_brand_sitemap');
    const result = await tool!.execute(
      { domain: '127.0.0.1', gtin: '745801105447' },
      makeCtx({ policy: makePolicy({ networkPolicy: 'local_only' }) }),
    );
    expect(result.status).toBe('policy_denied');
  });

  it('resolve_product_variants fails closed when every candidate is denied', async () => {
    const tool = defaultToolRegistry.get('resolve_product_variants');
    const result = await tool!.execute(
      { gtin: '745801105447', rawName: 'Wormeze', candidateUrls: ['http://127.0.0.1/a', 'http://10.0.0.5/b'] },
      makeCtx({ policy: makePolicy({ networkPolicy: 'local_only' }) }),
    );
    expect(result.status).toBe('policy_denied');
  });

  it('unrestricted search falls through to the discovery stack (Serper key missing => no_result, not policy_denied)', async () => {
    const tool = defaultToolRegistry.get('search_upc');
    const result = await tool!.execute(
      { gtin: '745801105447' },
      makeCtx({ policy: makePolicy({ dataSharingPolicy: 'cloud_models_and_sources' }) }),
    );
    expect(result.status).not.toBe('policy_denied');
    expect(result.status === 'no_result' || result.status === 'error').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 3: discovery-chain, Icecat-SDK, and VLM transport injection
// ---------------------------------------------------------------------------

describe('P0-1 round-3 transport injection', () => {
  it('discoverSources performs its Serper HTTP through the injected transport (spy)', async () => {
    upsertApiKey('serper', 'test-serper-key');
    const calls: string[] = [];
    const spy: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (input, _init) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          organic: [{ title: 'Feline Wormeze Liquid 4 oz', link: 'https://brand.example.com/p/wormeze-4oz', snippet: 'wormer', position: 1 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const { candidates } = await discoverSources('745801105447', 'Feline Wormeze Liquid', 'farnam.com', {
      // Skip the LLM name-consolidation call for a deterministic test.
      existingExpectedName: 'Feline Wormeze Liquid',
      networkFetch: spy,
    });
    expect(calls.length).toBeGreaterThan(0);
    // The Serper query rode the injected transport; the spy also performs the
    // variant-resolution fetches (fetchFn threading) — every discovery-chain
    // HTTP goes through the injected transport, never a raw global fetch.
    expect(calls.some((url) => url === 'https://google.serper.dev/search')).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('fetchOpenIcecatByGtin with an injected fetch uses the REST path via the spy (SDK skipped)', async () => {
    const calls: string[] = [];
    const spy: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (input, _init) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          data: {
            GeneralInfo: {
              Title: 'Feline Wormeze Liquid',
              Brand: 'Durvet',
              GTIN: ['745801105447'],
              Category: { Name: { Value: 'Wormer' } },
              Description: { LongDesc: 'Cat dewormer' },
            },
            Image: { HighPic: 'https://cdn.example.com/wormeze.jpg' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const evidence = await fetchOpenIcecatByGtin('745801105447', 'testuser', spy);
    expect(evidence).not.toBeNull();
    expect(evidence?.title).toBe('Feline Wormeze Liquid');
    expect(calls.length).toBe(1);
    // The gateway-compatible REST endpoint — NOT the SDK (whose HTTP cannot
    // be policy-gated).
    expect(calls[0]).toContain('live.icecat.biz');
  });

  it('callVlm performs the model HTTP through the injected fetch (spy)', async () => {
    const calls: string[] = [];
    const spy: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (input, _init) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ message: { content: '{"productName":"Wormeze"}' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const content = await callVlm(
      'extract',
      'aW1hZ2U=',
      { baseUrl: 'http://localhost:11434', model: 'qwen2.5vl:latest', enabled: true },
      spy,
    );
    expect(content).toBe('{"productName":"Wormeze"}');
    expect(calls).toEqual(['http://localhost:11434/api/chat']);
  });

  it('extractPackagingOcr threads the injected fetch into BOTH the image download and the VLM call', async () => {
    upsertApiKey('ollama_vlm', 'enabled', 'http://localhost:11434', 'qwen2.5vl:latest');
    const calls: string[] = [];
    const spy: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (input, _init) => {
      calls.push(String(input));
      const url = String(input);
      if (url.includes('/api/chat')) {
        return new Response(JSON.stringify({ message: { content: '{"productName":"Feline Wormeze Liquid"}' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The image download: >= 1KB non-SVG bytes.
      return new Response(new Uint8Array(2048).fill(7), { status: 200, headers: { 'content-type': 'image/png' } });
    };
    const ocr = await extractPackagingOcr({
      imageUrl: 'https://cdn.example.com/wormeze.jpg',
      sku: '745801105447',
      fetchFn: spy,
    });
    expect(ocr).not.toBeNull();
    expect(ocr?.productName).toBe('Feline Wormeze Liquid');
    expect(calls).toContain('https://cdn.example.com/wormeze.jpg');
    expect(calls).toContain('http://localhost:11434/api/chat');
  });

  it('packaging-ocr passes the injected fetch into callVlm (source-level)', () => {
    const source = fs.readFileSync('src/onboarding/packaging-ocr.ts', 'utf8');
    expect(source).toContain('callVlm(PACKAGING_OCR_PROMPT, base64Image, vlmConfig, fetchFn)');
  });
});

// ---------------------------------------------------------------------------
// Transport seams accept the injected (gateway-bound) fetch
// ---------------------------------------------------------------------------

describe('P0-1 transport seams', () => {
  it('fetchPageHtml accepts an injected fetchFn', async () => {
    const html = '<html><body>product</body></html>';
    const fetchFn = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    const page = await fetchPageHtml('https://shop.example.com/p', new AbortController().signal, 5000, fetchFn);
    expect(page.html).toBe(html);
    expect(page.contentHash).toBe(sha256Hex(html));
    expect(page.status).toBe(200);
  });

  it('ManagedFallbackRegistry attaches the injected fetchFn to provider requests', async () => {
    let receivedFetchFn: unknown = null;
    const observingProvider = {
      name: 'observing_provider',
      version: '0.1.0',
      async fetchPage(request: { url: string; signal: AbortSignal; timeoutMs: number; fetchFn?: unknown }) {
        receivedFetchFn = request.fetchFn;
        return { finalUrl: request.url, html: '', contentHash: sha256Hex(''), statusCode: 200, fetchedAt: new Date().toISOString() };
      },
    };
    const registry = new ManagedFallbackRegistry(
      { providers: [{ name: 'observing_provider', pinnedVersion: '0.1.0', allowedDomains: ['shop.example.com'], enabled: true, selectedByBenchmark: false }] },
      [observingProvider],
      async () => new Response('x', { status: 200 }),
    );
    await registry.fetch('https://shop.example.com/p', new AbortController().signal, 5000);
    expect(typeof receivedFetchFn).toBe('function');
  });

  // ---------------------------------------------------------------------
  // Round-3 finding 3: no module-global browser-policy state, and the
  // extraction-worker DNS check fails closed.
  // ---------------------------------------------------------------------

  it('per-run snapshot payloads carry their own source allowlist (no shared state)', () => {
    const runA = snapshotRequestFor({ url: 'https://a.example.com/p', captureNetwork: true }, ['a.example.com']);
    const runB = snapshotRequestFor({ url: 'https://b.example.com/p', captureNetwork: true }, ['b.example.com']);
    expect(runA.sourcesAllowlist).toEqual(['a.example.com']);
    expect(runB.sourcesAllowlist).toEqual(['b.example.com']);
    // Distinct arrays — a mutation of one run's policy must never leak into
    // the other run's payload.
    expect(runA.sourcesAllowlist).not.toBe(runB.sourcesAllowlist);
    runA.sourcesAllowlist!.push('contaminated.example.com');
    expect(runB.sourcesAllowlist).toEqual(['b.example.com']);
  });

  it('no module-scope browser-allowlist state remains in the ladder wiring', async () => {
    const wiring = await Bun.file('src/product-intelligence/extraction/wiring.ts').text();
    expect(wiring).not.toContain('snapshotSourcesAllowlist');
    expect(wiring).not.toContain('setSnapshotSourcesAllowlist');
  });

  it('extraction-worker DNS destination check fails closed and denies private-resolving hosts', async () => {
    // A hostname that resolves (via /etc/hosts) to a loopback address.
    const localhostBlock = await resolveDestinationAndCheck('http://localhost/p');
    expect(localhostBlock).not.toBeNull();
    expect(localhostBlock).toContain('private');
    // NXDOMAIN / resolver failure must DENY, not allow (fail closed).
    const nxDomainBlock = await resolveDestinationAndCheck('http://no-such-host-round3.invalid/p');
    expect(nxDomainBlock).not.toBeNull();
    expect(nxDomainBlock).toContain('fail closed');
  });
});

// Keep the compiler honest that these helpers exist (imports are used).
void policyDenied;
void HTTP_EXTRACTION_HEADERS;
void defaultPolicyGateway;
