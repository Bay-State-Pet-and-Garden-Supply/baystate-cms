#!/usr/bin/env bun
/**
 * Build the immutable bay-state-v3 taxonomy release (P1 of the curation audit).
 *
 * The release is DERIVED deterministically from:
 *   - the committed P0 runtime snapshot
 *     (src/classification/snapshots/bay-state-v2-effective-2026-08-16/),
 *   - the reviewed seed's department grouping comments
 *     (src/classification/config-seeds/bay-state-pet-garden-v1.ts),
 *   - the reviewed guidance preset
 *     (src/classification/presets/preset-pet-and-garden.ts).
 *
 * Deliberate v3 corrections (documented in the manifest notes):
 *   1. Every product type gets a `departmentId` (derived from the seed's
 *      department comments; the snapshot has no department dimension).
 *   2. Every attribute gets an explicit `exportDisposition`
 *      ({ kind: 'shopsite', catalogField } for the 17 mapped attributes,
 *      { kind: 'not_exported' } for the 8 unmapped ones).
 *   3. `bee-supplies` (the one type without a profile in v2) gets
 *      `bee-supplies-profile`, so the invariant is 73 types / 73 profiles.
 *   4. Guidance is ported from the dead preset into the release
 *      (species safety, page assignment, domain keywords).
 *
 * Idempotent: running this script twice produces byte-identical files
 * (fixed createdAt, stable key order, source-order preserved).
 *
 * Usage:
 *   bun run scripts/build-bay-state-v3-release.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dir, '..');
const SNAPSHOT_DIR = path.join(
  ROOT,
  'src',
  'classification',
  'snapshots',
  'bay-state-v2-effective-2026-08-16',
);
const SEED_FILE = path.join(
  ROOT,
  'src',
  'classification',
  'config-seeds',
  'bay-state-pet-garden-v1.ts',
);
const PRESET_FILE = path.join(
  ROOT,
  'src',
  'classification',
  'presets',
  'preset-pet-and-garden.ts',
);
const OUT_DIR = path.join(ROOT, 'src', 'classification', 'releases', 'bay-state-v3');

/** Fixed creation time so regeneration is byte-identical. */
const CREATED_AT = '2026-08-16T00:00:00.000Z';
const RELEASE_ID = 'bay-state-v3';

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function envelope(entries: unknown[]): any {
  return {
    bundleOrigin: { kind: 'release', releaseId: RELEASE_ID, createdAt: CREATED_AT },
    schemaVersion: 2,
    entries,
  };
}

/** Deterministic pretty JSON (2-space indent, stable key order). */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ─── 1. Load the snapshot (runtime truth) ───────────────────────────────────
const snapshotTypes = readJson(path.join(SNAPSHOT_DIR, 'product-types.json'));
const snapshotAttributes = readJson(path.join(SNAPSHOT_DIR, 'attributes.json'));
const snapshotProfiles = readJson(path.join(SNAPSHOT_DIR, 'attribute-profiles.json'));
const snapshotMappings = readJson(path.join(SNAPSHOT_DIR, 'mappings.json'));

// ─── 2. Derive departments from the seed's productTypes comments ────────────
const seedSource = fs.readFileSync(SEED_FILE, 'utf8');
const productTypesSection = seedSource.match(/productTypes: \[([\s\S]*?)\n  \],/);
if (!productTypesSection) throw new Error('Could not locate productTypes array in seed');

interface SeedDepartment {
  comment: string;
  typeIds: string[];
}
const departments: SeedDepartment[] = [];
let current: SeedDepartment | null = null;
for (const line of productTypesSection[1].split('\n')) {
  const commentMatch = line.match(/\/\/\s*Department\s+\d+:\s*(.+)/);
  if (commentMatch) {
    current = { comment: commentMatch[1].trim(), typeIds: [] };
    departments.push(current);
    continue;
  }
  const typeMatch = line.match(/id:\s*'([^']+)'/);
  if (typeMatch && current) {
    current.typeIds.push(typeMatch[1]);
  }
}
if (departments.length === 0) throw new Error('No department comments found in seed');

function kebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const DEPARTMENT_DESCRIPTIONS: Record<string, string> = {
  'pet-supplies': 'Dog and cat food, treats, toys, crates, litter, grooming, and pet care supplies.',
  'livestock-farm-animals': 'Feed, coops, waterers, feeders, health care, and bedding for livestock and farm animals.',
  'equine-horse-care': 'Horse feed, treats, supplements, fly control, grooming, hoof care, blankets, and tack.',
  'fencing-agriculture-containment': 'Electric fence chargers, wire, posts, gates, insulators, and fencing tools.',
  'heating-fuel-climate-control': 'Wood pellets, firewood, propane heaters, barn heaters, heat lamps, and chimney care.',
  'lawn-garden-landscaping': 'Fertilizer, grass seed, weed control, pest control, soil, tools, hoses, and sprinklers.',
  'power-equipment-tools': 'Mowers, trimmers, chainsaws, pressure washers, and power tool accessories.',
  'trailer-towing-equipment': 'Trailer hitches, balls, couplers, jacks, lights, wiring, straps, and chains.',
  'wild-bird-wildlife': 'Wild bird food, suet, feeders, houses, baths, and deer/wildlife feed.',
  'apparel-workwear': 'Work boots, gloves, outerwear, and overalls/coveralls.',
};

const departmentEntries = departments.map((dep, index) => {
  const id = kebab(dep.comment);
  return {
    id,
    name: dep.comment,
    description: DEPARTMENT_DESCRIPTIONS[id] ?? `Products in the ${dep.comment} department.`,
    sortOrder: index,
    typeIds: [...dep.typeIds],
  };
});
const departmentIdByType = new Map<string, string>();
for (const dep of departmentEntries) {
  for (const typeId of dep.typeIds) departmentIdByType.set(typeId, dep.id);
}

// Sanity: every snapshot type must have a department.
const missingDepartments = snapshotTypes.entries
  .map((t: any) => t.id)
  .filter((id: string) => !departmentIdByType.has(id));
if (missingDepartments.length > 0) {
  throw new Error(`Product types missing department assignment: ${missingDepartments.join(', ')}`);
}

// ─── 3. Build product-types.json (add departmentId) ─────────────────────────
const mappedByAttribute = new Map<string, string>();
for (const m of snapshotMappings.entries) {
  mappedByAttribute.set(m.attributeId, m.catalogField);
}

const productTypeEntries = snapshotTypes.entries.map((t: any) => {
  const entry: Record<string, unknown> = {};
  for (const key of ['id', 'name', 'description', 'attributeProfileId', 'oldIdAliases']) {
    if (key in t) entry[key] = t[key];
  }
  entry.departmentId = departmentIdByType.get(t.id)!;
  return entry;
});

// ─── 4. Build attributes.json (add exportDisposition) ───────────────────────
const attributeEntries = snapshotAttributes.entries.map((a: any) => {
  const entry: Record<string, unknown> = {};
  for (const key of [
    'id', 'name', 'description', 'group', 'valueMode', 'allowedValues', 'valueAliases',
    'canonicalUnit', 'isUniversal', 'isClaim', 'isCompositionAttribute',
    'visualEvidenceEligibility', 'evidencePolicy', 'oldIdAliases',
  ]) {
    if (key in a) entry[key] = a[key];
  }
  const catalogField = mappedByAttribute.get(a.id);
  entry.exportDisposition = catalogField
    ? { kind: 'shopsite', catalogField }
    : { kind: 'not_exported' };
  return entry;
});

// ─── 5. Build attribute-profiles.json (add bee-supplies-profile) ────────────
const profileEntries = snapshotProfiles.entries.map((p: any) => JSON.parse(JSON.stringify(p)));

