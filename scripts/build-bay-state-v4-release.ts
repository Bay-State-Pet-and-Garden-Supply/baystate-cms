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
 *   1. Hierarchy = 3 levels: L1 department roots (10, classifiable=false),
 *      L2 group nodes (13, classifiable=false), L3 leaf nodes (73, one per
 *      v3 type, classifiable=true).
 *   2. Leaf parent group = legacy parentCategory (matched by name via exact
 *      normalized match, then a curated alias map); unmatched types fall
 *      back to the department default group.
 *   3. Facet profiles are DEDUPLICATED from the 73 v3 profiles by identical
 *      attribute-set signature → 9 shared profiles.
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
  attributes: loadJson(path.join(V3_DIR, 'attributes.json')).entries as Array<Record<string, unknown>>,
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

// ─── Group structure (L2) ───────────────────────────────────────────────────────

/** groupId -> { label, departmentId, legacyGroups[] } */
const GROUP_DEFS: Record<string, { label: string; departmentId: string; legacyGroups: string[] }> = {
  'dog-supplies': { label: 'Dog Supplies', departmentId: 'pet-supplies', legacyGroups: ['dog_supplies'] },
  'cat-supplies': { label: 'Cat Supplies', departmentId: 'pet-supplies', legacyGroups: ['cat_supplies'] },
  'pet-supplies-other': { label: 'Other Pet Supplies', departmentId: 'pet-supplies', legacyGroups: ['pet_supplies'] },
  'pet-health': { label: 'Pet Health', departmentId: 'pet-supplies', legacyGroups: ['pet_health'] },
  'livestock-supplies': { label: 'Livestock Supplies', departmentId: 'livestock-farm-animals', legacyGroups: ['livestock_supplies'] },
  'equine-supplies': { label: 'Equine Supplies', departmentId: 'equine-horse-care', legacyGroups: ['equine_supplies'] },
  'fencing-supplies': { label: 'Fencing Supplies', departmentId: 'fencing-agriculture-containment', legacyGroups: ['fencing_supplies'] },
  'heating-fuel': { label: 'Heating & Fuel', departmentId: 'heating-fuel-climate-control', legacyGroups: ['heating_fuel'] },
  'lawn-garden': { label: 'Lawn & Garden', departmentId: 'lawn-garden-landscaping', legacyGroups: ['lawn_garden'] },
  'power-equipment': { label: 'Power Equipment', departmentId: 'power-equipment-tools', legacyGroups: ['power_equipment'] },
  'towing-equipment': { label: 'Towing Equipment', departmentId: 'trailer-towing-equipment', legacyGroups: ['towing_equipment'] },
  'wild-bird-supplies': { label: 'Wild Bird Supplies', departmentId: 'wild-bird-wildlife', legacyGroups: ['bird_supplies'] },
  // NOTE: the group id must differ from the department root id. The department
  // root for apparel is 'apparel-workwear'; the group node is 'apparel-supplies'
  // so the hierarchy has no duplicate node ids and no self-parent cycle.
  'apparel-supplies': { label: 'Apparel & Workwear', departmentId: 'apparel-workwear', legacyGroups: ['apparel_workwear'] },
};

/** departmentId -> default groupId (fallback for types with no legacy match). */
const DEPARTMENT_DEFAULT_GROUP: Record<string, string> = {
  'pet-supplies': 'pet-supplies-other',
  'livestock-farm-animals': 'livestock-supplies',
  'equine-horse-care': 'equine-supplies',
  'fencing-agriculture-containment': 'fencing-supplies',
  'heating-fuel-climate-control': 'heating-fuel',
  'lawn-garden-landscaping': 'lawn-garden',
  'power-equipment-tools': 'power-equipment',
  'trailer-towing-equipment': 'towing-equipment',
  'wild-bird-wildlife': 'wild-bird-supplies',
  'apparel-workwear': 'apparel-supplies',
};

