import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { closeDb, initDb, resetDb } from '../../../db/connection';
import { runMigrations } from '../../../db/migrations';
import { insertWorkspace } from '../../../db/repositories/workspace-repo';
import { createPiRun, getPiRun } from '../../../db/repositories/product-intelligence-repo';
import { buildDefaultPiPolicy, startProductIntelligenceRun } from '../../../product-intelligence/run-service';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from '../../../product-intelligence/executor';
import type { ProductResearchContext, ProductResearchInput, ProductResearchResult } from '../../../product-intelligence/contracts';

const dbPath = path.resolve(import.meta.dirname, 'product-seed-persistence.db');
const workspaceId = 'product-seed-persistence-workspace';

describe('ProductSeed run persistence (#50)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* test process may not have an open db */ }
    initDb(dbPath);
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'Product Seed Persistence',
      workspacePath: '/tmp/product-seed-persistence',
      gitPath: '/tmp/product-seed-persistence/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });
  afterAll(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it('starts a v2 seed with explicit discovered GTIN compatibility and keeps seed/context separately inspectable', async () => {
    const executor: ProductIntelligenceExecutor = {
      name: 'legacy',
      version: '1.0.0',
      async startResearch(input: ProductResearchInput, context: ProductResearchContext, events: ExecutionEventSink): Promise<ProductResearchResult> {
        expect(input.gtin).toBe('036000291452');
        events.emit('run_started', { data: { seedSku: 'SUP-2' } });
        return {
          runId: context.runId,
          outcome: 'unavailable',
          executor: 'legacy',
          executorVersion: '1.0.0',
          extensionVersions: [],
          configId: context.policy.configId,
          durationMs: 0,
          submission: null,
          failure: null,
          events: events.snapshot(),
        };
      },
    };
    const started = await startProductIntelligenceRun(executor, {
      input: { gtin: '036000291452', registerName: 'Treats', price: '2.5' },
      productSeed: { sku: 'SUP-2', name: 'Treats', price: 2.5 },
      batchContext: { schemaVersion: 1, authoritative: false, batchId: 'b2', siblingSkus: [], hints: {} },
      policy: buildDefaultPiPolicy(),
    }, { workspaceId, workspacePath: '/tmp/product-seed-persistence' });
    await started.completed;
    expect(getPiRun(started.run.id)?.inputSchemaVersion).toBe(2);
    expect(JSON.parse(getPiRun(started.run.id)?.productSeedJson ?? '{}').sku).toBe('SUP-2');
  });

  it('keeps v2 seed and batch context separately inspectable while old input remains replayable', () => {
    const run = createPiRun({
      workspaceId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ productSeed: { sku: 'SUP-1', name: 'Treats', price: 2.5 } }),
      productSeedJson: JSON.stringify({ sku: 'SUP-1', name: 'Treats', price: 2.5 }),
      batchContextJson: JSON.stringify({ schemaVersion: 1, authoritative: false, batchId: 'b1' }),
      inputSchemaVersion: 2,
      policyJson: '{}',
      configSnapshotId: 'seed',
      configSnapshotHash: 'seed',
    });
    expect(run.inputSchemaVersion).toBe(2);
    expect(JSON.parse(run.productSeedJson ?? '{}')).toEqual({ sku: 'SUP-1', name: 'Treats', price: 2.5 });
    expect(JSON.parse(run.batchContextJson ?? '{}').authoritative).toBe(false);
    expect(getPiRun(run.id)?.productSeedJson).toBe(run.productSeedJson);
  });
});
