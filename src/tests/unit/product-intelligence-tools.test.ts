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
import { createPiRun, transitionPiRunStatus, getPiRun } from '../../db/repositories/product-intelligence-repo';
import { startProductIntelligenceRun, getPiRunProjection } from '../../product-intelligence/run-service';
import { PiToolRegistry } from '../../product-intelligence/tools/registry';
import { buildDefaultToolRegistry, defaultToolRegistry } from '../../product-intelligence/tools';
import { taxonomyTools } from '../../product-intelligence/tools/taxonomy-tools';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../product-intelligence/executor';
import type { ProductResearchContext, ProductResearchInput, ProductResearchResult } from '../../product-intelligence/contracts';
import { asPi1Submission, testPolicy, validSubmission } from './product-intelligence/test-helpers';

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

  const toolCtx = (runId: string, overrides: Partial<{ signal: AbortSignal; remainingMs: number }> = {}) => ({
    runId,
    workspaceId: wsId,
    workspacePath: '/tmp/pi-tools-workspace',
    policy: testPolicy(),
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

  it('enforces the per-run tool-call budget', async () => {
    const registry = new PiToolRegistry({ maxToolCallsPerRun: 2 }).registerAll([...defaultToolRegistry.names().map((n) => defaultToolRegistry.get(n)!)]);
    const run = runningRun();
    const first = await registry.dispatch(registry.get('validate_gtin')!, { gtin: '036000291452' }, toolCtx(run.id));
    expect(first.status).toBe('ok');
    const second = await registry.dispatch(registry.get('check_exact_gtin_match')!, { requestedGtin: 'x', extractedGtins: [] }, toolCtx(run.id));
    expect(second.status).toBe('ok');
    const third = await registry.dispatch(registry.get('validate_gtin')!, { gtin: '036000291452' }, toolCtx(run.id));
    expect(third.status).toBe('policy_denied');
    expect((third as { status: string; reason: string }).reason).toContain('budget');
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

    // 3. submit with tool-derived evidence ids.
    const submission = validSubmission({
      identity: { ...validSubmission().identity, gtinEvidenceIds: [gtinEvidenceId] },
      classificationProposal: { productTypeId, categoryPageId: null, attributes: [] },
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
    const pi1 = asPi1Submission(parsed.submission);
    expect(pi1?.identity.gtinEvidenceIds[0]).toMatch(/^validate_gtin:/);
    expect(pi1?.classificationProposal.productTypeId).toBe('pt-dog-food');
  });
});

export { taxonomyTools };
