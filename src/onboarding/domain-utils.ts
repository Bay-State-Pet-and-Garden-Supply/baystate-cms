/**
 * Shared domain-matching utilities used by the discovery pipeline,
 * auto-selection policy, and page verifier.
 *
 * Kept in a dependency-free module so every consumer can import it
 * without creating import cycles between job-queue, source-discovery,
 * and page-verifier.
 */

/**
 * Normalize a domain for comparison: lowercase, trim, strip leading `www.`.
 * Returns an empty string for null/undefined/whitespace input.
 */
export function normalizeDiscoveryDomain(domain: string | null | undefined): string {
  if (!domain) return '';
  return domain.toLowerCase().trim().replace(/^www\./, '');
}

/**
 * True when the candidate domain matches an official mapped brand domain
 * via exact equality or a subdomain suffix (e.g. `us.mywoof.com` matches
 * `mywoof.com`). Broad `includes()` matching is intentionally NOT used to
 * avoid unrelated domains such as `notmywoof.com` matching `mywoof.com`.
 */
export function isOfficialDomainMatch(
  candidateDomain: string | null | undefined,
  officialDomain: string | null | undefined,
): boolean {
  const candidate = normalizeDiscoveryDomain(candidateDomain);
  const official = normalizeDiscoveryDomain(officialDomain);
  if (!candidate || !official) return false;
  return candidate === official || candidate.endsWith('.' + official);
}
