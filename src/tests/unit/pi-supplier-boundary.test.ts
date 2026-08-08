/**
 * Round-12 (review P0-1): supplier authority is NEVER selected by tool name.
 *
 * The reviewer's regression: onboarding_sources has no source_kind column, so
 * lookup_supplier_product previously DROPPED the kind predicate and emitted
 * supplier_evidence for EVERY workspace-matching onboarding source of the
 * requested UPC — an ordinary Serper/sitemap/retailer source became durable
 * sourceType=supplier via the event sink, and a supplier reuse grant could
 * authorize its assets.
 *
 * These tests pin the fail-closed contract:
 *   - supplier/distributor lookups return LEADS (catalog_evidence) only —
 *     same-GTIN and cross-GTIN alike;
 *   - the evidence-kind -> tier mapping never mints the supplier tier
 *     (supplier_evidence -> 'other');
 *   - the workspace + GTIN boundary from round-11 still holds.
 *
 * Trusted supplier authority can only come from a durable
 * pi_source_authorities record referencing an actual CMS supplier record
 * (not yet wired).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertSources } from '../../db/repositories/onboarding-source-repo';
import {
  createPiRun,
  listPiSources,
  transitionPiRunStatus,
} from '../../db/repositories/product-intelligence-repo';
import { upsertReusePolicy, buildReuseGrantResolver } from '../../db/repositories/pi-reuse-policy-repo';
import { persistToolEvidence } from '../../product-intelligence/run-service';
import { defaultToolRegistry } from '../../product-intelligence/tools';
import { testPolicy } from './product-intelligence/test-helpers';
import type { PiToolResult } from '../../product-intelligence/tools/contract';

const GTIN = '036000291452';
const wsIdA = 'pi-supplier-boundary-workspace-a';
const wsIdB = 'pi-supplier-boundary-workspace-b';

describe('PI supplier authority boundary (round-12 P0-1)', () => {
  let itemIdA: string;
  let itemIdB: string;

  beforeAll(() => {
    try {
      resetDb();
    } catch {
      /* ok */
    }
    initDb(path.resolve(import.meta.dirname, 'pi-supplier-boundary-test.db'));
    runMigrations();
    insertWorkspace({
      id: wsIdA,
      name: 'Supplier Boundary A',
      workspacePath: '/tmp/pi-supplier-boundary-a',
      gitPath: '/tmp/pi-supplier-boundary-a/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    insertWorkspace({
      id: wsIdB,
      name: 'Supplier Boundary B',
      workspacePath: '/tmp/pi-supplier-boundary-b',
      gitPath: '/tmp/pi-supplier-boundary-b/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    // Ordinary discovery provenance (the schema default: source_method
    // 'serper') — exactly the reviewer's fixture: a plain Serper source with
    // no supplier discriminator of any kind.
    const batchA = createBatch({ workspaceId: wsIdA, name: 'B A', fileName: 'a.csv', totalItems: 1 });
    const [itemA] = insertItems(batchA.id, [{ upc: GTIN, name: 'Stella Chicken Broth', rowNumber: 1 }]);
    itemIdA = itemA.id;
    insertSources(itemIdA, [
      { url: 'https://retailer.example.com/p/stella-16oz', domain: 'retailer.example.com', title: 'Stella Chicken Broth 16 oz', confidence: 0.9, sourceMethod: 'serper' },
    ]);

    // Workspace B holds an identical-GTIN source: cross-workspace reads must
    // be impossible.
    const batchB = createBatch({ workspaceId: wsIdB, name: 'B B', fileName: 'b.csv', totalItems: 1 });
    const [itemB] = insertItems(batchB.id, [{ upc: GTIN, name: 'Stella Chicken Broth', rowNumber: 1 }]);
    itemIdB = itemB.id;
    insertSources(itemIdB, [
      { url: 'https://other-workspace.example.com/p/stella', domain: 'other-workspace.example.com', title: 'Stella 16 oz', confidence: 0.8, sourceMethod: 'serper' },
    ]);
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(path.resolve(import.meta.dirname, 'pi-supplier-boundary-test.db'));
    } catch {
      /* ok */
    }
  });

  function makeRun(workspaceId: string, gtin = GTIN) {
    const run = createPiRun({
      workspaceId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin, registerName: 'Stella Chicken Broth 16 oz' }),
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    });
    return run.id;
  }

  const toolCtx = (runId: string, workspaceId: string) => ({
    runId,
    workspaceId,
    workspacePath: '/tmp/pi-supplier-boundary-workspace',
    policy: testPolicy({}),
    signal: new AbortController().signal,
    remainingMs: 60_000,
  });

  it('an ordinary serper onboarding source in the same workspace yields LEADS, never supplier authority (reviewer regression)', async () => {
    const rid = makeRun(wsIdA);
    const result = (await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('lookup_supplier_product')!,
      { gtin: GTIN },
      toolCtx(rid, wsIdA),
    )) as PiToolResult;
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const data = result.data as { leadOnly?: boolean; crossGtinLead?: boolean; sources: unknown[] };
    expect(data.sources.length).toBe(1);
    expect(data.leadOnly).toBe(true);
    expect(data.crossGtinLead).toBe(false); // same-GTIN is still a lead
    // Evidence kind: NEVER supplier_evidence.
    expect(result.evidence.length).toBe(1);
    for (const entry of result.evidence) {
      expect(entry.kind).toBe('catalog_evidence');
    }
    // The event sink path: persisting the returned evidence must NOT create
    // a supplier-tier source row.
    persistToolEvidence(rid, result.evidence, () => undefined);
    const sources = listPiSources(rid);
    expect(sources.length).toBe(1);
    // catalog_evidence maps to the neutral 'catalog' tier — never supplier.
    expect(sources[0].sourceType).toBe('catalog');
    expect(sources[0].sourceType).not.toBe('supplier');
    // The neutral tier never satisfies a supplier grant.
    expect(buildReuseGrantResolver(wsIdA)('catalog', 'retailer.example.com')).toBeNull();
    transitionPiRunStatus(rid, 'completed', {});
  });

  it('a supplier reuse grant never applies to the neutral lead tier', async () => {
    const rid = makeRun(wsIdA);
    upsertReusePolicy({
      workspaceId: wsIdA,
      sourceTier: 'supplier',
      domainPattern: 'retailer.example.com',
      allowed: true,
      terms: 'vendor license',
    });
    // The lead tier is 'other' — a supplier grant is never consulted for it.
    const grantForOther = buildReuseGrantResolver(wsIdA)('other', 'retailer.example.com');
    expect(grantForOther).toBeNull();
    // And no supplier-tier grant exists for any tier produced by the tool.
    expect(buildReuseGrantResolver(wsIdA)('supplier', 'retailer.example.com')?.sourceTier).toBe('supplier');
    expect(buildReuseGrantResolver(wsIdA)('catalog', 'retailer.example.com')).toBeNull();
    transitionPiRunStatus(rid, 'completed', {});
  });

  it('cross-workspace sources are invisible (round-11 boundary preserved)', async () => {
    const rid = makeRun(wsIdA);
    const result = (await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('lookup_supplier_product')!,
      { gtin: GTIN },
      toolCtx(rid, wsIdA),
    )) as PiToolResult;
    // The workspace-B source is the only same-GTIN source besides workspace
    // A's — workspace A still sees exactly its own source, and a run in B
    // sees exactly B's.
    const resultB = (await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('lookup_supplier_product')!,
      { gtin: GTIN },
      toolCtx(makeRun(wsIdB), wsIdB),
    )) as PiToolResult;
    expect(resultB.status).toBe('ok');
    if (resultB.status === 'ok') {
      const dataB = resultB.data as { sources: unknown[] };
      expect(dataB.sources.length).toBe(1);
      expect((dataB.sources[0] as { url: string }).url).toBe('https://other-workspace.example.com/p/stella');
    }
    // Workspace A sees exactly its own source (the B source is invisible).
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const dataA = result.data as { sources: unknown[] };
      expect(dataA.sources.length).toBe(1);
      expect((dataA.sources[0] as { url: string }).url).toBe('https://retailer.example.com/p/stella-16oz');
    }
    transitionPiRunStatus(rid, 'completed', {});
  });

  it('cross-GTIN exploration stays a lead with the flag set', async () => {
    const rid = makeRun(wsIdA);
    const OTHER = '012345678905';
    // Seed a SEPARATE item with the OTHER upc in workspace A so the lookup
    // returns rows without mutating the GTIN-matched fixture.
    const batchA2 = createBatch({ workspaceId: wsIdA, name: 'B A2', fileName: 'a2.csv', totalItems: 1 });
    const [itemOther] = insertItems(batchA2.id, [{ upc: OTHER, name: 'Other product', rowNumber: 1 }]);
    insertSources(itemOther.id, [
      { url: 'https://other-upc.example.com/p/x', domain: 'other-upc.example.com', title: 'Other product', confidence: 0.5, sourceMethod: 'serper' },
    ]);
    const result = (await defaultToolRegistry.dispatch(
      defaultToolRegistry.get('lookup_distributor_product')!,
      { gtin: OTHER },
      toolCtx(rid, wsIdA),
    )) as PiToolResult;
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const data = result.data as { crossGtinLead?: boolean; leadOnly?: boolean; warning?: string };
      expect(data.crossGtinLead).toBe(true);
      expect(data.leadOnly).toBe(true);
      expect(data.warning).toContain('differs from the run');
      for (const entry of result.evidence) {
        expect(entry.kind).toBe('catalog_evidence');
      }
    }
    transitionPiRunStatus(rid, 'completed', {});
  });

  it('sourceTypeOfKind: supplier_evidence maps to the neutral tier, never supplier', async () => {
    const rid = makeRun(wsIdA);
    // Whatever future path emits a supplier_evidence kind, the durable tier
    // is neutral 'other' — evidence kind alone never mints supplier.
    persistToolEvidence(
      rid,
      [
        {
          id: 'ev:supplier-evidence-fact',
          kind: 'supplier_evidence',
          url: 'https://vendor.example.com/p/stella',
          domain: 'vendor.example.com',
          method: 'supplier_source_lookup',
        },
      ],
      () => undefined,
    );
    const sources = listPiSources(rid);
    expect(sources.length).toBe(1);
    expect(sources[0].sourceType).toBe('other');
    expect(sources[0].sourceType).not.toBe('supplier');
    transitionPiRunStatus(rid, 'completed', {});
  });
});
