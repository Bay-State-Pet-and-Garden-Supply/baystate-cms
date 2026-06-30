/**
 * Longest Common Substring extractor for deriving consensus product names
 * from multiple marketplace search result titles.
 *
 * Given titles like:
 *   - "Woof Honest Chew Natural Antler Dog Chew, Small - Amazon.com"
 *   - "Woof Honest Chew Antler Small | Chewy"
 *   - "Woof HonestChew Antler Sm Dog Treat | Petco"
 *
 * Extracts a consensus name like "Woof Honest Chew" or similar.
 */

/**
 * Common site name suffixes to strip from search result titles.
 */
const SITE_SUFFIXES = [
  / [-–—|:] Amazon\.com$/i,
  / [-–—|:] Chewy\.com$/i,
  / [-–—|:] Chewy$/i,
  / [-–—|:] Walmart\.com$/i,
  / [-–—|:] Target$/i,
  / [-–—|:] Petco$/i,
  / [-–—|:] PetSmart$/i,
  / [-–—|:] eBay$/i,
  / [-–—|:] iHerb$/i,
  / [-–—|:]?\s*(?:Shop|Buy)\s+(?:Online|Now).*$/i,
  / [-–—|:]\s*[A-Za-z]+\.com$/i, // Generic "- SomeSite.com" fallback
];

/**
 * Strip common site name suffixes from a search result title.
 */
export function stripSiteSuffix(title: string): string {
  let cleaned = title.trim();
  for (const pattern of SITE_SUFFIXES) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.trim();
}

/**
 * Find the longest common substring between two strings.
 * Uses dynamic programming. Case-insensitive comparison, returns the
 * substring from `a` (preserving original casing).
 */
function longestCommonSubstring(a: string, b: string): string {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  const m = al.length;
  const n = bl.length;

  // Optimization: bail early for very short strings
  if (m === 0 || n === 0) return '';

  // DP row (space-optimized: only need current and previous row)
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);
  let maxLen = 0;
  let endIdx = 0;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (al[i - 1] === bl[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > maxLen) {
          maxLen = curr[j];
          endIdx = i;
        }
      } else {
        curr[j] = 0;
      }
    }
    // Swap rows
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  return a.slice(endIdx - maxLen, endIdx);
}

/**
 * Extract a consensus product name from multiple search result titles.
 *
 * Strategy:
 * 1. Strip site name suffixes from all titles
 * 2. Find pairwise longest common substrings
 * 3. Return the most frequently occurring long substring
 *
 * @param titles - Array of search result titles (at least 2 required)
 * @param minLength - Minimum character length for a valid consensus (default 10)
 * @returns The consensus product name, or null if no meaningful consensus found
 */
export function extractConsensusName(
  titles: string[],
  minLength = 10,
): string | null {
  if (titles.length < 2) return null;

  // Clean titles
  const cleaned = titles.map(stripSiteSuffix).filter(t => t.length > 0);
  if (cleaned.length < 2) return null;

  // Find pairwise LCS across all title pairs
  const candidates: Map<string, number> = new Map();

  for (let i = 0; i < cleaned.length; i++) {
    for (let j = i + 1; j < cleaned.length; j++) {
      const lcs = longestCommonSubstring(cleaned[i], cleaned[j]).trim();
      if (lcs.length >= minLength) {
        // Normalize for counting (lowercase)
        const key = lcs.toLowerCase();
        candidates.set(key, (candidates.get(key) ?? 0) + 1);
      }
    }
  }

  if (candidates.size === 0) return null;

  // Sort by frequency (descending), then by length (descending)
  const sorted = [...candidates.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0].length - a[0].length;
  });

  const bestKey = sorted[0][0];

  // Find the original-cased version from cleaned titles
  for (const title of cleaned) {
    const idx = title.toLowerCase().indexOf(bestKey);
    if (idx !== -1) {
      const original = title.slice(idx, idx + bestKey.length).trim();
      // Clean up: remove trailing punctuation, size codes, etc.
      return cleanProductName(original);
    }
  }

  return cleanProductName(bestKey);
}

/**
 * Clean up an extracted product name:
 * - Remove trailing commas, dashes, pipes
 * - Remove trailing UPC/EAN digits
 * - Remove trailing common noise
 */
function cleanProductName(name: string): string {
  let cleaned = name.trim();

  // Remove trailing punctuation
  cleaned = cleaned.replace(/[,\-–—|:]+\s*$/, '').trim();

  // Remove leading punctuation
  cleaned = cleaned.replace(/^[,\-–—|:]+\s*/, '').trim();

  // Remove trailing long number sequences (UPCs bleeding in)
  cleaned = cleaned.replace(/\s+\d{8,}$/, '').trim();

  return cleaned || name.trim();
}
