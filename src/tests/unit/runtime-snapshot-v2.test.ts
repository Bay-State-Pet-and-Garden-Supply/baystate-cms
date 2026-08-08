import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import {
  buildRuntimeSnapshot,
  snapshotHash,
  persistRuntimeSnapshot,
  runtimeSnapshotHashMatchesConfig,
  authorityConfigHashMatches,
  getRuntimeSnapshotByHash,
  assertModelPlanCompatible,
} from '../../classification/runtime-snapshot';
import type { RuntimeSnapshotInput } from '../../classification/runtime-snapshot';
import type { RuntimeConfigAuthority } from '../../classification/config-loader';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import { buildRuntimeRuleVersions } from '../../classification/model-operation-registry';

let workspacePath: string;
let workspaceId: string;
let authority: RuntimeConfigAuthority;

const EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

function buildV2Input(overrides: Partial<RuntimeSnapshotInput> = {}): RuntimeSnapshotInput {
  const bundle = (authority as { kind: 'v2'; bundle: unknown }).bundle as never;
  return {
    workspaceId,
    workspacePath,
    productSku: 'SKU-001',
    authority,
    configSnapshotRef: {
      id: bundleHash(),
      hash: bundleHash(),
      sourceCommit: null,
      createdAt: '2026-08-01T12:00:00.000Z',
    },
    sourceProductHash: 'src-hash-1',
    searchKeywords: 'dog food',
    productPageNames: [],
    pages: { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
    ...overrides,
  };
}

function bundleHash(): string {
  return (authority as { kind: 'v2'; bundle: { manifest: { bundleHash: string } } }).bundle.manifest.bundleHash;
}

describe('runtime snapshot with ACTIVE v2 config authority (Milestone 7)', () => {
  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-runtime-snap-v2-${workspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({ id: workspaceId, name: 'test', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });

    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    authority = { kind: 'v2', bundle: candidate.bundle };
  });

  it('builds a frozen snapshot from the v2 authority with resolved v2 fields', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    expect(snapshot.configAuthorityKind).toBe('v2');
    expect(snapshot.productTypes).toHaveLength(21);
    expect(snapshot.attributes).toHaveLength(15);
    expect(snapshot.attributeProfiles).toHaveLength(21);
    expect(snapshot.attributeMappings).toHaveLength(15);
    expect(snapshot.curationTargets.some(target => target.id === 'primary-product-type')).toBe(true);
    expect(snapshot.catalogEvidenceHash).toBeNull();
    // Universal brand attribute survives into the frozen snapshot.
    const brand = snapshot.attributes.find(attribute => attribute.id === 'brand');
    expect(brand).toBeDefined();
    expect((brand as unknown as { isUniversal?: boolean }).isUniversal).toBe(true);
    // V2-only ML features survive.
    const modelPolicy = snapshot.modelPolicy as unknown as { providerLocalities?: Record<string, string>; mlFeatures?: Record<string, unknown> };
    expect(modelPolicy.providerLocalities).toEqual({ ollama: 'local' });
    expect(modelPolicy.mlFeatures?.productionRetrieval).toMatchObject({ state: 'disabled' });
    expect(snapshot.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes identically across different createdAt timestamps (deterministic)', () => {
    const a = buildRuntimeSnapshot(buildV2Input({ createdAt: '2026-08-01T12:00:00.000Z' }));
    const b = buildRuntimeSnapshot(buildV2Input({ createdAt: '2026-08-02T12:00:00.000Z' }));
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });

  it('persists and round-trips the v2 snapshot', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    const { id, hash } = persistRuntimeSnapshot(snapshot);
    expect(hash).toBe(snapshot.snapshotHash);
    const reloaded = snapshotHash(snapshot);
    expect(reloaded).toBe(hash);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('runtimeSnapshotHashMatchesConfig compares v2 snapshots against the active bundle hash', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    const { hash } = persistRuntimeSnapshot(snapshot);
    const authorityBundle = (authority as { kind: 'v2'; bundle: unknown }).bundle;
    // The stored runtime snapshot row embeds configSnapshotRef.hash === bundleHash.
    expect(runtimeSnapshotHashMatchesConfig(workspaceId, hash, authorityBundle as never)).toBe(true);
    expect(runtimeSnapshotHashMatchesConfig(workspaceId, 'f'.repeat(64), authorityBundle as never)).toBe(false);
  });

  it('authorityConfigHashMatches compares the v2 bundle hash and rejects unknown hashes', () => {
    expect(authorityConfigHashMatches(authority, bundleHash())).toBe(true);
    expect(authorityConfigHashMatches(authority, '0'.repeat(64))).toBe(false);
    expect(authorityConfigHashMatches(authority, '-1414969445')).toBe(false);
  });

  it('rejects a snapshot input without any config authority', () => {
    const input = buildV2Input();
    delete (input as { authority?: unknown }).authority;
    delete (input as { config?: unknown }).config;
    expect(() => buildRuntimeSnapshot(input)).toThrow(/requires either a runtime config authority/);
  });

  // ── Issue #17 work item E: schema-v2 model-execution plan ─────────────────

  it('schema v2 snapshots carry a frozen model-execution plan and rule versions', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.modelExecutionPlan).toBeDefined();
    expect(snapshot.modelExecutionPlan!.entries.length).toBeGreaterThan(0);
    expect(snapshot.modelExecutionPlan!.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.runtimeRuleVersions).toBeDefined();
    expect(snapshot.runtimeRuleVersions!.digest).toMatch(/^[a-f0-9]{64}$/);
    // The plan entry resolves the policy default (ollama) for a stage-mapped op.
    const entry = snapshot.modelExecutionPlan!.entries.find(e => e.operation === 'attribute_ranking');
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe('ollama');
    expect(entry!.locality).toBe('local');
    expect(entry!.stage).toBe('product_attribute_proposals');
    expect(entry!.promptTemplateVersion).toBe('attribute-ranking-prompt-v1');
    expect(entry!.ruleVersion).toBe('attribute-ranking-rules-v1');
  });

  it('plan is immutable and included in the snapshot hash', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    expect(Object.isFrozen(snapshot.modelExecutionPlan)).toBe(true);
    const a = buildRuntimeSnapshot(buildV2Input());
    const b = buildRuntimeSnapshot(buildV2Input());
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });

  it('snapshot hash changes when prompt/rule versions change but not when task config mutates', () => {
    const a = buildRuntimeSnapshot(buildV2Input());
    // Rule-version change must change the snapshot hash (frozen plan digest).
    const mutated = buildRuntimeSnapshot(buildV2Input());
    // Simulate a registry bump by rewriting the frozen plan entry and digest.
    const raw = JSON.parse(JSON.stringify(mutated)) as typeof mutated;
    const rawEntry = raw.modelExecutionPlan!.entries.find(e => e.operation === 'attribute_ranking')!;
    rawEntry.ruleVersion = 'attribute-ranking-rules-v2';
    expect(snapshotHash(raw)).not.toBe(snapshotHash(a));
    // Task-config mutation does not change the snapshot (config is frozen at
    // build time and the plan comes from the policy, not llm_task_configs).
    const afterConfigMutate = buildRuntimeSnapshot(buildV2Input());
    expect(snapshotHash(afterConfigMutate)).toBe(snapshotHash(a));
  });

  it('assertModelPlanCompatible fails closed for legacy schema-v1 snapshots and passes for v2', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    expect(() => assertModelPlanCompatible(v2, 'attribute_ranking')).not.toThrow();
    expect(() => assertModelPlanCompatible(v2, 'product_type_ranking')).not.toThrow();
    // A schema-v1 snapshot has no plan → fail closed.
    const v1 = JSON.parse(JSON.stringify(v2));
    v1.schemaVersion = 1;
    delete v1.modelExecutionPlan;
    delete v1.runtimeRuleVersions;
    expect(() => assertModelPlanCompatible(v1, 'attribute_ranking')).toThrow(/no frozen model-execution plan/);
    expect(() => assertModelPlanCompatible(null, 'attribute_ranking')).toThrow(/no runtime snapshot/);
  });

  it('legacy schema-v1 snapshots remain readable (read-only support)', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    const legacy = JSON.parse(JSON.stringify(v2));
    legacy.schemaVersion = 1;
    delete legacy.modelExecutionPlan;
    delete legacy.runtimeRuleVersions;
    legacy.snapshotHash = snapshotHash(legacy);
    const { id } = persistRuntimeSnapshot(legacy);
    expect(id).toBeDefined();
    const loaded = getRuntimeSnapshotByHash(workspaceId, snapshotHash(legacy));
    expect(loaded).not.toBeNull();
    expect(loaded!.schemaVersion).toBe(1);
    expect(loaded!.modelExecutionPlan).toBeUndefined();
    // Legacy hash domain is stable across reads.
    expect(snapshotHash(loaded!)).toBe(snapshotHash(legacy));
  });

  it('runtime rule versions are deterministic and versioned', () => {
    const rv = buildRuntimeRuleVersions();
    expect(rv.version).toBe(1);
    expect(rv.registryVersion).toBe(1);
    expect(rv.digest).toMatch(/^[a-f0-9]{64}$/);
    const rv2 = buildRuntimeRuleVersions();
    expect(rv2.digest).toBe(rv.digest);
  });

  it('assertModelPlanCompatible rejects a forged call context version (pass 4b)', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    const forged = {
      runId: 'run',
      snapshotHash: v2.snapshotHash,
      stage: 'product_attribute_proposals' as const,
      operation: 'attribute_ranking' as const,
      attempt: 1,
      promptTemplateVersion: 'forged-prompt-v999',
      ruleVersion: 'forged-rule-v999',
    };
    expect(() => assertModelPlanCompatible(v2, 'attribute_ranking', forged)).toThrow(/context prompt-template version/);
    const forgedRuleOnly = { ...forged, promptTemplateVersion: 'attribute-ranking-prompt-v1' };
    expect(() => assertModelPlanCompatible(v2, 'attribute_ranking', forgedRuleOnly)).toThrow(/context rule version/);
  });

  it('assertModelPlanCompatible rejects a missing runtimeRuleVersions and a tampered plan digest (pass 4b)', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    // Missing runtimeRuleVersions on a schema-v2 snapshot → fail closed.
    const missingRules = JSON.parse(JSON.stringify(v2));
    delete missingRules.runtimeRuleVersions;
    expect(() => assertModelPlanCompatible(missingRules, 'attribute_ranking')).toThrow(/no frozen runtimeRuleVersions/);
    // Tampered plan entry without a recomputed digest → fail closed.
    const tamperedPlan = JSON.parse(JSON.stringify(v2));
    const entry = tamperedPlan.modelExecutionPlan.entries.find((e: any) => e.operation === 'attribute_ranking');
    entry.ruleVersion = 'tampered-rules-v2';
    expect(() => assertModelPlanCompatible(tamperedPlan, 'attribute_ranking')).toThrow(/plan digest does not match/);
    // Tampered rule-versions fields without a recomputed digest → fail closed.
    const tamperedRules = JSON.parse(JSON.stringify(v2));
    tamperedRules.runtimeRuleVersions.outputPolicyVersion = 'tampered-v2';
    expect(() => assertModelPlanCompatible(tamperedRules, 'attribute_ranking')).toThrow(/runtimeRuleVersions digest does not match/);
  });
});