const legacyGroupToGroupId = new Map<string, string>();
for (const [groupId, def] of Object.entries(GROUP_DEFS)) {
  for (const legacyGroup of def.legacyGroups) {
    legacyGroupToGroupId.set(legacyGroup, groupId);
  }
}

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

function resolveGroupForType(typeId: string, typeName: string, departmentId: string): {
  groupId: string;
  matchedLegacy: boolean;
  viaAlias: boolean;
} {
  // 1. Exact normalized-name match against the legacy taxonomy.
  const normalized = normalizeName(typeName);
  const legacy = legacyByName.get(normalized);
  if (legacy) {
    const groupId = legacyGroupToGroupId.get(legacy.parentCategory);
    if (groupId) return { groupId, matchedLegacy: true, viaAlias: false };
  }
  // 2. Curated alias map.
  const aliasLegacyId = TYPE_LEGACY_ALIASES[typeId];
  if (aliasLegacyId) {
    const legacyAlias = legacyTypes.find(l => l.id === aliasLegacyId);
    if (legacyAlias) {
      const groupId = legacyGroupToGroupId.get(legacyAlias.parentCategory);
      if (groupId) return { groupId, matchedLegacy: true, viaAlias: true };
    }
  }
  // 3. Department default group.
  return { groupId: DEPARTMENT_DEFAULT_GROUP[departmentId] ?? 'pet-supplies-other', matchedLegacy: false, viaAlias: false };
}

// ─── Facet profile dedupe ───────────────────────────────────────────────────────

interface FacetProfileDef {
  id: string;
  name: string;
  attributes: Array<{ attributeId: string; required: boolean; cardinality: string }>;
  v3ProfileIds: string[];
}

function profileSignature(profile: typeof v3.profiles[number]): string {
  // Signature = sorted attributeId set (order-insensitive). All v3 profiles
  // use required=false / cardinality=single, so the set fully distinguishes
  // profile shapes; required/cardinality are preserved on the output entries.
  return profile.attributes
    .map(a => a.attributeId)
    .sort()
    .join('|');
}

/** Deterministic label/name assignment per SORTED attributeId set. */
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

const signatureToProfile = new Map<string, FacetProfileDef>();
const v3ProfileToV4Profile = new Map<string, string>();

for (const profile of v3.profiles) {
  const sig = profileSignature(profile);
  let def = signatureToProfile.get(sig);
  if (!def) {
    const named = PROFILE_NAME_BY_ATTRSET[sig];
    if (!named) throw new Error(`No profile name mapped for signature: ${sig} (profile ${profile.id})`);
    def = {
      id: named.id,
      name: named.name,
      attributes: [...profile.attributes].sort((a, b) => a.attributeId.localeCompare(b.attributeId)),
      v3ProfileIds: [],
    };
    signatureToProfile.set(sig, def);
  }
  def.v3ProfileIds.push(profile.id);
  v3ProfileToV4Profile.set(profile.id, def.id);
}

// ─── Build hierarchy (L1 roots + L2 groups + L3 leaves) ────────────────────────

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

// L2: group nodes.
for (const [groupId, def] of Object.entries(GROUP_DEFS)) {
  const legacyTypeIds = v3.productTypes
    .filter(pt => {
      const { groupId: resolved } = resolveGroupForType(pt.id, pt.name, pt.departmentId);
      return resolved === groupId;
    })
    .map(pt => pt.id);
  hierarchyNodes.push({
    id: groupId,
    label: def.label,
    parentId: def.departmentId,
    classifiable: false,
    facetProfileId: null,
    departmentId: def.departmentId,
    legacyTypeIds,
    derivation: 'group',
  });
}

