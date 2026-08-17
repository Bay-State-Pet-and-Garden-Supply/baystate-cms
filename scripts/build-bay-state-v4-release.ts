#!/usr/bin/env bun
/**
 * Build the immutable bay-state-v4 canonical hierarchy release (hybrid
 * architecture, ChatGPT-ratified).
 *
 * ONE canonical hierarchy is the only classification truth. ShopSite Pages,
 * breadcrumbs, PF13/PF14, PF24/PF25 become COMPILED projections. v3's 73
 * product types are promoted INTO the hierarchy (not kept as a parallel
 * taxonomy).
 *
 * Derived deterministically from:
 *   - v3 release (src/classification/releases/bay-state-v3/): departments,
 *     73 product types, 25 attributes, 73 attribute profiles, 17 export
 *     mappings, 3 guidance rules, page-assignment policy
 *   - LEGACY v1 taxonomy (src/classification/taxonomy/product-types.json):
 *     group-level structure (13 parentCategory groups)
 *   - Live ShopSite pages (storage/catalog/store/classification/
 *     catalog-evidence.json): 153 pages
 *
 * Deliberate v4 content rules (documented in manifest notes):
 *   1. Hierarchy is SEMANTICALLY RAGGED (ChatGPT v4 review): 10 department
 *      roots, meaningful browse nodes only (dog, cat, pet-health-wellness,
 *      dog-food, cat-food, wild-bird), 73 classifiable leaf nodes (one per
 *      v3 type). Legacy wrapper groups (livestock-supplies, equine-supplies,
 *      fencing-supplies, heating-fuel, lawn-garden, power-equipment,
 *      towing-equipment, wild-bird-supplies, apparel-supplies,
 *      pet-supplies-other) are COLLAPSED into their department roots.
 *   2. Leaf parent = explicit override map first, then family membership,
 *      then legacy parentCategory, then department root.
 *   3. Facet profiles are DEDUPLICATED from the 73 v3 profiles by identical
 *      BEHAVIORAL fingerprint (attribute ids + required + cardinality +
 *      attribute valueMode/units/allowedValues/aliases/universal/export
 *      disposition) → shared profiles with provenance; splits occur when
 *      fingerprints differ.
 *   4. attributes.json gains 'canonical-category-id' (PF13) and
 *      'canonical-breadcrumb' (PF14) projection attributes → 27.
 *   5. export-mappings.json gains the two canonical projection mappings → 19.
 *   6. shopsite-projection.json assigns every one of the 153 live pages a
 *      role via deterministic heuristics; unmatched pages are 'needs_review'
 *      for the human curation phase.
 *
 * Idempotent: running this script twice produces byte-identical files
 * (fixed createdAt, stable key order, source-order preserved).
 *
 * Usage:
 *   bun run scripts/build-bay-state-v4-release.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dir, '..');
const V3_DIR = path.join(ROOT, 'src', 'classification', 'releases', 'bay-state-v3');
const LEGACY_FILE = path.join(ROOT, 'src', 'classification', 'taxonomy', 'product-types.json');
const EVIDENCE_FILE = path.join(ROOT, 'storage', 'catalog', 'store', 'classification', 'catalog-evidence.json');
const OUT_DIR = path.join(ROOT, 'src', 'classification', 'releases', 'bay-state-v4');

/** Fixed creation time so regeneration is byte-identical. */
const CREATED_AT = '2026-08-17T00:00:00.000Z';
const RELEASE_ID = 'bay-state-v4';

// ─── Loaders ───────────────────────────────────────────────────────────────────

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const v3 = {
  departments: loadJson(path.join(V3_DIR, 'departments.json')).entries as Array<{
    id: string; name: string; description?: string; typeIds: string[];
  }>,
  productTypes: loadJson(path.join(V3_DIR, 'product-types.json')).entries as Array<{
    id: string; name: string; description?: string; attributeProfileId: string; departmentId: string;
  }>,
  attributes: loadJson(path.join(V3_DIR, 'attributes.json')).entries as Array<{
    id: string;
    name: string;
    valueMode?: string | null;
    canonicalUnit?: string | null;
    allowedValues?: string[];
    valueAliases?: string[];
    isUniversal?: boolean;
    isClaim?: boolean;
    isCompositionAttribute?: boolean;
    visualEvidenceEligibility?: string | null;
    group?: string | null;
    exportDisposition?: { kind: string; catalogField?: string | null } | null;
  }>,
  profiles: loadJson(path.join(V3_DIR, 'attribute-profiles.json')).entries as Array<{
    id: string; name: string; productTypeId: string;
    attributes: Array<{ attributeId: string; required: boolean; cardinality: string }>;
  }>,
  exportMappings: loadJson(path.join(V3_DIR, 'export-mappings.json')).entries as Array<Record<string, unknown>>,
  guidance: loadJson(path.join(V3_DIR, 'guidance.json')).entries,
  pagePolicy: loadJson(path.join(V3_DIR, 'page-assignment-policy.json')),
};

