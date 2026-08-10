import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeDb, getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { listRegistry } from '../../db/repositories/field-registry-repo';
import { getCachedAttributeMappings } from '../../db/repositories/classification-config-repo';
import { GitClient } from '../../git/git-client';
import { previewCandidate, activateBundle } from '../../classification/config-store';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import {
  applyFieldMappingEdits,
  FieldMappingEditError,
} from '../../classification/field-mapping-editor';
import {
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
} from '../../classification/config-loader';
import { sha256Hex } from '../../shared/stable-id';
import type { ClassificationConfigBundleV2 } from '../../shared/schemas/classification';

const REVIEWED_FIELDS = [
  'ProductField4', 'ProductField8', 'ProductField16', 'ProductField17',
  'ProductField18', 'ProductField19', 'ProductField20', 'ProductField21',
  'ProductField22', 'ProductField23', 'ProductField24', 'ProductField25',
  'ProductField26', 'ProductField27', 'ProductField28', 'ProductField29',
  'ProductField30', 'ProductField32',
];
const ARTIFACT_CONTENT = JSON.stringify({
  schemaVersion: 1,
  sourceTreeHash: 'm7'.repeat(32),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: REVIEWED_FIELDS.length, xmlFields: [...REVIEWED_FIELDS].sort() },
  fields: [],
  pages: [],
});
const EVIDENCE_HASH = sha256Hex(ARTIFACT_CONTENT);

let root: string;
let workspaceId: string;

