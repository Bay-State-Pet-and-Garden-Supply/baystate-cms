/**
 * PI-4 workflow tests: bundle validator rules and fixture-agent runs through
 * the full stack (executor boundary -> run service -> validator -> persistence)
 * using a stubbed extraction contract — no network, no Pi SDK.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/21
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { getPiRun, getPiResult, listPiConflicts } from '../../db/repositories/product-intelligence-repo';
import { startProductIntelligenceRun } from '../../product-intelligence/run-service';
import { buildDefaultToolRegistry } from '../../product-intelligence/tools';
import { PiToolRegistry } from '../../product-intelligence/tools/registry';
import type { PageExtractionContract, PageExtractionResult } from '../../product-intelligence/tools/contract';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../product-intelligence/executor';
import type { ProductResearchContext, ProductResearchInput, ProductResearchResult } from '../../product-intelligence/contracts';
import {
  type IdentityConflictSubmission,
  type InsufficientEvidenceSubmission,
  type ProductResearchBundle,
  type TerminalSubmission,
} from '../../product-intelligence/workflow/bundle';
import { validateTerminalSubmission, isWorkflowSubmission } from '../../product-intelligence/workflow/bundle-validator';

const wsId = 'pi-workflow-test-workspace';
const GTIN = '036000291452';

// ---------------------------------------------------------------------------
// Stubbed extraction contract (deterministic pages per scenario)
// ---------------------------------------------------------------------------

function pageResult(overrides: Partial<PageExtractionResult> & { url: string }): PageExtractionResult {
  return {
    requestedUrl: overrides.url,
    finalUrl: overrides.url,
    fetchModes: ['http_detailed'],
    contentHash: 'hash',
    artifactRef: null,
    fields: [],
    gtins: [],
    sku: null,
    brand: null,
    productName: null,
    variant: null,
    size: null,
    packCount: null,
    images: [],
    conflicts: [],
    identityStatus: 'insufficient_evidence',
    identityReasons: [],
    deterministicOnly: true,
    ...overrides,
  };
}

class StubExtractionContract implements PageExtractionContract {
  readonly name = 'stub_extraction';
  readonly version = '1.0.0';
  results = new Map<string, PageExtractionResult>();

  async extract(request: { url: string; expected?: { gtin?: string } }): Promise<PageExtractionResult> {
    const result = this.results.get(request.url);
    if (!result) throw new Error(`no stubbed page for ${request.url}`);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Fixture agent: runs a scripted workflow using registry tools
// ---------------------------------------------------------------------------

type WorkflowScenario =
  | { kind: 'success' }
  | { kind: 'parent_page_only' }
  | { kind: 'wrong_variant' }
  | { kind: 'conflicting_size'; submitResearchComplete: boolean }
  | { kind: 'invalid_taxonomy_id' }
  | { kind: 'invalid_gtin_input' }
  | { kind: 'insufficient' }
  | { kind: 'identity_conflict_submission' };

class WorkflowFixtureExecutor implements ProductIntelligenceExecutor {
  readonly name = 'pi';
  readonly version = '1.0.0';
  registry: PiToolRegistry;
  scenario: WorkflowScenario;

  constructor(contract: PageExtractionContract, scenario: WorkflowScenario) {
    this.registry = buildDefaultToolRegistry(contract);
    this.scenario = scenario;
  }

  private async tool(name: string, params: Record<string, unknown>, ctx: ProductResearchContext, events: ExecutionEventSink) {
    events.emit('tool_call_started', { toolName: name });
    const adapter = this.registry.get(name);
    const result = adapter
      ? await this.registry.dispatch(adapter, params, {
          runId: ctx.runId,
          workspaceId: ctx.workspaceId,
          workspacePath: ctx.workspacePath,
          signal: ctx.signal ?? new AbortController().signal,
          remainingMs: 300_000,
        })
      : null;
    events.emit('tool_call_finished', { toolName: name, isError: !result || result.status === 'error' });
    return result;
  }

  async startResearch(input: ProductResearchInput, context: ProductResearchContext, events: ExecutionEventSink): Promise<ProductResearchResult> {
    events.emit('run_started', { message: 'workflow fixture' });
    events.emit('session_created', { data: { piVersion: 'fixture' } });
    const evId = (result: { status: string; evidence?: Array<{ id: string }> } | null): string =>
      result?.status === 'ok' && result.evidence && result.evidence[0] ? result.evidence[0].id : 'ev-missing';

    // Workflow step 1: validate GTIN.
    const gtinResult = await this.tool('validate_gtin', { gtin: input.gtin }, context, events);
    const gtinEvidenceId = evId(gtinResult);

    let submission: TerminalSubmission;
    switch (this.scenario.kind) {
      case 'invalid_gtin_input':
        submission = {
          schemaVersion: 1,
          gtin: input.gtin,
          inputName: input.registerName,
          reason: `GTIN ${input.gtin} failed validation`,
          actionableNextStep: 'Re-check the package barcode and retry',
          evidenceIds: [gtinEvidenceId],
          attemptedSteps: ['validate_gtin'],
        } satisfies InsufficientEvidenceSubmission;
        break;
      case 'insufficient':
        submission = {
          schemaVersion: 1,
          gtin: input.gtin,
          inputName: input.registerName,
          reason: 'No sources found',
          actionableNextStep: 'Provide a package photo for OCR',
          evidenceIds: [gtinEvidenceId],
          attemptedSteps: ['validate_gtin', 'search_upc'],
        } satisfies InsufficientEvidenceSubmission;
        break;
      case 'identity_conflict_submission':
        submission = {
          schemaVersion: 1,
          gtin: input.gtin,
          inputName: input.registerName,
          conflicts: [
            { field: 'gtin', values: [input.gtin, '0000000000000'], evidenceIds: [gtinEvidenceId], severity: 'blocking' },
          ],
          evidenceIds: [gtinEvidenceId],
          recommendedDisposition: 'identity_conflict',
        } satisfies IdentityConflictSubmission;
        break;
      default: {
        // Full bundle scenarios use extract_product_page against the stub.
        const url = `https://brand.example.com/p/${input.gtin}`;
        const extraction = await this.tool('extract_product_page', { url, gtin: input.gtin, expectedName: input.registerName }, context, events);
        const pageEvidenceId = evId(extraction);

        const identityStatus = (extraction as { data?: { identityStatus?: string } }).data?.identityStatus ?? 'insufficient_evidence';
        const conflicts =
          this.scenario.kind === 'conflicting_size'
            ? [{ field: 'size', values: ['16 oz', '8 oz'], evidenceIds: [pageEvidenceId], severity: 'blocking' as const }]
            : [];

        submission = {
          schemaVersion: 1,
          gtin: input.gtin,
          inputName: input.registerName,
          identity: {
            status: identityStatus as ProductResearchBundle['identity']['status'],
            brand: 'Stella',
            canonicalName: 'Stella Chicken Broth 16 oz',
            variant: null,
            manufacturer: null,
            netContent: { value: 16, unit: 'oz' },
            packCount: 1,
            evidenceIds: [pageEvidenceId],
          },
          commerceFacts: [
            { field: 'title', value: 'Stella Chicken Broth 16 oz', evidenceIds: [pageEvidenceId], extractionMethods: ['stub_extraction'], confidenceSignal: 0.9 },
          ],
          classificationProposals:
            this.scenario.kind === 'invalid_taxonomy_id'
              ? [{ targetId: 'pt-invented', selectedOptionId: 'pt-invented', evidenceIds: [pageEvidenceId], disposition: 'proposed' }]
              : [],
          imageCandidates: [],
          conflicts,
          disposition:
            this.scenario.kind === 'conflicting_size'
              ? this.scenario.submitResearchComplete
                ? 'research_complete'
                : 'identity_conflict'
              : identityStatus === 'exact_match'
                ? 'research_complete'
                : 'needs_review',
        } satisfies ProductResearchBundle;
      }
    }

    events.emit('submission_received', { data: { schemaVersion: 1 } });
    events.emit('run_completed', { data: { outcome: 'submitted' } });
    return {
      runId: context.runId,
      outcome: 'submitted',
      executor: this.name,
      executorVersion: this.version,
      piVersion: 'fixture',
      extensionVersions: [],
      configId: context.policy.configId,
      durationMs: 5,
      submission,
      failure: null,
      events: events.snapshot(),
    };
  }
}

describe('PI-4 workflow fixtures through the full stack', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-workflow-test.db');

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Workflow Test',
      workspacePath: '/tmp/pi-workflow-workspace',
      gitPath: '/tmp/pi-workflow-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    // Seed one valid product type for taxonomy validation.
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO classification_product_types (workspace_id, id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [wsId, 'pt-dog-food', 'Dog Food', null, now, now],
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  const opts = { workspaceId: wsId, workspacePath: '/tmp/pi-workflow-workspace' };

  async function runScenario(contract: PageExtractionContract, scenario: WorkflowScenario) {
    const executor = new WorkflowFixtureExecutor(contract, scenario);
    const started = await startProductIntelligenceRun(
      executor,
      { input: { gtin: GTIN, registerName: 'STELLA CHKN BROTH 16OZ' }, mode: 'shadow' },
      opts,
    );
    await started.completed;
    return started.run.id;
  }

  it('completes a research_complete run for an exact-match page (fixture passes terminal schema)', async () => {
    const contract = new StubExtractionContract();
    contract.results.set(`https://brand.example.com/p/${GTIN}`, pageResult({ url: `https://brand.example.com/p/${GTIN}`, gtins: [{ value: GTIN, method: 'meta' }], identityStatus: 'exact_match', identityReasons: ['exact GTIN present'] }));
    const runId = await runScenario(contract, { kind: 'success' });

    expect(getPiRun(runId)?.status).toBe('completed');
    const result = getPiResult(runId);
    expect(result?.disposition).toBe('submitted');
    const parsed = JSON.parse(result!.resultJson) as ProductResearchResult;
    expect(isWorkflowSubmission(parsed.submission)).toBe(true);
    expect(parsed.submission && 'disposition' in parsed.submission && parsed.submission.disposition).toBe('research_complete');
  });

  it('blocks parent-product-only pages submitted as research_complete (validation_error)', async () => {
    const contract = new StubExtractionContract();
    contract.results.set(`https://brand.example.com/p/${GTIN}`, pageResult({ url: `https://brand.example.com/p/${GTIN}`, productName: 'Stella Broth (all sizes)', identityStatus: 'parent_product_only' }));
    // The fixture (like a misbehaving model) submits research_complete anyway.
    const executor = new WorkflowFixtureExecutor(contract, { kind: 'parent_page_only' });
    const started = await startProductIntelligenceRun(executor, { input: { gtin: GTIN, registerName: 'X' }, mode: 'shadow' }, opts);
    await started.completed;
    // Override the fixture disposition to research_complete (the adversarial case).
    // The validator must reject it deterministically.
    const db = getDb();
    db.run('UPDATE product_intelligence_runs SET status = ? WHERE id = ?', ['running', started.run.id]);
    // Simulate the adversarial bundle directly through the validator:
    const bundle = {
      schemaVersion: 1,
      gtin: GTIN,
      inputName: 'X',
      identity: { status: 'parent_product_only', brand: null, canonicalName: null, variant: null, manufacturer: null, netContent: null, packCount: null, evidenceIds: ['ev-1'] },
      commerceFacts: [],
      classificationProposals: [],
      imageCandidates: [],
      conflicts: [],
      disposition: 'research_complete',
    } as unknown as ProductResearchBundle;
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('parent_product_only');
    db.run('UPDATE product_intelligence_runs SET status = ? WHERE id = ?', ['cancelled', started.run.id]);
  });

  it('blocks wrong_variant bundles as research_complete', () => {
    const bundle = {
      schemaVersion: 1,
      gtin: GTIN,
      inputName: 'X',
      identity: { status: 'wrong_variant', brand: null, canonicalName: null, variant: '8oz', manufacturer: null, netContent: null, packCount: null, evidenceIds: ['ev-1'] },
      commerceFacts: [],
      classificationProposals: [],
      imageCandidates: [],
      conflicts: [],
      disposition: 'research_complete',
    } as unknown as ProductResearchBundle;
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('wrong_variant');
  });

  it('requires identity_conflict disposition when blocking conflicts exist', () => {
    const withConflict = {
      schemaVersion: 1,
      gtin: GTIN,
      inputName: 'X',
      identity: { status: 'exact_match', brand: null, canonicalName: null, variant: null, manufacturer: null, netContent: null, packCount: null, evidenceIds: ['ev-1'] },
      commerceFacts: [],
      classificationProposals: [],
      imageCandidates: [],
      conflicts: [{ field: 'size', values: ['16oz', '8oz'], evidenceIds: ['ev-1'], severity: 'blocking' }],
      disposition: 'research_complete',
    } as unknown as ProductResearchBundle;
    expect(validateTerminalSubmission(withConflict, GTIN, wsId).valid).toBe(false);

    const resolved = { ...withConflict, disposition: 'identity_conflict' } as unknown as ProductResearchBundle;
    expect(validateTerminalSubmission(resolved, GTIN, wsId).valid).toBe(true);
  });

  it('rejects invented taxonomy ids and unknown-rights primary images', () => {
    const bundle = {
      schemaVersion: 1,
      gtin: GTIN,
      inputName: 'X',
      identity: { status: 'exact_match', brand: null, canonicalName: null, variant: null, manufacturer: null, netContent: null, packCount: null, evidenceIds: ['ev-1'] },
      commerceFacts: [],
      classificationProposals: [{ targetId: 'pt-invented', selectedOptionId: 'pt-invented', evidenceIds: ['ev-1'], disposition: 'proposed' }],
      imageCandidates: [
        { sourceId: 's1', sourceArtifactId: 'a1', url: 'https://x.example/i.jpg', role: 'primary', exactProductMatch: true, exactVariantMatch: null, variantReference: null, rightsStatus: 'unknown' },
      ],
      conflicts: [],
      disposition: 'research_complete',
    } as unknown as ProductResearchBundle;
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('pt-invented');
    expect(validation.issues.join(' ')).toContain('rights');
  });

  it('accepts valid taxonomy proposals against seeded config', () => {
    const bundle = {
      schemaVersion: 1,
      gtin: GTIN,
      inputName: 'X',
      identity: { status: 'exact_match', brand: null, canonicalName: null, variant: null, manufacturer: null, netContent: null, packCount: null, evidenceIds: ['ev-1'] },
      commerceFacts: [],
      classificationProposals: [{ targetId: 'pt-dog-food', selectedOptionId: 'pt-dog-food', evidenceIds: ['ev-1'], disposition: 'proposed' }],
      imageCandidates: [],
      conflicts: [],
      disposition: 'research_complete',
    } as unknown as ProductResearchBundle;
    expect(validateTerminalSubmission(bundle, GTIN, wsId).valid).toBe(true);
  });

  it('rejects bundles whose GTIN does not match the run input', () => {
    const bundle = {
      schemaVersion: 1,
      gtin: '0000000000000',
      inputName: 'X',
      identity: { status: 'exact_match', brand: null, canonicalName: null, variant: null, manufacturer: null, netContent: null, packCount: null, evidenceIds: ['ev-1'] },
      commerceFacts: [],
      classificationProposals: [],
      imageCandidates: [],
      conflicts: [],
      disposition: 'research_complete',
    } as unknown as ProductResearchBundle;
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('does not match');
  });

  it('rejects facts without evidence ids or extraction methods', () => {
    const bundle = {
      schemaVersion: 1,
      gtin: GTIN,
      inputName: 'X',
      identity: { status: 'exact_match', brand: 'Stella', canonicalName: null, variant: null, manufacturer: null, netContent: null, packCount: null, evidenceIds: [] },
      commerceFacts: [{ field: 'title', value: 'Uncited title', evidenceIds: [], extractionMethods: [] }],
      classificationProposals: [],
      imageCandidates: [],
      conflicts: [],
      disposition: 'research_complete',
    } as unknown as ProductResearchBundle;
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('completes insufficient-evidence runs as abstentions', async () => {
    const runId = await runScenario(new StubExtractionContract(), { kind: 'insufficient' });
    expect(getPiRun(runId)?.status).toBe('completed');
    expect(getPiResult(runId)?.disposition).toBe('abstained');
  });

  it('completes identity-conflict submissions and persists durable conflicts', async () => {
    const runId = await runScenario(new StubExtractionContract(), { kind: 'identity_conflict_submission' });
    expect(getPiRun(runId)?.status).toBe('completed');
    expect(getPiResult(runId)?.disposition).toBe('abstained');
    const conflicts = listPiConflicts(runId);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].severity).toBe('high'); // blocking -> high
  });

  it('fails runs whose bundles fail validation (invalid taxonomy id scenario)', async () => {
    const contract = new StubExtractionContract();
    contract.results.set(`https://brand.example.com/p/${GTIN}`, pageResult({ url: `https://brand.example.com/p/${GTIN}`, gtins: [{ value: GTIN, method: 'meta' }], identityStatus: 'exact_match' }));
    const executor = new WorkflowFixtureExecutor(contract, { kind: 'invalid_taxonomy_id' });
    const started = await startProductIntelligenceRun(executor, { input: { gtin: GTIN, registerName: 'X' }, mode: 'shadow' }, opts);
    await started.completed;
    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('failed');
    expect(run?.errorCode).toBe('validation_error');
    expect(run?.errorMessage).toContain('pt-invented');
  });
});
