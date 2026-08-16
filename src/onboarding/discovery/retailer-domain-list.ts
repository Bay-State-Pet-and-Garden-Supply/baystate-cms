/**
 * Known retailer/distributor domains (epic #46 follow-up, GPT plan phase 6).
 *
 * Conservative demotion list seeded from the live batch's weak discovery
 * candidates (retailer/distributor pages that dominated URL-verification
 * attention). Candidates on these domains are DEMOTED in ranking, never
 * discarded — a retailer page can still be a useful fallback.
 */
export const KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS: ReadonlySet<string> = new Set([
  'chewy.com',
  'petco.com',
  'petsmart.com',
  'shop.dogkrazy.com',
  'theproperpet.com',
  'shop.barkandluv.com',
  'pacificpet.net',
  'burlopet.com',
  'net32.com',
  'zeiglersdist.com',
  'pood.bluepetfood.eu',
]);

/** Normalize a candidate URL's domain for list lookup (lowercase, strip www). */
export function normalizeDomainForLookup(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

export function isKnownRetailerOrDistributorDomain(domain: string): boolean {
  return KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS.has(normalizeDomainForLookup(domain));
}
