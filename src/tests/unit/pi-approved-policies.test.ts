/**
 * P0-2 review remediation: server-authoritative, immutable/versioned approved
 * execution policies + strictly-reducing override lattice.
 *
 * DB-backed (bun test). Covers the pi_approved_policies migration, the
 * versioning/seeding semantics of the repository, the reduction lattice in
 * src/product-intelligence/policy, and configId round-tripping.
 *
 * @see docs/pi-review-remediation.md (P0-2)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createApprovedPolicyVersion,
  getActiveApprovedPolicy,
  getActiveDefaultApprovedPolicy,
  getApprovedPolicyById,
  isApprovedPolicyActive,
  isApprovedPolicyRecordActive,
  listApprovedPolicies,
  seedDefaultApprovedPolicy,
} from '../../db/repositories/pi-approved-policy-repo';
import {
  assertReducingOverride,
  computePolicyConfigId,
  verifyPolicySnapshot,
} from '../../product-intelligence/policy';
import { seedDefaultApprovedPolicyForWorkspace } from '../../server/services/migration-service';
import { buildDefaultPiPolicy } from '../../product-intelligence/run-service';
import { ProductIntelligencePolicySchema } from '../../product-intelligence/contracts';

const workspaceId = 'ws-pi-approved-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

describe('P0-2 approved policies', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-approved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('creates the pi_approved_policies table during migration', () => {
    const row = getDb()
      .query("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'pi_approved_policies'")
      .get() as { c: number };
    expect(row.c).toBe(1);
  });

  it('seeds the workspace default idempotently', () => {
    const policy = buildDefaultPiPolicy();
    const first = seedDefaultApprovedPolicy(workspaceId, JSON.stringify(policy), policy.configId);
    const second = seedDefaultApprovedPolicy(workspaceId, JSON.stringify(policy), policy.configId);
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(1);
    expect(second.active).toBe(1);
    expect(listApprovedPolicies(workspaceId).length).toBe(1);
  });

  it('creates immutable versions: a new version deactivates the previous one', () => {
    const p1 = buildDefaultPiPolicy();
    seedDefaultApprovedPolicy(workspaceId, JSON.stringify(p1), p1.configId);
    const p2 = computePolicyConfigId({ ...p1, maxToolCalls: 50 });
    const v2 = createApprovedPolicyVersion(workspaceId, 'default', JSON.stringify(p2), p2.configId);

    expect(v2.version).toBe(2);
    expect(v2.active).toBe(1);
    const rows = listApprovedPolicies(workspaceId);
    expect(rows.length).toBe(2);
    const v1row = rows.find((r) => r.version === 1);
    expect(v1row?.active).toBe(0);
    expect(v1row?.policyJson).toBe(JSON.stringify(p1)); // immutable: unchanged
    expect(getActiveApprovedPolicy(workspaceId)?.version).toBe(2);
  });

  it('isApprovedPolicyActive only returns true for the active configId', () => {
    const p1 = buildDefaultPiPolicy();
    seedDefaultApprovedPolicy(workspaceId, JSON.stringify(p1), p1.configId);
    const p2 = computePolicyConfigId({ ...p1, maxToolCalls: 50 });
    createApprovedPolicyVersion(workspaceId, 'default', JSON.stringify(p2), p2.configId);

    expect(isApprovedPolicyActive(workspaceId, p1.configId)).toBe(false); // superseded
    expect(isApprovedPolicyActive(workspaceId, p2.configId)).toBe(true);
    expect(isApprovedPolicyActive(workspaceId, 'unknown-config')).toBe(false);
  });

  it('looks a policy record up by id within the workspace', () => {
    const policy = buildDefaultPiPolicy();
    const seeded = seedDefaultApprovedPolicy(workspaceId, JSON.stringify(policy), policy.configId);
    const found = getApprovedPolicyById(workspaceId, seeded.id);
    expect(found?.id).toBe(seeded.id);
    expect(getApprovedPolicyById(workspaceId, 'no-such-id')).toBeUndefined();
  });

  it('resolves the active DEFAULT record explicitly (review finding 9)', () => {
    const policy = buildDefaultPiPolicy();
    const seeded = seedDefaultApprovedPolicy(workspaceId, JSON.stringify(policy), policy.configId);
    // A differently-named record must never shadow the default.
    createApprovedPolicyVersion(workspaceId, 'alt-policy', JSON.stringify(policy), `${policy.configId}-alt`);
    const active = getActiveDefaultApprovedPolicy(workspaceId);
    expect(active?.name).toBe('default');
    expect(active?.id).toBe(seeded.id);
    expect(getActiveApprovedPolicy(workspaceId)?.name).toBe('default');
  });

  it('isApprovedPolicyRecordActive checks the specific record+version (review finding 7)', () => {
    const policy = buildDefaultPiPolicy();
    const seeded = seedDefaultApprovedPolicy(workspaceId, JSON.stringify(policy), policy.configId);
    expect(isApprovedPolicyRecordActive(workspaceId, seeded.id, seeded.version)).toBe(true);
    expect(isApprovedPolicyRecordActive(workspaceId, 'no-such-id', 1)).toBe(false);
    // A superseded version is no longer active.
    const next = createApprovedPolicyVersion(workspaceId, 'default', JSON.stringify(policy), `${policy.configId}-v2`);
    expect(isApprovedPolicyRecordActive(workspaceId, seeded.id, seeded.version)).toBe(false);
    expect(isApprovedPolicyRecordActive(workspaceId, next.id, next.version)).toBe(true);
  });

  it('seeds the default approved policy for a new workspace at the server layer', () => {
    const wsId = 'ws-server-seed-test';
    seedWorkspace(wsId, wsPath);
    seedDefaultApprovedPolicyForWorkspace(wsId);
    const active = getActiveApprovedPolicy(wsId);
    expect(active?.name).toBe('default');
    expect(active?.active).toBe(1);
    // Idempotent: a second seed must not create a second record.
    seedDefaultApprovedPolicyForWorkspace(wsId);
    const rows = getDb()
      .query('SELECT COUNT(*) AS c FROM pi_approved_policies WHERE workspace_id = ?')
      .get(wsId) as { c: number };
    expect(rows.c).toBe(1);
  });

  it('accepts strictly-reducing overrides', () => {
    const base = buildDefaultPiPolicy();
    const merged = assertReducingOverride(base, { allowedTools: [], maxToolCalls: 50, deadlineMs: 10_000 });
    expect(merged.maxToolCalls).toBe(50);
    expect(merged.deadlineMs).toBe(10_000);
    expect(merged.allowedTools).toEqual([]);
    expect(merged.networkPolicy).toBe(base.networkPolicy);
  });

  it('accepts a more-restrictive dataSharingPolicy override', () => {
    const base = computePolicyConfigId({ ...buildDefaultPiPolicy(), dataSharingPolicy: 'cloud_models_only' });
    const merged = assertReducingOverride(base, { dataSharingPolicy: 'local_only' });
    expect(merged.dataSharingPolicy).toBe('local_only');
  });

  it('rejects allowlist growth', () => {
    const base = buildDefaultPiPolicy(); // allowedTools: []
    expect(() => assertReducingOverride(base, { allowedTools: ['read'] })).toThrow(/allowedTools override rejected/);
  });

  it('rejects numeric limit increases', () => {
    const base = buildDefaultPiPolicy(); // deadlineMs: 300_000
    expect(() => assertReducingOverride(base, { deadlineMs: 400_000 })).toThrow(/deadlineMs override rejected/);
    expect(() => assertReducingOverride(base, { maxToolCalls: 200 })).toThrow(/maxToolCalls override rejected/);
  });

  it('allows converting an unlimited maxCostUsd to a finite budget', () => {
    const base = buildDefaultPiPolicy(); // maxCostUsd: null (unlimited)
    const merged = assertReducingOverride(base, { maxCostUsd: 50 });
    expect(merged.maxCostUsd).toBe(50);
  });

  it('rejects raising a finite maxCostUsd (larger amount or null/unlimited)', () => {
    const base = computePolicyConfigId({ ...buildDefaultPiPolicy(), maxCostUsd: 50 });
    expect(() => assertReducingOverride(base, { maxCostUsd: 100 })).toThrow(/maxCostUsd override rejected/);
    expect(() => assertReducingOverride(base, { maxCostUsd: null })).toThrow(/maxCostUsd override rejected/);
    expect(() => assertReducingOverride(base, { maxCostUsd: 30 })).not.toThrow();
  });

  it('rejects network policy changes', () => {
    const base = buildDefaultPiPolicy(); // networkPolicy: allowlisted_remote
    expect(() => assertReducingOverride(base, { networkPolicy: 'local_only' })).toThrow(/networkPolicy override rejected/);
  });

  it('rejects modelRoute overrides entirely', () => {
    const base = buildDefaultPiPolicy(); // modelRoute: null
    expect(() =>
      assertReducingOverride(base, { modelRoute: { provider: 'opencode-go', model: 'glm-5.1', thinkingLevel: 'medium' } }),
    ).toThrow(/modelRoute is not caller-overridable/);
    expect(() => assertReducingOverride(base, { modelRoute: null })).toThrow(/modelRoute is not caller-overridable/);
  });

  it('rejects dataSharing loosening', () => {
    const base = buildDefaultPiPolicy(); // dataSharingPolicy: local_only
    expect(() => assertReducingOverride(base, { dataSharingPolicy: 'cloud_models_only' })).toThrow(
      /dataSharingPolicy override rejected/,
    );
  });

  it('rejects configId overrides', () => {
    const base = buildDefaultPiPolicy();
    expect(() => assertReducingOverride(base, { configId: 'forged' })).toThrow(/configId is not caller-overridable/);
  });

  it('computePolicyConfigId round-trips through verifyPolicySnapshot', () => {
    const withId = computePolicyConfigId(buildDefaultPiPolicy());
    expect(verifyPolicySnapshot(withId).valid).toBe(true);
    // Merged + rehashed policy also validates.
    const merged = assertReducingOverride(buildDefaultPiPolicy(), { maxToolCalls: 5 });
    const rehashed = computePolicyConfigId(ProductIntelligencePolicySchema.parse(merged));
    expect(verifyPolicySnapshot(rehashed).valid).toBe(true);
  });
});