const legacyTypes = loadJson(LEGACY_FILE) as Array<{
  id: string; name: string; parentCategory: string;
}>;

const evidence = loadJson(EVIDENCE_FILE) as { pages: Array<{ pageName: string; productCount: number }> };
const livePages = evidence.pages;

// ─── Browse/family structure (semantically meaningful nodes only) ────────────────

/**
 * Browse nodes kept in the canonical hierarchy (ChatGPT v4 review). Each is a
 * genuine classification dimension: species (dog/cat) or a health/wellness
 * family. Legacy wrapper groups are NOT kept — their leaves hang directly
 * under the department root.
 */
const BROWSE_DEFS: Record<string, { label: string; departmentId: string; legacyGroups: string[] }> = {
  'dog': { label: 'Dog', departmentId: 'pet-supplies', legacyGroups: ['dog_supplies'] },
  'cat': { label: 'Cat', departmentId: 'pet-supplies', legacyGroups: ['cat_supplies'] },
  'pet-health-wellness': { label: 'Pet Health & Wellness', departmentId: 'pet-supplies', legacyGroups: ['pet_health'] },
};

/**
 * Family browse nodes: real product families that partition leaves under a
 * browse node or a department root (semantically ragged — not forced depth).
 */
const FAMILY_DEFS: Record<string, { label: string; parentId: string; leafTypeIds: string[] }> = {
  'dog-food': { label: 'Dog Food', parentId: 'dog', leafTypeIds: ['dog-food-dry', 'dog-food-wet'] },
  'cat-food': { label: 'Cat Food', parentId: 'cat', leafTypeIds: ['cat-food-dry', 'cat-food-wet'] },
  'wild-bird': { label: 'Wild Bird', parentId: 'wild-bird-wildlife', leafTypeIds: ['bird-food', 'bird-houses-baths', 'suet-cakes', 'wild-bird-feeders'] },
};

/**
 * Explicit leaf → parent overrides (ChatGPT v4 review dispositions):
 *   - pet-supplies-other deleted → cat-toys → cat; dog-waste-bags → dog;
 *     supplements → pet-health-wellness; the rest → pet-supplies root
 *   - wild-bird-supplies deleted → wild-bird family (above);
 *     deer-wildlife-feed → wild-bird-wildlife root (real wildlife partition)
 */
const LEAF_PARENT_OVERRIDES: Record<string, string> = {
  'cat-toys': 'cat',
  'dog-waste-bags': 'dog',
  'supplements': 'pet-health-wellness',
  'collars-leashes': 'pet-supplies',
  'grooming': 'pet-supplies',
  'pet-beds': 'pet-supplies',
  'small-animal-feed-bedding': 'pet-supplies',
  'deer-wildlife-feed': 'wild-bird-wildlife',
};

/**
 * legacy parentCategory → canonical parent id. Legacy wrapper groups collapse
 * into their department root; real dimensions map to their browse node.
 */
const LEGACY_GROUP_TO_PARENT: Record<string, string> = {
  'dog_supplies': 'dog',
  'cat_supplies': 'cat',
  'pet_health': 'pet-health-wellness',
  'pet_supplies': 'pet-supplies',
  'livestock_supplies': 'livestock-farm-animals',
  'equine_supplies': 'equine-horse-care',
  'fencing_supplies': 'fencing-agriculture-containment',
  'heating_fuel': 'heating-fuel-climate-control',
  'lawn_garden': 'lawn-garden-landscaping',
  'power_equipment': 'power-equipment-tools',
  'towing_equipment': 'trailer-towing-equipment',
  'bird_supplies': 'wild-bird-wildlife',
  'apparel_workwear': 'apparel-workwear',
};

// ─── Leaf → group resolution ────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

const legacyByName = new Map<string, typeof legacyTypes[number]>();
for (const legacy of legacyTypes) legacyByName.set(normalizeName(legacy.name), legacy);

/** Curated alias map: v3 type id -> legacy type id for near-name matches the
 *  normalizer cannot resolve deterministically. */
const TYPE_LEGACY_ALIASES: Record<string, string> = {
  'dog-treats': 'dog_treat',
  'cat-treats': 'cat_treat',
  'cat-litter': 'cat_litter',
  'pet-beds': 'pet_beds',
  'cattle-feed': 'cattle_feed',
  'weed-control': 'weed_control',
  'insect-control': 'insect_pest_control',
  'potting-soil': 'potting_soil',
  'hand-tools': 'hand_garden_tool',
  'bird-food': 'bird_seed_food',
  'deer-wildlife-feed': 'deer_wildlife_feed',
  'heating-pellets-wood': 'heating_pellets_wood',
  'work-boots': 'work_boots',
};