const BEE_SUPPLIES_ATTRIBUTES = [
  'material',
  'size',
  'packaging-type',
  'product-feature',
  'product-cross-sell',
];
const beeSuppliesProfile = {
  attributes: BEE_SUPPLIES_ATTRIBUTES.map((attributeId) => ({
    applicabilityConditions: [],
    attributeId,
    cardinality: 'single',
    confidenceThresholds: {},
    constraints: {},
    required: false,
    valueAliases: [],
  })),
  id: 'bee-supplies-profile',
  name: 'Bee Supplies & Apiary',
  oldIdAliases: [],
  productTypeId: 'bee-supplies',
};
profileEntries.push(beeSuppliesProfile);

// Point bee-supplies at its new profile (v2 had null).
const beeType = productTypeEntries.find((t: any) => t.id === 'bee-supplies');
if (beeType) beeType.attributeProfileId = 'bee-supplies-profile';

// ─── 6. Build export-mappings.json (same entries as snapshot) ───────────────
const exportMappingEntries = snapshotMappings.entries.map((m: any) => JSON.parse(JSON.stringify(m)));

// ─── 7. Build guidance.json (port the three preset rules) ───────────────────
// The preset conforms to GuidanceConfigV2Schema (strict: id, scope, scopeId,
// structured, freeForm, manualReviewRequirement). Import is avoided so the
// release is self-contained; the rules are copied verbatim below.
const presetSource = fs.readFileSync(PRESET_FILE, 'utf8');
const presetObjectStart = presetSource.indexOf('PET_AND_GARDEN_PRESET: GuidanceConfig[] = [');
if (presetObjectStart === -1) {
  throw new Error('Could not locate PET_AND_GARDEN_PRESET array in preset file');
}
// Strip the trailing `;` after the array close so the wrapped expression is valid.
const presetArraySource = presetSource
  .slice(presetObjectStart + 'PET_AND_GARDEN_PRESET: GuidanceConfig[] ='.length, presetSource.lastIndexOf('];') + 2)
  .replace(/;\s*$/, '');
// eslint-disable-next-line no-eval
const presetEntries = Function(`return (${presetArraySource});`)() as Array<Record<string, unknown>>;
const guidanceEntries = presetEntries.map((rule) => {
  const entry: Record<string, unknown> = {};
  for (const key of ['id', 'scope', 'scopeId', 'structured', 'freeForm', 'manualReviewRequirement']) {
    if (key in rule) entry[key] = rule[key];
  }
  return entry;
});
if (guidanceEntries.length !== 3) {
  throw new Error(`Expected 3 guidance rules from preset, found ${guidanceEntries.length}`);
}

// ─── 8. page-assignment-policy.json ─────────────────────────────────────────
const pageAssignmentPolicy = {
  schemaVersion: 1,
  maxPagesPerProduct: 4,
  preferSpecificOverShopAll: true,
  crossSpeciesBlocked: true,
  allowedSpecies: ['dog', 'cat', 'bird', 'fish', 'reptile', 'small_animal'],
  notes:
    'Port of preset-pet-and-garden page-assignment guidance (page-assignment-guidance + species-safety-guidance) into the immutable release.',
};

// ─── 9. Write the release files ─────────────────────────────────────────────
const releaseFiles: Record<string, unknown> = {
  'departments.json': envelope(departmentEntries),
  'product-types.json': envelope(productTypeEntries),
  'attributes.json': envelope(attributeEntries),
  'attribute-profiles.json': envelope(profileEntries),
  'export-mappings.json': envelope(exportMappingEntries),
  'guidance.json': envelope(guidanceEntries),
  'page-assignment-policy.json': pageAssignmentPolicy,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [fileName, content] of Object.entries(releaseFiles)) {
  writeJson(path.join(OUT_DIR, fileName), content);
}

