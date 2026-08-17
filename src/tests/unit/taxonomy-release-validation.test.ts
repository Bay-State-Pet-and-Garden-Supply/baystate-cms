/**
 * Taxonomy Release Validation (P2) tests.
 *
 * The committed bay-state-v3 release must validate cleanly; any corruption
 * (tested on TEMP copies, never the real release) must produce the matching
 * error finding and make `loadTaxonomyRelease`/`assertReleaseValid` throw
 * `ReleaseValidationError` (code `release_invalid`).
 */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertReleaseValid,
  loadTaxonomyRelease,
  ReleaseValidationError,
  validateTaxonomyRelease,
  isValidReleaseId,
  type ReleaseValidationReport,
} from '../../classification/release-validation';
import { PET_AND_GARDEN_PRESET } from '../../classification/presets/preset-pet-and-garden';

const RELEASE_DIR = path.resolve(__dirname, '../../classification/releases/bay-state-v3');

function tempReleaseCopy(name: string): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `taxonomy-release-test-${name}-`));
  // Nest the copy under a `bay-state-v3` subdirectory so the release-id
  // binding check (releaseId == directory basename) stays satisfied and each
  // negative test isolates a single cause.
  const releaseDir = path.join(tmpRoot, 'bay-state-v3');
  fs.cpSync(RELEASE_DIR, releaseDir, { recursive: true });
  return releaseDir;
}

const tmpDirs: string[] = [];
function trackedTempReleaseCopy(name: string): string {
  const dir = tempReleaseCopy(name);
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function writeJson(dir: string, fileName: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(value, null, 2), 'utf8');
}

function readJson<T>(dir: string, fileName: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')) as T;
}

function errorCodes(report: ReleaseValidationReport): string[] {
  return report.findings.filter(f => f.severity === 'error').map(f => f.code);
}