function resolveParentForType(typeId: string, typeName: string, departmentId: string): {
  parentId: string;
  matchedLegacy: boolean;
  viaAlias: boolean;
} {
  // 0. Explicit override (ChatGPT dispositions).
  const override = LEAF_PARENT_OVERRIDES[typeId];
  if (override) return { parentId: override, matchedLegacy: false, viaAlias: false };
  // 0b. Family membership.
  for (const [familyId, family] of Object.entries(FAMILY_DEFS)) {
    if (family.leafTypeIds.includes(typeId)) {
      return { parentId: familyId, matchedLegacy: false, viaAlias: false };
    }
  }
  // 1. Exact normalized-name match against the legacy taxonomy.
  const normalized = normalizeName(typeName);
  const legacy = legacyByName.get(normalized);
  if (legacy) {
    const parentId = LEGACY_GROUP_TO_PARENT[legacy.parentCategory];
    if (parentId) return { parentId, matchedLegacy: true, viaAlias: false };
  }
  // 2. Curated alias map.
  const aliasLegacyId = TYPE_LEGACY_ALIASES[typeId];
  if (aliasLegacyId) {
    const legacyAlias = legacyTypes.find(l => l.id === aliasLegacyId);
    if (legacyAlias) {
      const parentId = LEGACY_GROUP_TO_PARENT[legacyAlias.parentCategory];
      if (parentId) return { parentId, matchedLegacy: true, viaAlias: true };
    }
  }
  // 3. Department root (collapsed wrapper groups / unmatched).
  return { parentId: departmentId, matchedLegacy: false, viaAlias: false };
}

// ─── Facet profile dedupe ───────────────────────────────────────────────────────

interface FacetProfileDef {
  id: string;
  name: string;
  attributes: Array<{ attributeId: string; required: boolean; cardinality: string }>;
  v3ProfileIds: string[];
}

function profileSignature(profile: typeof v3.profiles[number]): string {
  // Behavioral fingerprint: attribute ids + required + cardinality PLUS each
  // attribute's behavioral fields (valueMode, canonicalUnit, allowedValues,
  // valueAliases, universal/claim/composition flags, group, export
  // disposition). Two profiles are deduped ONLY when every compiler-relevant
  // property is equivalent (ChatGPT v4 review fix #12).
  const parts = profile.attributes
    .map(a => {
      const attr = v3.attributes.find(x => x.id === a.attributeId);
      const behavior = attr
        ? JSON.stringify({
            valueMode: attr.valueMode,
            canonicalUnit: attr.canonicalUnit ?? null,
            allowedValues: [...(attr.allowedValues ?? [])].sort(),
            valueAliases: [...(attr.valueAliases ?? [])].sort(),
            isUniversal: attr.isUniversal ?? false,
            isClaim: attr.isClaim ?? false,
            isCompositionAttribute: attr.isCompositionAttribute ?? false,
            visualEvidenceEligibility: attr.visualEvidenceEligibility ?? null,
            group: attr.group ?? null,
            exportKind: attr.exportDisposition?.kind ?? null,
            exportField: attr.exportDisposition?.kind === 'shopsite' ? attr.exportDisposition.catalogField : null,
          })
        : 'MISSING';
      return `${a.attributeId}|req:${a.required ? 1 : 0}|card:${a.cardinality ?? 'single'}|${behavior}`;
    })
    .sort()
    .join(';');
  return createHash('sha256').update(parts).digest('hex').slice(0, 24);
}

/** Attribute-set signature (sorted attribute ids) — used for NAMING only. */
function attrSetSignature(profile: typeof v3.profiles[number]): string {
  return profile.attributes.map(a => a.attributeId).sort().join('|');
}

/** Deterministic label/name assignment per SORTED attributeId set (naming only). */
const PROFILE_NAME_BY_ATTRSET: Record<string, { id: string; name: string }> = {
  'breed-size|dietary-features|flavor|food-form|health-benefits|life-stage|nutrition|product-cross-sell|species':
    { id: 'profile-pet-food', name: 'Pet Food & Treats' },
  'color|material|product-cross-sell|product-feature|size':
    { id: 'profile-accessories', name: 'Accessories, Grooming & Apparel' },
  'food-form|nutrition|packaging-type|product-cross-sell':
    { id: 'profile-livestock-feed', name: 'Livestock & Equine Feed' },
  'material|packaging-type|product-cross-sell|product-feature|size':
    { id: 'profile-livestock-equipment', name: 'Livestock & Equine Equipment' },
  'material|product-cross-sell|product-feature|size':
    { id: 'profile-fencing-towing', name: 'Fencing & Towing Hardware' },
  'packaging-type|product-cross-sell|product-feature':
    { id: 'profile-heating', name: 'Heating & Fuel' },
  'category|material|packaging-type|product-cross-sell|product-feature|size':
    { id: 'profile-garden', name: 'Lawn & Garden Care' },
  'material|product-cross-sell|product-feature':
    { id: 'profile-power-equipment', name: 'Power Equipment & Tools' },
  'food-form|packaging-type|product-cross-sell|product-feature':
    { id: 'profile-wild-bird', name: 'Wild Bird & Wildlife' },
};