// ─── 10. manifest.json with per-file hashes ────────────────────────────────
const fileVersions: Record<string, string> = {};
for (const fileName of Object.keys(releaseFiles)) {
  fileVersions[fileName] = sha256(path.join(OUT_DIR, fileName));
}
const manifest = {
  releaseId: RELEASE_ID,
  revision: RELEASE_ID,
  createdAt: CREATED_AT,
  schemaVersion: 2,
  compatibilityVersion: 2,
  lifecycle: 'release',
  sourceBaseline: 'bay-state-v2-effective-2026-08-16',
  fileVersions,
  counts: {
    productTypes: productTypeEntries.length,
    attributes: attributeEntries.length,
    attributeProfiles: profileEntries.length,
    departments: departmentEntries.length,
    mappings: exportMappingEntries.length,
    guidance: guidanceEntries.length,
  },
};
writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);

// ─── 11. Self-verification ─────────────────────────────────────────────────
const typeIds = new Set(productTypeEntries.map((t: any) => t.id));
const profileTypeIds = new Set(profileEntries.map((p: any) => p.productTypeId));
const profileIds = new Set(profileEntries.map((p: any) => p.id));
const attributeIds = new Set(attributeEntries.map((a: any) => a.id));
const departmentIds = new Set(departmentEntries.map((d: any) => d.id));

const errors: string[] = [];
if (productTypeEntries.length !== 73) errors.push(`expected 73 product types, got ${productTypeEntries.length}`);
if (attributeEntries.length !== 25) errors.push(`expected 25 attributes, got ${attributeEntries.length}`);
if (profileEntries.length !== 73) errors.push(`expected 73 profiles, got ${profileEntries.length}`);
for (const t of productTypeEntries as any[]) {
  if (!departmentIds.has(t.departmentId)) errors.push(`type ${t.id}: unknown departmentId ${t.departmentId}`);
  if (!profileIds.has(t.attributeProfileId)) errors.push(`type ${t.id}: unknown profile ${t.attributeProfileId}`);
}
for (const t of typeIds) if (!profileTypeIds.has(t)) errors.push(`type ${t} has no profile`);
for (const p of profileEntries as any[]) if (!typeIds.has(p.productTypeId)) errors.push(`profile ${p.id} references unknown type ${p.productTypeId}`);
for (const p of profileEntries as any[]) for (const a of p.attributes) if (!attributeIds.has(a.attributeId)) errors.push(`profile ${p.id}: unknown attribute ${a.attributeId}`);
const shopsiteCount = attributeEntries.filter((a: any) => a.exportDisposition.kind === 'shopsite').length;
const notExportedCount = attributeEntries.filter((a: any) => a.exportDisposition.kind === 'not_exported').length;
if (shopsiteCount !== 17) errors.push(`expected 17 shopsite dispositions, got ${shopsiteCount}`);
if (notExportedCount !== 8) errors.push(`expected 8 not_exported dispositions, got ${notExportedCount}`);
const guidanceIds = guidanceEntries.map((g: any) => g.id);
if (new Set(guidanceIds).size !== guidanceIds.length) errors.push('duplicate guidance ids');

if (errors.length > 0) {
  console.error('RELEASE VERIFICATION FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`✓ bay-state-v3 release written to ${path.relative(ROOT, OUT_DIR)}`);
console.log(`  productTypes=${productTypeEntries.length} attributes=${attributeEntries.length} profiles=${profileEntries.length} departments=${departmentEntries.length} mappings=${exportMappingEntries.length} guidance=${guidanceEntries.length}`);
console.log(`  export dispositions: ${shopsiteCount} shopsite / ${notExportedCount} not_exported`);
console.log(`  departments: ${departmentEntries.map((d) => d.id).join(', ')}`);
console.log(`  bee-supplies profile attributes: ${BEE_SUPPLIES_ATTRIBUTES.join(', ')}`);
console.log('✓ Self-verification passed (type/profile/attribute/department integrity, disposition counts, guidance uniqueness).');
