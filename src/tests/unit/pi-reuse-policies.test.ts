/**
 * P0-6 reuse grants (review remediation).
 *
 * Image reuse authorization is server-authoritative and independent of
 * source identity: a canonical vendor domain proves ORIGIN, never reuse
 * rights. Reuse requires a durable workspace-scoped grant matching the
 * declared source tier and the asset's domain; absence of a grant fails
 * closed. DB-backed (bun test).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  buildReuseGrantResolver,
  domainMatches,
  listReusePolicies,
  upsertReusePolicy,
} from '../../db/repositories/pi-reuse-policy-repo';

const workspaceId = 'ws-pi-reuse-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

describe('P0-6 reuse grants', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-reuse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('fails closed with no grants (default resolver denies everything)', () => {
    const resolver = buildReuseGrantResolver(workspaceId);
    expect(resolver('manufacturer', 'durvet.com')).toBeNull();
    expect(resolver('supplier', 'anywhere.example')).toBeNull();
    expect(listReusePolicies(workspaceId)).toHaveLength(0);
  });

  it('grants allow only the matching source tier and domain and return the grant record', () => {
    upsertReusePolicy({ workspaceId, sourceTier: 'manufacturer', domainPattern: 'durvet.com', allowed: true, terms: 'vendor license' });
    const resolver = buildReuseGrantResolver(workspaceId);
    const record = resolver('manufacturer', 'durvet.com');
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      allowed: true,
      sourceTier: 'manufacturer',
      domainPattern: 'durvet.com',
      terms: 'vendor license',
    });
    expect(typeof record!.grantId).toBe('string');
    expect(record!.grantId.length).toBeGreaterThan(0);
    // The grantId is the durable row id.
    expect(record!.grantId).toBe(listReusePolicies(workspaceId)[0].id);
    // Tier mismatch: a supplier asset is not covered by a manufacturer grant.
    expect(resolver('supplier', 'durvet.com')).toBeNull();
    // Domain mismatch.
    expect(resolver('manufacturer', 'other-site.com')).toBeNull();
  });

  it('supports wildcard and subdomain-suffix patterns case-insensitively', () => {
    upsertReusePolicy({ workspaceId, sourceTier: 'retailer', domainPattern: '*', allowed: true });
    expect(buildReuseGrantResolver(workspaceId)('retailer', 'anything.example')).not.toBeNull();
    expect(buildReuseGrantResolver(workspaceId)('manufacturer', 'anything.example')).toBeNull();

    upsertReusePolicy({ workspaceId, sourceTier: 'supplier', domainPattern: 'AcmeCdn.com', allowed: true });
    const cdnGrant = buildReuseGrantResolver(workspaceId)('supplier', 'cdn.acmecdn.com');
    expect(cdnGrant).not.toBeNull();
    expect(cdnGrant!.domainPattern).toBe('AcmeCdn.com');
    expect(buildReuseGrantResolver(workspaceId)('supplier', 'images.acmecdn.com')).not.toBeNull();
    expect(buildReuseGrantResolver(workspaceId)('supplier', 'evilacmecdn.com')).toBeNull();
  });

  it('upsert is idempotent and revocation (allowed=false) denies', () => {
    upsertReusePolicy({ workspaceId, sourceTier: 'manufacturer', domainPattern: 'durvet.com', allowed: true });
    upsertReusePolicy({ workspaceId, sourceTier: 'manufacturer', domainPattern: 'durvet.com', allowed: true });
    expect(listReusePolicies(workspaceId)).toHaveLength(1);
    upsertReusePolicy({ workspaceId, sourceTier: 'manufacturer', domainPattern: 'durvet.com', allowed: false, terms: 'revoked' });
    expect(buildReuseGrantResolver(workspaceId)('manufacturer', 'durvet.com')).toBeNull();
  });

  it('domainMatches covers exact, wildcard, and subdomain-suffix semantics', () => {
    expect(domainMatches('*', 'anything')).toBe(true);
    expect(domainMatches('Example.com', 'example.com')).toBe(true);
    expect(domainMatches('example.com', 'sub.example.com')).toBe(true);
    expect(domainMatches('example.com', 'badexample.com')).toBe(false);
    expect(domainMatches('example.com', 'other.com')).toBe(false);
  });
});
