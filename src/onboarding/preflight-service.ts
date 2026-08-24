import { getDb } from '../db/connection';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import { listAllBrandSites } from '../db/repositories/brand-site-repo';
import { listBrandAdvisoryProfiles } from '../db/repositories/distributor-repo';
import { listConnectionsByWorkspace } from '../db/repositories/distributor-repo';
import { matchExistingBrand } from '../shared/brand-matcher';
import type {
  BatchPreflightResponse,
  PreflightBrandGroup,
  PreflightDomainBlocker,
  PreflightRoutingBlocker,
  PreflightAvailableDistributor,
} from '../shared/schemas/onboarding';

/**
 * Format string to natural Title Case (e.g. "THREE DOG BAKERY" -> "Three Dog Bakery", "BETTER BONE" -> "Better Bone")
 */
function toTitleCase(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(/(\s+|[-'/&])/)
    .map((part) => {
      if (!part || /^\s+$/.test(part) || /^[-'/&]$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
}

const BRAND_SUFFIX_KEYWORDS = new Set([
  'bakery', 'bone', 'farms', 'farm', 'organics', 'organic', 'naturals', 'natural',
  'kitchen', 'kitchens', 'pet', 'pets', 'dog', 'dogs', 'cat', 'cats', 'honey', 'lane',
  'supply', 'bros', 'co', 'company', 'labs', 'botanicals', 'herbals', 'ranch', 'valley',
  'creek', 'treats', 'chews', 'foods', 'food', 'bites', 'nutrition', 'holistics', 'holistic'
]);

const PRODUCT_DESCRIPTOR_KEYWORDS = new Set([
  'soft', 'hard', 'classic', 'veggie', 'fun', 'bites', 'sprinkles', 'wraps', 'pup',
  'frzn', 'frozen', 'dinner', 'chkn', 'chicken', 'beef', 'pork', 'turkey', 'duck',
  'salmon', 'tuna', 'smoker', 'pellets', 'uncappingangle', 'knife', 'jacket',
  'pet-zel', 'cinnamut', 'crunch', 'cookies', 'cookie', 'adult', 'puppy', 'kitten',
  'senior', 'grain', 'free', 'raw', 'dry', 'wet', 'canned', 'chew', 'treat', 'dental',
  'freeze-dried', 'kibble', 'pack', 'packs', 'box', 'case', 'bottle', 'bag', 'tub',
  'oz', 'lb', 'lbs', 'ct', 'count', 'small', 'medium', 'large', 'sm', 'med', 'lg', 'xl'
]);

/**
 * Extract candidate brand phrase from product name when brand is not yet assigned.
 * Looks for known brand matches first, then multi-word brand heuristics (e.g. Three Dog Bakery, Better Bone).
 */
function extractCandidateBrand(name: string, knownBrands: string[]): string | null {
  if (!name) return null;
  const cleaned = name.trim();

  // 1. Match against all known store brands
  const matched = matchExistingBrand(cleaned, knownBrands);
  if (matched) return matched;

  // 2. Tokenize product name
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const firstClean = words[0].replace(/[^A-Za-z0-9'&]/g, '');
  if (firstClean.length < 2 || /^\d+$/.test(firstClean)) return null;

  // 3-word check: e.g. "Three Dog Bakery", "Harvest Lane Honey"
  if (words.length >= 3) {
    const w1 = words[0].toLowerCase().replace(/[^a-z0-9'&]/g, '');
    const w2 = words[1].toLowerCase().replace(/[^a-z0-9'&]/g, '');
    const w3 = words[2].toLowerCase().replace(/[^a-z0-9'&]/g, '');

    if (
      BRAND_SUFFIX_KEYWORDS.has(w3) ||
      (w1 === 'three' && w2 === 'dog' && w3 === 'bakery') ||
      (w1 === 'harvest' && w2 === 'lane' && w3 === 'honey') ||
      (w1 === 'inaba' && w2 === 'churu')
    ) {
      return toTitleCase(`${words[0]} ${words[1]} ${words[2]}`);
    }
  }

  // 2-word check: e.g. "Better Bone", "Lazy Dog", "Harvest Lane"
  if (words.length >= 2) {
    const w1 = words[0].toLowerCase().replace(/[^a-z0-9'&]/g, '');
    const w2 = words[1].toLowerCase().replace(/[^a-z0-9'&]/g, '');

    if (
      BRAND_SUFFIX_KEYWORDS.has(w2) &&
      !PRODUCT_DESCRIPTOR_KEYWORDS.has(w1)
    ) {
      return toTitleCase(`${words[0]} ${words[1]}`);
    }
  }

  // 1-word fallback in clean Title Case
  return toTitleCase(firstClean);
}

/**
 * Reusable server-side batch preflight analyzer (ADR 0017 / Controlled Release).
 * Evaluates readiness across brand resolution, official domains, and distributor routing.
 */
export function analyzeBatchPreflight(workspaceId: string, batchId: string): BatchPreflightResponse {
  const batch = findBatchById(batchId);
  if (!batch) {
    throw new Error(`Batch not found: ${batchId}`);
  }

  const items = listItemsByBatch(batchId);
  const totalItems = items.length;

  // 1. Fetch reference authorities and build canonical brand map
  const allBrandSites = listAllBrandSites();
  const knownBrandMap = new Map<string, string>();

  for (const site of allBrandSites) {
    const raw = site.brandName.trim();
    if (raw) {
      const lower = raw.toLowerCase();
      if (!knownBrandMap.has(lower)) {
        const formatted = (raw === raw.toUpperCase() && raw.length > 3)
          ? toTitleCase(raw)
          : raw;
        knownBrandMap.set(lower, formatted);
      }
    }
  }

  // Also query any existing catalog brands from products index if available
  try {
    const db = getDb();
    const rows = db.query(`
      SELECT DISTINCT json_extract(custom_fields, '$.ProductField16') AS brandName 
      FROM product_index 
      WHERE brandName IS NOT NULL AND brandName != ''
      LIMIT 500
    `).all() as { brandName?: string }[];
    for (const r of rows) {
      if (r?.brandName) {
        const raw = r.brandName.trim();
        const lower = raw.toLowerCase();
        if (raw && !knownBrandMap.has(lower)) {
          const formatted = (raw === raw.toUpperCase() && raw.length > 3)
            ? toTitleCase(raw)
            : raw;
          knownBrandMap.set(lower, formatted);
        }
      }
    }
  } catch {
    // Database query for catalog brands is optional/best-effort
  }

  const knownBrandNames = Array.from(knownBrandMap.values()).sort((a, b) => a.localeCompare(b));
  
  const brandsWithDomain = new Set<string>();
  const brandToPatternMap = new Map<string, string>();
  for (const site of allBrandSites) {
    const key = site.brandName.toLowerCase().trim();
    if (site.domain) {
      brandsWithDomain.add(key);
    }
    if (site.urlPattern && !brandToPatternMap.has(key)) {
      brandToPatternMap.set(key, site.urlPattern);
    }
  }

  const advisoryProfiles = listBrandAdvisoryProfiles(workspaceId);
  const brandToRoutingMap = new Map<string, { preferredDistributorIds: string[]; sourcingPolicy: string }>();
  for (const profile of advisoryProfiles) {
    const key = profile.brand.toLowerCase().trim();
    brandToRoutingMap.set(key, {
      preferredDistributorIds: profile.preferredDistributorIds ?? [],
      sourcingPolicy: profile.sourcingPolicy ?? 'preferred_then_fallback',
    });
  }

  const connections = listConnectionsByWorkspace(workspaceId, false);
  const availableDistributors: PreflightAvailableDistributor[] = connections.map((c) => ({
    id: c.id,
    distributorId: c.distributorId,
    connectorType: c.connectorType,
    enabled: c.enabled,
  }));

  // 2. Classify items
  let brandResolvedCount = 0;
  let ambiguousBrandCount = 0;
  let missingBrandCount = 0;
  let domainMappedCount = 0;
  let distributorRoutedCount = 0;

  const readyItemIds: string[] = [];
  const heldItemIds: string[] = [];

  // Grouping structures
  const unassignedByBrandKey = new Map<string, {
    suggestedBrand: string | null;
    itemIds: string[];
    sampleNames: string[];
    sampleProducts: { id: string; name: string; upc: string | null; sku: string | null }[];
  }>();
  const missingDomainByBrand = new Map<string, {
    brand: string;
    itemIds: string[];
    sampleNames: string[];
    sampleProducts: { id: string; name: string; upc: string | null; sku: string | null }[];
  }>();
  const unroutedByBrand = new Map<string, {
    brand: string;
    itemIds: string[];
    sampleNames: string[];
    sampleProducts: { id: string; name: string; upc: string | null; sku: string | null }[];
  }>();

  for (const item of items) {
    const rawBrand = item.brandHint?.trim() || null;
    const isBrandAssigned = !!rawBrand;

    if (isBrandAssigned) {
      brandResolvedCount++;
      const normBrand = rawBrand!.toLowerCase();

      // Check official domain
      if (brandsWithDomain.has(normBrand)) {
        domainMappedCount++;
      } else {
        const canonicalBrand = knownBrandMap.get(normBrand) || rawBrand!;
        const existing = missingDomainByBrand.get(normBrand) ?? {
          brand: canonicalBrand,
          itemIds: [],
          sampleNames: [],
          sampleProducts: [],
        };
        existing.itemIds.push(item.id);
        if (existing.sampleProducts.length < 10) {
          existing.sampleProducts.push({
            id: item.id,
            name: item.name,
            upc: item.upc || null,
            sku: item.existingSku || null,
          });
        }
        if (existing.sampleNames.length < 10) {
          existing.sampleNames.push(item.name);
        }
        missingDomainByBrand.set(normBrand, existing);
      }

      // Check distributor routing
      const routing = brandToRoutingMap.get(normBrand);
      if (routing && routing.preferredDistributorIds.length > 0) {
        distributorRoutedCount++;
      } else {
        const canonicalBrand = knownBrandMap.get(normBrand) || rawBrand!;
        const existing = unroutedByBrand.get(normBrand) ?? {
          brand: canonicalBrand,
          itemIds: [],
          sampleNames: [],
          sampleProducts: [],
        };
        existing.itemIds.push(item.id);
        if (existing.sampleProducts.length < 10) {
          existing.sampleProducts.push({
            id: item.id,
            name: item.name,
            upc: item.upc || null,
            sku: item.existingSku || null,
          });
        }
        if (existing.sampleNames.length < 10) {
          existing.sampleNames.push(item.name);
        }
        unroutedByBrand.set(normBrand, existing);
      }

      // Item with assigned brand is considered ready for controlled start
      readyItemIds.push(item.id);
    } else {
      // Missing brand hint: attempt candidate suggestion from product name
      const suggested = extractCandidateBrand(item.name, knownBrandNames);

      if (suggested) {
        ambiguousBrandCount++;
      } else {
        missingBrandCount++;
      }

      const groupKey = suggested ? `suggested:${suggested.toLowerCase()}` : 'unassigned:other';
      const existing = unassignedByBrandKey.get(groupKey) ?? {
        suggestedBrand: suggested,
        itemIds: [],
        sampleNames: [],
        sampleProducts: [],
      };
      existing.itemIds.push(item.id);
      if (existing.sampleProducts.length < 10) {
        existing.sampleProducts.push({
          id: item.id,
          name: item.name,
          upc: item.upc || null,
          sku: item.existingSku || null,
        });
      }
      if (existing.sampleNames.length < 10) {
        existing.sampleNames.push(item.name);
      }
      unassignedByBrandKey.set(groupKey, existing);

      // Unassigned brand items are held by default
      heldItemIds.push(item.id);
    }
  }

  // 3. Transform blockers
  const needsBrandGroups: PreflightBrandGroup[] = Array.from(unassignedByBrandKey.entries()).map(([key, data]) => ({
    key,
    suggestedBrand: data.suggestedBrand,
    itemCount: data.itemIds.length,
    itemIds: data.itemIds,
    sampleProductNames: data.sampleNames,
    sampleProducts: data.sampleProducts,
  })).sort((a, b) => b.itemCount - a.itemCount);

  const missingDomainBrands: PreflightDomainBlocker[] = Array.from(missingDomainByBrand.values()).map((data) => ({
    brand: data.brand,
    itemCount: data.itemIds.length,
    itemIds: data.itemIds,
    urlPattern: brandToPatternMap.get(data.brand.toLowerCase()) || null,
    sampleProductNames: data.sampleNames,
    sampleProducts: data.sampleProducts,
  })).sort((a, b) => b.itemCount - a.itemCount);

  const unroutedBrands: PreflightRoutingBlocker[] = Array.from(unroutedByBrand.values()).map((data) => {
    const profile = brandToRoutingMap.get(data.brand.toLowerCase());
    return {
      brand: data.brand,
      itemCount: data.itemIds.length,
      itemIds: data.itemIds,
      sampleProductNames: data.sampleNames,
      sampleProducts: data.sampleProducts,
      preferredDistributorIds: profile?.preferredDistributorIds ?? [],
      sourcingPolicy: (profile?.sourcingPolicy as 'advisory' | 'preferred_then_fallback' | 'preferred_only') ?? 'preferred_then_fallback',
    };
  }).sort((a, b) => b.itemCount - a.itemCount);

  const readyCount = readyItemIds.length;
  const heldCount = totalItems - readyCount;

  return {
    batchId: batch.id,
    batchName: batch.name,
    executionState: batch.executionState,
    totalItems,
    readyCount,
    heldCount,
    readyItemIds,
    heldItemIds,
    metrics: {
      brandResolvedCount,
      brandResolvedPercent: totalItems > 0 ? Math.round((brandResolvedCount / totalItems) * 100) : 0,
      ambiguousBrandCount,
      missingBrandCount,
      domainMappedCount,
      domainMappedPercent: totalItems > 0 ? Math.round((domainMappedCount / totalItems) * 100) : 0,
      missingDomainBrandCount: missingDomainBrands.length,
      distributorRoutedCount,
      distributorRoutedPercent: totalItems > 0 ? Math.round((distributorRoutedCount / totalItems) * 100) : 0,
      unroutedBrandCount: unroutedBrands.length,
    },
    blockers: {
      needsBrandGroups,
      missingDomainBrands,
      unroutedBrands,
    },
    availableDistributors,
    knownBrands: knownBrandNames,
  };
}