const fingerprintToProfile = new Map<string, FacetProfileDef>();
const v3ProfileToV4Profile = new Map<string, string>();

for (const profile of v3.profiles) {
  const fp = profileSignature(profile);
  let def = fingerprintToProfile.get(fp);
  if (!def) {
    const attrSet = attrSetSignature(profile);
    const named = PROFILE_NAME_BY_ATTRSET[attrSet];
    const id = named?.id ?? `profile-${attrSet.replace(/\|/g, '-').slice(0, 40)}`;
    const name = named?.name ?? `Shared profile (${attrSet.split('|').length} attributes)`;
    def = {
      id,
      name,
      attributes: [...profile.attributes].sort((a, b) => a.attributeId.localeCompare(b.attributeId)),
      v3ProfileIds: [],
    };
    fingerprintToProfile.set(fp, def);
  }
  def.v3ProfileIds.push(profile.id);
  v3ProfileToV4Profile.set(profile.id, def.id);
}

// ─── Build hierarchy (ragged: roots + browse + families + leaves) ───────────────

interface HierarchyNode {
  id: string;
  label: string;
  parentId: string | null;
  classifiable: boolean;
  facetProfileId: string | null;
  departmentId: string;
  legacyTypeIds: string[];
  derivation: string;
}

const hierarchyNodes: HierarchyNode[] = [];
const typeIdToNodeId = new Map<string, string>();

// L1: department roots.
for (const dept of v3.departments) {
  hierarchyNodes.push({
    id: dept.id,
    label: dept.name,
    parentId: null,
    classifiable: false,
    facetProfileId: null,
    departmentId: dept.id,
    legacyTypeIds: [...dept.typeIds],
    derivation: 'department',
  });
}

// Browse nodes (semantic dimensions only).
for (const [groupId, def] of Object.entries(BROWSE_DEFS)) {
  hierarchyNodes.push({
    id: groupId,
    label: def.label,
    parentId: def.departmentId,
    classifiable: false,
    facetProfileId: null,
    departmentId: def.departmentId,
    legacyTypeIds: [],
    derivation: 'group',
  });
}

// Family browse nodes (real product families).
for (const [familyId, def] of Object.entries(FAMILY_DEFS)) {
  hierarchyNodes.push({
    id: familyId,
    label: def.label,
    parentId: def.parentId,
    classifiable: false,
    facetProfileId: null,
    departmentId: v3.productTypes.find(pt => pt.id === def.leafTypeIds[0])?.departmentId ?? '',
    legacyTypeIds: [...def.leafTypeIds],
    derivation: 'family',
  });
}

// Leaf nodes (one per v3 type).
const leafMeta: Array<{ typeId: string; parentId: string; matchedLegacy: boolean; viaAlias: boolean }> = [];
for (const pt of v3.productTypes) {
  const { parentId, matchedLegacy, viaAlias } = resolveParentForType(pt.id, pt.name, pt.departmentId);
  leafMeta.push({ typeId: pt.id, parentId, matchedLegacy, viaAlias });
  const v4ProfileId = v3ProfileToV4Profile.get(pt.attributeProfileId);
  if (!v4ProfileId) throw new Error(`No v4 profile for v3 profile ${pt.attributeProfileId} (type ${pt.id})`);
  hierarchyNodes.push({
    id: pt.id,
    label: pt.name,
    parentId,
    classifiable: true,
    facetProfileId: v4ProfileId,
    departmentId: pt.departmentId,
    legacyTypeIds: [pt.id],
    derivation: 'type_1to1',
  });
  typeIdToNodeId.set(pt.id, pt.id);
}

// Browse nodes carry their DIRECT leaf ids (species check + audit). Family
// nodes already declared their leafTypeIds.
for (const node of hierarchyNodes) {
  if (node.derivation === 'group') {
    node.legacyTypeIds = leafMeta.filter(m => m.parentId === node.id).map(m => m.typeId).sort();
  }
}

// ─── ShopSite page projection (153 pages → roles) ───────────────────────────────

const NAV_PAGES = new Set([
  '##FaceBook Store',
  '#Services',
  'Delivery Services',
  'Landscape Services',
  'Propane Filling Station',
  'Lawn Equipment Rental',
  'The Fall Shop',
  'The Holiday Shoppe',
  'Winter Supplies',
  'Hardware',
]);

