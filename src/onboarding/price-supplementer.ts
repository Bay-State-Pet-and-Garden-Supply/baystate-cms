import { getApiKey } from '../db/repositories/api-key-repo';
import { getCachedSerperResults, insertSerperCache } from '../db/repositories/serper-cache-repo';

interface SupplementalPrice {
  price: string | null;
  sourceUrl: string | null;
}

/**
 * Searches Serper.dev for a product's price across white-listed retailers
 * and uses a two-tier extraction:
 * 1. Checks Serper snippets/titles directly for dollar values (fast, zero-overhead, block-proof).
 * 2. Falls back to fast HTTP-only extraction on the top candidate.
 */
export async function supplementPrice(
  productName: string,
  extractViaHttpFn: (url: string) => Promise<{ price: string | null }>
): Promise<SupplementalPrice> {
  const apiKeyRow = getApiKey('serper');
  if (!apiKeyRow || !apiKeyRow.api_key) {
    console.warn('[PriceSupplementer] Serper.dev API key not configured. Skipping supplemental pricing pass.');
    return { price: null, sourceUrl: null };
  }

  // Construct a targeted query restricting results to major retailers
  const query = `${productName} price (site:chewy.com OR site:petco.com OR site:amazon.com)`;

  try {
    console.log(`[PriceSupplementer] Searching pricing for: "${productName}"`);
    
    let results: Array<{ link: string; title: string; snippet?: string }> = [];
    const cached = getCachedSerperResults(query);
    if (cached) {
      console.log(`[PriceSupplementer] Using cached Serper results for query: "${query}"`);
      results = cached;
    } else {
      const response = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKeyRow.api_key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: query,
          num: 5, // fetch top 5 results for better snippet parsing chance
        }),
      });

      if (!response.ok) {
        console.warn(`[PriceSupplementer] Serper query failed: ${response.statusText}`);
        return { price: null, sourceUrl: null };
      }

      const data = await response.json() as { organic?: Array<{ link: string; title: string; snippet?: string }> };
      results = data.organic ?? [];
      
      insertSerperCache(
        query,
        results.map((r, idx) => ({
          title: r.title,
          link: r.link,
          snippet: r.snippet ?? '',
          position: idx + 1,
        }))
      );
    }

    if (results.length === 0) {
      console.log('[PriceSupplementer] No pricing results found from Serper search.');
      return { price: null, sourceUrl: null };
    }

    // Tier 1: Check Serper title and snippets for a price pattern (e.g. "$14.99")
    // This is 100% block-proof and doesn't load any pages.
    for (const result of results) {
      const text = `${result.title} ${result.snippet ?? ''}`;
      // Match price pattern like $12.34 or $1,234.56
      const match = text.match(/\$(\d+(?:,\d{3})*(?:\.\d{2})?)/);
      if (match) {
        // Exclude generic low-value pricing (e.g., "$0.00" or "$0")
        const priceVal = parseFloat(match[1].replace(/,/g, ''));
        if (priceVal > 0.5) {
          console.log(`[PriceSupplementer] Found price in search snippet: $${priceVal.toFixed(2)} from ${result.link}`);
          return {
            price: `$${priceVal.toFixed(2)}`,
            sourceUrl: result.link,
          };
        }
      }
    }

    // Tier 2: Fall back to fetching candidate pages via HTTP if no snippet matches
    for (const result of results) {
      const url = result.link;
      if (/blog|forum|reddit|pinterest|instagram/i.test(url)) continue;

      console.log(`[PriceSupplementer] Falling back to fast HTTP price extraction for: ${url}`);
      try {
        const extraction = await extractViaHttpFn(url);
        if (extraction.price) {
          console.log(`[PriceSupplementer] Successfully found price via HTTP: ${extraction.price} at ${url}`);
          return {
            price: extraction.price,
            sourceUrl: url,
          };
        }
      } catch (err: any) {
        console.warn(`[PriceSupplementer] Fast HTTP extraction failed for ${url}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[PriceSupplementer] Failed to supplement price:', err);
  }

  return { price: null, sourceUrl: null };
}
