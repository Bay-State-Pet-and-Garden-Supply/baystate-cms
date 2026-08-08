/**
 * Product Intelligence run service tests (PI-2).
 *
 * DB-backed (bun test). Uses a fake executor (no Pi SDK, no network) to
 * verify the durable run lifecycle end-to-end: happy path, abstention,
 * unavailable (legacy), failure, cancellation, timeout, replay cursors,
 * comparisons, retention, and review-blocking signals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { canonicalVerifiedAgainstHash } from '../../product-intelligence/assets/verification';
import {
  createPiRun,
  getPiImageCandidate,
  getPiRun,
  getPiResult,
  insertPiAsset,
  insertPiImageCandidate,
  insertPiSource,
  listPiAssetsByRun,
  listPiEvents,
  listPiEvidence,
  listPiSources,
} from '../../db/repositories/product-intelligence-repo';
import {
  buildDefaultPiPolicy,
  cancelPiRun,
  createPiComparison,
  getPiRunProjection,
  persistBundleAssets,
  PersistingExecutionEventSink,
  replayPiEvents,
  reviewReasons,
  runRetentionCleanup,
  startProductIntelligenceRun,
  submissionNeedsReview,
  assetEvidenceFromRow,
} from '../../product-intelligence/run-service';
import { validateTerminalSubmission } from '../../product-intelligence/workflow/bundle-validator';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../product-intelligence/executor';
import type { ProductResearchContext, ProductResearchInput, ProductResearchResult, TerminalResultSubmission } from '../../product-intelligence/contracts';
import { TEST_INPUT, validBundle, validSubmission, insufficientEvidenceSubmission } from './product-intelligence/test-helpers';
import type { ProductResearchBundle } from '../../product-intelligence/workflow/bundle';

const wsId = 'pi-service-test-workspace';

/** A validator-valid PI-4 bundle with one approved primary image (PI-6). */
function bundleWithImage(): ProductResearchBundle {
  return {
    schemaVersion: 1,
    gtin: TEST_INPUT.gtin,
    inputName: TEST_INPUT.registerName,
    identity: { status: 'exact_match', brand: null, canonicalName: null, variant: null, manufacturer: null, netContent: null, packCount: null, evidenceIds: [] },
    commerceFacts: [],
    classificationProposals: [],
    imageCandidates: [
      {
        sourceId: 's1',
        sourceArtifactId: 'a1',
        url: 'https://cdn.example.com/primary.jpg',
        role: 'primary',
        verifiedAssetId: '',
        exactProductMatch: true,
        exactVariantMatch: true,
        variantReference: null,
        rightsStatus: 'supplier_authorized',
        evidenceIds: ['ev-img-1'],
        sourcePageUrl: 'https://supplier.example.com/p/1',
        sourcePath: 'json_ld.image',
        extractionMethod: 'media_api',
        retrievedAt: '2026-08-05T00:00:00.000Z',
        rightsBasis: 'supplier_authorized_asset',
        rightsEvidenceRef: 'ev:supplier-1',
        originalContentHash: 'b'.repeat(64), // SHA-256 hex digest
        perceptualHash: 'phash-img-1',
        qualityStatus: 'usable',
        commerceApproved: true,
        observedNetContent: { value: 16, unit: 'oz' },
        observedPackCount: 1,
        conflicts: [],
      },
    ],
    conflicts: [],
    disposition: 'research_complete',
  };
}

// ---------------------------------------------------------------------------
// Fake executor: scriptable terminal outcomes, no external calls
// ---------------------------------------------------------------------------

class FakePiExecutor implements ProductIntelligenceExecutor {
  readonly name = 'pi';
  readonly version = '1.0.0';
  outcome: ProductResearchResult['outcome'] = 'submitted';
  submission: TerminalResultSubmission = validBundle();
  failure: ProductResearchResult['failure'] = null;
  emitToolCalls = true;
  /** When true, research waits until the caller signal aborts. */
  hangUntilAborted = false;
  lastContext: ProductResearchContext | null = null;
  calls = 0;

