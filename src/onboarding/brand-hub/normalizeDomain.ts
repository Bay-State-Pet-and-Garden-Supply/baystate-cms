// story: e35s10 — canonical domain normalization (single source for brand hub + UI entry points)
// Mirrors normalizeDomain in brand-url-index-repo but pure and client-safe (no DB).
export function normalizeBrandHubDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
}

/**
 * Extracts both the canonical domain and optional product URL path pattern
 * when a user pastes a product page URL (e.g. https://companyofanimals.com/us/brand-product/baskerville-ultra-muzzle/ -> domain: companyofanimals.com, urlPattern: /brand-product/).
 */
export function extractDomainAndPattern(input: string): { domain: string; urlPattern?: string } {
  let raw = input.trim();
  if (!raw) return { domain: '' };

  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    if (raw.includes('/')) {
      raw = 'https://' + raw;
    }
  }

  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const domain = url.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = url.pathname;

    let urlPattern: string | undefined = undefined;
    if (pathname && pathname !== '/' && pathname.length > 1) {
      // 1. Strip trailing slashes
      const cleanPath = pathname.replace(/\/+$/, '');
      
      // 2. Strip optional 2-letter or region locale prefix (e.g. /us/, /en-us/, /ca/)
      const pathWithoutLocale = cleanPath.replace(/^\/(?:[a-z]{2}(?:-[a-z]{2})?)\//i, '/');
      
      // 3. Split into segments
      const segments = pathWithoutLocale.split('/').filter(Boolean);
      
      if (segments.length >= 2) {
        // Last segment is the product slug/item (e.g. baskerville-ultra-muzzle)
        const folderSegments = segments.slice(0, -1);
        
        // Check for specific product markers like brand-product, products, product, item, etc.
        const specificMatch = folderSegments.find((s) => /^(?:brand-products?|products?|items?|goods|catalog|shop|p)$/i.test(s));
        if (specificMatch) {
          urlPattern = `/${specificMatch}/`;
        } else {
          urlPattern = `/${folderSegments.join('/')}/`;
        }
      } else if (segments.length === 1) {
        urlPattern = `/${segments[0]}/`;
      }
    }

    return { domain, urlPattern };
  } catch {
    const cleanDomain = normalizeBrandHubDomain(raw);
    return { domain: cleanDomain };
  }
}