function runGit(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

function evidenceWithFields(fields: string[]): CatalogEvidence {
  return {
    schemaVersion: 1,
    sourceTreeHash: '0'.repeat(64),
    productFileCount: 0,
    parseFailureCount: 0,
    parseFailures: [],
    fieldRegistry: { entryCount: fields.length, xmlFields: [...fields].sort() },
    fields: [...fields].sort().map(xmlField => ({
      xmlField,
      recordCount: 1,
      nonEmptyCount: 1,
      distinctValueCount: 1,
      distinctValueHash: '0'.repeat(64),
      delimiterEvidence: [],
    })),
    pages: [],
  };
}

async function freshWorkspace(): Promise<void> {
  workspaceId = randomUUID();
  root = fs.mkdtempSync(path.join(os.tmpdir(), `mapping-editor-${workspaceId.slice(0, 8)}`));
  fs.mkdirSync(path.join(root, 'store', 'classification'), { recursive: true });
  fs.mkdirSync(path.join(root, 'products'), { recursive: true });

  const dbPath = path.join(root, '.shopsite-cms', 'app.db');
  initDb(dbPath);
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: root,
    gitPath: path.join(root, '.git'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });

  const git = new GitClient(root);
  git.init();
  fs.writeFileSync(path.join(root, 'store', 'manifest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf-8');
  fs.writeFileSync(
    path.join(root, 'store', 'field-registry.json'),
    JSON.stringify({ entries: [...REVIEWED_FIELDS].sort().map(xmlField => ({ xmlField })) }),
    'utf-8',
  );
  runGit(['add', '--', 'store/manifest.json', 'store/field-registry.json']);
  runGit(['commit', '-m', 'seed catalog manifest']);

  const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
  const preview = previewCandidate(candidate.bundle, root, { catalogEvidence: ARTIFACT_CONTENT });
  if (!preview.hash) {
    throw new Error(`preview failed: ${preview.report.findings.map(f => f.code).join(', ')}`);
  }
  const activationContext = {
    catalogFields: REVIEWED_FIELDS,
    verifiedPageIds: ['page-1', 'page-2'],
    verifyCatalogEvidence: (input: { catalogEvidenceHash: string; sourceCatalogCommit: string }) => ({
      verified: input.catalogEvidenceHash === EVIDENCE_HASH && input.sourceCatalogCommit === runGit(['rev-parse', 'HEAD']),
      reason: 'test verifier',
    }),
  };
  await activateBundle(preview.hash, null, {
    workspacePath: root,
    workspaceId,
    activationContext: activationContext as never,
    catalogEvidenceHash: EVIDENCE_HASH,
    gitEnabled: true,
  });
}

function activeBundle(): ClassificationConfigBundleV2 {
  const authority = loadRuntimeConfigAuthority(root, createRuntimeActivationContext(root, workspaceId));
  if (authority.kind !== 'v2') {
    throw new Error('expected an active v2 authority');
  }
  return authority.bundle;
}

describe('field mapping editor (active v2 bundle)', () => {
  beforeAll(async () => {
    await freshWorkspace();
  });
  afterAll(() => closeDb());

  it('re-points a mapping (unmap + map) and keeps targets and the cache mirror in sync', () => {
    const before = activeBundle();
    expect(before.attributeMappings.find(m => m.attributeId === 'product-feature')?.catalogField).toBe('ProductField26');

    applyFieldMappingEdits(root, workspaceId, [
      { catalogField: 'ProductField26', attributeId: null },
      { catalogField: 'ProductField4', attributeId: 'product-feature' },
    ], { gitEnabled: false });

    const after = activeBundle();
    expect(after.attributeMappings.find(m => m.attributeId === 'product-feature')?.catalogField).toBe('ProductField4');
    expect(after.attributeMappings.some(m => m.catalogField === 'ProductField26')).toBe(false);
    expect(after.manifest.bundleHash).not.toBe(before.manifest.bundleHash);
    expect(after.manifest.fileVersions['mappings.json']).not.toBe(before.manifest.fileVersions['mappings.json']);
    expect(after.manifest.fileVersions['product-types.json']).toBe(before.manifest.fileVersions['product-types.json']);

    // Curation target for product-feature follows the mapping field.
    const featureTarget = after.curationTargets.find(t => t.kind === 'product_field' && t.attributeId === 'product-feature');
    expect(featureTarget?.catalogField).toBe('ProductField4');

    // Cache mirror (what draft-promoter reads) is refreshed with v2 rows.
    const cached = getCachedAttributeMappings(workspaceId);
    expect(cached.find(m => m.attributeId === 'product-feature')?.catalogField).toBe('ProductField4');
  });

  it('updates serialization on an existing mapping and re-binds file hashes', () => {
    const before = activeBundle();
    applyFieldMappingEdits(root, workspaceId, [
      {
        catalogField: 'ProductField24',
        attributeId: 'category',
        serialization: { kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' },
      },
    ], { gitEnabled: false });

    const after = activeBundle();
    const mapping = after.attributeMappings.find(m => m.attributeId === 'category')!;
    expect(mapping.serialization).toEqual({ kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' });
    expect(after.manifest.fileVersions['mappings.json']).not.toBe(before.manifest.fileVersions['mappings.json']);
    const cached = getCachedAttributeMappings(workspaceId);
    expect(cached.find(m => m.attributeId === 'category')?.serialization).toMatchObject({ kind: 'delimited', delimiter: '|' });
  });

  it('unmaps a field: removes the mapping and its curation target', () => {
    const before = activeBundle();
    expect(before.attributeMappings.some(m => m.attributeId === 'product-cross-sell')).toBe(true);

    applyFieldMappingEdits(root, workspaceId, [
      { catalogField: 'ProductField32', attributeId: null },
    ], { gitEnabled: false });

    const after = activeBundle();
    expect(after.attributeMappings.some(m => m.catalogField === 'ProductField32')).toBe(false);
    expect(after.curationTargets.some(t => t.kind === 'product_field' && t.attributeId === 'product-cross-sell')).toBe(false);
    const cached = getCachedAttributeMappings(workspaceId);
    expect(cached.some(m => m.attributeId === 'product-cross-sell')).toBe(false);
  });

  it('rejects edits referencing an unknown attribute', () => {
    expect(() => applyFieldMappingEdits(root, workspaceId, [
      { catalogField: 'ProductField25', attributeId: 'does-not-exist' },
    ], { gitEnabled: false })).toThrow(FieldMappingEditError);
    try {
      applyFieldMappingEdits(root, workspaceId, [
        { catalogField: 'ProductField25', attributeId: 'does-not-exist' },
      ], { gitEnabled: false });
    } catch (error) {
      expect((error as FieldMappingEditError).code).toBe('unknown_attribute');
    }
  });

  it('rejects moving an already-mapped attribute to a second field', () => {
    try {
      applyFieldMappingEdits(root, workspaceId, [
        { catalogField: 'ProductField16', attributeId: 'brand' }, // already mapped to 16 — no-op
        { catalogField: 'ProductField25', attributeId: 'brand' }, // second field for brand
      ], { gitEnabled: false });
    } catch (error) {
      expect((error as FieldMappingEditError).code).toBe('attribute_already_mapped');
      return;
    }
    throw new Error('expected attribute_already_mapped error');
  });

  it('I3.1: a mapping-only edit leaves the field registry unchanged', () => {
    const registryBefore = listRegistry(workspaceId);

    applyFieldMappingEdits(root, workspaceId, [
      { catalogField: 'ProductField24', attributeId: 'category' },
    ], { gitEnabled: false });

    // The mapping editor no longer writes field metadata — the registry
    // (including curated labels) is owned exclusively by the canonical
    // field-metadata service.
    expect(listRegistry(workspaceId)).toEqual(registryBefore);
  });

  it('I3.2: a label in the edit payload is rejected (no alternate label authority)', () => {
    try {
      applyFieldMappingEdits(root, workspaceId, [
        { catalogField: 'ProductField24', attributeId: 'category', label: 'Should not apply' },
      ] as never, { gitEnabled: false });
    } catch (error) {
      expect((error as FieldMappingEditError).code).toBe('invalid_edit');
      return;
    }
    throw new Error('expected invalid_edit error for a label-bearing edit payload');
  });

  it('fails closed when the edited bundle cannot pass active validation', () => {
    // ProductField99 is not attested in the live field registry; unmap the
    // category mapping first so the re-map reaches validation (the two edits
    // are one atomic call — nothing is written on failure).
    try {
      applyFieldMappingEdits(root, workspaceId, [
        { catalogField: 'ProductField24', attributeId: null },
        { catalogField: 'ProductField99', attributeId: 'category' },
      ], { gitEnabled: false });
    } catch (error) {
      expect((error as FieldMappingEditError).code).toBe('validation_failed');
      return;
    }
    throw new Error('expected validation_failed error');
  });

  it('commits the scoped change to the nested repository when git is enabled', () => {
    const headBefore = runGit(['rev-parse', 'HEAD']);
    applyFieldMappingEdits(root, workspaceId, [
      { catalogField: 'ProductField32', attributeId: 'product-cross-sell' },
    ]);
    const headAfter = runGit(['rev-parse', 'HEAD']);
    expect(headAfter).not.toBe(headBefore);
    const touched = runGit(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
    expect(touched.every(file => file.startsWith('store/classification/'))).toBe(true);
  });

  it('keeps the DB active-config hash aligned with the edited manifest', () => {
    const bundle = activeBundle();
    const stored = getDb()
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get(`active_classification_config_hash:${workspaceId}`) as { value: string } | undefined;
    expect(stored?.value).toBe(bundle.manifest.bundleHash);
  });
});
