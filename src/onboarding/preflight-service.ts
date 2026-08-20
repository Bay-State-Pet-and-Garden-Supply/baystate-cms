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
 * Extract candidate brand token (e.g. first word/prefix) from product name.
 */
function extractNamePrefix(name: string): string | null {
  if (!name) return null;
  const cleaned = name.trim();
  const match = cleaned.match(/^([A-Za-z0-9'&]+)/);
  if (!match) return null;
  const token = match[1].trim();
  if (token.length < 2 || /^\d+$/.test(token)) return null;
  return token.toUpperCase();
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

  // 1. Fetch reference authorities
  const allBrandSites = listAllBrandSites();
  const knownBrandNames = Array.from(new Set(allBrandSites.map((b) => b.brandName.toLowerCase().trim())));
  const brandToDomainMap = new Map<string, string[]>();
  for (const site of allBrandSites) {
    const key = site.brandName.toLowerCase().trim();
    const existing = brandToDomainMap.get(key) ?? [];
    if (!existing.includes(site.domain)) {
      existing.push(site.domain);
    }
    brandToDomainMap.set(key, existing);
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
  const unassignedByBrandKey = new Map<string, { suggestedBrand: string | null; itemIds: string[]; sampleNames: string[] }>();
  const missingDomainByBrand = new Map<string, { brand: string; itemIds: string[] }>();
  const unroutedByBrand = new Map<string, { brand: string; itemIds: string[] }>();

  for (const item of items) {
    const rawBrand = item.brandHint?.trim() || null;
    const isBrandAssigned = !!rawBrand;

    if (isBrandAssigned) {
      brandResolvedCount++;
      const normBrand = rawBrand!.toLowerCase();

      // Check official domain
      const domains = brandToDomainMap.get(normBrand);
      if (domains && domains.length > 0) {
        domainMappedCount++;
      } else {
        const existing = missingDomainByBrand.get(normBrand) ?? { brand: rawBrand!, itemIds: [] };
        existing.itemIds.push(item.id);
        missingDomainByBrand.set(normBrand, existing);
      }

      // Check distributor routing
      const routing = brandToRoutingMap.get(normBrand);
      if (routing && routing.preferredDistributorIds.length > 0) {
        distributorRoutedCount++;
      } else {
        const existing = unroutedByBrand.get(normBrand) ?? { brand: rawBrand!, itemIds: [] };
        existing.itemIds.push(item.id);
        unroutedByBrand.set(normBrand, existing);
      }

      // Item with assigned brand is considered ready for controlled start
      readyItemIds.push(item.id);
    } else {
      // Missing brand hint: attempt candidate suggestion from product name
      const matched = matchExistingBrand(item.name, knownBrandNames);
      const prefix = extractNamePrefix(item.name);
      const suggested = matched || prefix || null;

      if (suggested) {
        ambiguousBrandCount++;
      } else {
        missingBrandCount++;
      }

      const groupKey = suggested ? `suggested:${suggested.toUpperCase()}` : 'unassigned:other';
      const existing = unassignedByBrandKey.get(groupKey) ?? { suggestedBrand: suggested, itemIds: [], sampleNames: [] };
      existing.itemIds.push(item.id);
      if (existing.sampleNames.length < 3) {
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
  })).sort((a, b) => b.itemCount - a.itemCount);

  const missingDomainBrands: PreflightDomainBlocker[] = Array.from(missingDomainByBrand.values()).map((data) => ({
    brand: data.brand,
    itemCount: data.itemIds.length,
    itemIds: data.itemIds,
  })).sort((a, b) => b.itemCount - a.itemCount);

  const unroutedBrands: PreflightRoutingBlocker[] = Array.from(unroutedByBrand.values()).map((data) => {
    const profile = brandToRoutingMap.get(data.brand.toLowerCase());
    return {
      brand: data.brand,
      itemCount: data.itemIds.length,
      itemIds: data.itemIds,
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
  };
}