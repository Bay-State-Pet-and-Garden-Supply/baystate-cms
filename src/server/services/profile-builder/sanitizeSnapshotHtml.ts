/**
 * sanitizeSnapshotHtml.ts — MVP HTML sanitizer for LLM prompt construction.
 *
 * Takes raw snapshot HTML and produces a bounded, structure-preserving
 * HTML document suitable for the one-shot selector generation prompt.
 *
 * Uses Cheerio for DOM manipulation (existing project dependency).
 * No Bun-only imports — safe for both Bun server contexts.
 */

import * as cheerio from 'cheerio';

// ─── Constants ──────────────────────────────────────────────────────────────────

const MAX_SANITIZED_CHARS = 350_000;

/** Regular expression matching common inline event handler attribute names. */
const EVENT_HANDLER_RE = /^on\w+$/i;

/** Attribute names to preserve during sanitization. */
const PRESERVED_ATTRS = new Set([
  'id',
  'class',
  'name',
  'role',
  'itemprop',
  'itemtype',
  'itemscope',
  'property',
  'content',
  'href',
  'src',
  'srcset',
  'alt',
  'title',
  'aria-label',
  'aria-labelledby',
  'aria-hidden',
  'data-testid',
  'data-test',
  'data-qa',
]);

// ─── Result Type ────────────────────────────────────────────────────────────────

export interface SanitizeSnapshotResult {
  html: string;
  originalCharacters: number;
  sanitizedCharacters: number;
  truncated: boolean;
  warnings: string[];
}

// ─── Top-Level Sanitizer ────────────────────────────────────────────────────────

/**
 * Sanitize raw HTML for LLM prompt consumption.
 *
 * Steps:
 * 1. Parse HTML with Cheerio.
 * 2. Remove non-content elements (script, style, svg, etc.).
 * 3. Remove HTML comments.
 * 4. Strip inline event-handler attributes and style attributes.
 * 5. Remove excessively long attribute values.
 * 6. Strip base64/blob URL payloads from attribute values.
 * 7. Minify whitespace.
 * 8. Enforce 350,000-character limit.
 */
export function sanitizeSnapshotHtml(rawHtml: string): SanitizeSnapshotResult {
  const originalCharacters = rawHtml.length;
  const warnings: string[] = [];

  if (!rawHtml || rawHtml.trim().length === 0) {
    return {
      html: '',
      originalCharacters,
      sanitizedCharacters: 0,
      truncated: false,
      warnings: [],
    };
  }

  const $ = cheerio.load(rawHtml);

  // ── Remove non-content elements ────────────────────────────────────
  $('script, style, noscript, template, iframe, object, embed, canvas, svg').remove();

  // ── Remove HTML comments ───────────────────────────────────────────
  removeComments($);

  // ── Strip inline event handlers and style attributes ──────────────
  stripDisallowedAttributes($);

  // ── Remove excessive attribute values ─────────────────────────────
  truncateLongAttributes($);

  // ── Strip base64 payloads from attributes ─────────────────────────
  stripBase64Attrs($);

  // ── Get the cleaned HTML ──────────────────────────────────────────
  let cleaned = $.html() || '';

  // ── Minify whitespace ─────────────────────────────────────────────
  cleaned = minifyWhitespace(cleaned);

  // ── Enforce 350K char limit ───────────────────────────────────────
  let truncated = false;
  if (cleaned.length > MAX_SANITIZED_CHARS) {
    // Try to truncate at the last element boundary before the limit
    const truncatedAt = cleaned.lastIndexOf('>', MAX_SANITIZED_CHARS);
    const cutPoint = truncatedAt > 0 ? truncatedAt + 1 : MAX_SANITIZED_CHARS;
    cleaned = cleaned.slice(0, cutPoint);
    // Ensure the result doesn't end mid-tag
    if (cleaned.lastIndexOf('<') > cleaned.lastIndexOf('>')) {
      cleaned = cleaned.slice(0, cleaned.lastIndexOf('<'));
    }
    truncated = true;
    warnings.push('TRUNCATED_HTML: Sanitized HTML exceeded 350K character limit and was truncated.');
  }

  const sanitizedCharacters = cleaned.length;

  return {
    html: cleaned,
    originalCharacters,
    sanitizedCharacters,
    truncated,
    warnings,
  };
}

// ─── Comment Removal ────────────────────────────────────────────────────────────

function removeComments($: cheerio.CheerioAPI): void {
  // Cheerio's $.root() traverse doesn't easily remove comments across all
  // children. We walk all top-level nodes and remove comment nodes.
  $.root()
    .find('*')
    .contents()
    .each((_i, node) => {
      if (node.type === 'comment') {
        $(node).remove();
      }
    });
}

// ─── Attribute Stripping ────────────────────────────────────────────────────────

function stripDisallowedAttributes($: cheerio.CheerioAPI): void {
  $('*').each((_i, el) => {
    const $el = $(el);
    const rawAttribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    const attrs = Object.keys(rawAttribs);
    for (const attr of attrs) {
      // Remove inline event handlers (onclick, onload, etc.)
      if (EVENT_HANDLER_RE.test(attr)) {
        $el.removeAttr(attr);
        continue;
      }
      // Remove style attributes
      if (attr === 'style') {
        $el.removeAttr(attr);
        continue;
      }
      // Remove non-preserved data-* attributes that aren't in the preserved set
      if (attr.startsWith('data-') && !PRESERVED_ATTRS.has(attr)) {
        // Keep data-product-* and data-variant-*
        if (
          !attr.startsWith('data-product-') &&
          !attr.startsWith('data-variant-')
        ) {
          $el.removeAttr(attr);
        }
        continue;
      }
      // Remove non-preserved aria-* attributes beyond the preserved ones
      if (attr.startsWith('aria-') && !PRESERVED_ATTRS.has(attr)) {
        $el.removeAttr(attr);
        continue;
      }
    }
  });
}

// ─── Attribute Truncation ───────────────────────────────────────────────────────

const MAX_ATTR_LENGTH = 500;

function truncateLongAttributes($: cheerio.CheerioAPI): void {
  $('*').each((_i, el) => {
    const $el = $(el);
    const rawAttribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    const attrs = Object.keys(rawAttribs);
    for (const attr of attrs) {
      const val = $el.attr(attr);
      if (val && val.length > MAX_ATTR_LENGTH) {
        $el.attr(attr, val.slice(0, MAX_ATTR_LENGTH) + '…[truncated]');
      }
    }
  });
}

// ─── Base64 Stripping ───────────────────────────────────────────────────────────

function stripBase64Attrs($: cheerio.CheerioAPI): void {
  $('*').each((_i, el) => {
    const $el = $(el);
    const rawAttribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    const attrs = Object.keys(rawAttribs);
    for (const attr of attrs) {
      const val = $el.attr(attr);
      if (val && (val.startsWith('data:') || val.startsWith('blob:'))) {
        // For src/srcset-type attrs, strip the value (it's a blob/base64 payload)
        if (attr === 'src' || attr === 'srcset' || attr === 'href') {
          $el.removeAttr(attr);
        }
      }
    }
  });
}

// ─── Whitespace Minification ────────────────────────────────────────────────────

function minifyWhitespace(html: string): string {
  return html
    .replace(/\n\s*\n/g, '\n')   // collapse blank lines
    .replace(/^\s+|\s+$/gm, '')  // trim each line
    .replace(/\s{2,}/g, ' ')     // collapse multiple spaces
    .trim();
}
