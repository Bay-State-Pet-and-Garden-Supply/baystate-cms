/**
 * Product URL identity helpers — variant-aware canonicalization.
 * Retains ?variant=, ?variation_id=, ?sku=, attribute_* etc.
 * Removes only known tracking params (utm_*, gclid, fbclid, msclkid).
 */

const TRACKING_PREFIXES = ['utm_'];
const TRACKING_EXACT = new Set(['gclid', 'fbclid', 'msclkid', 'gbraid', 'wbraid', 'dclid']);

const VARIANT_KEYS = new Set([
  'variant',
  'variation_id',
  'sku',
]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_EXACT.has(lower)) return true;
  for (const prefix of TRACKING_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

function isVariantParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (VARIANT_KEYS.has(lower)) return true;
  if (lower.startsWith('attribute_')) return true;
  if (lower.startsWith('option')) return true;
  if (lower.startsWith('options[')) return true;
  return false;
}

function normalizeUrlInternal(urlStr: string, keepVariant: boolean): string {
  const url = new URL(urlStr);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  url.hostname = url.hostname.toLowerCase();
  // remove default ports
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  // sort query params, strip tracking
  const params = new URLSearchParams(url.search);
  const kept: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    if (isTrackingParam(k)) continue;
    if (!keepVariant && isVariantParam(k)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  // normalize pathname dot segments via URL
  // keep fragment only if non-empty
  if (!url.hash || url.hash === '#') url.hash = '';
  // lowercase scheme/host already; keep path case
  return url.toString();
}

/**
 * Identity key that RETAINS variant params — use for source_url uniqueness.
 */
export function productUrlIdentityKey(urlStr: string): string {
  try {
    return normalizeUrlInternal(urlStr, true);
  } catch {
    return urlStr;
  }
}

/**
 * Parent key that REMOVES variant selectors — use to group sibling deep links.
 */
export function parentProductKey(urlStr: string): string {
  try {
    return normalizeUrlInternal(urlStr, false);
  } catch {
    return urlStr;
  }
}

/**
 * Build a variant deep link by replacing only that platform's variant keys
 * and retaining unrelated non-tracking params.
 */
export function buildVariantDeepLink(
  parentUrl: string,
  candidate: { deepLink?: string | null; platformId?: string | null; url?: string | null },
): string {
  const parent = new URL(parentUrl);
  let variantUrl: string | null = (candidate.deepLink as string | null) ?? (candidate.url as string | null) ?? null;
  if (candidate.platformId && !variantUrl) {
    // fallback: infer shopify style
    variantUrl = `${parent.origin}${parent.pathname}?variant=${candidate.platformId}`;
  }
  if (!variantUrl) return parentUrl;
  try {
    const v = new URL(variantUrl, parent.origin);
    // Remove old variant keys from parent, then apply variant's variant keys
    const parentParams = new URLSearchParams(parent.search);
    for (const k of Array.from(parentParams.keys())) {
      if (isVariantParam(k)) parentParams.delete(k);
    }
    const variantParams = new URLSearchParams(v.search);
    for (const [k, val] of variantParams.entries()) {
      if (isVariantParam(k)) parentParams.set(k, val);
    }
    // retain non-tracking non-variant parent params already in parentParams
    const filtered = new URLSearchParams();
    for (const [k, val] of parentParams.entries()) {
      if (isTrackingParam(k)) continue;
      filtered.append(k, val);
    }
    // also add any variant param not yet added (if v had non-variant? keep variant only)
    // rebuild url
    const out = new URL(parent.toString());
    out.search = filtered.toString() ? `?${filtered.toString()}` : '';
    // preserve variant hash if non-empty
    if (v.hash && v.hash !== '#') out.hash = v.hash;
    return productUrlIdentityKey(out.toString());
  } catch {
    return parentUrl;
  }
}

/**
 * Helper for tests: check if url has variant identity.
 */
export function hasVariantParam(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    for (const k of url.searchParams.keys()) {
      if (isVariantParam(k)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
