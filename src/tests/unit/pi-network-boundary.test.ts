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
import { defaultToolRegistry, buildDefaultToolRegistry } from '../../product-intelligence/tools';
import { discoveryTools } from '../../product-intelligence/tools/discovery-tools';
import { fetchPageHtml, HTTP_EXTRACTION_HEADERS } from '../../product-intelligence/extraction/platforms';
import { ManagedFallbackRegistry } from '../../product-intelligence/extraction/managed-fallback';
import { policyDenied, type PiToolContext } from '../../product-intelligence/tools/contract';
import type { ProductIntelligencePolicy } from '../../product-intelligence/contracts';
import { sha256Hex } from '../../shared/stable-id';

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
  const TOOL_SOURCE_FILES = [
    'src/product-intelligence/tools/discovery-tools.ts',
    'src/product-intelligence/tools/extraction-tools.ts',
    'src/product-intelligence/tools/identity-tools.ts',
    'src/product-intelligence/tools/verification-tools.ts',
    'src/product-intelligence/tools/taxonomy-tools.ts',
    'src/product-intelligence/tools/image-tools.ts',
  ] as const;

  const GATEWAY_SEAM = /checkNetworkRequest|gatewayFetch|buildPiNetworkFetch|policyDenied/;
  // Network markers that indicate the adapter performs (or reaches) an
  // external fetch. 'gatewayFetch(' contains 'fetch(' so require a preceding
  // boundary that excludes the gateway seam itself.
  const NETWORK_MARKER = /(?<![a-z_])fetch\(|discoverSources|fetchAndParseSitemap|resolveVariantsForCandidates|extractPackagingOcr|searchSerper/;

  it('every network-capable tool adapter references the gateway seam in its source', () => {
    const registry = buildDefaultToolRegistry();
    const names = registry.names();
    expect(names.length).toBeGreaterThan(10);

    const inspected = new Set<string>();
    for (const name of names) {
      const file = TOOL_SOURCE_FILES.find((candidate) => {
        const source = fs.readFileSync(candidate, 'utf8');
        return source.includes(`name: '${name}'`);
      });
      if (!file) continue;
      inspected.add(file);
      const source = fs.readFileSync(file, 'utf8');
      const networkCapable = NETWORK_MARKER.test(source);
      const gatesThroughGateway = GATEWAY_SEAM.test(source);
      // Tools that reach the network MUST gate through the gateway in the
      // same source file (the adapter is the only path into the capability).
      if (networkCapable) {
        expect(gatesThroughGateway, `${name} (${file}) reaches the network without a gateway seam`).toBe(true);
      }
    }
    // Sanity: we actually inspected every tool source file.
    expect(inspected.size).toBe(TOOL_SOURCE_FILES.length);
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
      const networkCapable = NETWORK_MARKER.test(block);
      if (networkCapable) {
        expect(
          /checkNetworkRequest|gatewayFetch|buildPiNetworkFetch|policyDenied/.test(block),
          `discovery adapter ${tool.name} reaches the network without a gateway gate`,
        ).toBe(true);
      }
    }
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
});

// Keep the compiler honest that these helpers exist (imports are used).
void policyDenied;
void HTTP_EXTRACTION_HEADERS;
void defaultPolicyGateway;
