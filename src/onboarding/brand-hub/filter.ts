// story: e35s10 — unified hub filtering (single search + facets, read-only)
import type { BrandHubRow } from './view-model';

export interface BrandHubFilterOptions {
  search?: string;
  healthStatus?: string;
  profileStatus?: string;
  attentionOnly?: boolean;
}

function normalizeSearch(input: string | undefined): string {
  if (!input) return '';
  return input.trim().toLowerCase();
}

function rowMatchesSearch(row: BrandHubRow, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  if (row.domain.toLowerCase().includes(normalizedSearch)) return true;
  if (row.normalizedDomain.toLowerCase().includes(normalizedSearch)) return true;
  for (const b of row.brandAssociations) {
    if (b.brandName.toLowerCase().includes(normalizedSearch)) return true;
  }
  return false;
}

function rowMatchesHealth(row: BrandHubRow, healthStatus: string | undefined): boolean {
  if (!healthStatus) return true;
  return row.sitemap?.status === healthStatus;
}

function rowMatchesProfile(row: BrandHubRow, profileStatus: string | undefined): boolean {
  if (!profileStatus) return true;
  return row.profile.status === profileStatus;
}

function rowMatchesAttention(row: BrandHubRow, attentionOnly: boolean | undefined): boolean {
  if (!attentionOnly) return true;
  return !!row.sitemap?.needsAttention;
}

/**
 * Pure filter: single domain+brand search plus health/profile/attention facets,
 * all applied uniformly with AND semantics. No mutation.
 */
export function filterBrandHubRows(rows: BrandHubRow[], opts: BrandHubFilterOptions): BrandHubRow[] {
  const search = normalizeSearch(opts.search);
  return rows.filter(
    (r) =>
      rowMatchesSearch(r, search) &&
      rowMatchesHealth(r, opts.healthStatus) &&
      rowMatchesProfile(r, opts.profileStatus) &&
      rowMatchesAttention(r, opts.attentionOnly),
  );
}
