import type { ExtractionData } from '../shared/schemas/onboarding';

export interface ValidationResult {
  valid: boolean;
  status: 'ok' | 'blocked' | 'offline' | 'mismatch';
  reason: string | null;
  confidence: number;
}

// Common English stop words to filter out before word overlap calculation
const STOP_WORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
  'from', 'up', 'about', 'into', 'over', 'after', 'dog', 'cat', 'pet', 'food', 'toy', 'treat'
]);

// Common patterns indicating the page is offline, down, or blocked
const DEAD_PAGE_PATTERNS = [
  /store is currently unavailable/i,
  /coming soon/i,
  /under maintenance/i,
  /page not found/i,
  /404/i,
  /no longer available/i,
  /site maintenance/i,
  /temporarily down/i
];

const BLOCKED_PAGE_PATTERNS = [
  /sorry, you have been blocked/i,
  /access denied/i,
  /cloudflare/i,
  /attention required/i,
  /security check/i,
  /bot verification/i,
  /please verify you are a human/i
];

/**
 * Extract domain name from a URL or hostname.
 */
function extractDomain(urlOrHost: string): string {
  try {
    const urlStr = urlOrHost.startsWith('http') ? urlOrHost : `http://${urlOrHost}`;
    const parsed = new URL(urlStr);
    return parsed.hostname.replace(/^www\./, '').toLowerCase().trim();
  } catch {
    return urlOrHost.toLowerCase().replace(/^www\./, '').trim();
  }
}

/**
 * Validates extracted product data against the expected name and brand.
 * Categorizes failure types (blocked, offline, mismatch) and calculates a validation confidence score.
 */
export function validateExtraction(
  extracted: Partial<ExtractionData>,
  expected: { name: string; brandHint?: string | null; domain?: string | null }
): ValidationResult {
  const title = (extracted.title ?? '').trim();
  const url = (extracted.sourceUrl ?? '').toLowerCase();

  // 1. Check for empty title
  if (!title) {
    return {
      valid: false,
      status: 'offline',
      reason: 'Extracted title is empty',
      confidence: 0,
    };
  }

  // 2. Check for Cloudflare/WAF block indicators in the title
  for (const pattern of BLOCKED_PAGE_PATTERNS) {
    if (pattern.test(title)) {
      return {
        valid: false,
        status: 'blocked',
        reason: `Access blocked: matches pattern "${pattern.source}"`,
        confidence: 0,
      };
    }
  }

  // 3. Check for Dead page / Offline indicators in the title
  for (const pattern of DEAD_PAGE_PATTERNS) {
    if (pattern.test(title)) {
      return {
        valid: false,
        status: 'offline',
        reason: `Dead page: matches pattern "${pattern.source}"`,
        confidence: 0,
      };
    }
  }

  // 4. Heuristic Title Match / Mismatch check
  const cleanTitle = title.toLowerCase();
  const expectedName = expected.name.toLowerCase();
  const brand = (expected.brandHint ?? '').toLowerCase().trim();

  // If the page is a generic store page (e.g. just lists collections or lists login)
  if (cleanTitle === 'login' || cleanTitle === 'customer login' || cleanTitle === 'shopify' || cleanTitle === 'error') {
    return {
      valid: false,
      status: 'offline',
      reason: `Generic or error page: title is "${title}"`,
      confidence: 0,
    };
  }

  // Determine if we are on the brand's official domain
  let isOnBrandDomain = false;
  if (url) {
    const pageDomain = extractDomain(url);
    if (expected.domain) {
      const targetDomain = extractDomain(expected.domain);
      isOnBrandDomain = pageDomain.includes(targetDomain) || targetDomain.includes(pageDomain);
    }
    if (!isOnBrandDomain && brand) {
      const normalizedBrand = brand.replace(/\s+/g, '');
      isOnBrandDomain = pageDomain.includes(normalizedBrand);
    }
  }

  // Calculate word overlap
  const getWords = (str: string) =>
    str
      .replace(/[^\w\s-]/g, '') // remove punctuation
      .split(/[\s-]+/)
      .map(w => w.trim())
      // Keep words of length > 2, OR length > 1 if we are matching brand/critical tags
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  const expectedWords = getWords(expectedName);

  if (expectedWords.length === 0) {
    return {
      valid: true,
      status: 'ok',
      reason: null,
      confidence: 0.5,
    };
  }

  // Count how many expected words are present in the extracted title
  const matchingWords = expectedWords.filter(w => cleanTitle.includes(w));
  const overlapRatio = matchingWords.length / expectedWords.length;

  // Check if the brand name is present
  const brandInTitle = brand && cleanTitle.includes(brand);

  // Match decision threshold:
  // If we are on the brand's official domain, we are more lenient since they don't prefix their brand name to every product page.
  const threshold = isOnBrandDomain ? 0.15 : 0.25;
  const requireBrand = !isOnBrandDomain;

  const isMismatch = (overlapRatio < threshold && !(brandInTitle && overlapRatio > 0)) || matchingWords.length === 0 || (requireBrand && brand && !brandInTitle && overlapRatio < 0.5);

  if (isMismatch) {
    return {
      valid: false,
      status: 'mismatch',
      reason: `Catalog mismatch: title "${title}" has only ${Math.round(overlapRatio * 100)}% word overlap with expected name "${expected.name}" (threshold: ${threshold * 100}%, isOnBrandDomain: ${isOnBrandDomain})`,
      confidence: overlapRatio,
    };
  }

  // Calculate a match confidence score based on overlap and brand inclusion
  let confidence = overlapRatio;
  if (brandInTitle || isOnBrandDomain) {
    confidence = Math.min(1.0, confidence + 0.25);
  }

  return {
    valid: true,
    status: 'ok',
    reason: null,
    confidence: Math.round(confidence * 100) / 100,
  };
}
