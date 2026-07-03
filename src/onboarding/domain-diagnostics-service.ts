/**
 * Domain Diagnostics — read-only aggregation service.
 *
 * Builds a snapshot of every known domain's profile, sitemap, health,
 * brand, and generated-profile signals for the Onboarding Pipeline
 * Settings page. The service is intentionally side-effect free:
 *
 *   - It does not call `getDomainStatus()` (which deletes stale rows).
 *   - It does not call `getCachedSitemapUrls()` (which deletes expired
 *     sitemap rows). It uses the new read-only `listAllSitemapCaches()`
 *     instead.
 *   - It does not trigger any network fetch, source discovery, page
 *     extraction, profile generation, profile validation, or
 *     status/cache writes.
 *
 * The function is pure with respect to its inputs: given the same
 * database contents and `now` value, it produces the same output.
 * The `now` parameter is exported mainly so tests can pin timestamps
 * deterministically.
 */

import { listAllProfiles } from '../db/repositories/extractor-profile-repo';
import { listAllBrandSites } from '../db/repositories/brand-site-repo';
import { listAllDomainStatuses } from '../db/repositories/domain-status-repo';
import {
  listAllSitemapCaches,
  type SitemapCacheRow,
} from '../db/repositories/sitemap-cache-repo';
import {
  listProfileGenerationDomainSummaries,
  type ProfileGenerationDomainSummary,
} from '../db/repositories/profile-generation-repo';
import type {
  BrandSite,
  DomainDiagnosticsBrandAssociation,
  DomainDiagnosticsEntry,
  DomainDiagnosticsResponse,
  DomainHealthStatus,
  ExtractorProfile,
} from '../shared/schemas/onboarding';

// ─── Staleness rules ──────────────────────────────────────────────────────────

/** Mirrors `domain-status-repo.ts` intent: a health row is stale if
 *  the `checked_at` timestamp is missing, unparseable, or more than
 *  7 days older than `now`. Diagnostics reports the flag but never
 *  deletes the row. */
const HEALTH_STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A sitemap cache row is stale if its `expires_at` is missing,
 *  unparseable, or at or before `now`. */
function isSitemapStale(row: SitemapCacheRow, now: Date): boolean {
  if (!row.sitemapExpiresAt) return true;
  const parsed = Date.parse(row.sitemapExpiresAt);
  if (Number.isNaN(parsed)) return true;
  return parsed <= now.getTime();
}

function isHealthStale(checkedAt: string | null, now: Date): boolean {
  if (!checkedAt) return true;
  const parsed = Date.parse(checkedAt);
  if (Number.isNaN(parsed)) return true;
  return now.getTime() - parsed > HEALTH_STALE_WINDOW_MS;
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

interface DomainAccumulator {
  domain: string;
  profiles: ExtractorProfile[];
  sitemap: SitemapCacheRow | null;
  healthRow: ReturnType<typeof listAllDomainStatuses>[number] | null;
  brandSites: BrandSite[];
  generation: ProfileGenerationDomainSummary | null;
}

function pickActiveProfile(profiles: ExtractorProfile[]): ExtractorProfile | null {
  if (profiles.length === 0) return null;
  // The repository normalizes domains, so each domain has at most one
  // row. Be defensive anyway and prefer the most recently updated row.
  return profiles.reduce((latest, current) =>
    Date.parse(current.updatedAt) >= Date.parse(latest.updatedAt) ? current : latest,
  );
}

function buildBrandAssociations(sites: BrandSite[]): DomainDiagnosticsBrandAssociation[] {
  return sites.map((site) => ({
    id: site.id,
    brandName: site.brandName,
    successCount: site.successCount,
    lastUsedAt: site.lastUsedAt,
  }));
}

function deriveHealthStatus(
  row: DomainAccumulator['healthRow'],
): DomainHealthStatus {
  if (!row) return 'unknown';
  // The persisted enum does not include 'unknown'; that status is
  // only used to indicate "no row at all".
  return row.status;
}

function buildEntry(acc: DomainAccumulator, now: Date): DomainDiagnosticsEntry {
  const profile = pickActiveProfile(acc.profiles);
  const sitemap = acc.sitemap;
  const sitemapStale = sitemap ? isSitemapStale(sitemap, now) : false;
  const healthCheckedAt = acc.healthRow?.checkedAt ?? null;
  const healthStale = acc.healthRow ? isHealthStale(healthCheckedAt, now) : false;

  return {
    domain: acc.domain,
    hasActiveProfile: profile !== null,
    activeProfileId: profile ? profile.id : null,
    profileUpdatedAt: profile ? profile.updatedAt : null,
    sitemapUrlsCount: sitemap ? sitemap.sitemapUrlsCount : 0,
    sitemapFetchedAt: sitemap ? sitemap.sitemapFetchedAt : null,
    sitemapExpiresAt: sitemap ? sitemap.sitemapExpiresAt : null,
    sitemapSourceUrl: sitemap ? sitemap.sitemapSourceUrl : null,
    sitemapStale,
    healthStatus: deriveHealthStatus(acc.healthRow),
    healthCheckedAt,
    healthReason: acc.healthRow?.reason ?? null,
    healthStale,
    brandAssociations: buildBrandAssociations(acc.brandSites),
    generationCount: acc.generation?.generationCount ?? 0,
    latestGenerationStatus: acc.generation?.latestGenerationStatus ?? null,
    latestGenerationAt: acc.generation?.latestGenerationAt ?? null,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a single diagnostics entry for every known domain. The
 * domain universe is the union of domains present in any of the
 * five read-only source tables. Entries are sorted by domain
 * ascending so the response is deterministic for both UI rendering
 * and tests.
 */
export function buildDomainDiagnostics(now: Date = new Date()): DomainDiagnosticsEntry[] {
  const profiles = listAllProfiles();
  const brandSites = listAllBrandSites();
  const domainStatuses = listAllDomainStatuses();
  const sitemapCaches = listAllSitemapCaches();
  const generations = listProfileGenerationDomainSummaries();

  const byDomain = new Map<string, DomainAccumulator>();

  const ensure = (domain: string): DomainAccumulator => {
    let acc = byDomain.get(domain);
    if (!acc) {
      acc = {
        domain,
        profiles: [],
        sitemap: null,
        healthRow: null,
        brandSites: [],
        generation: null,
      };
      byDomain.set(domain, acc);
    }
    return acc;
  };

  for (const profile of profiles) {
    ensure(profile.domain).profiles.push(profile);
  }
  for (const cache of sitemapCaches) {
    ensure(cache.domain).sitemap = cache;
  }
  for (const status of domainStatuses) {
    ensure(status.domain).healthRow = status;
  }
  for (const brand of brandSites) {
    ensure(brand.domain).brandSites.push(brand);
  }
  for (const summary of generations) {
    ensure(summary.domain).generation = summary;
  }

  const entries: DomainDiagnosticsEntry[] = [];
  for (const acc of byDomain.values()) {
    entries.push(buildEntry(acc, now));
  }
  entries.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return entries;
}

/**
 * Wrap `buildDomainDiagnostics()` in the public response envelope.
 * The route layer is expected to call this directly; the `now`
 * parameter is overridable for tests.
 */
export function getDomainDiagnosticsResponse(
  now: Date = new Date(),
): DomainDiagnosticsResponse {
  return {
    entries: buildDomainDiagnostics(now),
    generatedAt: now.toISOString(),
  };
}
