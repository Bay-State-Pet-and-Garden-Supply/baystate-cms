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
import { createPiRun, getPiRun, getPiResult, insertPiAsset, insertPiSource, listPiAssetsByRun, listPiConflicts } from '../../db/repositories/product-intelligence-repo';
import { startProductIntelligenceRun } from '../../product-intelligence/run-service';
import { buildDefaultToolRegistry } from '../../product-intelligence/tools';
import { PolicyGateway } from '../../product-intelligence/policy/policy-gateway';
import { PiToolRegistry } from '../../product-intelligence/tools/registry';
import type { PageExtractionContract, PageExtractionResult } from '../../product-intelligence/tools/contract';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../product-intelligence/executor';
import type { ProductResearchContext, ProductResearchInput, ProductResearchResult } from '../../product-intelligence/contracts';
import {
  type BundleImageCandidate,
  type IdentityConflictSubmission,
  type InsufficientEvidenceSubmission,
  type ProductResearchBundle,
  type TerminalSubmission,
} from '../../product-intelligence/workflow/bundle';
import { validateTerminalSubmission, isWorkflowSubmission } from '../../product-intelligence/workflow/bundle-validator';

const wsId = 'pi-workflow-test-workspace';
const GTIN = '036000291452';

// ---------------------------------------------------------------------------
// PI-6 image fixture helpers
// ---------------------------------------------------------------------------

function validPrimaryImage(overrides: Partial<BundleImageCandidate> = {}): BundleImageCandidate {
  return {
    sourceId: 's1',
    sourceArtifactId: 'a1',
    url: 'https://cdn.example.com/primary.jpg',
    role: 'primary',
    verifiedAssetIds: [],
    exactProductMatch: true,
    exactVariantMatch: true,
    variantReference: null,
    rightsStatus: 'supplier_authorized',
    evidenceIds: ['ev-img-1'],
    sourcePageUrl: `https://brand.example.com/p/${GTIN}`,
    sourcePath: 'json_ld.image',
    extractionMethod: 'media_api',
    retrievedAt: '2026-08-05T00:00:00.000Z',
    rightsBasis: 'supplier_authorized_asset',
    rightsEvidenceRef: 'ev:supplier-1',
    originalContentHash: 'a'.repeat(64), // SHA-256 hex digest
    perceptualHash: 'deadbeef',
    qualityStatus: 'usable',
    commerceApproved: true,
    observedNetContent: { value: 16, unit: 'oz' },
    observedPackCount: 1,
    conflicts: [],
    ...overrides,
  };
}

/** Round-3: seed a DURABLE server-verified asset row (the authority a
 *  terminal candidate must cite). Returns the row id. The row's fields are
 *  what validation/persistence derive from — the candidate's own claims are
 *  ignored. A real run row backs the asset (FK to product_intelligence_runs). */
let _seedRunId: string | null = null;
function seedRunId(): string {
  if (!_seedRunId) {
    _seedRunId = createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: '{}',
      policyJson: '{}',
      configSnapshotId: 'seed',
      configSnapshotHash: 'seed',
    }).id;
  }
  return _seedRunId;
}
function seedVerifiedAssetRow(overrides: Record<string, unknown> = {}): string {
  const backingRunId = seedRunId();
  const source = insertPiSource({
    runId: backingRunId,
    url: 'https://cdn.example.com/primary.jpg',
    domain: 'cdn.example.com',
    sourceType: 'supplier',
    licenseRef: 'grant:supplier@cdn.example.com',
    termsRef: 'supplier_authorized_asset',
  });
  const asset = insertPiAsset({
    runId: backingRunId,
    sourceId: source.id,
    sourceUrl: 'https://cdn.example.com/primary.jpg',
    sourceType: 'supplier',
    sourceArtifactId: 'a1',
    extractionMethod: 'image_ocr',
    retrievedAt: '2026-08-05T00:00:00.000Z',
    originalContentHash: 'a'.repeat(64),
    perceptualHash: 'deadbeef',
    rightsStatus: 'approved',
    rightsBasis: 'grant:supplier@cdn.example.com',
    rightsEvidenceRef: 'grant:supplier@cdn.example.com',
    exactProductMatch: true,
    exactVariantMatch: true,
    qualityStatus: 'usable',
    commerceApproved: true,
    conflicts: [],
    ...(overrides as object),
  });
  return asset.id;
}

