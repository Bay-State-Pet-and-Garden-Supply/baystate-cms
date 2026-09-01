/**
 * v5 canonical-hierarchy and product-type invariants release validation tests.
 *
 * Verifies the committed bay-state-v5 release validates, loads, and compiles with
 * controlled species, domain facet profiles, and deterministic invariant attributes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertReleaseValidV5,
  loadTaxonomyReleaseV5,
  validateTaxonomyReleaseV5,
  type ReleaseValidationReport,
} from '../../classification/release-validation';
import { compileTaxonomyReleaseV5 } from '../../classification/release-compiler';

const RELEASE_ID = 'bay-state-v5';
const RELEASE_DIR = path.resolve(__dirname, '..', '..', 'classification', 'releases', RELEASE_ID);

function findingCodes(report: ReleaseValidationReport): string[] {
  return report.findings.map(f => f.code);
}

function expectFinding(report: ReleaseValidationReport, code: string): void {
  expect(findingCodes(report)).toContain(code);
}

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-release-test-'));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* best effort */ }
});

function copyV5Release(scenarioName: string): string {
  const dir = path.join(tmpRoot, `${scenarioName}-${Math.random().toString(36).slice(2, 8)}`, RELEASE_ID);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(RELEASE_DIR)) {
    fs.copyFileSync(path.join(RELEASE_DIR, file), path.join(dir, file));
  }
  return dir;
}

describe('bay-state-v5 release validation & invariants', () => {
  it('validates and loads the committed bay-state-v5 release bundle', () => {
    assertReleaseValidV5(RELEASE_DIR);
    const report = validateTaxonomyReleaseV5(RELEASE_DIR);
    expect(report.ok).toBe(true);
    expect(report.counts.productTypes).toBe(74);

    const bundle = loadTaxonomyReleaseV5(RELEASE_DIR);
    expect(bundle.manifest.revision).toBe('bay-state-v5');
    expect(bundle.hierarchy.length).toBeGreaterThan(74);

    const dryDog = bundle.hierarchy.find(n => n.id === 'dog-food-dry');
    expect(dryDog).toBeDefined();
    expect(dryDog!.invariantAttributes).toEqual({
      species: 'Dog',
      'food-form': 'Dry Food',
    });
  });

  it('verifies species is controlled with canonical values and aliases', () => {
    const bundle = loadTaxonomyReleaseV5(RELEASE_DIR);
    const speciesAttr = bundle.attributes.find(a => a.id === 'species');
    expect(speciesAttr).toBeDefined();
    expect(speciesAttr!.valueMode).toBe('controlled');
    expect(speciesAttr!.allowedValues).toContain('Dog');
    expect(speciesAttr!.allowedValues).toContain('Cat');
    expect(speciesAttr!.allowedValues).toContain('Horse');
    expect(speciesAttr!.allowedValues).toContain('Poultry');
    expect(speciesAttr!.allowedValues).toContain('Cattle');
    expect(speciesAttr!.allowedValues).toContain('Swine');
    expect(speciesAttr!.allowedValues).toContain('Wildlife');

    expect(speciesAttr!.valueAliases.some(a => a.alias === 'canine' && a.mapsTo === 'Dog')).toBe(true);
    expect(speciesAttr!.valueAliases.some(a => a.alias === 'feline' && a.mapsTo === 'Cat')).toBe(true);
    expect(speciesAttr!.valueAliases.some(a => a.alias === 'equine' && a.mapsTo === 'Horse')).toBe(true);
    expect(speciesAttr!.valueAliases.some(a => a.alias === 'chicken' && a.mapsTo === 'Poultry')).toBe(true);
  });

  it('compiles into runtime authority with 30 invariant-bearing product types', () => {
    const bundle = loadTaxonomyReleaseV5(RELEASE_DIR);
    const compiled = compileTaxonomyReleaseV5(bundle);
    expect(compiled.taxonomyRevision).toBe('bay-state-v5');
    expect(compiled.productTypes).toHaveLength(74);

    const dogKibble = compiled.productTypes.find(t => t.id === 'dog-food-dry');
    expect(dogKibble!.invariantAttributes).toEqual({
      species: 'Dog',
      'food-form': 'Dry Food',
    });

    const horseFeed = compiled.productTypes.find(t => t.id === 'horse-feed');
    expect(horseFeed!.invariantAttributes).toEqual({ species: 'Horse' });

    const pellets = compiled.productTypes.find(t => t.id === 'heating-pellets-wood');
    expect(pellets!.invariantAttributes).toEqual({ 'fuel-type': 'Wood Pellets' });
  });

  describe('invariant validation failure modes on temp copies', () => {
    it('fails when an invariant references an unknown attribute', () => {
      const dir = copyV5Release('unknown-attr');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog-food-dry');
      dog.invariantAttributes = { 'non-existent-attr': 'Foo' };
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'unknown_invariant_attribute');
    });

    it('fails when an invariant attribute is not in the facet profile and not universal', () => {
      const dir = copyV5Release('not-applicable');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog-food-dry');
      // fuel-type is not in profile-pet-food and is not universal
      dog.invariantAttributes = { 'fuel-type': 'Wood Pellets' };
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'invariant_attribute_not_applicable');
    });

    it('fails when an invariant provides an invalid controlled value', () => {
      const dir = copyV5Release('invalid-controlled');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog-food-dry');
      dog.invariantAttributes = { species: 'Unicorn' };
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'invalid_invariant_controlled_value');
    });

    it('fails when cardinality mismatches (single given array)', () => {
      const dir = copyV5Release('cardinality-mismatch');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog-food-dry');
      dog.invariantAttributes = { species: ['Dog', 'Puppy'] };
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'invariant_cardinality_mismatch');
    });
  });
});
