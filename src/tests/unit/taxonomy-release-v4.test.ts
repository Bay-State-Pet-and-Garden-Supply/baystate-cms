/**
 * v4 canonical-hierarchy release validation tests (P-v4 gate).
 *
 * Verifies the committed bay-state-v4 release validates and loads, then
 * exercises every hierarchy invariant on TEMP COPIES (never mutates the real
 * release): duplicate node ids, unknown parents, cycles, missing facet
 * profiles, unknown attribute refs, page/node collisions, non-classifiable
 * canonical pages, manifest count/hash mismatches, and release-id binding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReleaseValidationError,
  assertReleaseValidV4,
  loadTaxonomyReleaseV4,
  validateTaxonomyReleaseV4,
  type ReleaseValidationReport,
} from '../../classification/release-validation';

const RELEASE_ID = 'bay-state-v4';
const RELEASE_DIR = path.resolve(__dirname, '..', '..', 'classification', 'releases', RELEASE_ID);
const V3_RELEASE_ID = 'bay-state-v3';
const V3_RELEASE_DIR = path.resolve(__dirname, '..', '..', 'classification', 'releases', V3_RELEASE_ID);

function findingCodes(report: ReleaseValidationReport): string[] {
  return report.findings.map(f => f.code);
}

function expectFinding(report: ReleaseValidationReport, code: string): void {
  expect(findingCodes(report)).toContain(code);
}

// ─── Temp-copy helpers (tests never mutate the real release) ───────────────────

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-release-test-'));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* best effort */ }
});

/**
 * Create a per-test release directory named `bay-state-v4` with a sibling
 * `bay-state-v3` baseline, so release-id binding and the leaf bijection checks
 * behave exactly like the committed release. Returns the v4 dir path.
 */