  async startResearch(
    input: ProductResearchInput,
    context: ProductResearchContext,
    events: ExecutionEventSink,
  ): Promise<ProductResearchResult> {
    this.calls += 1;
    this.lastContext = context;
    if (this.hangUntilAborted) {
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          context.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        context.signal?.addEventListener('abort', onAbort, { once: true });
        // Safety: never hang the test forever.
        setTimeout(resolve, 5_000);
      });
    }
    // Honor the caller cancellation signal (deterministic cancel test).
    if (context.signal?.aborted) {
      events.emit('run_cancelled', { message: 'cancelled by caller signal' });
      return {
        runId: context.runId,
        outcome: 'cancelled',
        executor: this.name,
        executorVersion: this.version,
        extensionVersions: [],
        configId: context.policy.configId,
        durationMs: 1,
        submission: null,
        failure: null,
        events: events.snapshot(),
      };
    }
    events.emit('run_started', { message: `researching ${input.gtin}` });
    events.emit('session_created', { data: { piVersion: '0.83.0', tools: ['read', 'grep', 'find', 'ls', 'submit_product_research_bundle'] } });
    if (this.emitToolCalls) {
      events.emit('tool_call_started', { toolName: 'read' });
      events.emit('tool_call_finished', { toolName: 'read', isError: false });
    }
    const startedAt = Date.now();
    switch (this.outcome) {
      case 'submitted':
      case 'abstained':
        events.emit('submission_received', { data: { schemaVersion: this.submission.schemaVersion } });
        events.emit('run_completed', { data: { outcome: this.outcome } });
        return {
          runId: context.runId,
          outcome: this.outcome,
          executor: this.name,
          executorVersion: this.version,
          piVersion: '0.83.0',
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: Date.now() - startedAt,
          submission: this.submission,
          failure: null,
          events: events.snapshot(),
        };
      case 'unavailable':
        events.emit('run_completed', { data: { outcome: 'unavailable' } });
        return {
          runId: context.runId,
          outcome: 'unavailable',
          executor: 'legacy',
          executorVersion: '1.0.0',
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: 1,
          submission: null,
          failure: null,
          events: events.snapshot(),
        };
      case 'failed':
        events.emit('run_failed', { isError: true, message: this.failure?.message ?? 'no submission', data: { code: this.failure?.code ?? 'missing_submission' } });
        return {
          runId: context.runId,
          outcome: 'failed',
          executor: this.name,
          executorVersion: this.version,
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: 1,
          submission: null,
          failure: this.failure ?? { code: 'missing_submission', message: 'no submission' },
          events: events.snapshot(),
        };
      case 'cancelled':
        events.emit('run_cancelled', { message: 'cancelled' });
        return {
          runId: context.runId,
          outcome: 'cancelled',
          executor: this.name,
          executorVersion: this.version,
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: 1,
          submission: null,
          failure: null,
          events: events.snapshot(),
        };
      case 'timed_out':
        events.emit('run_timeout', { message: 'deadline' });
        return {
          runId: context.runId,
          outcome: 'timed_out',
          executor: this.name,
          executorVersion: this.version,
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: 1,
          submission: null,
          failure: { code: 'deadline_exceeded', message: 'deadline' },
          events: events.snapshot(),
        };
    }
  }
}

