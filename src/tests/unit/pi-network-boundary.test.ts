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
import { PolicyGateway, PolicyDeniedError, MAX_MODEL_RESPONSE_BYTES } from '../../product-intelligence/policy/policy-gateway';
import { defaultPolicyGateway } from '../../product-intelligence/policy';
import { defaultToolRegistry } from '../../product-intelligence/tools';
import { discoveryTools } from '../../product-intelligence/tools/discovery-tools';
import { fetchPageHtml, HTTP_EXTRACTION_HEADERS } from '../../product-intelligence/extraction/platforms';
import { ManagedFallbackRegistry } from '../../product-intelligence/extraction/managed-fallback';
import { snapshotRequestFor } from '../../product-intelligence/extraction/wiring';
import { resolveDestinationAndCheck, pinHttpDestination, resolvePublicAddress } from '../../extraction-worker/routes/snapshot';
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
    { file: 'src/onboarding/page-verifier.ts', needle: 'fetchFn: NetworkFetch = fetch', note: 'verifyCandidate' },
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
    const verification = fs.readFileSync('src/product-intelligence/tools/verification-tools.ts', 'utf8');
    expect(verification).toContain('buildPiNetworkFetch');
    expect(verification).toContain('verifyCandidate');
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
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(urlStr);
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

  it('verify_candidate_page drives the real fetch through the injected gateway fetch (spy)', async () => {
    const calls: string[] = [];
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
      fetchFn: async (input) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(urlStr);
        return new Response('<html><head><title>Acme Widget GTIN 01234567890123</title></head><body>UPC 01234567890123 Acme</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    const tool = defaultToolRegistry.get('verify_candidate_page');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { url: 'https://shop.example.com/verify-product', gtin: '01234567890123', expectedName: 'Acme Widget' },
      makeCtx({
        gateway,
        policy: makePolicy({ dataSharingPolicy: 'cloud_models_and_sources', networkPolicy: 'allowlisted_remote' }),
      }),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBe('https://shop.example.com/verify-product');
    expect(result.status).toBe('ok');
  });

  it('verify_candidate_page respects caller cancellation/deadline signal (Round 14 review P1-4)', async () => {
    const controller = new AbortController();
    controller.abort(); // pre-aborted caller signal
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
      fetchFn: async (_url, init) => {
        if (init?.signal?.aborted) {
          throw new DOMException('The operation was aborted', 'AbortError');
        }
        return new Response('<html></html>', { status: 200 });
      },
    });

    const tool = defaultToolRegistry.get('verify_candidate_page');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { url: 'https://shop.example.com/verify-product', gtin: '01234567890123', expectedName: 'Acme Widget' },
      makeCtx({
        gateway,
        signal: controller.signal,
        policy: makePolicy({ dataSharingPolicy: 'cloud_models_and_sources', networkPolicy: 'allowlisted_remote' }),
      }),
    );
    expect(result.status).toBe('no_result');
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
      makeCtx({ gateway: stubGateway(), policy: makePolicy({ dataSharingPolicy: 'cloud_models_and_sources' }) }),
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

  it('packaging-ocr passes the injected model transport into callVlm (source-level)', () => {
    const source = fs.readFileSync('src/onboarding/packaging-ocr.ts', 'utf8');
    expect(source).toContain('callVlm(PACKAGING_OCR_PROMPT, base64Image, vlmConfig, modelFetchFn ?? fetchFn)');
  });
});

// ---------------------------------------------------------------------------
// Round-4: VLM model-policy boundary (checkModelEndpoint) + field-level OCR
// evidence bound to the exact downloaded bytes (contentHash)
// ---------------------------------------------------------------------------