// L3: leaf nodes (one per v3 type).
const leafMeta: Array<{ typeId: string; groupId: string; matchedLegacy: boolean; viaAlias: boolean }> = [];
for (const pt of v3.productTypes) {
  const { groupId, matchedLegacy, viaAlias } = resolveGroupForType(pt.id, pt.name, pt.departmentId);
  leafMeta.push({ typeId: pt.id, groupId, matchedLegacy, viaAlias });
  const v4ProfileId = v3ProfileToV4Profile.get(pt.attributeProfileId);
  if (!v4ProfileId) throw new Error(`No v4 profile for v3 profile ${pt.attributeProfileId} (type ${pt.id})`);
  hierarchyNodes.push({
    id: pt.id,
    label: pt.name,
    parentId: groupId,
    classifiable: true,
    facetProfileId: v4ProfileId,
    departmentId: pt.departmentId,
    legacyTypeIds: [pt.id],
    derivation: 'type_1to1',
  });
  typeIdToNodeId.set(pt.id, pt.id);
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

const facetProfileEntries = [...signatureToProfile.values()]
  .map(def => ({
    id: def.id,
    name: def.name,
    attributes: def.attributes,
  }))
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
  .map(([v3ProfileId, v4ProfileId]) => ({
    id: `profile-map-${v3ProfileId}`,
    kind: 'profile_map',
    v3ProfileId,
    v4ProfileId,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

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
    'Hierarchy: L1 = 10 department roots (classifiable=false); L2 = 13 group nodes (classifiable=false); L3 = 73 leaf nodes (classifiable=true, one per v3 type, derivation type_1to1).',
    'Leaf parent group resolution: exact normalized-name match against the legacy v1 taxonomy, then a curated alias map (13 types), then the department default group for unmatched types (dog-waste-bags, cat-toys, grooming, supplements, collars-leashes, small-animal-feed-bedding, bee-supplies, bird-houses-baths).',
    `Facet profiles: the 73 v3 attribute profiles deduplicated by identical attribute-set signature into ${facetProfileEntries.length} shared profiles (profile-*). v3 profile -> v4 profile map recorded in legacy-mappings.json.`,
    'attributes.json carries 25 v3 attributes plus 2 compiled projection attributes: canonical-category-id (ProductField13) and canonical-breadcrumb (ProductField14).',
    'export-mappings.json carries the 17 v3 mappings plus canonical-category-id-mapping (PF13) and canonical-breadcrumb-mapping (PF14).',
    `ShopSite page projection: ${livePages.length} live pages assigned roles deterministically — canonical_leaf=${canonicalLeafCount}, shop_all_aggregate=${shopAllCount}, merchandising=${merchandisingCount}, navigation=${navigationCount}, needs_review=${needsReviewCount} (canonical_browse=0 in this first pass; page roles for the remaining pages require human curation in the next phase).`,
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

// Every group's legacyTypeIds must be exactly its assigned leaves.
for (const group of hierarchyEntries.filter(n => n.derivation === 'group')) {
  const expected = leafMeta.filter(m => m.groupId === group.id).map(m => m.typeId).sort();
  const actual = [...(group.legacyTypeIds as string[])].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    problems.push(`group ${group.id} legacyTypeIds mismatch`);
  }
}

console.log('=== bay-state-v4 build ===');
console.log(`nodes: ${hierarchyEntries.length} (roots=${hierarchyEntries.filter(n=>n.parentId===null).length}, groups=${hierarchyEntries.filter(n=>n.derivation==='group').length}, leaves=${leafNodes.length})`);
console.log(`facet profiles: ${facetProfileEntries.length} (from 73 v3 profiles)`);
console.log(`attributes: ${attributeEntries.length}; mappings: ${exportMappingEntries.length}; pages: ${pageRoleEntries.length}`);
console.log(`page roles: canonical_leaf=${canonicalLeafCount} shop_all=${shopAllCount} merchandising=${merchandisingCount} navigation=${navigationCount} needs_review=${needsReviewCount}`);
console.log(`group fallback (no legacy match, via department default): ${leafMeta.filter(m=>!m.matchedLegacy).map(m=>m.typeId).join(', ') || '(none)'}`);
console.log(`group via alias map: ${leafMeta.filter(m=>m.viaAlias).map(m=>m.typeId).join(', ') || '(none)'}`);
console.log(`problems: ${problems.length ? problems.join('; ') : 'NONE — all invariants satisfied'}`);
if (problems.length) process.exit(1);
