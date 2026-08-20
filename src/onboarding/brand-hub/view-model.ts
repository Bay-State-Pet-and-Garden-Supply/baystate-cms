// story: e35s10 — thin view-model: domain-keyed join of extractor profile + sitemap/brand-url signals
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';
import type { DomainUrlCounts } from '../../db/repositories/brand-url-index-repo';
import type { DomainSitemapHealthSummary } from '../sitemap-health-evaluator';
import type { BrandSite } from '../../shared/schemas/onboarding';
import { normalizeBrandHubDomain } from './normalizeDomain';

export type BrandHubProfileStatus = 'missing' | 'partial' | 'complete';

export interface BrandHubRow {
  domain: string;
  normalizedDomain: string;
  profile: {
    exists: boolean;
    status: BrandHubProfileStatus;
    sitemapProductUrlPattern: string | null;
    runtime: 'static' | 'rendered' | null;
  };
  sitemap: {
    status: string;
    needsAttention: boolean;
    attentionReasons: string[];
    lastRefreshedAt: string | null;
  } | null;
  urlCounts: DomainUrlCounts;
  brandAssociations: BrandSite[];
}

export { normalizeBrandHubDomain };

function deriveProfileStatus(profile: ExtractorProfile | null): BrandHubProfileStatus {
  if (!profile) return 'missing';
  if (profile.titleSelector && (profile.descriptionSelector || profile.imagesSelector)) return 'complete';
  return 'partial';
}

/**
 * Pure derivation: compose per-domain signals into a Brand Hub row.
 * Read-only — no writes, no DB access. Callers filter brandSites for the domain before passing.
 */
// story: e35s10
export function deriveBrandHubRow(params: {
  domain: string;
  profile: ExtractorProfile | null;
  urlCounts: DomainUrlCounts;
  health: DomainSitemapHealthSummary | null;
  brandSites: BrandSite[];
}): BrandHubRow {
  const normalizedDomain = normalizeBrandHubDomain(params.domain);
  const status = deriveProfileStatus(params.profile);

  return {
    domain: normalizedDomain,
    normalizedDomain,
    profile: {
      exists: params.profile !== null,
      status,
      sitemapProductUrlPattern: params.profile?.sitemapProductUrlPattern ?? null,
      runtime: params.profile?.runtime ?? null,
    },
    sitemap: params.health
      ? {
          status: params.health.status,
          needsAttention: params.health.needsAttention,
          attentionReasons: [...params.health.attentionReasons],
          lastRefreshedAt: params.health.lastRefreshedAt,
        }
      : null,
    urlCounts: { ...params.urlCounts },
    brandAssociations: [...params.brandSites],
  };
}
