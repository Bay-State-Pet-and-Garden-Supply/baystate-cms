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
} from '../../classification/runtime-snapshot';
import type { RuntimeSnapshotInput } from '../../classification/runtime-snapshot';
import type { RuntimeConfigAuthority } from '../../classification/config-loader';
import type { CatalogEvidence } from '../../classification/catalog-evidence';

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
});
