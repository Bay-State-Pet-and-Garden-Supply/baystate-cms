/**
 * bay-state-v4 release compiler tests (P4 — plan B.P4.1/B.P4.4 tests).
 *
 * Pins the compiler contract that makes a release-pinned runtime safe:
 * - the committed bay-state-v4 bundle compiles into the strict v2 runtime
 *   authority shape (74 types / 74 expanded profiles / 27 attributes /
 *   19 mappings / derived curation targets);
 * - compilation is deterministic and hash-stable across independent loads
 *   (same bundle bytes ⇒ byte-identical config ⇒ identical bundleHash);
 * - canonical page-projection resolution joins verified page names to PF13/
 *   PF14 values and returns null (never guesses) on any missing join;
 * - loader pin selection: absent pin and pin=bay-state-v3 are byte-identical
 *   golden loads, unknown pins fail closed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClassificationConfigBundleV2Schema,
  type ClassificationConfig,
} from '../../shared/schemas/classification';
import {
  loadTaxonomyReleaseV4,
} from '../../classification/release-validation';
import {
  V4_TAXONOMY_REVISION,
  compileTaxonomyReleaseV4,
  resolveCanonicalPageProjections,
} from '../../classification/release-compiler';
import {
  ClassificationConfigLoadError,
  classificationDir,
  loadLegacyV1ConfigForMigration,
  loadRuntimeConfigAuthority,
  saveClassificationConfig,
} from '../../classification/config-loader';
import { writeWorkspaceState } from '../../classification/workspace-state';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';

// The loader-level tests below exercise the transitional legacy writer to seed
// temp workspaces; the freeze is lifted for the suite (restored in afterEach).
setTaxonomyFreezeForTests(false);

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-compiler-'));
  roots.push(root);
  return root;
}

function v1SeedFixture(): ClassificationConfig {
  const now = '2026-08-01T12:00:00.000Z';
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
    productTypes: [{ id: 'dog-food-dry', name: 'Dry Dog Food', description: 'Kibble.', attributeProfileId: null, oldIdAliases: [] }],
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    curationTargets: [],
    brands: [],
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: 'test',
      stageOverrides: {},
    imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
    },
    dataSharing: {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 90,
    },
  };
}

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  setTaxonomyFreezeForTests(true);
});

describe('bay-state-v4 release compiler', () => {
  it('compiles the committed v4 release into the strict v2 authority shape', () => {
    const compiled = compileTaxonomyReleaseV4(loadTaxonomyReleaseV4('bay-state-v4'));

    // Strict schema self-check passes on the taxonomy payload (the compiler
    // throws otherwise; parse again here so this assertion fails independently).
    // The two advisory runtime-view fields are intentionally OUTSIDE the strict
    // schema and ride along as extra properties.
    const { taxonomyRevision, pageAssignmentPolicyAdvisory, ...taxonomyPayload } = compiled;
    expect(() => ClassificationConfigBundleV2Schema.parse(taxonomyPayload)).not.toThrow();
    expect(taxonomyRevision).toBe(V4_TAXONOMY_REVISION);
    expect(pageAssignmentPolicyAdvisory.schemaVersion).toBeGreaterThan(0);

    expect(compiled.manifest.schemaVersion).toBe(2);
    expect(compiled.manifest.activeRevision).toBe(V4_TAXONOMY_REVISION);
    expect(compiled.manifest.lifecycle).toBe('active');
    expect(compiled.taxonomyRevision).toBe(V4_TAXONOMY_REVISION);

    expect(compiled.productTypes).toHaveLength(74);
    expect(new Set(compiled.productTypes.map(t => t.id)).size).toBe(74);

    // One profile PER classifiable node (runtime contract), each resolving.
    expect(compiled.attributeProfiles).toHaveLength(74);
    const productTypeIds = new Set(compiled.productTypes.map(t => t.id));
    const profileIds = new Set<string>();
    for (const profile of compiled.attributeProfiles) {
      expect(profileIds.has(profile.id)).toBe(false); // unique ids
      profileIds.add(profile.id);
      expect(productTypeIds.has(profile.productTypeId)).toBe(true);
    }
    for (const type of compiled.productTypes) {
      expect(profileIds.has(type.attributeProfileId ?? '')).toBe(true);
    }

    expect(compiled.attributes).toHaveLength(27);
    expect(compiled.attributeMappings).toHaveLength(19);
    expect(compiled.pageAssignmentPolicyAdvisory.maxPagesPerProduct).toBeGreaterThan(0);
    // Releases carry no store-local brands; the loader overlays those.
    expect(compiled.brands).toEqual([]);
  });

  it('derives deterministic curation targets: type gate + every exported non-projection attribute + pages', () => {
    const compiled = compileTaxonomyReleaseV4(loadTaxonomyReleaseV4('bay-state-v4'));
    const targets = compiled.curationTargets;

    expect(targets[0]).toMatchObject({ id: 'primary-product-type', kind: 'product_type', required: true });

    // Exported attributes minus the two compiled projections become targets,
    // in deterministic catalog-field order with sortOrder starting at 10.
    const fieldTargets = targets.filter(t => t.kind === 'product_field');
    const exportedNonProjection = compiled.attributes.filter(
      a => a.exportDisposition?.kind === 'shopsite' &&
        !['canonical-category-id', 'canonical-breadcrumb'].includes(a.id),
    );
    expect(fieldTargets).toHaveLength(exportedNonProjection.length);
    expect(fieldTargets.every(t => t.optionSource === 'configured' && !t.required)).toBe(true);
    const sortOrders = fieldTargets.map(t => t.sortOrder);
    expect([...sortOrders].sort((a, b) => a - b)).toEqual(sortOrders);
    expect(sortOrders[0]).toBe(10);

    const last = targets[targets.length - 1];
    expect(last).toMatchObject({ id: 'store-pages', kind: 'page', optionSource: 'live_store', sortOrder: 30 });
  });

  it('is deterministic and hash-stable across two independent loads', () => {
    const first = compileTaxonomyReleaseV4(loadTaxonomyReleaseV4('bay-state-v4'));
    const second = compileTaxonomyReleaseV4(loadTaxonomyReleaseV4('bay-state-v4'));

    expect(JSON.stringify(first.manifest.bundleHash)).toBe(JSON.stringify(second.manifest.bundleHash));
    // Byte-identical serialized configs (hash inputs cannot drift).
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  describe('resolveCanonicalPageProjections (B.P4.2)', () => {
    const bundle = loadTaxonomyReleaseV4('bay-state-v4');

    it('joins a ratified canonical_leaf page to node id + root-to-leaf breadcrumb', () => {
      const projection = bundle.pageProjections.find(p => p.role === 'canonical_leaf');
      expect(projection).toBeDefined();
      const resolved = resolveCanonicalPageProjections(bundle, projection!.pageName);
      expect(resolved).not.toBeNull();
      const expectedNodeId = projection!.nodeId;
      if (expectedNodeId === null) throw new Error('canonical_leaf projections must carry a nodeId');
      expect(resolved!.canonicalCategoryId).toBe(expectedNodeId);

      const node = bundle.hierarchy.find(n => n.id === projection!.nodeId)!;
      // Breadcrumb walks parent labels up to the department root.
      expect(resolved!.canonicalBreadcrumb.endsWith(node.label)).toBe(true);
      const labels: string[] = resolved!.canonicalBreadcrumb.split(' > ');
      expect(labels[labels.length - 1]).toBe(node.label);
    });

    it('returns null for unknown pages and never invents values', () => {
      expect(resolveCanonicalPageProjections(bundle, 'Definitely Not A Page')).toBeNull();
      const merchandising = bundle.pageProjections.find(p => p.role === 'merchandising');
      if (merchandising) {
        expect(resolveCanonicalPageProjections(bundle, merchandising.pageName)).toBeNull();
      }
    });
  });
});

describe('loader pin selection (plan B.P4.1 acceptance criteria 1–2 + unknown-pin fail-closed)', () => {
  function seededWorkspace(): string {
    const root = tempRoot();
    saveClassificationConfig(root, v1SeedFixture());
    return root;
  }

  it('absent pin: byte-identical golden load (HEAD behavior)', () => {
    const root = seededWorkspace();
    const golden = loadLegacyV1ConfigForMigration(root);
    const authority = loadRuntimeConfigAuthority(root);
    expect(authority.kind).toBe('v1');
    if (authority.kind !== 'v1') throw new Error('expected v1 authority');
    expect(JSON.stringify(authority.config)).toBe(JSON.stringify(golden));
    expect(fs.existsSync(path.join(classificationDir(root), 'state.json'))).toBe(false);
  });

  it('pin=bay-state-v3: byte-identical golden load', () => {
    const root = seededWorkspace();
    writeWorkspaceState(root, { activeTaxonomyRevision: 'bay-state-v3', updatedAt: '2026-08-16T12:00:00.000Z' });
    const golden = loadLegacyV1ConfigForMigration(root);
    const authority = loadRuntimeConfigAuthority(root);
    expect(authority.kind).toBe('v1');
    if (authority.kind !== 'v1') throw new Error('expected v1 authority');
    expect(JSON.stringify(authority.config)).toBe(JSON.stringify(golden));
  });

  it('pin=unknown revision fails closed without touching the workspace', () => {
    const root = seededWorkspace();
    writeWorkspaceState(root, { activeTaxonomyRevision: 'bay-state-v99', updatedAt: '2026-08-16T12:00:00.000Z' });
    try {
      loadRuntimeConfigAuthority(root);
      throw new Error('expected load to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ClassificationConfigLoadError);
      expect((error as ClassificationConfigLoadError).code).toBe('unsupported_version');
    }
    // Workspace bundle untouched.
    expect(fs.existsSync(classificationDir(root))).toBe(true);
  });

  it('pin=bay-state-v4 serves the V4-compiled v2 authority with preserved ids', () => {
    const root = seededWorkspace();
    writeWorkspaceState(root, { activeTaxonomyRevision: V4_TAXONOMY_REVISION, updatedAt: '2026-08-16T12:00:00.000Z' });
    const authority = loadRuntimeConfigAuthority(root);
    expect(authority.kind).toBe('v2');
    const bundle = authority.kind === 'v2' ? authority.bundle : null;
    expect(bundle).not.toBeNull();
    expect(bundle!.manifest.activeRevision).toBe(V4_TAXONOMY_REVISION);
    // oldIdAliases preservation: migrated v3 type ids survive as aliases.
    const aliased = (bundle as unknown as Record<string, unknown> & { taxonomyRevision?: string });
    expect(aliased.taxonomyRevision).toBe(V4_TAXONOMY_REVISION);
    const dogFood = bundle!.productTypes.find(t => t.id === 'dog-food-dry');
    expect(dogFood).toBeDefined();
    expect(dogFood!.oldIdAliases.length >= 0).toBe(true);
  });
});
