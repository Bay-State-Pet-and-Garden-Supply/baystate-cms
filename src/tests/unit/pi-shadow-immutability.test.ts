/**
 * PI-9 shadow-mode immutability test (issue #26 acceptance: shadow runs
 * cannot mutate onboarding or catalog state; tests prove shadow mode cannot
 * import, promote, or publish).
 *
 * DB-backed (bun test).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createPiRun, insertPiResult, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { importRunToOnboarding } from '../../product-intelligence/onboarding-import';
import {
  DEFAULT_PRODUCT_INTELLIGENCE_FLAGS,
  overrideProductIntelligenceFlags,
} from '../../product-intelligence/flags';
import { createExecutionRouter } from '../../product-intelligence/execution-router';
import { PiProductIntelligenceExecutor } from '../../product-intelligence/pi/pi-executor';
import { LegacyProductIntelligenceExecutor } from '../../product-intelligence/legacy-executor';

const workspaceId = 'ws-pi-shadow-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

function makeShadowRun(): string {
  const run = createPiRun({
    workspaceId,
    mode: 'shadow',
    executor: 'pi',
    inputJson: JSON.stringify({ gtin: '085000079585', registerName: 'STELLA CHKN BROTH 16OZ' }),
    policyJson: JSON.stringify({ configId: 'c' }),
    configSnapshotId: 'c',
    configSnapshotHash: 'c',
  });
  insertPiResult({
    runId: run.id,
    schemaVersion: 1,
    disposition: 'submitted',
    result: {
      schemaVersion: 1,
      gtin: '085000079585',
      inputName: 'STELLA CHKN BROTH 16OZ',
      identity: { gtinMatch: 'exact' },
      evidenceItems: [],
      evidenceSources: [],
      productProposal: { fields: [{ field: 'title', value: 'Proposed Title' }] },
      abstention: false,
    },
  });
  transitionPiRunStatus(run.id, 'completed', {});
  return run.id;
}

describe('PI-9 shadow mode immutability', () => {
  let wsPath: string;
  let existingItems: number;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
    // One normal item exists before the shadow run.
    const batch = createBatch({ workspaceId, name: 'seed', fileName: 'seed.csv', totalItems: 1, columnMappingJson: '{}' });
    insertItems(batch.id, [{ upc: '085000079585', name: 'Seed Item', rowNumber: 1 }]);
    existingItems = (getDb().query('SELECT COUNT(*) AS c FROM onboarding_items').get() as { c: number }).c;
    overrideProductIntelligenceFlags({
      ...DEFAULT_PRODUCT_INTELLIGENCE_FLAGS,
      productIntelligenceEnabled: true,
      piEnabled: true,
      shadowOnly: true,
      allowOnboardingImport: true,
    });
  });

  afterEach(() => {
    overrideProductIntelligenceFlags(DEFAULT_PRODUCT_INTELLIGENCE_FLAGS);
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('a shadow run executes but cannot import (service + route level)', async () => {
    const runId = makeShadowRun();
    const itemsAfter = (getDb().query('SELECT COUNT(*) AS c FROM onboarding_items').get() as { c: number }).c;
    expect(itemsAfter).toBe(existingItems); // the run itself mutated nothing

    // Service level: import refuses in shadow mode.
    expect(() => importRunToOnboarding(runId, { mode: 'create' })).toThrow(/shadowOnly/);

    // Route level: 403.
    const { default: app } = await import('../../server/app');
    const response = await app.request(`http://localhost/api/product-intelligence/runs/${runId}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'create' }),
    });
    expect(response.status).toBe(403);

    // No imports, no new batches, no catalog writes.
    expect((getDb().query('SELECT COUNT(*) AS c FROM product_intelligence_imports').get() as { c: number }).c).toBe(0);
    const itemsFinal = (getDb().query('SELECT COUNT(*) AS c FROM onboarding_items').get() as { c: number }).c;
    expect(itemsFinal).toBe(existingItems);
    const batches = (getDb().query('SELECT COUNT(*) AS c FROM onboarding_batches').get() as { c: number }).c;
    expect(batches).toBe(1);
  });

  it('the same run becomes importable when shadow mode is lifted (import gate is the boundary)', () => {
    const runId = makeShadowRun();
    expect(() => importRunToOnboarding(runId, { mode: 'create' })).toThrow(/shadowOnly/);
    overrideProductIntelligenceFlags({
      ...DEFAULT_PRODUCT_INTELLIGENCE_FLAGS,
      productIntelligenceEnabled: true,
      piEnabled: true,
      shadowOnly: false,
      allowOnboardingImport: true,
    });
    const result = importRunToOnboarding(runId, { mode: 'create' });
    expect(result.created).toBe(true);
    expect((getDb().query('SELECT COUNT(*) AS c FROM product_intelligence_imports').get() as { c: number }).c).toBe(1);
  });

  it('the kill switch routes execution back to legacy (shadow or not)', async () => {
    const legacy = new LegacyProductIntelligenceExecutor();
    const router = createExecutionRouter({
      legacy,
      pi: new PiProductIntelligenceExecutor({ sessionFactory: {} as never }),
      flags: () => ({ ...DEFAULT_PRODUCT_INTELLIGENCE_FLAGS, productIntelligenceEnabled: true, piEnabled: true }),
    });
    process.env.BAYSTATE_CMS_PI_KILL_SWITCH = 'true';
    const selection = await router.resolveExecutor();
    expect(selection.name).toBe('legacy');
    expect(selection.reason).toContain('kill_switch');
    delete process.env.BAYSTATE_CMS_PI_KILL_SWITCH;
  });
});