const leafLabelToNodeId = new Map<string, string>();
for (const node of hierarchyNodes) {
  if (node.derivation === 'type_1to1') leafLabelToNodeId.set(normalizeName(node.label), node.id);
}

function pageTokenSet(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean).sort();
}

function roleForPage(pageName: string): {
  role: string;
  nodeId: string | null;
  facetProfileId: string | null;
} {
  // 1. Shop All aggregation pages.
  if (/shop\s*all$/i.test(pageName)) {
    return { role: 'shop_all_aggregate', nodeId: null, facetProfileId: null };
  }
  // 2. Navigation pages.
  if (NAV_PAGES.has(pageName)) {
    return { role: 'navigation', nodeId: null, facetProfileId: null };
  }
  // 3. Merchandising pages.
  if (
    /^brand\s*-/i.test(pageName) ||
    /featured|special offers|season|gift shop|candles|refreshments|soap lotion|grills/i.test(pageName)
  ) {
    return { role: 'merchandising', nodeId: null, facetProfileId: null };
  }
  // 4. Canonical leaf pages: normalized label equality OR token-set equality
  //    with a hierarchy leaf (order-insensitive, catches "Dog Food Dry" ↔
  //    "Dry Dog Food").
  const normalized = normalizeName(pageName);
  if (leafLabelToNodeId.has(normalized)) {
    const nodeId = leafLabelToNodeId.get(normalized)!;
    const leaf = hierarchyNodes.find(n => n.id === nodeId)!;
    return { role: 'canonical_leaf', nodeId, facetProfileId: leaf.facetProfileId };
  }
  const tokens = pageTokenSet(pageName);
  for (const [leafNorm, nodeId] of leafLabelToNodeId) {
    const leafTokens = pageTokenSet(leafNorm);
    if (leafTokens.length === tokens.length && leafTokens.every(t => tokens.includes(t))) {
      const leaf = hierarchyNodes.find(n => n.id === nodeId)!;
      return { role: 'canonical_leaf', nodeId, facetProfileId: leaf.facetProfileId };
    }
  }
  // 5. Everything else needs human curation.
  return { role: 'needs_review', nodeId: null, facetProfileId: null };
}

const pageProjections = livePages.map(page => {
  const { role, nodeId, facetProfileId } = roleForPage(page.pageName);
  return {
    pageName: page.pageName,
    role,
    nodeId,
    childPages: [] as string[],
    facetProfileId,
    productCount: page.productCount,
  };
});

// childPages for canonical_browse pages (none in first pass; populate for
// future curation: direct children pages under the same node).
// ─── v4 content assembly ─────────────────────────────────────────────────────────

const envelope = {
  bundleOrigin: { kind: 'release', releaseId: RELEASE_ID, createdAt: CREATED_AT },
  schemaVersion: 2,
};