function freshCopy(): string {
  const caseRoot = path.join(tmpRoot, `case-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(caseRoot, { recursive: true });
  const dir = path.join(caseRoot, RELEASE_ID);
  fs.cpSync(RELEASE_DIR, dir, { recursive: true });
  fs.cpSync(V3_RELEASE_DIR, path.join(caseRoot, V3_RELEASE_ID), { recursive: true });
  return dir;
}

function readJson(dir: string, fileName: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));
}

function writeJson(dir: string, fileName: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ─── Positive: the committed release ───────────────────────────────────────────

describe('committed bay-state-v4 release', () => {
  it('loads with expected counts matching the manifest', () => {
    const bundle = loadTaxonomyReleaseV4(RELEASE_ID);
    expect(bundle.manifest.releaseId).toBe('bay-state-v4');
    expect(bundle.manifest.counts.nodes).toBe(96);
    expect(bundle.hierarchy.length).toBe(96);
    const leaves = bundle.hierarchy.filter(n => n.classifiable);
    expect(leaves.length).toBe(73);
    expect(bundle.manifest.counts.types).toBe(73);
    expect(bundle.attributes.length).toBe(27);
    expect(bundle.manifest.counts.attributes).toBe(27);
    expect(bundle.pageProjections.length).toBe(153);
    expect(bundle.manifest.counts.pages).toBe(153);
    expect(bundle.exportMappings.length).toBe(19);
    expect(bundle.manifest.counts.mappings).toBe(19);
    expect(bundle.facetProfiles.length).toBe(9);
    expect(bundle.guidance.length).toBe(3);
  });

  it('validates with ok=true and zero error findings', () => {
    const report = validateTaxonomyReleaseV4(RELEASE_ID);
    expect(report.ok).toBe(true);
    expect(report.findings.filter(f => f.severity === 'error')).toEqual([]);
  });

  it('assertReleaseValidV4 does not throw', () => {
    expect(() => assertReleaseValidV4(RELEASE_ID)).not.toThrow();
  });

  it('hierarchy shape: 10 roots, 13 groups, 73 leaves, all reachable', () => {
    const bundle = loadTaxonomyReleaseV4(RELEASE_ID);
    const roots = bundle.hierarchy.filter(n => n.parentId === null);
    expect(roots.length).toBe(10);
    const groups = bundle.hierarchy.filter(n => n.derivation === 'group');
    expect(groups.length).toBe(13);
    const leaves = bundle.hierarchy.filter(n => n.classifiable);
    expect(leaves.length).toBe(73);
    const nodeIds = new Set(bundle.hierarchy.map(n => n.id));
    expect(nodeIds.size).toBe(bundle.hierarchy.length);
    // Every non-root parent resolves.
    for (const node of bundle.hierarchy) {
      if (node.parentId !== null) expect(nodeIds.has(node.parentId)).toBe(true);
    }
  });
});

// ─── Negative cases (temp copies) ───────────────────────────────────────────────

describe('negative cases (temp copies)', () => {
  it('rejects a duplicate node id', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const first = hierarchy.entries[0];
    hierarchy.entries.push({ ...first, id: first.id });
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'duplicate_node_id');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a node whose parentId references a nonexistent node', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const leaf = hierarchy.entries.find((e: any) => e.classifiable);
    leaf.parentId = 'nonexistent-node';
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'unknown_parent_node');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a self-parent cycle', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const leaf = hierarchy.entries.find((e: any) => e.classifiable);
    leaf.parentId = leaf.id;
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'self_parent_node');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a two-node cycle that makes nodes unreachable from roots', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const entries = hierarchy.entries as Array<{ id: string; parentId: string | null }>;
    // Reparent a leaf under another leaf to create a cycle pair.
    const leaves = entries.filter((e: any) => e.classifiable);
    const a = leaves[0];
    const b = leaves[1];
    a.parentId = b.id;
    b.parentId = a.id;
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    // Both nodes become unreachable from the roots → cycle detected.
    expect(findingCodes(report).some(c => c === 'hierarchy_cycle_or_unreachable')).toBe(true);
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a classifiable node with a missing facetProfileId', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const leaf = hierarchy.entries.find((e: any) => e.classifiable);
    leaf.facetProfileId = null;
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'classifiable_node_missing_profile');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a facet profile referencing an unknown attribute', () => {
    const dir = freshCopy();
    const profiles = readJson(dir, 'facet-profiles.json');
    // Push a schema-valid attribute entry with an unknown attributeId (clone
    // the first attribute so the pushed object passes the strict schema).
    const template = profiles.entries[0].attributes[0];
    profiles.entries[0].attributes.push({ ...template, attributeId: 'does-not-exist' });
    writeJson(dir, 'facet-profiles.json', profiles);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'facet_profile_unknown_attribute');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a duplicate attribute inside one facet profile', () => {
    const dir = freshCopy();
    const profiles = readJson(dir, 'facet-profiles.json');
    const profile = profiles.entries[0];
    const firstAttr = profile.attributes[0];
    profile.attributes.push({ ...firstAttr });
    writeJson(dir, 'facet-profiles.json', profiles);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'facet_profile_duplicate_attribute');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects two canonical_leaf pages sharing a nodeId', () => {
    const dir = freshCopy();
    const projection = readJson(dir, 'shopsite-projection.json');
    const leafPage = projection.entries.find((e: any) => e.role === 'canonical_leaf');
    const anotherLeaf = projection.entries.find((e: any) => e.role === 'canonical_leaf' && e.pageName !== leafPage.pageName);
    anotherLeaf.nodeId = leafPage.nodeId;
    writeJson(dir, 'shopsite-projection.json', projection);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'duplicate_canonical_node_page');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a canonical_leaf page whose nodeId is not classifiable', () => {
    const dir = freshCopy();
    const projection = readJson(dir, 'shopsite-projection.json');
    const leafPage = projection.entries.find((e: any) => e.role === 'canonical_leaf');
    // Repoint at the first root (a department root, non-classifiable).
    const hierarchy = readJson(dir, 'hierarchy.json');
    const root = hierarchy.entries.find((e: any) => e.parentId === null);
    leafPage.nodeId = root.id;
    writeJson(dir, 'shopsite-projection.json', projection);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'canonical_leaf_node_not_classifiable');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a manifest count mismatch', () => {
    const dir = freshCopy();
    const manifest = readJson(dir, 'manifest.json');
    manifest.counts.nodes = manifest.counts.nodes + 1;
    writeJson(dir, 'manifest.json', manifest);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'manifest_count_mismatch');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a manifest file-hash mismatch', () => {
    const dir = freshCopy();
    const manifest = readJson(dir, 'manifest.json');
    manifest.fileVersions['hierarchy.json'] = '0'.repeat(64);
    writeJson(dir, 'manifest.json', manifest);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'manifest_hash_mismatch');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a releaseId that does not match the directory basename', () => {
    const dir = freshCopy();
    const manifest = readJson(dir, 'manifest.json');
    manifest.releaseId = 'not-bay-state-v4';
    writeJson(dir, 'manifest.json', manifest);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'release_id_mismatch');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a v3 type absent from leaf legacyTypeIds (bijection break)', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const leaf = hierarchy.entries.find((e: any) => e.classifiable && e.legacyTypeIds.length > 0);
    leaf.legacyTypeIds = [];
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expect(findingCodes(report).some(c => c === 'leaf_node_no_legacy_type' || c === 'leaf_type_missing')).toBe(true);
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('throws ReleaseValidationError with code release_invalid on load', () => {
    const dir = freshCopy();
    const manifest = readJson(dir, 'manifest.json');
    manifest.counts.pages = 999;
    writeJson(dir, 'manifest.json', manifest);
    try {
      loadTaxonomyReleaseV4(dir);
      throw new Error('expected loadTaxonomyReleaseV4 to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReleaseValidationError);
      expect((err as ReleaseValidationError).code).toBe('release_invalid');
    }
  });
});
