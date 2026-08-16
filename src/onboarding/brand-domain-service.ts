/**
 * ADR 0017 — guarded brand→official-domain assignment (commitment 4).
 *
 * Shared by the per-item `assign_domain` discovery attention action and the
 * batch-level 'Resolve Brand Domains' setup panel. Both surfaces funnel
 * through `assignOfficialDomainForBrand` so the normalization, retailer/
 * distributor denylist guard, and `brand_sites` upsert can never diverge:
 *
 * - domain normalization is URL-tolerant and delegates to the discovery
 *   pipeline's single `normalizeDiscoveryDomain` path so stored values always
 *   match the authority gate's keys (strict exact-or-subdomain);
 * - blank/invalid input and known retailer/distributor domains fail closed
 *   with typed errors (the denylist is the reviewed override boundary —
 *   Settings → Domain Configuration remains the only reviewed path);
 * - success upserts the brand→domain mapping (`upsertBrandSite`, full
 *   replacement semantics) and reports the normalized result.
 */
import type { BrandSite } from '../shared/schemas/onboarding';
import { upsertBrandSite } from '../db/repositories/brand-site-repo';
import { normalizeDiscoveryDomain } from './domain-utils';
import { isKnownRetailerOrDistributorDomain } from './discovery/retailer-domain-list';

export type AssignOfficialDomainErrorCode = 'invalid_domain' | 'retailer_domain';

export interface AssignOfficialDomainSuccess {
  ok: true;
  /** Trimmed brand as passed by the caller (the upsert stores its own normalized form). */
  brand: string;
  /** Normalized bare domain persisted to `brand_sites`. */
  domain: string;
  site: BrandSite;
}

export interface AssignOfficialDomainFailure {
  ok: false;
  code: AssignOfficialDomainErrorCode;
  message: string;
}

export type AssignOfficialDomainResult = AssignOfficialDomainSuccess | AssignOfficialDomainFailure;

/**
 * Normalize an operator-supplied domain for `assign_domain`: tolerate
 * URL-shaped input ("https://www.frommfamily.com/…") down to the bare
 * hostname, stripping scheme/path/port/www so the stored `brand_sites`
 * value matches the `normalizeDiscoveryDomain` keys used by the authority
 * gate and sitemap targeting. Returns '' when the input cannot be reduced
 * to a bare hostname label.
 */
export function cleanAssignedDomain(raw: string): string {
  let token = raw.trim().toLowerCase();
  if (token.includes('://')) {
    try {
      token = new URL(token).hostname;
    } catch {
      return '';
    }
  }
  // Delegate the shared lowercase/trim/www-strip normalization to the
  // discovery pipeline's single normalization path so stored `brand_sites`
  // values always match the authority gate's `normalizeDiscoveryDomain` keys.
  return normalizeDiscoveryDomain(token.split('/')[0].split(':')[0]);
}

/** Bare-hostname shape expected of a stored `brand_sites` domain. */
const BARE_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Assign `domain` as the official brand domain for `brand` (ADR 0017
 * commitment 3+4 guards included). Never throws for operator input — every
 * rejection is a typed `ok: false` result the caller maps to HTTP 400.
 */
export function assignOfficialDomainForBrand(input: { brand: string; domain: string }): AssignOfficialDomainResult {
  const normalizedDomain = cleanAssignedDomain(input.domain);
  if (!normalizedDomain || !BARE_DOMAIN_RE.test(normalizedDomain)) {
    return {
      ok: false,
      code: 'invalid_domain',
      message: 'domain must be a valid bare domain or URL (e.g. frommfamily.com)',
    };
  }

  // ADR 0017 commitment 3 guard: retailer/distributor domains are never
  // mapped as official brand domains through the operator attention action
  // (the denylist is the reviewed override boundary — Settings → Domain
  // Configuration remains the only reviewed path). No upsert.
  if (isKnownRetailerOrDistributorDomain(normalizedDomain)) {
    return {
      ok: false,
      code: 'retailer_domain',
      message:
        'Retailer/distributor domains cannot be mapped as official brand domains via Assign Domain — use Settings → Domain Configuration for reviewed overrides',
    };
  }

  const brand = input.brand.trim();
  const site = upsertBrandSite(brand, normalizedDomain);
  return { ok: true, brand, domain: normalizedDomain, site };
}