describe('P0-1 round-4 VLM model-policy boundary', () => {
  it('a REMOTE VLM endpoint is denied under local_only (model authority, not network authority)', async () => {
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
    });
    const decision = await gateway.checkModelEndpoint(makeCtx({ policy: makePolicy({ dataSharingPolicy: 'local_only' }) }), {
      provider: 'ollama_vlm',
      model: 'qwen2.5vl:latest',
      endpointUrl: 'https://vlm.example.com',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('local_only_denies_model');
  });

  it('a LOCAL loopback VLM endpoint is allowed under local_only', async () => {
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
    });
    const decision = await gateway.checkModelEndpoint(makeCtx({ policy: makePolicy({ dataSharingPolicy: 'local_only' }) }), {
      provider: 'ollama_vlm',
      model: 'qwen2.5vl:latest',
      endpointUrl: 'http://127.0.0.1:11434',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.detail).toContain('local model endpoint');
  });

  it('a REMOTE VLM endpoint under cloud_models_only requires the modelRoute to match', async () => {
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
    });
    const baseCtx = makeCtx({
      policy: makePolicy({
        dataSharingPolicy: 'cloud_models_only',
        modelRoute: { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', thinkingLevel: 'off' },
      }),
    });
    const matching = await gateway.checkModelEndpoint(baseCtx, {
      provider: 'ollama_vlm',
      model: 'qwen2.5vl:latest',
      endpointUrl: 'https://vlm.example.com',
    });
    expect(matching.allowed).toBe(true);
    const nonMatching = await gateway.checkModelEndpoint(baseCtx, {
      provider: 'ollama_vlm',
      model: 'some-other-model',
      endpointUrl: 'https://vlm.example.com',
    });
    expect(nonMatching.allowed).toBe(false);
    expect(nonMatching.reasonCode).toBe('model_not_in_route');
  });

  it('extract_packaging_evidence emits one field-level evidence entry per OCR fact, each bound to the exact downloaded bytes', async () => {
    upsertApiKey('ollama_vlm', 'enabled', 'http://127.0.0.1:11434', 'qwen2.5vl:latest');
    const imageBytes = new Uint8Array(2048).fill(7);
    const expectedHash = sha256Hex(Buffer.from(imageBytes));
    const calls: string[] = [];
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
      fetchFn: async (input, _init) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/api/chat')) {
          return new Response(
            JSON.stringify({ message: { content: '{"productName":"Feline Wormeze Liquid","brand":"Farnam","size":"4 oz","upc":"745801105447","count":"1"}' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(imageBytes, { status: 200, headers: { 'content-type': 'image/png' } });
      },
    });
    const tool = defaultToolRegistry.get('extract_packaging_evidence');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { imageUrl: 'https://cdn.example.com/wormeze.jpg', gtin: '745801105447' },
      makeCtx({ gateway, policy: makePolicy({ dataSharingPolicy: 'local_only' }) }),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // Round-6: the OCR adapter now emits upc + count as well.
    expect(result.evidence.length).toBe(5); // productName, brand, size, upc, count
    const byField = new Map(result.evidence.map((e) => [(e as { field?: string }).field ?? '', e]));
    for (const [field, value] of [
      ['productName', 'Feline Wormeze Liquid'],
      ['brand', 'Farnam'],
      ['size', '4 oz'],
      ['upc', '745801105447'],
      ['count', '1'],
    ] as const) {
      const entry = byField.get(field) as { value?: string; contentHash?: string; method?: string; url?: string; id?: string };
      expect(entry).toBeDefined();
      expect(entry.value).toBe(value);
      expect(entry.method).toBe('image_ocr');
      expect(entry.contentHash).toBe(expectedHash);
      expect(entry.url).toBe('https://cdn.example.com/wormeze.jpg');
      expect(entry.id).toContain(`:${field}:`);
    }
    // Both authorities performed their own HTTP through the gateway transport.
    expect(calls).toContain('https://cdn.example.com/wormeze.jpg');
    expect(calls).toContain('http://127.0.0.1:11434/api/chat');
  });

  it('the VLM model call is denied when the endpoint is remote under local_only (end-to-end through the tool)', async () => {
    upsertApiKey('ollama_vlm', 'enabled', 'https://vlm.example.com', 'qwen2.5vl:latest');
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.includes(':') || /^[\d.]+$/.test(hostname) ? [hostname] : ['93.184.216.34']),
      fetchFn: async () => new Response('{}', { status: 200 }),
    });
    const tool = defaultToolRegistry.get('extract_packaging_evidence');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { imageUrl: 'https://cdn.example.com/wormeze.jpg' },
      makeCtx({ gateway, policy: makePolicy({ dataSharingPolicy: 'local_only' }) }),
    );
    expect(result.status).toBe('policy_denied');
    if (result.status === 'policy_denied') {
      expect(result.reason).toContain('VLM model call denied: local_only_denies_model');
    }
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

