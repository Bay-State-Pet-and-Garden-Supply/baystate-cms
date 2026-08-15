import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { getEvidenceAttemptsForItem } from '../../db/repositories/onboarding-evidence-repo';
import { getAcceptedAttemptIdsForItem } from '../../db/repositories/onboarding-acceptance-repo';
import { createDistributor, createConnection } from '../../db/repositories/distributor-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import { normalizeGtin } from '../../onboarding/sourcing/contracts';
import type { SourcingEngine, SourcingGenerationRunResult } from '../../onboarding/sourcing/contracts';
import type { EvidenceLookupOutcome } from '../../shared/schemas/distributor-evidence';
import type { Workspace } from '../../shared/types';

/**
 * Observe mode (ADR 0014 Amendment A, MC): shadow distributor data
 * collection. Observation persists generation-scoped evidence attempts with
 * measured durationMs but NEVER writes conflicts, acceptances, decisions, or
 * stage transitions, and an observation failure NEVER becomes a Discovery
 * failure. Repeat polling does not duplicate.
 */
describe('Sourcing observe mode — bounded shadow observation (MC)', () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-observe-test-'));
    dbPath = path.join(tempDir, 'test.db');
    initDb(dbPath);
    runMigrations();
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'observe' });

    workspaceId = 'ws-observe';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Observe Workspace',
      workspacePath: tempDir,
      gitPath: path.join(tempDir, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
  });

  afterEach(() => {
    resetSourcingFlagsOverride();
    closeDb();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** Observe-mode imports enter Discovery; marker-v1 (current policy). */
  function makeDiscoveryItem(upc = '012345678901', name = 'Observed Product') {
    const batch = createBatch({ workspaceId, name: 'Observe Batch', fileName: 'obs.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc, name, rowNumber: 1 }], 'discovery', SOURCING_ENTRY_POLICY_VERSION);
    return item;
  }

  /** Fake engine that persists attempts through the real single writer (with
   *  measured durationMs) and returns a deterministic summary. */
  function makeObserveEngine(
    outcome: EvidenceLookupOutcome,
    opts: { identity?: Record<string, unknown>; errorCode?: string; count?: number } = {},
  ): SourcingEngine {
    // Real workspace connections (the evidence writer rejects foreign ids).
    const connectionIds: Record<string, string> = {};
    for (const providerId of ['phillips', 'unfi']) {
      createDistributor({ id: providerId, name: providerId, status: 'active' });
      connectionIds[providerId] = createConnection({ workspaceId, distributorId: providerId, connectorType: 'api' }).id;
    }
    return {
      runGeneration: async (req): Promise<SourcingGenerationRunResult> => {
        const count = opts.count ?? 1;
        const summaries: SourcingGenerationRunResult['attempts'] = [];
        for (let i = 0; i < count; i++) {
          const providerId = i === 0 ? 'phillips' : 'unfi';
          const identity =
            outcome === 'found'
              ? {
                  upc: normalizeGtin(req.upc),
                  name: 'Observed Product',
                  weight: i === 0 ? '10 lbs' : '20 lbs',
                  ...(opts.identity ?? {}),
                }
              : null;
          const attempt = (await import('../../db/repositories/onboarding-evidence-repo')).insertEvidenceAttempt({
            itemId: req.itemId,
            providerId,
            distributorConnectionId: connectionIds[providerId],
            lookupUpc: normalizeGtin(req.upc) ?? req.upc,
            outcome,
            confidence: outcome === 'found' ? 0.9 : 0,
            evidenceUrl: null,
            matchedFields: outcome === 'found' ? ['upc', 'name'] : [],
            identityJson: identity ? JSON.stringify(identity) : null,
            warningsJson: null,
            errorCode: outcome === 'source_error' ? (opts.errorCode ?? 'timeout') : null,
            errorMessage: outcome === 'source_error' ? 'provider timed out' : null,
            catalogVersion: 'v2026.3',
            observedAt: '2026-08-13T00:00:00.000Z',
            sourcingGenerationId: req.generationId,
            durationMs: 42,
          });
          summaries.push({
            attemptId: attempt.id,
            connectionId: `conn-${providerId}`,
            providerId,
            outcome,
            matchedIdentifier: null,
            errorCode: outcome === 'source_error' ? (opts.errorCode ?? 'timeout') : null,
          });
        }
        return { generationId: req.generationId, attempts: summaries, skipped: [] };
      },
    } as SourcingEngine;
  }

  function mutationSnapshot(itemId: string) {
    return {
      decision: getDb().query('SELECT sourcing_decision_json FROM onboarding_items WHERE id = ?').get(itemId) as { sourcing_decision_json: string | null },
      acceptances: getAcceptedAttemptIdsForItem(itemId),
      conflicts: (getDb().query('SELECT COUNT(*) AS c FROM onboarding_evidence_conflicts WHERE item_id = ?').get(itemId) as { c: number }).c,
      extractions: (getDb().query('SELECT COUNT(*) AS c FROM onboarding_extractions WHERE item_id = ?').get(itemId) as { c: number }).c,
      stage: (getDb().query('SELECT stage, stage_status FROM onboarding_items WHERE id = ?').get(itemId) as { stage: string; stage_status: string }),
    };
  }

  test('observe mode: found evidence persists attempts with durationMs but ZERO item/decision/acceptance/conflict/extraction mutation', async () => {
    const item = makeDiscoveryItem();
    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () => makeObserveEngine('found'));
    await worker.poll();

    const attempts = getEvidenceAttemptsForItem(item.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].durationMs).toBe(42);
    expect(attempts[0].outcome).toBe('found');

    const snap = mutationSnapshot(item.id);
    expect(snap.decision.sourcing_decision_json).toBeNull();
    expect(snap.acceptances).toEqual([]);
    expect(snap.conflicts).toBe(0);
    expect(snap.extractions).toBe(0);
    // Discovery still owns the item — observation never transitions it.
    expect(snap.stage.stage).toBe('discovery');
  });

  test('observe mode: conflicting evidence NEVER produces conflict rows or needs_input', async () => {
    const item = makeDiscoveryItem();
    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () => makeObserveEngine('found', { count: 2 }));
    await worker.poll();

    const attempts = getEvidenceAttemptsForItem(item.id);
    expect(attempts.length).toBe(2);
    expect(attempts.every((a) => a.durationMs === 42)).toBe(true);

    const snap = mutationSnapshot(item.id);
    expect(snap.conflicts).toBe(0);
    expect(snap.acceptances).toEqual([]);
    expect(snap.decision.sourcing_decision_json).toBeNull();
    expect(snap.stage.stage).toBe('discovery');
    expect(snap.stage.stage_status).not.toBe('needs_input');
  });

  test('observe mode: provider errors and timeouts never fail Discovery', async () => {
    const item = makeDiscoveryItem();
    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () => makeObserveEngine('source_error', { errorCode: 'timeout' }));
    await worker.poll();

    const attempts = getEvidenceAttemptsForItem(item.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('source_error');
    expect(attempts[0].errorCode).toBe('timeout');
    expect(attempts[0].durationMs).toBe(42);

    const snap = mutationSnapshot(item.id);
    expect(snap.decision.sourcing_decision_json).toBeNull();
    expect(snap.stage.stage).toBe('discovery');
  });

  test('observe mode: repeat polling does NOT duplicate attempts (idempotent, generation-scoped)', async () => {
    const item = makeDiscoveryItem();
    const engine = makeObserveEngine('found');
    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () => engine);

    await worker.poll();
    const afterFirst = getEvidenceAttemptsForItem(item.id).length;
    expect(afterFirst).toBe(1);

    // Second poll: the existing observation generation short-circuits.
    await worker.poll();
    const afterSecond = getEvidenceAttemptsForItem(item.id).length;
    expect(afterSecond).toBe(1);

    const generations = getDb().query('SELECT COUNT(*) AS c FROM sourcing_generations WHERE item_id = ?').get(item.id) as { c: number };
    expect(generations.c).toBe(1);
  });

  test('observe mode: an item without a usable identifier is skipped (no generation, no attempts)', async () => {
    const item = makeDiscoveryItem('NOT-A-GTIN');
    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () => makeObserveEngine('found'));
    await worker.poll();

    expect(getEvidenceAttemptsForItem(item.id).length).toBe(0);
    const generations = getDb().query('SELECT COUNT(*) AS c FROM sourcing_generations WHERE item_id = ?').get(item.id) as { c: number };
    expect(generations.c).toBe(0);
  });

  test('observe mode: marker-v0 (legacy) discovery items are NEVER observed', async () => {
    const batch = createBatch({ workspaceId, name: 'V0 Batch', fileName: 'v0.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678909', name: 'Legacy', rowNumber: 1 }], 'discovery');

    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () => makeObserveEngine('found'));
    await worker.poll();

    expect(getEvidenceAttemptsForItem(item.id).length).toBe(0);
    const generations = getDb().query('SELECT COUNT(*) AS c FROM sourcing_generations WHERE item_id = ?').get(item.id) as { c: number };
    expect(generations.c).toBe(0);
  });
});
