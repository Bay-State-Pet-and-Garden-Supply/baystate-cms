/**
 * snapshotPreflight.ts — Conservative snapshot preflight for one-shot
 * selector generation.
 *
 * Inspects snapshot HTML for high-confidence unusable pages BEFORE an
 * expensive LLM call. Only rejects when multiple strong signals agree.
 *
 * Ambiguous conditions produce warnings and continue to generation.
 *
 * Uses Cheerio for DOM inspection (existing project dependency).
 */

import * as cheerio from 'cheerio';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PreflightReason =
  | 'LOGIN_PAGE_DETECTED'
  | 'ACCESS_DENIED_DETECTED'
  | 'CAPTCHA_DETECTED'
  | 'ERROR_PAGE_DETECTED'
  | 'INSUFFICIENT_CONTENT';

export interface SnapshotPreflightResult {
  /** Whether the snapshot is usable for selector generation. */
  usable: boolean;
  /** Why it was rejected (only set when usable === false). */
  reason?: PreflightReason;
  /** Non-blocking warnings about the snapshot content. */
  warnings: string[];
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Inspect a snapshot HTML document and determine if it is usable for
 * one-shot selector generation.
 *
 * Rejection is conservative — only when MULTIPLE strong signals agree.
 * Ambiguous pages continue with warnings.
 */
export function inspectSnapshot(html: string): SnapshotPreflightResult {
  if (!html || html.trim().length === 0) {
    return {
      usable: false,
      reason: 'INSUFFICIENT_CONTENT',
      warnings: ['Snapshot HTML is empty.'],
    };
  }

  const $ = cheerio.load(html);

  const title = extractTitle($);
  const visibleText = extractVisibleText($);
  const textLength = visibleText.length;

  // ── Signal detectors ───────────────────────────────────────────────

  const hasLoginTitle = /(?:log\s*(?:-|–|—)?\s*in|sign\s*(?:-|–|—)?\s*in|login|signin)/i.test(title);
  const hasAccessDeniedTitle = /access\s+denied|forbidden|unauthorized|blocked/i.test(title);
  const hasCaptchaTitle = /(?:captcha|just a moment|verify|security check)/i.test(title);
  const hasErrorTitle = /\b(?:500|503|error|unavailable|maintenance|down for)\b/i.test(title);

  const hasPasswordInput = $('input[type="password"]').length > 0;
  const hasLoginLink = $('a').filter((_, el) => {
    const text = $(el).text().toLowerCase();
    return /(?:log\s*(?:-|–|—)?\s*in|sign\s*(?:-|–|—)?\s*in|login)/i.test(text);
  }).length > 0;

  const hasCaptchaFrame = $('iframe').filter((_, el) => {
    const src = $(el).attr('src') || '';
    return /recaptcha|hcaptcha|turnstile|captcha/i.test(src);
  }).length > 0;

  const hasCaptchaClass = $('[class*="captcha"], [class*="recaptcha"], [id*="captcha"], [id*="recaptcha"]').length > 0;
  const hasCaptchaScript = $('script').filter((_, el) => {
    const src = $(el).attr('src') || '';
    return /recaptcha|hcaptcha|turnstile|captcha/i.test(src);
  }).length > 0;

  const hasProductHeading = $('h1').filter((_, el) => {
    const $el = $(el);
    const cls = ($el.attr('class') || '').toLowerCase();
    const itemprop = ($el.attr('itemprop') || '').toLowerCase();
    // Has a product-related class or itemprop
    return (
      /product|title|heading|name/i.test(cls) ||
      itemprop === 'name'
    );
  }).length > 0;

  const hasAnyH1 = $('h1').length > 0;
  const hasProductJsonLd = hasProductJsonLdInHtml(html);

  const hasServerErrorText = /\b(?:internal server error|500|503|service unavailable|maintenance mode|down for maintenance)\b/i.test(visibleText);

  const hasAccessDeniedText = /\b(?:access denied|access den?ied|403|forbidden|you do not have permission|not authorized)\b/i.test(visibleText);

  const hasProductSignals =
    hasProductHeading ||
    hasAnyH1 ||
    hasProductJsonLd ||
    /\b(?:price|product|brand|sku|upc)\b/i.test(visibleText);

  // ── Decision logic ──────────────────────────────────────────────────
  const warnings: string[] = [];

  // LOGIN_PAGE_DETECTED: login title + password input + no product signals
  if (hasLoginTitle && hasPasswordInput && !hasProductSignals) {
    return {
      usable: false,
      reason: 'LOGIN_PAGE_DETECTED',
      warnings: ['The captured page appears to be a login page rather than a product page.'],
    };
  }

  // ACCESS_DENIED_DETECTED: access denied title (strong single signal is enough)
  if (hasAccessDeniedTitle || (hasAccessDeniedText && !hasProductSignals)) {
    return {
      usable: false,
      reason: 'ACCESS_DENIED_DETECTED',
      warnings: ['The captured page appears to be an access-denied or error page.'],
    };
  }

  // CAPTCHA_DETECTED: captcha frame/class + no product signals
  if ((hasCaptchaFrame || hasCaptchaClass) && !hasProductSignals && !hasAnyH1) {
    return {
      usable: false,
      reason: 'CAPTCHA_DETECTED',
      warnings: ['The captured page appears to be blocked by a CAPTCHA or bot challenge.'],
    };
  }

  // ERROR_PAGE_DETECTED: small body + error title or error text
  if (textLength < 200 && (hasErrorTitle || hasServerErrorText)) {
    return {
      usable: false,
      reason: 'ERROR_PAGE_DETECTED',
      warnings: ['The captured page appears to be a server error page.'],
    };
  }

  // INSUFFICIENT_CONTENT: very small + no product signals at all
  if (textLength < 100 && !hasProductJsonLd && !hasAnyH1) {
    return {
      usable: false,
      reason: 'INSUFFICIENT_CONTENT',
      warnings: ['The captured page has insufficient content for selector generation.'],
    };
  }

  // ── Ambiguous conditions — continue with warnings ──────────────────

  // Product page with login link in nav
  if (hasLoginLink && hasProductSignals) {
    warnings.push('SNAPSHOT_WARNING: The snapshot contains a login link alongside product content. Review generated selectors for any session-specific elements.');
  }

  // Product page with CAPTCHA script reference
  if (hasCaptchaScript && (hasProductSignals || hasAnyH1)) {
    warnings.push('SNAPSHOT_WARNING: The snapshot references a CAPTCHA script. If selector generation is slow or fails, the page may be behind a bot challenge.');
  }

  // Product page with login title but also has product signals
  if (hasLoginTitle && hasProductSignals) {
    warnings.push('SNAPSHOT_WARNING: Page title suggests login but product content was detected. Review generated selectors carefully.');
  }

  // Small page but has JSON-LD
  if (textLength < 200 && hasProductJsonLd && !hasAnyH1) {
    warnings.push('SNAPSHOT_WARNING: Page has limited visible text but product data was found in embedded metadata.');
  }

  // Authenticated content warning
  if (hasPasswordInput && hasProductSignals) {
    warnings.push('SNAPSHOT_WARNING: The snapshot appears to contain authenticated account content alongside product data. Review generated selectors for session-specific elements.');
  }

  return {
    usable: true,
    warnings,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the document title from the HTML.
 */
function extractTitle($: cheerio.CheerioAPI): string {
  return $('title').first().text().trim();
}

/**
 * Extract visible text content from the body.
 * Strips script, style, and hidden elements.
 */
function extractVisibleText($: cheerio.CheerioAPI): string {
  // Clone the body to avoid mutating the original
  const $body = $('body').clone();

  // Remove non-text elements
  $body.find('script, style, noscript, template, iframe, object, embed, canvas, svg').remove();

  // Remove hidden elements
  $body.find('[hidden], [aria-hidden="true"]').remove();
  $body.find('*').filter((_, el) => {
    const $el = $(el);
    const style = $el.attr('style') || '';
    return /display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style);
  }).remove();

  const text = $body.text() || '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Check whether the raw HTML contains Product JSON-LD.
 * Quick regex-based check before loading the DOM.
 */
function hasProductJsonLdInHtml(html: string): boolean {
  const jsonLdRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const raw = match[1].trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const check = (obj: unknown): boolean => {
        if (typeof obj !== 'object' || obj === null) return false;
        const o = obj as Record<string, unknown>;
        if (o['@type'] === 'Product') return true;
        if (Array.isArray(o['@graph'])) return o['@graph'].some(check);
        if (Array.isArray(obj)) return (obj as unknown[]).some(check);
        return false;
      };
      if (check(parsed)) return true;
    } catch {
      continue;
    }
  }
  return false;
}