describe('taxonomy release validation — committed bay-state-v3', () => {
  it('validates the committed release with expected counts', () => {
    const report = validateTaxonomyRelease(RELEASE_DIR);
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({
      productTypes: 73,
      attributes: 25,
      attributeProfiles: 73,
      departments: 10,
      mappings: 17,
    });
    expect(report.findings).toEqual([]);
  });

  it('loads the committed release into a structured bundle', () => {
    const bundle = loadTaxonomyRelease(RELEASE_DIR);
    expect(bundle.productTypes).toHaveLength(73);
    expect(bundle.attributes).toHaveLength(25);
    expect(bundle.attributeProfiles).toHaveLength(73);
    expect(bundle.departments).toHaveLength(10);
    expect(bundle.exportMappings).toHaveLength(17);
    expect(bundle.guidance).toHaveLength(3);
    expect(bundle.manifest.releaseId).toBe('bay-state-v3');
    expect(bundle.manifest.revision).toBe('bay-state-v3');
    expect(bundle.pageAssignmentPolicy.maxPagesPerProduct).toBeGreaterThan(0);
    // Every product type has a departmentId and every attribute an exportDisposition.
    for (const pt of bundle.productTypes) expect(pt.departmentId).toBeDefined();
    for (const attr of bundle.attributes) expect(attr.exportDisposition).toBeDefined();
  });

  it('assertReleaseValid passes for the committed release', () => {
    expect(() => assertReleaseValid(RELEASE_DIR)).not.toThrow();
  });

  it('FIX 1: release guidance has exhaustive parity with the reviewed preset (both directions, semantic equality)', () => {
    const bundle = loadTaxonomyRelease(RELEASE_DIR);
    const releaseGuidance = bundle.guidance;

    // (a) Every preset rule must be present in the release with semantically
    // equal content (structured body, freeForm, manualReviewRequirement,
    // scope, scopeId).
    for (const rule of PET_AND_GARDEN_PRESET) {
      const release = releaseGuidance.find(g => g.id === rule.id);
      expect(release, `preset rule "${rule.id}" missing from release guidance`).toBeDefined();
      if (!release) continue;
      expect(release.scope).toEqual(rule.scope);
      expect(release.scopeId).toEqual(rule.scopeId);
      expect(release.structured).toEqual(rule.structured);
      expect(release.freeForm).toEqual(rule.freeForm);
      expect(release.manualReviewRequirement).toEqual(rule.manualReviewRequirement);
    }

    // (b) The release must contain NO guidance id that is not in the preset
    // (inventory parity in the reverse direction).
    const presetIds = new Set(PET_AND_GARDEN_PRESET.map(r => r.id));
    for (const g of releaseGuidance) {
      expect(presetIds.has(g.id), `release guidance "${g.id}" not present in preset`).toBe(true);
    }

    // Both directions agree, so the counts must match exactly.
    expect(releaseGuidance.length).toBe(PET_AND_GARDEN_PRESET.length);
  });

  it('FIX 2: export mappings are set-equal to the shopsite-disposition projection', () => {
    const bundle = loadTaxonomyRelease(RELEASE_DIR);
    const expected = new Map<string, string>();
    for (const attr of bundle.attributes) {
      if (attr.exportDisposition?.kind === 'shopsite') {
        expected.set(attr.id, attr.exportDisposition.catalogField);
      }
    }
    const actual = new Map<string, string[]>();
    for (const m of bundle.exportMappings) {
      const arr = actual.get(m.attributeId) ?? [];
      arr.push(m.catalogField);
      actual.set(m.attributeId, arr);
    }
    expect(actual.size).toBe(expected.size);
    for (const [attributeId, expectedField] of expected) {
      expect(actual.get(attributeId)).toEqual([expectedField]);
    }
    // Every mapping belongs to a shopsite attribute (no mapping for not_exported).
    const shopsiteIds = new Set(expected.keys());
    for (const attributeId of actual.keys()) {
      expect(shopsiteIds.has(attributeId), `mapping for non-shopsite attribute "${attributeId}"`).toBe(true);
    }
  });

  it('FIX 4/5: department ids and release id satisfy the kebab-case format, and releaseId binds to the directory basename', () => {
    const bundle = loadTaxonomyRelease(RELEASE_DIR);
    for (const dept of bundle.departments) {
      expect(isValidReleaseId(dept.id), `department id "${dept.id}" not kebab-case`).toBe(true);
    }
    expect(isValidReleaseId(bundle.manifest.releaseId)).toBe(true);
    expect(isValidReleaseId(bundle.manifest.revision)).toBe(true);
    expect(bundle.manifest.releaseId).toBe(path.basename(RELEASE_DIR));
  });
});

