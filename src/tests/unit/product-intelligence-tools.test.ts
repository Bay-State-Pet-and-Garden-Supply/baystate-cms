/**
 * Product Intelligence tool registry + fixture-agent run tests (PI-3).
 *
 * DB-backed (bun test): registry enforcement (ownership, policy allowlist,
 * budget, schema rejection, timeout, cancellation), taxonomy tools against
 * seeded config, and a fake agent completing a full fixture run using only
 * registry tools — no Pi SDK, no network.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/20
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createPiRun, transitionPiRunStatus, getPiRun, insertPiSource, listPiSources, listSourceAuthoritiesByRun } from '../../db/repositories/product-intelligence-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { upsertReusePolicy, buildReuseGrantResolver } from '../../db/repositories/pi-reuse-policy-repo';
import { startProductIntelligenceRun, getPiRunProjection } from '../../product-intelligence/run-service';
import type { ProductResearchBundle } from '../../product-intelligence/workflow/bundle';
import { PiToolRegistry } from '../../product-intelligence/tools/registry';
import { buildDefaultToolRegistry, defaultToolRegistry } from '../../product-intelligence/tools';
import { taxonomyTools } from '../../product-intelligence/tools/taxonomy-tools';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../product-intelligence/executor';
import type { ProductResearchContext, ProductResearchInput, ProductResearchResult } from '../../product-intelligence/contracts';
import { testPolicy, validBundle } from './product-intelligence/test-helpers';

const wsId = 'pi-tools-test-workspace';

describe('PiToolRegistry enforcement', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-tools-test.db');

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Tools Test',
      workspacePath: '/tmp/pi-tools-workspace',
      gitPath: '/tmp/pi-tools-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  function runningRun() {
    return createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: '{}',
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    });
  }

  const toolCtx = (runId: string, overrides: Partial<{ signal: AbortSignal; remainingMs: number; policy: ReturnType<typeof testPolicy> }> = {}) => ({
    runId,
    workspaceId: wsId,
    workspacePath: '/tmp/pi-tools-workspace',
    policy: overrides.policy ?? testPolicy(),
    signal: overrides.signal ?? new AbortController().signal,
    remainingMs: overrides.remainingMs ?? 60_000,
  });

  it('exposes every registered tool under a stable name and version', () => {
    const names = defaultToolRegistry.names();
    for (const expected of [
      'validate_gtin',
      'lookup_existing_product',
      'lookup_existing_onboarding_evidence',
      'lookup_supplier_product',
      'lookup_distributor_product',
      'lookup_structured_product_database',
      'search_upc',
      'search_product_name',
      'get_brand_domains',
      'search_brand_sitemap',
      'list_cached_search_results',
      'resolve_product_variants',
      'verify_candidate_page',
      'check_exact_gtin_match',
      'compare_identity_signals',
      'check_source_priority',
      'extract_product_page',
      'extract_structured_page_data',
      'extract_packaging_evidence',
      'inspect_candidate_image',
      'verify_image_candidate',
      'discover_image_candidates',
      'list_product_type_candidates',
      'list_attribute_options',
      'list_category_page_candidates',
      'validate_taxonomy_selection',
    ]) {
      expect(names, expected).toContain(expected);
      expect(defaultToolRegistry.get(expected)?.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('grants only allowlisted tools to a session (empty allowlist = none)', () => {
    const run = runningRun();
    const none = defaultToolRegistry.buildSessionTools({ ...toolCtx(run.id), allowedTools: [], policy: testPolicy() });
    expect(none).toHaveLength(0);
    const subset = defaultToolRegistry.buildSessionTools({ ...toolCtx(run.id), allowedTools: ['validate_gtin', 'check_exact_gtin_match'], policy: testPolicy() });
    expect(subset.map((t) => t.name).sort()).toEqual(['check_exact_gtin_match', 'validate_gtin']);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('denies dispatch when the run does not exist or belongs elsewhere', async () => {
    const missing = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('validate_gtin')!,
      { gtin: '036000291452' },
      toolCtx('no-such-run'),
    );
    expect(missing.status).toBe('policy_denied');

    const run = runningRun();
    const wrongWs = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('validate_gtin')!,
      { gtin: '036000291452' },
      { ...toolCtx(run.id), workspaceId: 'other-ws' },
    );
    expect(wrongWs.status).toBe('policy_denied');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('denies dispatch for runs that are not running', async () => {
    const run = runningRun();
    transitionPiRunStatus(run.id, 'completed', {});
    const result = await defaultToolRegistry.dispatch(defaultToolRegistry.get('validate_gtin')!, { gtin: '036000291452' }, toolCtx(run.id));
    expect(result.status).toBe('policy_denied');
  });

  it('enforces the per-run tool-call budget from the IMMUTABLE POLICY (round-9 P1)', async () => {
    // Round-9 (review P1): policy.maxToolCalls is the authority at the adapter
    // boundary — the constructor option is only a no-policy fallback. Call
    // N+1 is rejected SYNCHRONOUSLY before the adapter starts.
    const registry = new PiToolRegistry().registerAll([...defaultToolRegistry.names().map((n) => defaultToolRegistry.get(n)!)]);
    const run = runningRun();
    const policy = { ...testPolicy(), maxToolCalls: 2 };
    const ctx = toolCtx(run.id, { policy });
    let invoked = 0;
    const counting = {
      name: 'count_me',
      version: '1.0.0',
      description: 'counts invocations',
      parameters: { type: 'object', properties: {} } as never,
      execute: async () => {
        invoked += 1;
        return { status: 'ok', data: {}, evidence: [] } as never;
      },
    };
    registry.register(counting);
    const first = await registry.dispatch(counting, {}, ctx);
    expect(first.status).toBe('ok');
    const second = await registry.dispatch(counting, {}, ctx);
    expect(second.status).toBe('ok');
    const third = await registry.dispatch(counting, {}, ctx);
    expect(third.status).toBe('policy_denied');
    expect((third as { status: string; reason: string }).reason).toContain('policy maxToolCalls 2');
    // The adapter never started for call N+1.
    expect(invoked).toBe(2);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('rejects malformed and oversized parameters', async () => {
    const run = runningRun();
    const malformed = await defaultToolRegistry.dispatch(defaultToolRegistry.get('validate_gtin')!, 'not-an-object', toolCtx(run.id));
    expect(malformed.status).toBe('error');
    const oversized = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('validate_gtin')!,
      { gtin: 'x'.repeat(200) },
      toolCtx(run.id),
    );
    expect(oversized.status).toBe('error');
    expect((oversized as { status: string; message: string }).message).toContain('schema');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('times out adapters that exceed the call budget', async () => {
    const registry = new PiToolRegistry({ callTimeoutMs: 50 });
    const hangAdapter = {
      name: 'hang_tool',
      version: '1.0.0',
      description: 'hangs',
      parameters: { type: 'object', properties: {} } as never,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { status: 'ok', data: {}, evidence: [] } as never;
      },
    };
    registry.register(hangAdapter);
    const run = runningRun();
    const result = await registry.dispatch(hangAdapter, {}, toolCtx(run.id));
    expect(result.status).toBe('error');
    expect((result as { status: string; code: string }).code).toBe('timeout');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('uses the EFFECTIVE remaining run time for the per-call deadline (round-9 P1)', async () => {
    // Round-9 (review P1): the per-call timeout is bounded by the run's
    // effective remaining time (workspace cap vs policy deadline) threaded
    // from the executor — never a fresh policy-duration budget. remainingMs
    // in the context drives the deadline when no callTimeoutMs option exists.
    const registry = new PiToolRegistry();
    const hangAdapter = {
      name: 'hang_tool_effective',
      version: '1.0.0',
      description: 'hangs',
      parameters: { type: 'object', properties: {} } as never,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { status: 'ok', data: {}, evidence: [] } as never;
      },
    };
    registry.register(hangAdapter);
    const run = runningRun();
    const started = Date.now();
    const result = await registry.dispatch(hangAdapter, {}, toolCtx(run.id, { remainingMs: 50 }));
    const elapsed = Date.now() - started;
    expect(result.status).toBe('error');
    expect((result as { status: string; code: string }).code).toBe('timeout');
    // The timeout fired at ~50ms of effective remaining time, not the 60s default.
    expect(elapsed).toBeLessThan(2_000);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('cancels adapters when the caller signal aborts', async () => {
    const registry = new PiToolRegistry();
    const slowAdapter = {
      name: 'slow_tool',
      version: '1.0.0',
      description: 'slow',
      parameters: { type: 'object', properties: {} } as never,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return { status: 'ok', data: {}, evidence: [] } as never;
      },
    };
    registry.register(slowAdapter);
    const run = runningRun();
    const controller = new AbortController();
    const resultPromise = registry.dispatch(slowAdapter, {}, toolCtx(run.id, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 30);
    const result = await resultPromise;
    expect(result.status).toBe('policy_denied');
    expect((result as { status: string; reason: string }).reason).toContain('cancelled');
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('taxonomy tools validate against seeded configuration', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_product_types (workspace_id, id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [wsId, 'pt-dog-food', 'Dog Food', 'Dry and wet dog food', now, now],
    );
    db.run(
      `INSERT INTO classification_attributes (workspace_id, id, name, value_mode, allowed_values_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'attr-protein', 'Protein Source', 'controlled', JSON.stringify(['Chicken', 'Beef', 'Fish']), now, now],
    );

    const run = runningRun();
    const typesResult = await defaultToolRegistry.dispatch(defaultToolRegistry.get('list_product_type_candidates')!, {}, toolCtx(run.id));
    expect(typesResult.status).toBe('ok');
    if (typesResult.status === 'ok') {
      expect((typesResult.data as { productTypes: Array<{ id: string }> }).productTypes).toContainEqual(expect.objectContaining({ id: 'pt-dog-food' }));
    }
    const attrsResult = await defaultToolRegistry.dispatch(defaultToolRegistry.get('list_attribute_options')!, {}, toolCtx(run.id));
    expect(attrsResult.status).toBe('ok');
    if (attrsResult.status === 'ok') {
      const attrs = attrsResult.data as { attributes: Array<{ name: string; allowedValues: string[] }> };
      expect(attrs.attributes[0]).toMatchObject({ name: 'Protein Source', allowedValues: ['Chicken', 'Beef', 'Fish'] });
    }
    const valid = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('validate_taxonomy_selection')!,
      { productTypeId: 'pt-dog-food', attributeValues: [{ name: 'Protein Source', value: 'Chicken' }] },
      toolCtx(run.id),
    );
    expect(valid.status).toBe('ok');
    if (valid.status === 'ok') expect((valid.data as { valid: boolean }).valid).toBe(true);

    const invalid = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('validate_taxonomy_selection')!,
      { productTypeId: 'pt-invented', attributeValues: [{ name: 'Protein Source', value: 'Unicorn' }] },
      toolCtx(run.id),
    );
    expect(invalid.status).toBe('ok');
    if (invalid.status === 'ok') {
      expect((invalid.data as { valid: boolean }).valid).toBe(false);
      expect((invalid.data as { issues: string[] }).issues.length).toBe(2);
    }
    transitionPiRunStatus(run.id, 'completed', {});
  });
});

// ---------------------------------------------------------------------------
// Fixture agent: completes a full run using only registry tools
// ---------------------------------------------------------------------------

class FixtureAgentExecutor implements ProductIntelligenceExecutor {
  readonly name = 'pi';
  readonly version = '1.0.0';
  readonly registry = buildDefaultToolRegistry();

  async startResearch(input: ProductResearchInput, context: ProductResearchContext, events: ExecutionEventSink): Promise<ProductResearchResult> {
    const toolCtx = {
      runId: context.runId,
      workspaceId: context.workspaceId,
      workspacePath: context.workspacePath,
      policy: context.policy,
      signal: context.signal ?? new AbortController().signal,
      remainingMs: 300_000,
    };

    events.emit('run_started', { message: 'fixture agent researching' });
    events.emit('session_created', { data: { piVersion: '0.0.0-fixture' } });

    // 1. validate the GTIN.
    events.emit('tool_call_started', { toolName: 'validate_gtin' });
    const gtinResult = await this.registry.dispatch(this.registry.get('validate_gtin')!, { gtin: input.gtin }, toolCtx);
    events.emit('tool_call_finished', { toolName: 'validate_gtin', isError: gtinResult.status === 'error' });
    const gtinEvidenceId = gtinResult.status === 'ok' && gtinResult.evidence[0] ? gtinResult.evidence[0].id : 'ev-missing';

    // 2. taxonomy candidates.
    events.emit('tool_call_started', { toolName: 'list_product_type_candidates' });
    const taxonomyResult = await this.registry.dispatch(this.registry.get('list_product_type_candidates')!, {}, toolCtx);
    events.emit('tool_call_finished', { toolName: 'list_product_type_candidates', isError: taxonomyResult.status === 'error' });
    const productTypeId =
      taxonomyResult.status === 'ok' && (taxonomyResult.data as { productTypes: Array<{ id: string }> }).productTypes[0]
        ? (taxonomyResult.data as { productTypes: Array<{ id: string }> }).productTypes[0].id
        : null;

    // 3. submit with tool-derived evidence ids (PI-4 workflow bundle).
    const submission = validBundle({
      gtin: '036000291452',
      inputName: 'TEST PRODUCT 16OZ',
      identity: { ...validBundle().identity, evidenceIds: [gtinEvidenceId] },
      classificationProposals: productTypeId
        ? [{ targetId: productTypeId, selectedOptionId: productTypeId, evidenceIds: [gtinEvidenceId], disposition: 'proposed' }]
        : [],
    });
    events.emit('submission_received', { data: { schemaVersion: submission.schemaVersion } });
    events.emit('run_completed', { data: { outcome: 'submitted' } });
    return {
      runId: context.runId,
      outcome: 'submitted',
      executor: this.name,
      executorVersion: this.version,
      piVersion: '0.0.0-fixture',
      extensionVersions: [],
      configId: context.policy.configId,
      durationMs: 10,
      submission,
      failure: null,
      events: events.snapshot(),
    };
  }
}

describe('Fixture agent run using only research tools', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-tools-fixture.db');

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Fixture Test',
      workspacePath: '/tmp/pi-fixture-workspace',
      gitPath: '/tmp/pi-fixture-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_product_types (workspace_id, id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [wsId, 'pt-dog-food', 'Dog Food', null, now, now],
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('completes a full run using only registry tools and persists tool calls', async () => {
    const started = await startProductIntelligenceRun(
      new FixtureAgentExecutor(),
      { input: { gtin: '036000291452', registerName: 'TEST PRODUCT 16OZ' }, mode: 'shadow' },
      { workspaceId: wsId, workspacePath: '/tmp/pi-fixture-workspace' },
    );
    await started.completed;

    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('completed');

    const projection = getPiRunProjection(started.run.id);
    const toolCalls = projection?.toolCalls as Array<{ toolName: string; policyOutcome: string }>;
    const toolNames = toolCalls.map((t) => t.toolName).sort();
    expect(toolNames).toEqual(['list_product_type_candidates', 'validate_gtin']);
    expect(toolCalls.every((t) => t.policyOutcome === 'allowed')).toBe(true);

    // The submission cites the tool-derived evidence id and the taxonomy id.
    const result = projection?.result as { resultJson: string };
    const parsed = JSON.parse(result.resultJson) as ProductResearchResult;
    const bundle = parsed.submission as ProductResearchBundle | null;
    expect(bundle?.identity.evidenceIds[0]).toMatch(/^validate_gtin:/);
    expect(bundle?.classificationProposals[0]?.targetId).toBe('pt-dog-food');
  });
});

export { taxonomyTools };

describe('Round-9 source authority (brand-matched, first-class records)', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-tools-authority.db');

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Authority Test',
      workspacePath: '/tmp/pi-authority-workspace',
      gitPath: '/tmp/pi-authority-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  const makeRun = (brandHint?: string) =>
    createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify(brandHint ? { gtin: '085000079585', registerName: 'X', brandHint } : { gtin: '085000079585', registerName: 'X' }),
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    }).id;

  const checkPriority = async (runId: string, url: string) =>
    defaultToolRegistry.dispatch(defaultToolRegistry.get('check_source_priority')!, { url }, {
      runId,
      workspaceId: wsId,
      workspacePath: '/tmp/pi-tools-workspace',
      policy: testPolicy(),
      signal: new AbortController().signal,
      remainingMs: 60_000,
    });

  it('Brand A official domain does not establish manufacturer authority while researching Brand B', async () => {
    upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun('BrandB');
    const out = await checkPriority(runId, 'https://branda.example.com/p/1');
    expect(out.status).toBe('ok');
    const data = (out as { data?: { tier: string; isOfficial: boolean; authorityEstablished?: boolean } }).data!;
    expect(data.tier).toBe('official'); // the domain IS registry-official (display)
    expect(data.isOfficial).toBe(true);
    expect(data.authorityEstablished).toBe(false); // but NOT authority for a different brand
    // No durable authority record exists for the run.
    expect(listSourceAuthoritiesByRun(runId).length).toBe(0);
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('registry brand matching the expected product brand establishes manufacturer authority', async () => {
    const brandSiteId = upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun('BrandA');
    const out = await checkPriority(runId, 'https://branda.example.com/p/1');
    expect(out.status).toBe('ok');
    const data = (out as { data?: { authorityEstablished?: boolean; authorityType?: string } }).data!;
    expect(data.authorityEstablished).toBe(true);
    expect(data.authorityType).toBe('manufacturer');
    const authorities = listSourceAuthoritiesByRun(runId);
    expect(authorities.length).toBe(1);
    expect(authorities[0].authorityType).toBe('manufacturer');
    expect(authorities[0].brandName).toBe('branda'); // normalized by the registry repo
    expect(authorities[0].authorityRef).toBe(`brand_site:${brandSiteId.id}`);
    expect(authorities[0].establishedBy).toBe('check_source_priority');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('first-writer regression: an existing neutral source row is UPGRADED to the authority tier', async () => {
    const brandSiteId = upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun('BrandA');
    // A search tool created the source row FIRST with the neutral tier.
    const source = insertPiSource({
      runId,
      url: 'https://branda.example.com/p/1',
      domain: 'branda.example.com',
      sourceType: 'other',
    });
    // The reuse grant exists for the manufacturer tier.
    upsertReusePolicy({ workspaceId: wsId, sourceTier: 'manufacturer', domainPattern: 'branda.example.com', allowed: true, terms: 'authorized' });
    // Brand-matched authority comes later and must WIN (no first-writer bug).
    const out = await checkPriority(runId, 'https://branda.example.com/p/1');
    expect(out.status).toBe('ok');
    const upgraded = listPiSources(runId).find((row) => row.id === source.id);
    expect(upgraded?.sourceType).toBe('manufacturer');
    const authorities = listSourceAuthoritiesByRun(runId);
    expect(authorities.length).toBe(1);
    expect(authorities[0].authorityRef).toBe(`brand_site:${brandSiteId.id}`);
    // The reuse grant now resolves for the effective manufacturer tier.
    const grant = buildReuseGrantResolver(wsId)('manufacturer', 'branda.example.com');
    expect(grant?.grantId).toBeTruthy();
    transitionPiRunStatus(runId, 'completed', {});
  });

  it("a 'registry' reuse grant cannot authorize a neutral (non-authority) asset tier", () => {
    upsertReusePolicy({ workspaceId: wsId, sourceTier: 'registry', domainPattern: 'anything.example.com', allowed: true, terms: 'x' });
    // post-neutralization evidence-kind sources are 'other'; a 'registry' grant
    // is never consulted for them.
    const grantForNeutral = buildReuseGrantResolver(wsId)('other', 'anything.example.com');
    expect(grantForNeutral).toBeNull();
  });
});