describe('Product Intelligence run service', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-service-test.db');

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Service Test',
      workspacePath: '/tmp/pi-service-workspace',
      gitPath: '/tmp/pi-service-workspace/.git',
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

  const runOpts = { workspaceId: wsId, workspacePath: '/tmp/pi-service-workspace' };

  it('runs a submitted research end-to-end with durable artifacts', async () => {
    const executor = new FakePiExecutor();
    // A bundle with a blocking conflict + cited identity evidence exercises
    // the workflow persistence path (conflicts + gap reporting).
    executor.submission = validBundle({
      identity: { ...validBundle().identity, status: 'exact_match' },
      conflicts: [{ field: 'netContent', values: ['16 oz', '4 oz'], severity: 'medium', evidenceIds: ['ev-bundle-1'] }],
    });
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT, mode: 'shadow' }, runOpts);
    await started.completed;

    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('completed');
    expect(run?.mode).toBe('shadow');
    expect(run?.piVersion).toBe('0.83.0');
    expect(run?.configSnapshotId).toBe(buildDefaultPiPolicy().configId);
    expect(JSON.parse(run?.inputJson ?? '{}').gtin).toBe(TEST_INPUT.gtin);
    expect(run?.codeCommit).toBeTruthy();

    // Result with schema version + content hash.
    const result = getPiResult(started.run.id);
    expect(result?.disposition).toBe('submitted');
    expect(result?.schemaVersion).toBe(1);
    expect(result?.resultHash).toBeTruthy();

    // Workflow persistence: no sources/evidence rows from a minimal bundle
    // (per-tool persistence creates those), but the blocking conflict is
    // durable and the uncited identity evidence is reported as a gap.
    const sources = listPiSources(started.run.id);
    expect(sources.length).toBe(0);
    const evidence = listPiEvidence(started.run.id);
    expect(evidence.length).toBe(0);
    const conflicts = getPiRunProjection(started.run.id)?.conflicts as Array<{ field: string; severity: string }>;
    expect(conflicts.map((c) => c.field)).toContain('netContent');

    // Events persisted in order; tool call derived.
    const events = listPiEvents(started.run.id);
    expect(events.length).toBeGreaterThan(3);
    expect(events.map((e) => e.type)).toContain('submission_received');
    // The SSE-facing stream maps normalized types to domain events.
    const mapped = replayPiEvents(started.run.id).map((e) => e.type);
    expect(mapped).toContain('run.completed');
    expect(mapped).toContain('conflict.detected');
    // Cited-but-not-durable evidence surfaces as an honest gap (never fabricated).
    expect(mapped).toContain('evidence.gap');
    // No duplicate run.started/run.completed (service emits only additive events).
    expect(mapped.filter((t) => t === 'run.completed')).toHaveLength(1);
    const toolCalls = getPiRunProjection(started.run.id)?.toolCalls as Array<{ toolName: string }>;
    expect(toolCalls[0].toolName).toBe('read');

    // Steps derived (session + submission).
    const steps = getPiRunProjection(started.run.id)?.steps as Array<{ stepType: string; status: string }>;
    expect(steps.map((s) => s.stepType).sort()).toEqual(['session', 'submission']);

    // Policy signal wired into the executor context.
    expect(executor.lastContext?.signal).toBeInstanceOf(AbortSignal);
    expect(executor.lastContext?.executionMode).toBe('shadow');
  });

  it('persists an abstained run and emits no needs_review for exact identity', async () => {
    const executor = new FakePiExecutor();
    executor.submission = insufficientEvidenceSubmission();
    executor.outcome = 'abstained';
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT, mode: 'shadow' }, runOpts);
    await started.completed;
    expect(getPiResult(started.run.id)?.disposition).toBe('abstained');
    const types = replayPiEvents(started.run.id).map((e) => e.type);
    expect(types).not.toContain('run.needs_review');
  });

  it('flags needs_review when identity is not exact (round-5: uncited images now fail the gate instead)', async () => {
    const executor = new FakePiExecutor();
    executor.submission = validBundle({
      identity: { ...validBundle().identity, status: 'probable_match' },
      imageCandidates: [],
    });
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const types = listPiEvents(started.run.id).map((e) => e.type);
    expect(types).toContain('run.needs_review');
    const payload = JSON.parse(listPiEvents(started.run.id).find((e) => e.type === 'run.needs_review')!.payloadJson);
    expect(payload.reasons.length).toBeGreaterThanOrEqual(1);
  });

  it('denies a legacy PI-1 envelope at the terminal gate (review finding 6)', async () => {
    const executor = new FakePiExecutor();
    // A fake executor CAN cast a legacy envelope through the type boundary —
    // the deterministic CMS-side gate must deny it at runtime, never pass it.
    executor.submission = validSubmission() as unknown as TerminalResultSubmission;
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('failed');
    expect(run?.errorCode).toBe('validation_error');
    expect(run?.errorMessage).toContain('unsupported submission shape');
    const types = replayPiEvents(started.run.id).map((e) => e.type);
    expect(types).toContain('run.failed');
  });

  it('marks unavailable runs completed with disposition unavailable (legacy path)', async () => {
    const executor = new FakePiExecutor();
    executor.outcome = 'unavailable';
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    expect(getPiRun(started.run.id)?.status).toBe('completed');
    expect(getPiResult(started.run.id)?.disposition).toBe('unavailable');
  });

  it('fails runs with the executor failure code', async () => {
    const executor = new FakePiExecutor();
    executor.outcome = 'failed';
    executor.failure = { code: 'missing_submission', message: 'session ended without submission' };
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('failed');
    expect(run?.errorCode).toBe('missing_submission');
    expect(run?.errorMessage).toContain('submission');
    const types = replayPiEvents(started.run.id).map((e) => e.type);
    expect(types).toContain('run.failed');
  });

  it('marks timed-out runs failed with deadline_exceeded', async () => {
    const executor = new FakePiExecutor();
    executor.outcome = 'timed_out';
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('failed');
    expect(run?.errorCode).toBe('deadline_exceeded');
  });

  it('marks cancelled runs cancelled when the caller aborts', async () => {
    const executor = new FakePiExecutor();
    executor.hangUntilAborted = true;
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    expect(cancelPiRun(started.run.id)).toBe(true);
    await started.completed;
    const run = getPiRun(started.run.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.cancelledAt).toBeTruthy();
    expect(run?.completedAt).toBeNull();
    const types = replayPiEvents(started.run.id).map((e) => e.type);
    expect(types).toContain('run.cancelled');
  });

  it('propagates executor throws as failed runs', async () => {
    const executor = new FakePiExecutor();
    executor.startResearch = async () => {
      throw new Error('boom');
    };
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await expect(started.completed).rejects.toThrow('boom');
    expect(getPiRun(started.run.id)?.status).toBe('failed');
    expect(getPiRun(started.run.id)?.errorCode).toBe('unknown');
  });

  it('replays events after a cursor (SSE reconnect)', async () => {
    const executor = new FakePiExecutor();
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const all = replayPiEvents(started.run.id);
    expect(all.length).toBe(listPiEvents(started.run.id).length);
    // Replay from a mid-stream cursor returns only newer events, in order.
    const cursor = 1;
    const tail = replayPiEvents(started.run.id, cursor);
    expect(tail.every((e) => e.sequence > cursor)).toBe(true);
    const sequences = tail.map((e) => e.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });

  it('creates comparisons with metrics against a baseline', async () => {
    const executor = new FakePiExecutor();
    // A bundle with one commerce fact drives fieldCount from the workflow shape
    // (bundles have no productProposal/evidenceSources — per-tool persistence
    // owns source rows).
    executor.submission = validBundle({
      commerceFacts: [{ field: 'netContent', value: '16 oz', evidenceIds: ['ev-bundle-1'], extractionMethods: ['json_ld'], confidenceSignal: null }],
    });
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const comparison = createPiComparison({ runId: started.run.id, baselineType: 'legacy', baselineRef: 'legacy-run-xyz' });
    const metrics = JSON.parse((comparison as { metricsJson: string }).metricsJson);
    expect(metrics.executor).toBe('pi');
    expect(metrics.outcome).toBe('submitted');
    expect(metrics.fieldCount).toBe(1);
    expect(metrics.sourceCount).toBe(0);
  });

  it('persists bundle image candidates from the cited durable verified asset (round-3/4)', () => {
    // Round-3: the terminal candidate cites a DURABLE server-verified asset
    // row; every authoritative field in the persisted asset derives from that
    // row, never from agent-supplied claims. Round-4: the cited asset must
    // belong to the CURRENT run and be bound to its immutable input identity
    // (verified-against hash); cross-run borrowing or URL substitution never
    // persists. (The end-to-end completion flow is covered by the workflow
    // suite, where the verifying tool runs inside the executing run; this
    // test pins the persistence boundary directly.)
    const runId = createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: TEST_INPUT.gtin, registerName: TEST_INPUT.registerName }),
      policyJson: '{}',
      configSnapshotId: 'seed',
      configSnapshotHash: 'seed',
    }).id;
    const seedSource = insertPiSource({
      runId,
      url: 'https://cdn.example.com/primary.jpg',
      domain: 'cdn.example.com',
      sourceType: 'supplier',
      licenseRef: 'grant:supplier@cdn.example.com',
      termsRef: 'grant:supplier@cdn.example.com',
    });
    const verifiedHash = canonicalVerifiedAgainstHash({
      runId,
      gtin: TEST_INPUT.gtin,
      name: TEST_INPUT.registerName,
    });
    const assetId = insertPiAsset({
      runId,
      sourceId: seedSource.id,
      sourceUrl: 'https://cdn.example.com/primary.jpg',
      sourceType: 'supplier',
      sourceArtifactId: 'a1',
      extractionMethod: 'image_ocr',
      retrievedAt: '2026-08-05T00:00:00.000Z',
      originalContentHash: 'b'.repeat(64),
      perceptualHash: 'phash-img-1',
      rightsStatus: 'approved',
      rightsBasis: 'grant:supplier@cdn.example.com',
      rightsEvidenceRef: 'grant:supplier@cdn.example.com',
      observedNetContent: { value: 16, unit: 'oz' },
      observedPackCount: 1,
      exactProductMatch: true,
      exactVariantMatch: true,
      qualityStatus: 'usable',
      commerceApproved: true,
      conflicts: [],
      verifiedAgainstJson: JSON.stringify({ runId, gtin: TEST_INPUT.gtin, name: TEST_INPUT.registerName }),
      verifiedAgainstHash: verifiedHash,
      declaredSourceType: 'supplier',
    }).id;

    const bundle = bundleWithImage();
    bundle.imageCandidates[0].verifiedAssetId = assetId;

    // The terminal gate accepts the run-bound, identity-bound citation.
    const validation = validateTerminalSubmission(bundle, TEST_INPUT.gtin, wsId, runId);
    expect(validation.valid).toBe(true);

    // Persistence derives every authoritative field from the durable row.
    const sink = { emitDomain: () => undefined } as unknown as PersistingExecutionEventSink;
    persistBundleAssets(runId, bundle, sink);

    const assets = listPiAssetsByRun(runId).map(assetEvidenceFromRow);
    expect(assets.length).toBeGreaterThanOrEqual(1);
    // The tool-time verified seed (same run, round-4 binding) plus the
    // bundle-persisted copy both derive from the durable row — assert the
    // bundle copy (last row), like the workflow suite does.
    const persisted = assets[assets.length - 1];
    expect(persisted).toMatchObject({
      rightsStatus: 'approved',
      commerceApproved: true,
      // Server-derived from the verified row — the candidate's own
      // 'media_api'/'ev:supplier-1' claims are ignored.
      extractionMethod: 'image_ocr',
      originalContentHash: 'b'.repeat(64),
    });
    expect(persisted.rightsEvidenceRef).toBe('grant:supplier@cdn.example.com');
    // The source row carries the grant record's license/terms refs.
    const sources = listPiSources(runId);
    const imageSource = sources.find((s) => s.url === 'https://cdn.example.com/primary.jpg');
    expect(imageSource?.licenseRef).toBe('grant:supplier@cdn.example.com');
    expect(imageSource?.termsRef).toBe('grant:supplier@cdn.example.com');
  });

  it('preserves the exact candidate FK through terminal persistence (round-11 P1-4)', async () => {
    const runId = createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify(TEST_INPUT),
      policyJson: '{}',
      configSnapshotId: 'seed',
      configSnapshotHash: 'seed',
    }).id;
    // A real candidate row (one row = one image URL; the round-11 trigger
    // requires candidate.image_url === asset.source_url, which the live
    // verifier already enforces — mirror that state here).
    const candidate = insertPiImageCandidate({
      runId,
      imageUrl: 'https://cdn.example.com/primary.jpg',
      entityId: 'sku:7449053000110',
      extractionMethod: 'json_ld',
    });
    expect(getPiImageCandidate(candidate.id)?.id).toBe(candidate.id);
    const verifiedHash = canonicalVerifiedAgainstHash({
      runId,
      gtin: TEST_INPUT.gtin,
      name: TEST_INPUT.registerName,
    });
    const seedSource = insertPiSource({
      runId,
      url: 'https://cdn.example.com/primary.jpg',
      domain: 'cdn.example.com',
      sourceType: 'manufacturer',
    });
    // The tool-time verified asset carries the exact candidate FK.
    const assetId = insertPiAsset({
      runId,
      sourceId: seedSource.id,
      sourceUrl: 'https://cdn.example.com/primary.jpg',
      sourceType: 'manufacturer',
      sourceArtifactId: 'a1',
      extractionMethod: 'image_ocr',
      retrievedAt: '2026-08-05T00:00:00.000Z',
      originalContentHash: 'b'.repeat(64),
      rightsStatus: 'approved',
      rightsBasis: 'grant:manufacturer@cdn.example.com',
      rightsEvidenceRef: 'grant:manufacturer@cdn.example.com',
      exactProductMatch: true,
      qualityStatus: 'usable',
      commerceApproved: true,
      conflicts: [],
      verifiedAgainstJson: JSON.stringify({ runId, gtin: TEST_INPUT.gtin, name: TEST_INPUT.registerName }),
      verifiedAgainstHash: verifiedHash,
      declaredSourceType: 'manufacturer',
      candidateId: candidate.id,
    }).id;

    const bundle = bundleWithImage();
    bundle.imageCandidates[0].verifiedAssetId = assetId;
    const validation = validateTerminalSubmission(bundle, TEST_INPUT.gtin, wsId, runId);
    expect(validation.valid).toBe(true);

    const sink = { emitDomain: () => undefined } as unknown as PersistingExecutionEventSink;
    persistBundleAssets(runId, bundle, sink);

    // The bundle-persisted COPY keeps the exact candidate FK (round-11:
    // terminal persistence must not drop the round-10 relationship).
    const persisted = listPiAssetsByRun(runId).find((a) => a.id !== assetId);
    expect(persisted).toBeTruthy();
    expect(persisted?.candidateId).toBe(candidate.id);
    expect(persisted?.sourceUrl).toBe('https://cdn.example.com/primary.jpg');
  });

  it('drops bundle image candidates that cite nothing durable (round-3 adversarial)', async () => {
    // The old bypass: an agent-manufactured image with plausible-looking
    // rights/hash/exact-match/commerce claims and NO verified record. It must
    // not persist as an approved asset.
    const executor = new FakePiExecutor();
    executor.submission = bundleWithImage(); // verifiedAssetIds: []
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT, mode: 'shadow' }, runOpts);
    await started.completed;
    const run = getPiRun(started.run.id);
    // Validation rejects the uncited primary, so the run fails and no asset
    // row is written.
    expect(run?.status).toBe('failed');
    expect(listPiAssetsByRun(started.run.id).length).toBe(0);
  });

  it('derives review signaling from the durable asset row, never the deprecated candidate fields (round-6 P1)', () => {
    // Round-6 (review P1): submissionNeedsReview/reviewReasons must read the
    // SERVER-RESOLVED asset row. Here the candidate's agent-supplied fields
    // CLAIM approved rights + exact match while the durable row is restricted.
    const runId = createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: TEST_INPUT.gtin, registerName: TEST_INPUT.registerName }),
      policyJson: '{}',
      configSnapshotId: 'seed',
      configSnapshotHash: 'seed',
    }).id;
    const source = insertPiSource({
      runId,
      url: 'https://cdn.example.com/primary.jpg',
      domain: 'cdn.example.com',
      sourceType: 'supplier',
      licenseRef: 'grant:supplier@cdn.example.com',
      termsRef: 'grant:supplier@cdn.example.com',
    });
    const assetId = insertPiAsset({
      runId,
      sourceId: source.id,
      sourceUrl: 'https://cdn.example.com/primary.jpg',
      sourceType: 'supplier',
      sourceArtifactId: 'a1',
      extractionMethod: 'image_ocr',
      retrievedAt: '2026-08-05T00:00:00.000Z',
      originalContentHash: 'b'.repeat(64),
      perceptualHash: 'phash-img-1',
      rightsStatus: 'restricted',
      rightsBasis: 'grant:supplier@cdn.example.com',
      rightsEvidenceRef: 'grant:supplier@cdn.example.com',
      exactProductMatch: true,
      exactVariantMatch: true,
      qualityStatus: 'usable',
      commerceApproved: false,
      conflicts: [],
      verifiedAgainstJson: JSON.stringify({ runId, gtin: TEST_INPUT.gtin, name: TEST_INPUT.registerName }),
      verifiedAgainstHash: canonicalVerifiedAgainstHash({ runId, gtin: TEST_INPUT.gtin, name: TEST_INPUT.registerName }),
      declaredSourceType: 'supplier',
    }).id;
    const bundle = bundleWithImage();
    bundle.imageCandidates[0].verifiedAssetId = assetId;
    // The candidate still claims supplier_authorized/exact (deprecated fields).
    const result = {
      schemaVersion: 1,
      gtin: TEST_INPUT.gtin,
      inputName: TEST_INPUT.registerName,
      outcome: 'submitted' as const,
      submission: bundle,
    } as unknown as ProductResearchResult;
    expect(submissionNeedsReview(result)).toBe(true);
    expect(reviewReasons(result).join(' ')).toContain('durable asset rights');

    // Negative: agent fields CLAIM unknown/not-exact but the durable row is
    // approved + exact — no review is triggered by the image.
    insertPiAsset({
      runId,
      sourceId: source.id,
      sourceUrl: 'https://cdn.example.com/primary.jpg',
      sourceType: 'supplier',
      sourceArtifactId: 'a2',
      extractionMethod: 'image_ocr',
      retrievedAt: '2026-08-05T00:00:00.000Z',
      originalContentHash: 'b'.repeat(64),
      perceptualHash: 'phash-img-2',
      rightsStatus: 'approved',
      rightsBasis: 'grant:supplier@cdn.example.com',
      rightsEvidenceRef: 'grant:supplier@cdn.example.com',
      exactProductMatch: true,
      exactVariantMatch: true,
      qualityStatus: 'usable',
      commerceApproved: true,
      conflicts: [],
      verifiedAgainstJson: JSON.stringify({ runId, gtin: TEST_INPUT.gtin, name: TEST_INPUT.registerName }),
      verifiedAgainstHash: canonicalVerifiedAgainstHash({ runId, gtin: TEST_INPUT.gtin, name: TEST_INPUT.registerName }),
      declaredSourceType: 'supplier',
    });
    const approvedId = listPiAssetsByRun(runId).find((a) => a.sourceArtifactId === 'a2')!.id;
    const approvedBundle = bundleWithImage();
    approvedBundle.imageCandidates[0].verifiedAssetId = approvedId;
    approvedBundle.imageCandidates[0].rightsStatus = 'unknown';
    approvedBundle.imageCandidates[0].exactProductMatch = false;
    const approvedResult = {
      schemaVersion: 1,
      gtin: TEST_INPUT.gtin,
      inputName: TEST_INPUT.registerName,
      outcome: 'submitted' as const,
      submission: approvedBundle,
    } as unknown as ProductResearchResult;
    // The row is approved + exact — the lying candidate fields do NOT trigger
    // review.
    expect(submissionNeedsReview(approvedResult)).toBe(false);
  });

  it('does not review-signal comparison assets on rights — binding still applies (round-7 P1)', async () => {
    const runId = createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: TEST_INPUT.gtin, registerName: TEST_INPUT.registerName }),
      policyJson: '{}',
      configSnapshotId: 'seed',
      configSnapshotHash: 'seed',
    }).id;
    const source = insertPiSource({
      runId,
      url: 'https://cdn.example.com/cmp.jpg',
      domain: 'cdn.example.com',
      sourceType: 'retailer',
    });
    // Comparison asset: restricted rights (never a commerce asset) but durably
    // bound to this run + identity.
    const cmpId = insertPiAsset({
      runId,
      sourceId: source.id,
      sourceUrl: 'https://cdn.example.com/cmp.jpg',
      sourceType: 'retailer',
      sourceArtifactId: 'cmp',
      extractionMethod: 'image_ocr',
      retrievedAt: '2026-08-05T00:00:00.000Z',
      originalContentHash: 'c'.repeat(64),
      perceptualHash: 'phash-cmp',
      rightsStatus: 'restricted',
      exactProductMatch: true,
      exactVariantMatch: true,
      qualityStatus: 'usable',
      commerceApproved: false,
      conflicts: [],
      verifiedAgainstJson: JSON.stringify({ runId, gtin: TEST_INPUT.gtin, name: TEST_INPUT.registerName }),
      verifiedAgainstHash: canonicalVerifiedAgainstHash({ runId, gtin: TEST_INPUT.gtin, name: TEST_INPUT.registerName }),
      declaredSourceType: 'retailer',
    }).id;
    const bundle = bundleWithImage();
    bundle.imageCandidates[0].verifiedAssetId = cmpId;
    bundle.imageCandidates[0].role = 'comparison';
    const result = {
      schemaVersion: 1,
      gtin: TEST_INPUT.gtin,
      inputName: TEST_INPUT.registerName,
      outcome: 'submitted' as const,
      submission: bundle,
    } as unknown as ProductResearchResult;
    // Restricted rights on a comparison asset is NOT a review reason.
    expect(submissionNeedsReview(result)).toBe(false);
    expect(reviewReasons(result)).not.toContain(expect.stringContaining('rights'));

    // Binding still applies: an unresolvable comparison citation flags review.
    const unresolvable = bundleWithImage();
    unresolvable.imageCandidates[0].role = 'comparison';
    unresolvable.imageCandidates[0].verifiedAssetId = '00000000-0000-0000-0000-000000000000';
    const result2 = {
      schemaVersion: 1,
      gtin: TEST_INPUT.gtin,
      inputName: TEST_INPUT.registerName,
      outcome: 'submitted' as const,
      submission: unresolvable,
    } as unknown as ProductResearchResult;
    expect(submissionNeedsReview(result2)).toBe(true);
    expect(reviewReasons(result2).join(' ')).toContain('does not resolve');
  });

  it('enforces retention policy (terminal only, older than cutoff)', async () => {
    const executor = new FakePiExecutor();
    const started = await startProductIntelligenceRun(executor, { input: TEST_INPUT }, runOpts);
    await started.completed;
    const db = getDb();
    db.run('UPDATE product_intelligence_runs SET started_at = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', started.run.id]);
    const deleted = runRetentionCleanup(wsId, 30);
    expect(deleted).toBe(1);
    expect(getPiRun(started.run.id)).toBeFalsy();
    expect(listPiEvents(started.run.id)).toHaveLength(0); // cascade
  });

  it('rejects runs when no workspace exists', async () => {
    const executor = new FakePiExecutor();
    // Force the workspace lookup off by passing a workspace that does not exist.
    await expect(
      startProductIntelligenceRun(executor, { input: TEST_INPUT }, { workspaceId: 'missing-ws', workspacePath: '/tmp/nope' }),
    ).rejects.toThrow(/workspace/i);
  });

  it('keeps the default policy immutable and self-hashed', () => {
    const a = buildDefaultPiPolicy();
    const b = buildDefaultPiPolicy();
    expect(a.configId).toMatch(/^[a-f0-9]{64}$/);
    expect(a.configId).toBe(b.configId);
    expect(a.modelRoute).toBeNull();
    expect(a.allowedTools).toEqual([]); // worker isolation: no host-file tools
    expect(a.networkPolicy).toBe('allowlisted_remote');
  });
});