describe('taxonomy release validation — negative cases (temp copies)', () => {
  it('rejects a duplicate product type id', () => {
    const dir = trackedTempReleaseCopy('dup-type');
    const types = readJson<{ entries: Array<{ id: string }> }>(dir, 'product-types.json');
    types.entries.push({ ...types.entries[0] });
    writeJson(dir, 'product-types.json', types);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('duplicate_product_type_id');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a product type with no attribute profile', () => {
    const dir = trackedTempReleaseCopy('missing-profile');
    const profiles = readJson<{ entries: Array<{ productTypeId: string }> }>(dir, 'attribute-profiles.json');
    profiles.entries = profiles.entries.filter(p => p.productTypeId !== 'dog-food-dry');
    writeJson(dir, 'attribute-profiles.json', profiles);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('missing_profile_for_type');
    expect(() => assertReleaseValid(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects an orphan profile referencing an unknown product type', () => {
    const dir = trackedTempReleaseCopy('orphan-profile');
    const profiles = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'attribute-profiles.json');
    profiles.entries.push({
      id: 'orphan-profile',
      productTypeId: 'no-such-type',
      name: 'Orphan',
      attributes: [],
      oldIdAliases: [],
    });
    writeJson(dir, 'attribute-profiles.json', profiles);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('orphan_profile');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a profile attributeId that does not exist in attributes.json', () => {
    const dir = trackedTempReleaseCopy('bad-profile-attr');
    const profiles = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'attribute-profiles.json');
    const profile = profiles.entries[0];
    (profile.attributes as Array<Record<string, unknown>>).push({
      attributeId: 'nonexistent-attribute',
      required: false,
      cardinality: 'single',
      applicabilityConditions: [],
      constraints: {},
      confidenceThresholds: {},
      valueAliases: [],
    });
    writeJson(dir, 'attribute-profiles.json', profiles);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('profile_unknown_attribute');
    expect(() => assertReleaseValid(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects an attribute with no exportDisposition', () => {
    const dir = trackedTempReleaseCopy('no-disposition');
    const attrs = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'attributes.json');
    for (const attr of attrs.entries) {
      if (attr.id === 'brand') {
        delete attr.exportDisposition;
        break;
      }
    }
    writeJson(dir, 'attributes.json', attrs);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('attribute_missing_export_disposition');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a product type with an unknown departmentId', () => {
    const dir = trackedTempReleaseCopy('bad-dept');
    const types = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'product-types.json');
    for (const pt of types.entries) {
      if (pt.id === 'dog-food-dry') {
        pt.departmentId = 'no-such-department';
        break;
      }
    }
    writeJson(dir, 'product-types.json', types);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('unknown_department_id');
    expect(() => assertReleaseValid(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a controlled attribute with a duplicate allowed value', () => {
    const dir = trackedTempReleaseCopy('dup-allowed');
    const attrs = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'attributes.json');
    for (const attr of attrs.entries) {
      if (attr.valueMode === 'controlled' && Array.isArray(attr.allowedValues) && (attr.allowedValues as string[]).length > 0) {
        (attr.allowedValues as string[]).push((attr.allowedValues as string[])[0]);
        break;
      }
    }
    writeJson(dir, 'attributes.json', attrs);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('duplicate_allowed_value');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects an export mapping referencing an unknown attribute', () => {
    const dir = trackedTempReleaseCopy('bad-mapping');
    const mappings = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'export-mappings.json');
    mappings.entries[0].attributeId = 'nonexistent-attribute';
    writeJson(dir, 'export-mappings.json', mappings);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('mapping_unknown_attribute');
    expect(() => assertReleaseValid(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects when a release file hash does not match the manifest', () => {
    const dir = trackedTempReleaseCopy('hash-mismatch');
    // Corrupt a file without touching the manifest fileVersions.
    const attrs = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'attributes.json');
    attrs.entries[0].description = 'tampered';
    writeJson(dir, 'attributes.json', attrs);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('manifest_hash_mismatch');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects when manifest counts disagree with the release contents', () => {
    const dir = trackedTempReleaseCopy('count-mismatch');
    const manifest = readJson<{ counts: Record<string, number> }>(dir, 'manifest.json');
    manifest.counts = { ...manifest.counts, productTypes: 1 };
    writeJson(dir, 'manifest.json', manifest);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('manifest_count_mismatch');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a page-assignment-policy with maxPagesPerProduct <= 0', () => {
    const dir = trackedTempReleaseCopy('bad-max-pages');
    const policy = readJson<{ maxPagesPerProduct: number }>(dir, 'page-assignment-policy.json');
    policy.maxPagesPerProduct = 0;
    writeJson(dir, 'page-assignment-policy.json', policy);
    const report = validateTaxonomyRelease(dir);
    // The strict schema rejects non-positive maxPagesPerProduct first; the
    // runtime rule (invalid_max_pages) is defense-in-depth if the schema is
    // ever relaxed. Either way the release must be impossible to load.
    const codes = errorCodes(report);
    expect(
      codes.includes('invalid_page_assignment_policy') || codes.includes('invalid_max_pages'),
    ).toBe(true);
    expect(() => assertReleaseValid(dir)).toThrow(ReleaseValidationError);
  });

  it('throws ReleaseValidationError with code release_invalid', () => {
    const dir = trackedTempReleaseCopy('error-code');
    const types = readJson<{ entries: Array<{ id: string }> }>(dir, 'product-types.json');
    types.entries.push({ ...types.entries[0] });
    writeJson(dir, 'product-types.json', types);
    try {
      loadTaxonomyRelease(dir);
      throw new Error('expected loadTaxonomyRelease to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReleaseValidationError);
      expect((err as ReleaseValidationError).code).toBe('release_invalid');
      expect((err as ReleaseValidationError).report.ok).toBe(false);
    }
  });

  it('FIX 2: rejects when a shopsite attribute loses its export mapping', () => {
    const dir = trackedTempReleaseCopy('missing-mapping');
    const mappings = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'export-mappings.json');
    // Drop the first mapping (brand -> ProductField16 is shopsite-dispositioned).
    mappings.entries = mappings.entries.filter(m => m.attributeId !== 'brand');
    writeJson(dir, 'export-mappings.json', mappings);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('export_mapping_missing');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('FIX 2: rejects when a not_exported attribute gains an export mapping', () => {
    const dir = trackedTempReleaseCopy('forbidden-mapping');
    const mappings = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'export-mappings.json');
    // npk-ratio is not_exported; a mapping for it must be forbidden.
    mappings.entries.push({
      id: 'npk-ratio-mapping',
      attributeId: 'npk-ratio',
      catalogField: 'ProductField99',
      serialization: { kind: 'scalar', prefix: '', suffix: '' },
      isStale: false,
    });
    writeJson(dir, 'export-mappings.json', mappings);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('export_mapping_forbidden');
    expect(() => assertReleaseValid(dir)).toThrow(ReleaseValidationError);
  });

  it('FIX 2: rejects when a mapping catalogField differs from the disposition', () => {
    const dir = trackedTempReleaseCopy('mismatch-field');
    const mappings = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'export-mappings.json');
    for (const m of mappings.entries) {
      if (m.attributeId === 'brand') {
        m.catalogField = 'ProductField999';
        break;
      }
    }
    writeJson(dir, 'export-mappings.json', mappings);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('export_mapping_mismatch');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('FIX 2: rejects duplicate export mappings for the same attribute', () => {
    const dir = trackedTempReleaseCopy('dup-mapping');
    const mappings = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'export-mappings.json');
    mappings.entries.push({ ...mappings.entries[0] });
    writeJson(dir, 'export-mappings.json', mappings);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('duplicate_export_mapping');
    expect(() => assertReleaseValid(dir)).toThrow(ReleaseValidationError);
  });

  it('FIX 4: rejects duplicate department ids', () => {
    const dir = trackedTempReleaseCopy('dup-dept');
    const departments = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'departments.json');
    departments.entries.push({ ...departments.entries[0] });
    writeJson(dir, 'departments.json', departments);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('duplicate_department_id');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('FIX 4: rejects a department id that is not kebab-case', () => {
    const dir = trackedTempReleaseCopy('bad-dept-format');
    const departments = readJson<{ entries: Array<Record<string, unknown>> }>(dir, 'departments.json');
    for (const dept of departments.entries) {
      if (dept.id === 'pet-supplies') {
        // pet_supplies passes the shared slug schema (underscores allowed) but
        // fails the stricter kebab-case release-id/department format.
        dept.id = 'pet_supplies';
        break;
      }
    }
    writeJson(dir, 'departments.json', departments);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('invalid_department_id_format');
    expect(() => assertReleaseValid(dir)).toThrow(ReleaseValidationError);
  });

  it('FIX 5: rejects when manifest releaseId does not match the directory basename', () => {
    const dir = trackedTempReleaseCopy('release-id-mismatch');
    const manifest = readJson<{ releaseId: string }>(dir, 'manifest.json');
    manifest.releaseId = 'some-other-release';
    writeJson(dir, 'manifest.json', manifest);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('release_id_mismatch');
    expect(() => loadTaxonomyRelease(dir)).toThrow(ReleaseValidationError);
  });

  it('FIX 5: rejects a manifest releaseId that is not kebab-case', () => {
    const dir = trackedTempReleaseCopy('bad-release-id');
    const manifest = readJson<{ releaseId: string }>(dir, 'manifest.json');
    // bay_state_v3 is a valid slug per ClassificationSlugSchema (parses fine)
    // but fails the stricter kebab-case release-id format.
    manifest.releaseId = 'bay_state_v3';
    writeJson(dir, 'manifest.json', manifest);
    const report = validateTaxonomyRelease(dir);
    expect(errorCodes(report)).toContain('invalid_release_id_format');
    expect(() => assertReleaseValid(dir)).toThrow(ReleaseValidationError);
  });
});
