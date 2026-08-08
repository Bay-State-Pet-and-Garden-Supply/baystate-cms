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
import { createPiRun, transitionPiRunStatus, getPiRun, insertPiSource, listPiSources, listSourceAuthoritiesByRun, insertPiAsset, listPiAssetsByRun, listPiPageArtifactsByRun } from '../../db/repositories/product-intelligence-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertSources } from '../../db/repositories/onboarding-source-repo';
import { upsertReusePolicy, buildReuseGrantResolver } from '../../db/repositories/pi-reuse-policy-repo';
import { startProductIntelligenceRun, getPiRunProjection } from '../../product-intelligence/run-service';
import type { ProductResearchBundle } from '../../product-intelligence/workflow/bundle';
import { PiToolRegistry } from '../../product-intelligence/tools/registry';
import { buildDefaultToolRegistry, defaultToolRegistry } from '../../product-intelligence/tools';
import { taxonomyTools } from '../../product-intelligence/tools/taxonomy-tools';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../product-intelligence/executor';
import type { ProductResearchContext, ProductResearchInput, ProductResearchResult } from '../../product-intelligence/contracts';
import { testPolicy, validBundle } from './product-intelligence/test-helpers';
import { PolicyGateway } from '../../product-intelligence/policy/policy-gateway';

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

  const toolCtx = (runId: string, overrides: Partial<{ signal: AbortSignal; remainingMs: number; deadlineAt: number | null; policy: ReturnType<typeof testPolicy> }> = {}) => ({
    runId,
    workspaceId: wsId,
    workspacePath: '/tmp/pi-tools-workspace',
    policy: overrides.policy ?? testPolicy(),
    signal: overrides.signal ?? new AbortController().signal,
    remainingMs: overrides.remainingMs ?? 60_000,
    deadlineAt: overrides.deadlineAt === undefined ? null : overrides.deadlineAt,
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

  it('denies dispatch SYNCHRONOUSLY when the run deadline has already elapsed (round-10 P1)', async () => {
    // A tool beginning at/after the run deadline is denied before the adapter
    // starts — session abort and adapter abort must not be different
    // mechanisms.
    const registry = new PiToolRegistry();
    let invoked = 0;
    const counting = {
      name: 'count_dead',
      version: '1.0.0',
      description: 'counts invocations',
      parameters: { type: 'object', properties: {} } as never,
      execute: async () => {
        invoked += 1;
        return { status: 'ok', data: {}, evidence: [] } as never;
      },
    };
    registry.register(counting);
    const run = runningRun();
    const result = await registry.dispatch(counting, {}, toolCtx(run.id, { deadlineAt: Date.now() - 1 }));
    expect(result.status).toBe('error');
    expect((result as { status: string; code: string }).code).toBe('timeout');
    expect(invoked).toBe(0);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('recomputes the per-call budget from the ABSOLUTE deadline at every dispatch (round-10 P1)', async () => {
    // Two dispatches of the same tool observe budgets tied to their own
    // deadlineAt — a value frozen at session creation would ignore the delay.
    const registry = new PiToolRegistry();
    const hangAdapter = {
      name: 'hang_deadline',
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

    const started1 = Date.now();
    const first = await registry.dispatch(hangAdapter, {}, toolCtx(run.id, { deadlineAt: Date.now() + 120 }));
    const elapsed1 = Date.now() - started1;
    expect((first as { status: string; code: string }).code).toBe('timeout');
    expect(elapsed1).toBeGreaterThanOrEqual(60);
    expect(elapsed1).toBeLessThan(2_000);

    const started2 = Date.now();
    const second = await registry.dispatch(hangAdapter, {}, toolCtx(run.id, { deadlineAt: Date.now() + 40 }));
    const elapsed2 = Date.now() - started2;
    expect((second as { status: string; code: string }).code).toBe('timeout');
    // The second dispatch, closer to its deadline, times out sooner.
    expect(elapsed2).toBeGreaterThanOrEqual(20);
    expect(elapsed2).toBeLessThan(elapsed1);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('fires the adapter\'s composed AbortSignal at the run deadline (round-10 P1)', async () => {
    // The adapter's ctx.signal (caller + per-call timeout composed by the
    // registry) aborts when the run deadline elapses — an in-flight adapter
    // is authoritatively cancelled by the deadline, not left running.
    const registry = new PiToolRegistry();
    const deadlineAware = {
      name: 'await_signal',
      version: '1.0.0',
      description: 'awaits its signal',
      parameters: { type: 'object', properties: {} } as never,
      execute: async (_params: never, callCtx: { signal: AbortSignal }) => {
        await new Promise((resolve) => {
          callCtx.signal.addEventListener('abort', () => resolve(undefined), { once: true });
          setTimeout(resolve, 5_000); // safety
        });
        return { status: 'no_result', reason: 'signal fired', evidence: [] } as never;
      },
    };
    registry.register(deadlineAware);
    const run = runningRun();
    const started = Date.now();
    const result = await registry.dispatch(deadlineAware, {}, toolCtx(run.id, { deadlineAt: Date.now() + 80 }));
    const elapsed = Date.now() - started;
    expect(result.status).toBe('error');
    expect((result as { status: string; code: string }).code).toBe('timeout');
    // Fired at the ~80ms deadline, not the 5s safety or 60s default.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2_000);
    transitionPiRunStatus(run.id, 'completed', {});
  });

  it('cancels adapters when the caller signal aborts', async () => {
    const registry = new PiToolRegistry();    const slowAdapter = {
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

  it('extract_product_page payload advertises the TYPED page_html artifact (round-10 P1-6)', async () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Stella Chicken Broth 16 oz","image":"https://cdn.example.com/stella-16oz.jpg"}</script></head><body>Stella Chicken Broth</body></html>`;
    const gateway = new PolicyGateway({
      resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []),
      fetchFn: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const run = runningRun();
    const result = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('extract_product_page')!,
      { url: 'https://brand.example.com/p/stella-broth', gtin: '085000079585' },
      {
        ...toolCtx(run.id),
        gateway,
        policy: testPolicy({ networkPolicy: 'allowlisted_remote', allowedSourceDomains: [] }),
      },
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const data = result.data as { artifactId?: string | null; artifactType?: string | null };
      expect(data.artifactId).toBeTruthy();
      expect(data.artifactType).toBe('page_html');
      const retained = listPiPageArtifactsByRun(run.id).find((a) => a.id === data.artifactId);
      expect(retained?.artifactType).toBe('page_html');
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

describe('Round-10 source authority (durable exact-GTIN-resolved brand, brandHint demoted)', () => {
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

  const GTIN = '085000079585';
  const makeRun = (brandHint?: string) =>
    createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify(brandHint ? { gtin: GTIN, registerName: 'X', brandHint } : { gtin: GTIN, registerName: 'X' }),
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    }).id;

  /** Seed the DURABLE exact-GTIN-linked evidence the authority rule runs on:
   *  a verified asset whose observed GTIN equals the run's requested GTIN. */
  const seedResolvedBrand = (runId: string, brand: string, gtin = GTIN) =>
    insertPiAsset({
      runId,
      sourceUrl: 'https://branda.example.com/p/1',
      sourceType: 'other',
      extractionMethod: 'manual',
      retrievedAt: new Date().toISOString(),
      originalContentHash: 'evidence-hash',
      rightsStatus: 'unknown',
      qualityStatus: 'usable',
      observedBrand: brand,
      observedGtin: gtin,
      exactProductMatch: true,
    });

  const checkPriority = async (runId: string, url: string) =>
    defaultToolRegistry.dispatch(defaultToolRegistry.get('check_source_priority')!, { url }, {
      runId,
      workspaceId: wsId,
      workspacePath: '/tmp/pi-tools-workspace',
      policy: testPolicy(),
      signal: new AbortController().signal,
      remainingMs: 60_000,
    });

  it('Brand A official domain does not establish manufacturer authority while researching Brand B (cross-brand)', async () => {
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

  it('brandHint matching the registry brand WITHOUT durable GTIN evidence never establishes authority', async () => {
    upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun('BrandA'); // hint == registry brand, but no evidence
    const out = await checkPriority(runId, 'https://branda.example.com/p/1');
    expect(out.status).toBe('ok');
    const data = (out as { data?: { tier: string; authorityEstablished?: boolean; reason?: string } }).data!;
    expect(data.tier).toBe('official'); // display only
    expect(data.authorityEstablished).toBe(false);
    expect(data.reason).toMatch(/brand hints are untrusted/);
    expect(listSourceAuthoritiesByRun(runId).length).toBe(0);
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('registry brand matching the durable exact-GTIN-resolved product brand establishes manufacturer authority', async () => {
    const brandSiteId = upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun('BrandA');
    seedResolvedBrand(runId, 'BrandA');
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
    expect(authorities[0].establishedBy).toBe('check_source_priority:resolved_brand');
    // Round-11 (review P1): the authority RETAINS the evidence that resolved
    // the brand — the verified asset id + content hash — so the record says
    // "Brand A observed from evidence E on asset bytes H whose GTIN X was
    // independently exact" rather than merely "asset row says exact X + A".
    const asset = listPiAssetsByRun(runId).find((a) => a.observedBrand === 'BrandA');
    expect(asset).toBeTruthy();
    expect(authorities[0].brandEvidenceId).toBe(asset?.id);
    expect(authorities[0].brandEvidenceHash).toBe('evidence-hash');
    expect(authorities[0].brandEvidenceKind).toBe('verified_asset');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('check_source_priority before any exact-GTIN evidence fails closed; evidence later unlocks authority (round-11 release-blocker regression)', async () => {
    upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun('BrandA');
    // (1) The workflow ranks sources BEFORE verification — no exact asset
    //     exists yet, so no resolved brand and no authority (fail closed).
    const first = await checkPriority(runId, 'https://branda.example.com/p/1');
    expect(first.status).toBe('ok');
    expect((first as { data?: { authorityEstablished?: boolean } }).data?.authorityEstablished).toBe(false);
    expect(listSourceAuthoritiesByRun(runId).length).toBe(0);
    // (2) The agent verifies an image; the exact-GTIN asset (with a brand)
    //     now exists. The next authority evaluation succeeds.
    const asset = seedResolvedBrand(runId, 'BrandA');
    const second = await checkPriority(runId, 'https://branda.example.com/p/1');
    expect(second.status).toBe('ok');
    expect((second as { data?: { authorityEstablished?: boolean } }).data?.authorityEstablished).toBe(true);
    const authorities = listSourceAuthoritiesByRun(runId);
    expect(authorities.length).toBe(1);
    expect(authorities[0].brandEvidenceId).toBe(asset.id);
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('resolved product brand differing from the registry brand never establishes authority', async () => {
    upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun('BrandA'); // hint matches, but durable evidence says otherwise
    seedResolvedBrand(runId, 'BrandB');
    const out = await checkPriority(runId, 'https://branda.example.com/p/1');
    expect(out.status).toBe('ok');
    const data = (out as { data?: { authorityEstablished?: boolean; reason?: string } }).data!;
    expect(data.authorityEstablished).toBe(false);
    expect(data.reason).toMatch(/does not match the durable resolved product brand/);
    expect(listSourceAuthoritiesByRun(runId).length).toBe(0);
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('ambiguous resolved brands (two distinct durable brands) fail closed with no authority', async () => {
    upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun('BrandA');
    seedResolvedBrand(runId, 'BrandA');
    seedResolvedBrand(runId, 'BrandB');
    const out = await checkPriority(runId, 'https://branda.example.com/p/1');
    expect(out.status).toBe('ok');
    const data = (out as { data?: { authorityEstablished?: boolean } }).data!;
    expect(data.authorityEstablished).toBe(false);
    expect(listSourceAuthoritiesByRun(runId).length).toBe(0);
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('an absent brandHint does NOT block authority when the durable resolved brand matches the registry', async () => {
    upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun(); // NO brandHint at all
    seedResolvedBrand(runId, 'BrandA');
    const out = await checkPriority(runId, 'https://branda.example.com/p/1');
    expect(out.status).toBe('ok');
    const data = (out as { data?: { authorityEstablished?: boolean } }).data!;
    expect(data.authorityEstablished).toBe(true);
    const authorities = listSourceAuthoritiesByRun(runId);
    expect(authorities.length).toBe(1);
    expect(authorities[0].authorityType).toBe('manufacturer');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('first-writer regression: an existing neutral source row is UPGRADED to the authority tier', async () => {
    const brandSiteId = upsertBrandSite('BrandA', 'branda.example.com', null);
    const runId = makeRun('BrandA');
    seedResolvedBrand(runId, 'BrandA');
    // A search tool created the source row FIRST with the neutral tier.
    const source = insertPiSource({
      runId,
      url: 'https://branda.example.com/p/1',
      domain: 'branda.example.com',
      sourceType: 'other',
    });
    // The reuse grant exists for the manufacturer tier.
    upsertReusePolicy({ workspaceId: wsId, sourceTier: 'manufacturer', domainPattern: 'branda.example.com', allowed: true, terms: 'authorized' });
    // Evidence-resolved authority comes later and must WIN (no first-writer bug).
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

describe('Workspace-scoped onboarding research reads (round-11 P0)', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-tools-workspace.db');
  const wsB = 'pi-tools-test-workspace-B';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Workspace A',
      workspacePath: '/tmp/pi-ws-a',
      gitPath: '/tmp/pi-ws-a/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    insertWorkspace({
      id: wsB,
      name: 'PI Workspace B',
      workspacePath: '/tmp/pi-ws-b',
      gitPath: '/tmp/pi-ws-b/.git',
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

  const GTIN_A = '085000079585';
  const GTIN_B = '036000291452';

  /** Seed an onboarding source for a GTIN under a workspace (item -> batch -> workspace). */
  const seedOnboardingSource = (workspaceId: string, upc: string, url: string, domain: string) => {
    const batch = createBatch({ workspaceId, name: 'seed', fileName: 'seed.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc, name: `seed-${upc}`, rowNumber: 1 }]);
    const [source] = insertSources(item.id, [
      { url, title: `${upc} title`, domain, confidence: 0.9 },
    ]);
    return { batchId: batch.id, itemId: item.id, sourceId: source.id };
  };

  const makeRun = (gtin: string | null, workspaceId: string) =>
    createPiRun({
      workspaceId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify(gtin ? { gtin, registerName: 'X' } : { registerName: 'X' }),
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    }).id;

  const dispatchLookup = (runId: string, workspaceId: string, tool: string, gtin: string) =>
    defaultToolRegistry.dispatch(defaultToolRegistry.get(tool)!, { gtin }, {
      runId,
      workspaceId,
      workspacePath: '/tmp/pi-tools-workspace',
      policy: testPolicy(),
      signal: new AbortController().signal,
      remainingMs: 60_000,
      deadlineAt: null,
    });

  it('a workspace-A run NEVER sees workspace-B onboarding sources (no supplier evidence leaks)', async () => {
    seedOnboardingSource(wsB, GTIN_A, 'https://supplier-b.example.com/p/1', 'supplier-b.example.com');
    const runA = makeRun(GTIN_A, wsId);
    const out = await dispatchLookup(runA, wsId, 'lookup_supplier_product', GTIN_A);
    expect(out.status).toBe('no_result');
    expect(out.evidence ?? []).toHaveLength(0);
    // No durable source row was minted for run A by a foreign-workspace read.
    expect(listPiSources(runA)).toHaveLength(0);
    transitionPiRunStatus(runA, 'completed', {});
  });

  it('same-workspace supplier lookup returns supplier_evidence and the matching source', async () => {
    seedOnboardingSource(wsId, GTIN_A, 'https://supplier-a.example.com/p/1', 'supplier-a.example.com');
    const runA = makeRun(GTIN_A, wsId);
    const out = await dispatchLookup(runA, wsId, 'lookup_supplier_product', GTIN_A);
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      const data = out.data as { sources: Array<{ url: string }>; crossGtinLead?: boolean };
      expect(data.sources.map((s) => s.url)).toContain('https://supplier-a.example.com/p/1');
      expect(data.crossGtinLead).toBe(false);
    }
    expect(out.evidence?.every((e) => e.kind === 'supplier_evidence')).toBe(true);
    transitionPiRunStatus(runA, 'completed', {});
  });

  it('GTIN binding: a cross-GTIN lookup returns a LEAD (catalog_evidence), never supplier authority', async () => {
    seedOnboardingSource(wsId, GTIN_B, 'https://supplier-b-cross.example.com/p/1', 'supplier-b-cross.example.com');
    const runA = makeRun(GTIN_A, wsId); // run immutable gtin = GTIN_A
    const out = await dispatchLookup(runA, wsId, 'lookup_supplier_product', GTIN_B); // requests GTIN_B
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      const data = out.data as { crossGtinLead?: boolean; warning?: string };
      expect(data.crossGtinLead).toBe(true);
      expect(data.warning).toContain(GTIN_A);
    }
    expect(out.evidence?.every((e) => e.kind === 'catalog_evidence')).toBe(true);
    expect(out.evidence?.some((e) => e.kind === 'supplier_evidence')).toBe(false);
    transitionPiRunStatus(runA, 'completed', {});
  });

  it('GTIN binding fails closed when the run input cannot be read (leads only, never supplier authority)', async () => {
    seedOnboardingSource(wsId, GTIN_B, 'https://supplier-nogtin.example.com/p/1', 'supplier-nogtin.example.com');
    const runNoInput = makeRun(null, wsId); // inputJson without a gtin
    const out = await dispatchLookup(runNoInput, wsId, 'lookup_supplier_product', GTIN_B);
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      const data = out.data as { crossGtinLead?: boolean; warning?: string };
      expect(data.crossGtinLead).toBe(true);
      expect(data.warning).toContain('unavailable');
    }
    expect(out.evidence?.every((e) => e.kind === 'catalog_evidence')).toBe(true);
    transitionPiRunStatus(runNoInput, 'completed', {});
  });

  it('lookup_existing_onboarding_evidence denies a FOREIGN item with policy_denied', async () => {
    const { itemId } = seedOnboardingSource(wsB, GTIN_A, 'https://wsb.example.com/p/1', 'wsb.example.com');
    const runA = makeRun(GTIN_A, wsId);
    const out = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('lookup_existing_onboarding_evidence')!,
      { onboardingItemId: itemId },
      {
        runId: runA,
        workspaceId: wsId,
        workspacePath: '/tmp/pi-tools-workspace',
        policy: testPolicy(),
        signal: new AbortController().signal,
        remainingMs: 60_000,
        deadlineAt: null,
      },
    );
    expect(out.status).toBe('policy_denied');
    expect((out as { status: string; reason: string }).reason).toContain('does not belong to the current workspace');
    transitionPiRunStatus(runA, 'completed', {});
  });

  it('lookup_existing_onboarding_evidence reads a SAME-workspace item and returns its sources', async () => {
    const { itemId } = seedOnboardingSource(wsId, GTIN_A, 'https://wsa.example.com/p/1', 'wsa.example.com');
    const runA = makeRun(GTIN_A, wsId);
    const out = await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('lookup_existing_onboarding_evidence')!,
      { onboardingItemId: itemId },
      {
        runId: runA,
        workspaceId: wsId,
        workspacePath: '/tmp/pi-tools-workspace',
        policy: testPolicy(),
        signal: new AbortController().signal,
        remainingMs: 60_000,
        deadlineAt: null,
      },
    );
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      const data = out.data as { sources: Array<{ url: string }> };
      expect(data.sources.map((s) => s.url)).toContain('https://wsa.example.com/p/1');
    }
    transitionPiRunStatus(runA, 'completed', {});
  });

  it('lookup_distributor_product is workspace-scoped too', async () => {
    seedOnboardingSource(wsB, GTIN_A, 'https://dist-b.example.com/p/1', 'dist-b.example.com');
    seedOnboardingSource(wsId, GTIN_A, 'https://dist-a.example.com/p/1', 'dist-a.example.com');
    const runA = makeRun(GTIN_A, wsId);
    const out = await dispatchLookup(runA, wsId, 'lookup_distributor_product', GTIN_A);
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      const data = out.data as { sources: Array<{ url: string }> };
      expect(data.sources.map((s) => s.url)).toContain('https://dist-a.example.com/p/1');
      expect(data.sources.map((s) => s.url)).not.toContain('https://dist-b.example.com/p/1');
    }
    transitionPiRunStatus(runA, 'completed', {});
  });
});
