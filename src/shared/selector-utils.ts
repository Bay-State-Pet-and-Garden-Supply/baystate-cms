/**
 * Shared CSS selector generation utilities.
 *
 * Extracted from `profile-generator.ts` so that the extraction worker
 * (Node.js-only, no Bun dependencies) can also generate stable CSS
 * selectors from DOM elements.
 *
 * The module has zero Bun-only imports — only `cheerio`, which is
 * available in both Bun and Node.js runtimes.
 */

import * as cheerio from 'cheerio';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Stability = 'high' | 'medium' | 'low';

export interface BuildStableSelectorResult {
  selector: string;
  stability: Stability;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Stable data-* attribute names that make excellent selectors. */
// fallow-ignore-next-line unused-export
export const STABLE_DATA_ATTRS = [
  'data-testid',
  'data-test',
  'data-cy',
  'data-qa',
  'data-product-id',
  'data-product-sku',
];

/** Substrings that, when present in class/id, indicate semantic value. */
export const SEMANTIC_HINT_SUBSTRINGS: Record<string, string[]> = {
  title: ['title', 'product-title', 'product-name', 'pdp-title', 'heading'],
  price: ['price', 'amount', 'sale', 'money', 'cost'],
  description: ['description', 'desc', 'long-desc', 'product-info', 'details'],
  brand: ['brand', 'vendor', 'manufacturer', 'maker'],
  image: ['product-image', 'gallery', 'hero-image', 'pdp-image', 'product-photo', 'product-media', 'product-single', 'media-gallery', 'slides', 'carousel', 'swiper', 'slick'],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return `true` for IDs that look auto-generated and should not be used
 * as stable selectors (CSS modules, React keys, Shopify section ids,
 * hex-only hashes, etc.).
 */
// fallow-ignore-next-line unused-export
export function isLikelyGeneratedId(id: string): boolean {
  if (!id) return true;
  if (id.length < 2) return true;
  if (id.startsWith('_')) return true; // React, Vue, Svelte
  if (id.includes('__')) return true; // CSS modules
  if (id.includes('--')) return true; // Tailwind arbitrary values
  if (/^[a-f0-9]{6,}$/i.test(id)) return true; // hex hash
  if (/^\d+$/.test(id)) return true; // pure numeric
  if (/^section-/.test(id) && /\d/.test(id)) return true; // Shopify sections
  return false;
}

/** Lowercase a class string list and return as a Set for quick lookup. */
// fallow-ignore-next-line unused-export
export function classSet(className: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!className) return set;
  for (const cls of className.split(/\s+/)) {
    if (cls) set.add(cls.toLowerCase());
  }
  return set;
}

/** Return a CSS attribute selector for a given attribute. */
// fallow-ignore-next-line unused-export
export function attrSelector(attr: string, value: string): string {
  // Escape any double quotes in the value.
  const safe = value.replace(/"/g, '\\"');
  return `[${attr}="${safe}"]`;
}

// ─── Core selector generation ───────────────────────────────────────────────

/**
 * Build a stable CSS selector for a single element using a 6-tier
 * priority hierarchy:
 *   1. Unique id (if not auto-generated) → `#id` — high
 *   2. Stable data-* attributes → `tag[data-testid="..."]` — high
 *   3. itemprop / schema attributes → `tag[itemprop="name"]` — high
 *   4. Semantic class combinations → `tag.product-title` — medium
 *   5. Ancestor + child (stable ancestor) → `#parent tag` — medium
 *   6. Last resort: nth-of-type → `tag:nth-of-type(n)` — low
 */
export function buildStableSelector(
  $: cheerio.CheerioAPI,
  el: cheerio.Element,
): BuildStableSelectorResult {
  const node = $(el);
  // `el.name` is the canonical tag name on domhandler Elements.
  const tag = ((el as { name?: string }).name ?? 'div').toLowerCase();

  // 1. Unique id (if not auto-generated).
  const id = node.attr('id');
  if (id && !isLikelyGeneratedId(id)) {
    const safeId = id.replace(/(["'\\\s\[\]:.])/g, '\\$1');
    const matches = $(`#${safeId}`);
    if (matches.length === 1) {
      return { selector: `#${id}`, stability: 'high' };
    }
  }

  // 2. Stable data-* attributes.
  for (const attr of STABLE_DATA_ATTRS) {
    const value = node.attr(attr);
    if (!value) continue;
    const sel = tag + attrSelector(attr, value);
    const matches = $(sel);
    if (matches.length >= 1 && matches.length <= 5) {
      return { selector: sel, stability: 'high' };
    }
  }

  // 3. itemprop / itemscope / schema attributes.
  const itemprop = node.attr('itemprop');
  if (itemprop) {
    return { selector: tag + attrSelector('itemprop', itemprop), stability: 'high' };
  }

  // 4. Semantic class combinations.
  const classAttr = node.attr('class') ?? '';
  const idAttr = node.attr('id') ?? '';
  const classes = classSet(classAttr);
  const hints: string[] = [];
  for (const [, substrings] of Object.entries(SEMANTIC_HINT_SUBSTRINGS)) {
    for (const sub of substrings) {
      const subLower = sub.toLowerCase();
      if (
        classes.has(subLower) ||
        classes.has(`${subLower}-${tag}`) ||
        idAttr.toLowerCase().includes(subLower) ||
        classAttr.toLowerCase().includes(subLower)
      ) {
        hints.push(sub);
      }
    }
  }
  if (hints.length > 0) {
    // Build a tag.class selector using the most semantic class found.
    const semanticClass = [...classes].find((c) =>
      hints.some((h) => c.includes(h.toLowerCase())),
    );
    if (semanticClass) {
      const sel = `${tag}.${semanticClass}`;
      return { selector: sel, stability: 'medium' };
    }
  }

  // 5. Ancestor + child selector (one level up, with a stable id/class
  //    on the ancestor).
  const parent = node.parent();
  if (parent.length > 0) {
    const parentNode = parent.get(0);
    if (parentNode) {
      const parentId = $(parentNode).attr('id');
      if (parentId && !isLikelyGeneratedId(parentId)) {
        return {
          selector: `#${parentId} ${tag}`,
          stability: 'medium',
        };
      }
      const parentClass = $(parentNode).attr('class');
      if (parentClass) {
        const parentClassList = classSet(parentClass);
        const parentSemantic = [...parentClassList].find((c) =>
          Object.values(SEMANTIC_HINT_SUBSTRINGS)
            .flat()
            .some((sub) => c.includes(sub.toLowerCase())),
        );
        if (parentSemantic) {
          return {
            selector: `${parentNode.tagName?.toLowerCase()}.${parentSemantic} ${tag}`,
            stability: 'medium',
          };
        }
      }
    }
  }

  // 6. Last resort: nth-of-type. Marked low stability.
  const parentChildren = node.parent().children(tag);
  const index = parentChildren.index(el) + 1;
  return {
    selector: `${tag}:nth-of-type(${index})`,
    stability: 'low',
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Reject selectors that use unsupported syntax (XPath, JS execution,
 * browser-only pseudo-selectors that Cheerio cannot evaluate).
 */
export function isSupportedSelectorSyntax(sel: string): boolean {
  if (!sel || typeof sel !== 'string') return false;
  const trimmed = sel.trim();
  if (!trimmed) return false;
  // XPath-style selectors.
  if (trimmed.startsWith('//') || trimmed.startsWith('(')) return false;
  if (trimmed.startsWith('xpath:')) return false;
  // JS execution style.
  if (trimmed.includes('() =>') || trimmed.includes('function(')) return false;
  // Some pseudo-classes are valid CSS but Cheerio does not evaluate them
  // (e.g., :has(), :is(), :where() require modern engines). The library
  // does support :nth-of-type, :first-child, etc. We allow those.
  const unsupportedPseudos = [':has(', ':is(', ':where(', ':focus', ':hover'];
  for (const p of unsupportedPseudos) {
    if (trimmed.includes(p)) return false;
  }
  return true;
}

/** Snippet-safe text from a Cheerio element (trimmed and length-capped). */
export function snippetOf(
  $: cheerio.CheerioAPI,
  el: cheerio.Element,
  max = 120,
): string {
  const text = $(el).text().replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
