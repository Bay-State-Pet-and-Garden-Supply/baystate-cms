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
  type ReleaseValidationReport,
} from '../../classification/release-validation';

const RELEASE_DIR = path.resolve(__dirname, '../../classification/releases/bay-state-v3');

function tempReleaseCopy(name: string): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `taxonomy-release-test-${name}-`));
  fs.cpSync(RELEASE_DIR, tmpRoot, { recursive: true });
  return tmpRoot;
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
});
