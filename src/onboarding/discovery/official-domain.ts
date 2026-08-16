/**
 * Official-domain matching for candidate ranking (epic #46 follow-up, GPT
 * plan phase 6).
 *
 * `scoreBrandDomainMatch` gives a conservative 0..1 similarity between a
 * brand and a candidate domain — used as a RANKING BIAS only. Auto-selection
 * stays gated by the page verifier; a brand-like domain never auto-verifies
 * on its own. Generic pet-store words ("pet", "dog", "store", "shop"…) never
 * count as a brand match.
 */
/** Generic tokens that must not alone constitute a brand match. */
export const GENERIC_BRAND_TOKENS: ReadonlySet<string> = new Set([
  'pet', 'pets', 'dog', 'dogs', 'cat', 'cats', 'natural', 'healthy', 'health',
  'store', 'shop', 'supply', 'supplies', 'food', 'feed', 'farm', 'market',
  'online', 'express', 'plus', 'pro', 'best', 'value', 'wholesale',
]);

/** Brand → comparison slug (lowercase, non-alphanumerics stripped). */
export function normalizeBrandForDomainMatch(brand: string): string {
  return brand.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Domain → comparison label (second-level registrable-ish label). */
export function domainMatchLabel(domain: string): string {
  const normalized = domain.toLowerCase().replace(/^www\./, '').trim();
  const parts = normalized.split('.');
  // shop.dogkrazy.com → dogkrazy; co.uk-style tails are rare here and the
  // label is only used for substring similarity — take the second-to-last
  // part when the host has 3+ labels, else the first.
  return parts.length >= 3 ? parts[parts.length - 2] : parts[0] ?? '';
}

/**
 * 0..1 brand↔domain similarity:
 * - 1.0  — the full brand slug appears inside the domain's main label
 *          (e.g. "fromm" in "frommfamily") and the brand is not generic;
 * - 0.5  — every non-generic brand word appears inside the main label
 *          (multi-word brands, order-insensitive);
 * - 0    — no match or the brand is a generic token.
 */
export function scoreBrandDomainMatch(brand: string | null | undefined, domain: string): number {
  if (!brand || !brand.trim() || !domain) return 0;
  const brandSlug = normalizeBrandForDomainMatch(brand);
  if (!brandSlug || GENERIC_BRAND_TOKENS.has(brandSlug)) return 0;
  const label = domainMatchLabel(domain);
  if (!label) return 0;
  if (label.includes(brandSlug)) return 1;
  const words = brand.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const meaningful = words.filter(w => !GENERIC_BRAND_TOKENS.has(w));
  if (meaningful.length === 0) return 0;
  if (meaningful.every(w => label.includes(w))) return 0.5;
  return 0;
}