const hierarchyEntries = hierarchyNodes
  .map(node => ({
    id: node.id,
    label: node.label,
    parentId: node.parentId,
    classifiable: node.classifiable,
    facetProfileId: node.facetProfileId,
    departmentId: node.departmentId,
    legacyTypeIds: node.legacyTypeIds,
    derivation: node.derivation,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

// Profile provenance: per shared profile, the consuming canonical node ids
// (blast radius) and the behavioral fingerprint. The fingerprint is computed
// from the shared profile's OWN attributes via the same profileSignature
// machinery (v3 attributes are the attribute truth).
const profileFingerprintCache = new Map<string, string>();
function fingerprintForProfileAttributes(attributes: Array<{ attributeId: string; required: boolean; cardinality: string }>): string {
  const key = JSON.stringify(attributes.map(a => a.attributeId).sort());
  const cached = profileFingerprintCache.get(key);
  if (cached) return cached;
  const parts = attributes
    .map(a => {
      const attr = v3.attributes.find(x => x.id === a.attributeId);
      const behavior = attr
        ? JSON.stringify({
            valueMode: attr.valueMode,
            canonicalUnit: attr.canonicalUnit ?? null,
            allowedValues: [...(attr.allowedValues ?? [])].sort(),
            valueAliases: [...(attr.valueAliases ?? [])].sort(),
            isUniversal: attr.isUniversal ?? false,
            isClaim: attr.isClaim ?? false,
            isCompositionAttribute: attr.isCompositionAttribute ?? false,
            visualEvidenceEligibility: attr.visualEvidenceEligibility ?? null,
            group: attr.group ?? null,
            exportKind: attr.exportDisposition?.kind ?? null,
            exportField: attr.exportDisposition?.kind === 'shopsite' ? attr.exportDisposition.catalogField : null,
          })
        : 'MISSING';
      return `${a.attributeId}|req:${a.required ? 1 : 0}|card:${a.cardinality ?? 'single'}|${behavior}`;
    })
    .sort()
    .join(';');
  const fp = createHash('sha256').update(parts).digest('hex').slice(0, 24);
  profileFingerprintCache.set(key, fp);
  return fp;
}

const facetProfileEntries = [...fingerprintToProfile.values()]
  .map(def => {
    const behaviorFingerprint = fingerprintForProfileAttributes(def.attributes as Array<{ attributeId: string; required: boolean; cardinality: string }>);
    const canonicalNodeIds = hierarchyEntries
      .filter(n => n.classifiable && n.facetProfileId === def.id)
      .map(n => n.id)
      .sort();
    return {
      id: def.id,
      name: def.name,
      attributes: def.attributes,
      sourceV3ProfileIds: [...def.v3ProfileIds].sort(),
      canonicalNodeIds,
      behaviorFingerprint,
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

const typeMigrationEntries = v3.productTypes
  .map(pt => ({
    id: `migration-${pt.id}`,
    kind: 'type_migration',
    v3TypeId: pt.id,
    targetNodeId: typeIdToNodeId.get(pt.id) ?? pt.id,
    disposition: 'preserve_as_node',
    rationale: `v3 type ${pt.id} ("${pt.name}") promoted 1:1 into the canonical hierarchy as leaf node.`,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

const profileMapEntries = [...v3ProfileToV4Profile.entries()]
  .map(([v3ProfileId, v4ProfileId]) => {
    const v3Profile = v3.profiles.find(p => p.id === v3ProfileId)!;
    const v4Profile = facetProfileEntries.find(p => p.id === v4ProfileId)!;
    const v3Fingerprint = profileSignature(v3Profile);
    return {
      id: `profile-map-${v3ProfileId}`,
      kind: 'profile_map',
      v3ProfileId,
      v4ProfileId,
      v3Fingerprint,
      v4Fingerprint: v4Profile.behaviorFingerprint,
      equivalent: v3Fingerprint === v4Profile.behaviorFingerprint,
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

// Guard: every profile_map entry must be behaviorally equivalent (ChatGPT
// review fix #12). A mismatch means the v4 shared profile diverges from its
// v3 source — fail the build rather than ship a silently-changed profile.
const nonEquivalentProfiles = profileMapEntries.filter(m => !m.equivalent);
if (nonEquivalentProfiles.length > 0) {
  throw new Error(
    `Profile equivalence failure: ${nonEquivalentProfiles.length} v3→v4 profile mappings differ behaviorally: ` +
      nonEquivalentProfiles.map(m => `${m.v3ProfileId}→${m.v4ProfileId} (${m.v3Fingerprint} vs ${m.v4Fingerprint})`).join(', '),
  );
}

const canonicalCategoryIdAttribute = {
  id: 'canonical-category-id',
  name: 'Canonical Category ID',
  description: 'Stable canonical category node id (compiled projection, ProductField13).',
  valueMode: 'freeText',
  canonicalUnit: null,
  allowedValues: [],
  valueAliases: [],
  visualEvidenceEligibility: 'ineligible',
  isClaim: false,
  isCompositionAttribute: false,
  group: 'Store',
  isUniversal: true,
  oldIdAliases: [],
  evidencePolicy: {
    directEvidenceRequired: false,
    forbidAbsenceInference: false,
    allowedSources: ['page_context'],
    allowVisualEvidence: false,
    allowThirdPartyEvidence: false,
    thirdPartyEvidenceApproval: null,
    manualReviewRequired: false,
  },
  exportDisposition: { kind: 'shopsite', catalogField: 'ProductField13' },
};

const canonicalBreadcrumbAttribute = {
  id: 'canonical-breadcrumb',
  name: 'Canonical Breadcrumb',
  description: 'Render-ready canonical breadcrumb path (compiled projection, ProductField14).',
  valueMode: 'freeText',
  canonicalUnit: null,
  allowedValues: [],
  valueAliases: [],
  visualEvidenceEligibility: 'ineligible',
  isClaim: false,
  isCompositionAttribute: false,
  group: 'Store',
  isUniversal: true,
  oldIdAliases: [],
  evidencePolicy: {
    directEvidenceRequired: false,
    forbidAbsenceInference: false,
    allowedSources: ['page_context'],
    allowVisualEvidence: false,
    allowThirdPartyEvidence: false,
    thirdPartyEvidenceApproval: null,
    manualReviewRequired: false,
  },
  exportDisposition: { kind: 'shopsite', catalogField: 'ProductField14' },
};

const attributeEntries = [...v3.attributes, canonicalCategoryIdAttribute, canonicalBreadcrumbAttribute].sort(
  (a, b) => (a.id as string).localeCompare(b.id as string),
);

const exportMappingEntries = [
  ...v3.exportMappings,
  {
    id: 'canonical-category-id-mapping',
    attributeId: 'canonical-category-id',
    catalogField: 'ProductField13',
    serialization: { kind: 'scalar', prefix: '', suffix: '' },
    isStale: false,
  },
  {
    id: 'canonical-breadcrumb-mapping',
    attributeId: 'canonical-breadcrumb',
    catalogField: 'ProductField14',
    serialization: { kind: 'scalar', prefix: '', suffix: '' },
    isStale: false,
  },
].sort((a, b) => (a.id as string).localeCompare(b.id as string));

const pageRoleEntries = pageProjections.sort((a, b) => a.pageName.localeCompare(b.pageName));

const guidanceEntries = v3.guidance;
const pagePolicy = v3.pagePolicy;

// ─── Write files ────────────────────────────────────────────────────────────────

const files: Record<string, object> = {
  'hierarchy.json': { ...envelope, entries: hierarchyEntries },
  'facet-profiles.json': { ...envelope, entries: facetProfileEntries },
  'legacy-mappings.json': { ...envelope, entries: [...typeMigrationEntries, ...profileMapEntries] },
  'attributes.json': { ...envelope, entries: attributeEntries },
  'shopsite-projection.json': { ...envelope, entries: pageRoleEntries },
  'export-mappings.json': { ...envelope, entries: exportMappingEntries },
  'guidance.json': { ...envelope, entries: guidanceEntries },
  'page-assignment-policy.json': pagePolicy,
};

fs.mkdirSync(OUT_DIR, { recursive: true });

const canonicalJson = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

const fileVersions: Record<string, string> = {};
for (const [fileName, content] of Object.entries(files)) {
  const text = canonicalJson(content);
  fs.writeFileSync(path.join(OUT_DIR, fileName), text, 'utf8');
  fileVersions[fileName] = createHash('sha256').update(text).digest('hex');
}

const needsReviewCount = pageRoleEntries.filter(p => p.role === 'needs_review').length;
const canonicalLeafCount = pageRoleEntries.filter(p => p.role === 'canonical_leaf').length;
const shopAllCount = pageRoleEntries.filter(p => p.role === 'shop_all_aggregate').length;
const merchandisingCount = pageRoleEntries.filter(p => p.role === 'merchandising').length;
const navigationCount = pageRoleEntries.filter(p => p.role === 'navigation').length;

const manifest = {
  releaseId: RELEASE_ID,
  revision: RELEASE_ID,
  createdAt: CREATED_AT,
  schemaVersion: 3,
  compatibilityVersion: 3,
  lifecycle: 'release',
  sourceBaseline: 'bay-state-v3',
  fileVersions,
  counts: {
    nodes: hierarchyEntries.length,
    departments: 10,
    types: 73,
    attributes: attributeEntries.length,
    facetProfiles: facetProfileEntries.length,
    pages: livePages.length,
    mappings: exportMappingEntries.length,
  },
  notes: [
    'Hybrid architecture (ChatGPT-ratified): one immutable canonical hierarchy is the only classification truth; ShopSite Pages, breadcrumbs, PF13/PF14, PF24/PF25 are compiled projections.',
    'Hierarchy is SEMANTICALLY RAGGED (ChatGPT v4 review): L1 = 10 department roots (classifiable=false); browse nodes = dog, cat, pet-health-wellness (species/dimension) + dog-food, cat-food, wild-bird (real product families); L3 = 73 leaf nodes (classifiable=true, one per v3 type, derivation type_1to1). Legacy wrapper groups are collapsed into their department roots.',
    'Leaf parent resolution: explicit override map first (cat-toys→cat, dog-waste-bags→dog, supplements→pet-health-wellness, collars-leashes/grooming/pet-beds/small-animal-feed-bedding→pet-supplies, deer-wildlife-feed→wild-bird-wildlife), then family membership, then legacy parentCategory, then department root.',
    `Facet profiles: the 73 v3 attribute profiles deduplicated by BEHAVIORAL FINGERPRINT (attribute ids + required + cardinality + attribute valueMode/units/allowedValues/aliases/universal/claim/composition/export disposition) into ${facetProfileEntries.length} shared profiles. Every profile carries sourceV3ProfileIds + canonicalNodeIds (blast radius) + behaviorFingerprint; every profile_map entry in legacy-mappings.json is verified equivalent:true (build fails otherwise).`,    'attributes.json carries 25 v3 attributes plus 2 compiled projection attributes: canonical-category-id (ProductField13) and canonical-breadcrumb (ProductField14).',
    'export-mappings.json carries the 17 v3 mappings plus canonical-category-id-mapping (PF13) and canonical-breadcrumb-mapping (PF14).',
    `ShopSite page projection: ${livePages.length} live pages assigned roles deterministically — canonical_leaf=${canonicalLeafCount}, shop_all_aggregate=${shopAllCount}, merchandising=${merchandisingCount}, navigation=${navigationCount}, needs_review=${needsReviewCount} (canonical_browse=0 in this pass; remaining pages require human curation — needs_review must reach 0 before the compiler phase).`,
    'Shop All aggregation pages are page projections, NOT hierarchy nodes (documented in the hybrid plan).',
    'Legacy v1 taxonomy (src/classification/taxonomy/*.json) is still referenced by this builder but remains otherwise dead code pending the P6 removal phase.',
  ],
};

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), canonicalJson(manifest), 'utf8');

// ─── Self-verification ──────────────────────────────────────────────────────────

const leafNodes = hierarchyEntries.filter(n => n.classifiable);
const leafMissingProfile = leafNodes.filter(n => !n.facetProfileId);
const profileIds = new Set(facetProfileEntries.map(p => p.id));
const leafBadProfileRef = leafNodes.filter(n => n.facetProfileId && !profileIds.has(n.facetProfileId!));
const canonicalLeafPages = pageRoleEntries.filter(p => p.role === 'canonical_leaf');
const pageBadNodeRef = canonicalLeafPages.filter(p => !p.nodeId || !hierarchyEntries.some(n => n.id === p.nodeId));

const problems: string[] = [];
if (leafNodes.length !== 73) problems.push(`expected 73 leaf nodes, got ${leafNodes.length}`);
if (leafMissingProfile.length) problems.push(`${leafMissingProfile.length} leaves missing facetProfileId`);
if (leafBadProfileRef.length) problems.push(`${leafBadProfileRef.length} leaves reference unknown profile`);
if (pageBadNodeRef.length) problems.push(`${pageBadNodeRef.length} canonical_leaf pages reference unknown node`);
if (pageRoleEntries.length !== 153) problems.push(`expected 153 pages, got ${pageRoleEntries.length}`);
if (attributeEntries.length !== 27) problems.push(`expected 27 attributes, got ${attributeEntries.length}`);
if (exportMappingEntries.length !== 19) problems.push(`expected 19 mappings, got ${exportMappingEntries.length}`);
if (manifest.counts.nodes !== hierarchyEntries.length) problems.push('manifest node count mismatch');

// Every browse/family node's legacyTypeIds must be exactly its assigned leaves.
for (const node of hierarchyEntries.filter(n => n.derivation === 'group' || n.derivation === 'family')) {
  const expected = leafMeta.filter(m => m.parentId === node.id).map(m => m.typeId).sort();
  const actual = [...(node.legacyTypeIds as string[])].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    problems.push(`node ${node.id} legacyTypeIds mismatch (expected ${expected.join(',')}, got ${actual.join(',')})`);
  }
}

// Blast-radius report: shared profiles with >1 consuming node.
const multiNodeProfiles = facetProfileEntries.filter(p => (p.canonicalNodeIds as string[]).length > 1);
for (const p of multiNodeProfiles) {
  console.log(`profile blast radius: ${p.id} -> ${(p.canonicalNodeIds as string[]).length} nodes`);
}

console.log('=== bay-state-v4 build ===');
console.log(`nodes: ${hierarchyEntries.length} (roots=${hierarchyEntries.filter(n=>n.parentId===null).length}, browse=${hierarchyEntries.filter(n=>n.derivation==='group').length}, families=${hierarchyEntries.filter(n=>n.derivation==='family').length}, leaves=${leafNodes.length})`);
console.log(`facet profiles: ${facetProfileEntries.length} (from 73 v3 profiles; ${multiNodeProfiles.length} shared by >1 node)`);
console.log(`attributes: ${attributeEntries.length}; mappings: ${exportMappingEntries.length}; pages: ${pageRoleEntries.length}`);
console.log(`page roles: canonical_leaf=${canonicalLeafCount} shop_all=${shopAllCount} merchandising=${merchandisingCount} navigation=${navigationCount} needs_review=${needsReviewCount}`);
console.log(`leaf via override: ${leafMeta.filter(m=>LEAF_PARENT_OVERRIDES[m.typeId]).map(m=>m.typeId).join(', ') || '(none)'}`);
console.log(`leaf fallback (no legacy match, department root): ${leafMeta.filter(m=>!m.matchedLegacy && !m.viaAlias && !LEAF_PARENT_OVERRIDES[m.typeId]).map(m=>m.typeId).join(', ') || '(none)'}`);
console.log(`leaf via alias map: ${leafMeta.filter(m=>m.viaAlias).map(m=>m.typeId).join(', ') || '(none)'}`);
console.log(`problems: ${problems.length ? problems.join('; ') : 'NONE — all invariants satisfied'}`);
if (problems.length) process.exit(1);