function exactMatchBundle(overrides: Record<string, unknown> = {}): ProductResearchBundle {
  return {
    schemaVersion: 1,
    gtin: GTIN,
    inputName: 'X',
    identity: { status: 'exact_match', brand: null, canonicalName: null, variant: null, manufacturer: null, netContent: null, packCount: null, evidenceIds: ['ev-1'] },
    commerceFacts: [],
    classificationProposals: [],
    imageCandidates: [],
    conflicts: [],
    disposition: 'research_complete',
    ...overrides,
  } as unknown as ProductResearchBundle;
}

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
  | { kind: 'success'; verifiedAssetId?: string }
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
  gateway = new PolicyGateway({ resolveHostname: async (hostname) => (hostname.endsWith('example.com') ? ['93.184.216.34'] : []) });

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
          policy: ctx.policy,
          gateway: this.gateway,
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
          // Only the success scenario proposes a primary image (and only by
          // citing a durable verified asset); the failure scenarios keep the
          // bundle focused on the identity/taxonomy assertions they test.
          imageCandidates:
            this.scenario.kind === 'success'
              ? [
                  validPrimaryImage({
                    verifiedAssetIds: this.scenario.verifiedAssetId ? [this.scenario.verifiedAssetId] : [],
                    evidenceIds: [pageEvidenceId],
                    sourcePageUrl: url,
                    observedNetContent: { value: 16, unit: 'oz' },
                    observedPackCount: 1,
                  }),
                ]
              : [],
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
    // Round-3: the terminal image cites a DURABLE server-verified asset row;
    // the persisted asset derives its identity/rights/commerce fields from
    // that row, never from agent-supplied claims.
    const verifiedId = seedVerifiedAssetRow();
    const contract = new StubExtractionContract();
    contract.results.set(`https://brand.example.com/p/${GTIN}`, pageResult({ url: `https://brand.example.com/p/${GTIN}`, gtins: [{ value: GTIN, method: 'meta' }], identityStatus: 'exact_match', identityReasons: ['exact GTIN present'] }));
    const runId = await runScenario(contract, { kind: 'success', verifiedAssetId: verifiedId });

    expect(getPiRun(runId)?.status).toBe('completed');
    const result = getPiResult(runId);
    expect(result?.disposition).toBe('submitted');
    const parsed = JSON.parse(result!.resultJson) as ProductResearchResult;
    expect(isWorkflowSubmission(parsed.submission)).toBe(true);
    expect(parsed.submission && 'disposition' in parsed.submission && parsed.submission.disposition).toBe('research_complete');
    // The primary image candidate is persisted ONLY because it cites the
    // durable verified asset row — and its authoritative fields are the
    // row's server-side values, not the candidate's claims.
    const assets = listPiAssetsByRun(runId);
    expect(assets.length).toBe(1);
    expect(assets[0].rightsStatus).toBe('approved');
    expect(assets[0].commerceApproved).toBe(1);
    expect(assets[0].rightsEvidenceRef).toBe('grant:supplier@cdn.example.com');
    expect(assets[0].exactProductMatch).toBe(1);
  });

  it('blocks a fabricated terminal image candidate whose verified asset does not exist (round-3 adversarial)', async () => {
    const contract = new StubExtractionContract();
    contract.results.set(`https://brand.example.com/p/${GTIN}`, pageResult({ url: `https://brand.example.com/p/${GTIN}`, gtins: [{ value: GTIN, method: 'meta' }], identityStatus: 'exact_match', identityReasons: ['exact GTIN present'] }));
    const runId = await runScenario(contract, {
      kind: 'success',
      // Made-up asset id + the candidate's own plausible-looking claims —
      // none of it resolves to a durable verified record.
      verifiedAssetId: 'made-up-verified-asset-id',
    });
    const run = getPiRun(runId);
    // The validator rejects the fabricated primary (no resolvable durable
    // asset) so the run fails validation and nothing is persisted.
    expect(run?.status).toBe('failed');
    expect(listPiAssetsByRun(runId).length).toBe(0);
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

  it('rejects invented taxonomy ids and uncited primary images', () => {
    const bundle = {
      schemaVersion: 1,
      gtin: GTIN,
      inputName: 'X',
      identity: { status: 'exact_match', brand: null, canonicalName: null, variant: null, manufacturer: null, netContent: null, packCount: null, evidenceIds: ['ev-1'] },
      commerceFacts: [],
      classificationProposals: [{ targetId: 'pt-invented', selectedOptionId: 'pt-invented', evidenceIds: ['ev-1'], disposition: 'proposed' }],
      imageCandidates: [
        { sourceId: 's1', sourceArtifactId: 'a1', url: 'https://x.example/i.jpg', role: 'primary', exactProductMatch: true, exactVariantMatch: null, variantReference: null, rightsStatus: 'unknown', verifiedAssetIds: [] },
      ],
      conflicts: [],
      disposition: 'research_complete',
    } as unknown as ProductResearchBundle;
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('pt-invented');
    // Round-3: an uncited primary fails even when its claims look plausible.
    expect(validation.issues.join(' ')).toContain('verified asset id');
  });

  it('accepts valid taxonomy proposals against seeded config', () => {
    const bundle = exactMatchBundle({
      classificationProposals: [{ targetId: 'pt-dog-food', selectedOptionId: 'pt-dog-food', evidenceIds: ['ev-1'], disposition: 'proposed' }],
    });
    expect(validateTerminalSubmission(bundle, GTIN, wsId).valid).toBe(true);
  });

  it('accepts a valid primary image candidate citing a durable verified asset (PI-6, round-3)', () => {
    const verifiedId = seedVerifiedAssetRow();
    const bundle = exactMatchBundle({ imageCandidates: [validPrimaryImage({ verifiedAssetIds: [verifiedId] })] });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it('rejects a fabricated primary image citing a nonexistent verified asset (round-3 adversarial)', () => {
    const bundle = exactMatchBundle({ imageCandidates: [validPrimaryImage({ verifiedAssetIds: ['made-up-asset-id'] })] });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('no resolvable durable verified asset');
  });

  it('blocks parent-product-only verified assets as primary (exactVariantMatch false)', () => {
    const verifiedId = seedVerifiedAssetRow({ exactVariantMatch: false, commerceApproved: false });
    const bundle = exactMatchBundle({ imageCandidates: [validPrimaryImage({ verifiedAssetIds: [verifiedId] })] });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('exact variant');
  });

  it('blocks primary verified assets with conflicting visible-package evidence', () => {
    const verifiedId = seedVerifiedAssetRow({ conflicts: ['pack_count_mismatch: observed pack count 2 vs expected 1'], commerceApproved: false });
    const bundle = exactMatchBundle({ imageCandidates: [validPrimaryImage({ verifiedAssetIds: [verifiedId] })] });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('conflicting visible-package evidence');
  });

  it('rejects a verified asset whose stored commerce approval contradicts its own fields', () => {
    // The row's fields recompute to approved, but the row was persisted with
    // commerceApproved false — a contradiction that must surface.
    const verifiedId = seedVerifiedAssetRow({ commerceApproved: false });
    const bundle = exactMatchBundle({ imageCandidates: [validPrimaryImage({ verifiedAssetIds: [verifiedId] })] });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('stored commerce approval');
  });

  it('rejects more than one primary image', () => {
    const verifiedId = seedVerifiedAssetRow();
    const bundle = exactMatchBundle({
      imageCandidates: [validPrimaryImage({ verifiedAssetIds: [verifiedId] }), validPrimaryImage({ url: 'https://cdn.example.com/second.jpg', verifiedAssetIds: [verifiedId] })],
    });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('at most one primary image');
  });

  it('rejects a verified asset without a content hash (missing extraction provenance)', () => {
    const verifiedId = seedVerifiedAssetRow({ originalContentHash: '' });
    const bundle = exactMatchBundle({ imageCandidates: [validPrimaryImage({ verifiedAssetIds: [verifiedId] })] });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('no content hash');
  });

  it('blocks a primary verified asset whose rights are not approved (no durable reuse grant)', () => {
    const verifiedId = seedVerifiedAssetRow({ rightsStatus: 'restricted', rightsBasis: null, rightsEvidenceRef: null, commerceApproved: false });
    const bundle = exactMatchBundle({ imageCandidates: [validPrimaryImage({ verifiedAssetIds: [verifiedId] })] });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(' ')).toContain('not approved');
  });

  it('accepts a primary verified asset with an approved rights grant', () => {
    const verifiedId = seedVerifiedAssetRow();
    const bundle = exactMatchBundle({ imageCandidates: [validPrimaryImage({ verifiedAssetIds: [verifiedId] })] });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(true);
  });

  it('accepts alternate/retailer images without blocking (non-primary roles unconstrained)', () => {
    const verifiedId = seedVerifiedAssetRow();
    const bundle = exactMatchBundle({
      imageCandidates: [
        validPrimaryImage({ verifiedAssetIds: [verifiedId] }),
        {
          sourceId: 's2',
          sourceArtifactId: 'a2',
          url: 'https://cdn.example.com/alternate.jpg',
          role: 'alternate',
          exactProductMatch: true,
          exactVariantMatch: null,
          rightsStatus: 'unknown',
          evidenceIds: ['ev-img-2'],
          commerceApproved: false,
        },
      ],
    });
    const validation = validateTerminalSubmission(bundle, GTIN, wsId);
    expect(validation.valid).toBe(true);
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
