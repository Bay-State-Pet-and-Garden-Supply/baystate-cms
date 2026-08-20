// story: e35s10 — hub pattern edit delegates verbatim to extractor-profile repo
import { upsertProfile, type ExtractorProfile } from '../../db/repositories/extractor-profile-repo';
import { normalizeBrandHubDomain } from './normalizeDomain';

/**
 * Update sitemapProductUrlPattern via the canonical extractor-profile upsert.
 * Explicit null clears, undefined preserves, string replaces — delegated verbatim
 * so repo merge semantics stay single-sourced.
 */
export function updateBrandHubPattern(domain: string, pattern: string | null | undefined): ExtractorProfile {
  const normalizedDomain = normalizeBrandHubDomain(domain);
  if (!normalizedDomain) throw new Error('domain is required');
  return upsertProfile(normalizedDomain, { sitemapProductUrlPattern: pattern });
}