// ---------------------------------------------------------------------------
// Round-4 P1-4: DNS-rebinding TOCTOU hardening
// ---------------------------------------------------------------------------

describe('P0-1 round-4 DNS-rebinding pinning', () => {
  it('pinHttpDestination rewrites an http hostname URL to the validated address literal', () => {
    const pinned = pinHttpDestination('http://brand.example.com/p/wormeze-4oz?ref=1', '93.184.216.34');
    expect(pinned).toBe('http://93.184.216.34/p/wormeze-4oz?ref=1');
  });

  it('pinHttpDestination never pins https (TLS SNI — the residual TOCTOU window stays re-validation-only)', () => {
    expect(pinHttpDestination('https://brand.example.com/p/wormeze', '93.184.216.34')).toBeNull();
  });

  it('pinHttpDestination never pins IP-literal hosts or empty addresses', () => {
    expect(pinHttpDestination('http://93.184.216.34/p', '93.184.216.34')).toBeNull();
    expect(pinHttpDestination('http://brand.example.com/p', '')).toBeNull();
    expect(pinHttpDestination('not a url', '93.184.216.34')).toBeNull();
  });

  it('pinHttpDestination brackets IPv6 addresses', () => {
    expect(pinHttpDestination('http://brand.example.com/p', '2606:2800:220:1:248:1893:25c8:1946')).toBe(
      'http://[2606:2800:220:1:248:1893:25c8:1946]/p',
    );
  });

  it('resolvePublicAddress denies private-resolving hostnames (fail closed)', async () => {
    // localhost resolves (via /etc/hosts) to a loopback address.
    expect(await resolvePublicAddress('localhost')).toBeNull();
  });

  it('resolvePublicAddress denies unresolvable hostnames (fail closed)', async () => {
    expect(await resolvePublicAddress('no-such-host-round4.invalid')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-5: model transports compose TWO authorities — model/data-sharing AND
// destination/SSRF — on every hop, with a stream-bounded response cap.
// ---------------------------------------------------------------------------

describe('P0-1 round-5 model-transport destination authority', () => {
  /** A gateway whose DNS never touches the real network. */
  function literalGateway(fetchFn: (input: string, init?: RequestInit) => Promise<Response>): PolicyGateway {
    return new PolicyGateway({
      fetchFn: fetchFn as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
      resolveHostname: async (hostname) => {
        if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return [hostname];
        return ['93.184.216.34'];
      },
    });
  }

  const modelCall = { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', endpointUrl: 'https://vlm.example.com' };

  it('a remote model endpoint at a private address is denied even with a matching model route', async () => {
    const gateway = literalGateway(async () => new Response('{}', { status: 200 }));
    const ctx = makeCtx({
      policy: makePolicy({
        dataSharingPolicy: 'cloud_models_only',
        modelRoute: { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', thinkingLevel: 'off' },
      }),
    });
    const fetch = gateway.buildModelFetch(ctx, modelCall);
    // 10.0.0.5 is private; the model route matches but the SSRF floor denies.
    await expect(fetch('http://10.0.0.5/v1/chat')).rejects.toThrow(PolicyDeniedError);
  });

  it('a remote model endpoint on a non-80/443 port is denied', async () => {
    const gateway = literalGateway(async () => new Response('{}', { status: 200 }));
    const ctx = makeCtx({
      policy: makePolicy({
        dataSharingPolicy: 'cloud_models_only',
        modelRoute: { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', thinkingLevel: 'off' },
      }),
    });
    const fetch = gateway.buildModelFetch(ctx, modelCall);
    await expect(fetch('https://vlm.example.com:9999/v1/chat')).rejects.toThrow(/port 9999 not allowed/);
  });

  it('a remote model endpoint redirecting to a loopback/private destination is denied', async () => {
    const gateway = literalGateway(async (input) => {
      const url = String(input);
      if (url.startsWith('https://vlm.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8000/v1/chat' } });
      }
      return new Response('{}', { status: 200 });
    });
    const ctx = makeCtx({
      policy: makePolicy({
        dataSharingPolicy: 'cloud_models_only',
        modelRoute: { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', thinkingLevel: 'off' },
      }),
    });
    const fetch = gateway.buildModelFetch(ctx, modelCall);
    // The redirect hop is re-checked with BOTH authorities; the loopback
    // target falls under the loopback-model policy, whose port allowlist
    // (80/443/11434/11435) rejects :8000.
    await expect(fetch('https://vlm.example.com/v1/chat')).rejects.toThrow(PolicyDeniedError);
  });

  it('a local model endpoint under local_only is allowed through the composed transport', async () => {
    const calls: string[] = [];
    const gateway = literalGateway(async (input) => {
      calls.push(String(input));
      return new Response('{"done":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const ctx = makeCtx({ policy: makePolicy({ dataSharingPolicy: 'local_only' }) });
    const fetch = gateway.buildModelFetch(ctx, {
      provider: 'ollama_vlm',
      model: 'qwen2.5vl:latest',
      endpointUrl: 'http://127.0.0.1:11434',
    });
    const response = await fetch('http://127.0.0.1:11434/api/chat');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"done":true}');
    expect(calls).toEqual(['http://127.0.0.1:11434/api/chat']);
  });

  it('a local model endpoint redirecting off-loopback is denied (local redirects must stay loopback)', async () => {
    const gateway = literalGateway(async (input) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:11434')) {
        return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5:11434/api/chat' } });
      }
      return new Response('{}', { status: 200 });
    });
    // Permissive policy so ONLY the destination authority can deny the hop.
    const ctx = makeCtx({
      policy: makePolicy({
        dataSharingPolicy: 'cloud_models_and_sources',
        networkPolicy: 'allowlisted_remote',
        modelRoute: { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', thinkingLevel: 'off' },
      }),
    });
    const fetch = gateway.buildModelFetch(ctx, {
      provider: 'ollama_vlm',
      model: 'qwen2.5vl:latest',
      endpointUrl: 'http://127.0.0.1:11434',
    });
    // 10.0.0.5 is not loopback -> the redirect hop is treated as remote and
    // the private-address floor denies it.
    await expect(fetch('http://127.0.0.1:11434/api/chat')).rejects.toThrow(/zone_transition|private|invalid_port|local model endpoint/);
  });

  // -------------------------------------------------------------------
  // Round-6: the model transport TRUST ZONE is classified once from the
  // configured endpoint and never transitions. A route-authorized remote
  // VLM cannot redirect into 127.0.0.1:11434 (the loopback model policy
  // would otherwise allow it), and a local Ollama cannot hop out to a
  // public endpoint.
  // -------------------------------------------------------------------

  it('a remote model redirecting to an allowlisted loopback port is denied (zone_transition)', async () => {
    // The reviewer's exact case: vlm.example.com 302s to http://127.0.0.1:11434.
    // Port 11434 IS in LOCAL_MODEL_PORTS — the old code allowed the hop; the
    // round-6 zone rule denies it as a local/remote transition.
    const gateway = literalGateway(async (input) => {
      const url = String(input);
      if (url.startsWith('https://vlm.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:11434/api/chat' } });
      }
      return new Response('{}', { status: 200 });
    });
    const ctx = makeCtx({
      policy: makePolicy({
        dataSharingPolicy: 'cloud_models_only',
        modelRoute: { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', thinkingLevel: 'off' },
      }),
    });
    const fetch = gateway.buildModelFetch(ctx, modelCall);
    // The zone rule denies the hop with reasonCode zone_transition (the
    // message carries the reason; bun's toThrow callback form is unusable).
    await expect(fetch('https://vlm.example.com/v1/chat')).rejects.toThrow(/zone_transition/);
  });

  it('a remote model redirecting to a private (non-loopback) address is denied', async () => {
    const gateway = literalGateway(async (input) => {
      const url = String(input);
      if (url.startsWith('https://vlm.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5:11434/api/chat' } });
      }
      return new Response('{}', { status: 200 });
    });
    const ctx = makeCtx({
      policy: makePolicy({
        dataSharingPolicy: 'cloud_models_only',
        modelRoute: { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', thinkingLevel: 'off' },
      }),
    });
    const fetch = gateway.buildModelFetch(ctx, modelCall);
    // 10.x is not loopback, so the hop stays 'remote' zone; the public/
    // remote destination floor rejects the private address.
    await expect(fetch('https://vlm.example.com/v1/chat')).rejects.toThrow(/private|Policy denied/);
  });

  it('a remote model redirecting to another remote endpoint is allowed (remote stays remote)', async () => {
    const calls: string[] = [];
    const gateway = literalGateway(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://vlm.example.com/v1/chat') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/vlm/chat' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const ctx = makeCtx({
      policy: makePolicy({
        dataSharingPolicy: 'cloud_models_only',
        modelRoute: { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', thinkingLevel: 'off' },
      }),
    });
    const fetch = gateway.buildModelFetch(ctx, modelCall);
    const response = await fetch('https://vlm.example.com/v1/chat');
    expect(response.status).toBe(200);
    expect(calls).toEqual(['https://vlm.example.com/v1/chat', 'https://cdn.example.com/vlm/chat']);
  });

  it('a local model redirecting to a public endpoint is denied (local never becomes remote)', async () => {
    const gateway = literalGateway(async (input) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:11434')) {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/api/chat' } });
      }
      return new Response('{}', { status: 200 });
    });
    const ctx = makeCtx({ policy: makePolicy({ dataSharingPolicy: 'cloud_models_and_sources' }) });
    const fetch = gateway.buildModelFetch(ctx, {
      provider: 'ollama_vlm',
      model: 'qwen2.5vl:latest',
      endpointUrl: 'http://127.0.0.1:11434',
    });
    await expect(fetch('http://127.0.0.1:11434/api/chat')).rejects.toThrow(/zone_transition/);
  });

  it('a local model redirecting to another loopback endpoint is allowed (local stays local)', async () => {
    const calls: string[] = [];
    const gateway = literalGateway(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'http://127.0.0.1:11434/api/chat') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:11435/api/chat' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const ctx = makeCtx({ policy: makePolicy({ dataSharingPolicy: 'local_only' }) });
    const fetch = gateway.buildModelFetch(ctx, {
      provider: 'ollama_vlm',
      model: 'qwen2.5vl:latest',
      endpointUrl: 'http://127.0.0.1:11434',
    });
    const response = await fetch('http://127.0.0.1:11434/api/chat');
    expect(response.status).toBe(200);
    // 11435 is in LOCAL_MODEL_PORTS and both hops are explicit loopback.
    expect(calls).toEqual(['http://127.0.0.1:11434/api/chat', 'http://127.0.0.1:11435/api/chat']);
  });

  it('a chunked model response without Content-Length exceeding 20MB is rejected by the bounded stream', async () => {
    const chunk = 'x'.repeat(1024 * 1024);
    const gateway = literalGateway(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const encoder = new TextEncoder();
            for (let i = 0; i < 21; i++) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }, // NO content-length
      );
    });
    const ctx = makeCtx({
      policy: makePolicy({
        dataSharingPolicy: 'cloud_models_only',
        modelRoute: { provider: 'ollama_vlm', model: 'qwen2.5vl:latest', thinkingLevel: 'off' },
      }),
    });
    const fetch = gateway.buildModelFetch(ctx, modelCall);
    const response = await fetch('https://vlm.example.com/v1/chat');
    await expect(response.text()).rejects.toThrow(/exceeds|response_too_large/);
    expect(MAX_MODEL_RESPONSE_BYTES).toBe(20 * 1024 * 1024);
  });
});
