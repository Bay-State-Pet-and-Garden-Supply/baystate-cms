/**
 * selectorValidator.ts — Validates and ranks LLM-proposed CSS selectors
 * against the captured snapshot HTML.
 *
 * Uses Cheerio (existing dependency) for DOM querying. Each candidate
 * is scored on a deterministic 0-100 scale based on syntax validity,
 * match count, visibility, multiplicity, semantics, and stability.
 *
 * The highest-ranked candidate is returned per field.
 */

import * as cheerio from 'cheerio';
import type { SelectorWarning } from '../../../shared/schemas/selector-generation';

// ─── Positional Pseudo-Class Deny List ─────────────────────────────────────

const FORBIDDEN_POSITIONAL_PSEUDOS = [
  ':first-child', ':last-child', ':only-child',
  ':nth-child', ':nth-last-child',
  ':first-of-type', ':last-of-type', ':only-of-type',
  ':nth-of-type', ':nth-last-of-type',
];

// fallow-ignore-next-line unused-export — used by tests
export function hasForbiddenPositionalPseudo(selector: string): boolean {
  return FORBIDDEN_POSITIONAL_PSEUDOS.some((p) =>
    selector.toLowerCase().includes(p)
  );
}

// fallow-ignore-next-line unused-export — used by tests
export function extractBannedPseudo(selector: string): string {
  const lowered = selector.toLowerCase();
  for (const pseudo of FORBIDDEN_POSITIONAL_PSEUDOS) {
    if (lowered.includes(pseudo)) return pseudo;
  }
  return 'unknown-positional';
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ValidatedCandidate {
  selector: string;
  status: 'suggested' | 'not_found' | 'invalid';
  validation: {
    syntaxValid: boolean;
    matchedCount: number;
    visibleMatchedCount: number | null;
    unique: boolean;
  };
  quality: 'high' | 'medium' | 'low' | 'unusable';
  warnings: SelectorWarning[];
  explanation?: string;
  preview?: {
    text?: string | null;
    values?: string[] | null;
    imageUrls?: string[] | null;
  };
}

export interface LlmFieldResult {
  notFound: boolean;
  candidates: Array<{
    selector: string;
    evidence: string;
  }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SELECTOR_CHARS = 500;
const MAX_SELECTOR_GROUPS = 5;
const MAX_COMBINATORS = 16;
const MAX_MATCHES_FOR_SINGLE = 1;

/**
 * Substrings that, when present in class/id/attributes, indicate a
 * stable semantic selector. Derived from src/shared/selector-utils.ts.
 */
const SEMANTIC_HINTS = [
  'title', 'product-title', 'product-name', 'pdp-title', 'heading',
  'price', 'amount', 'sale', 'money', 'cost',
  'description', 'desc', 'long-desc', 'product-info', 'details',
  'brand', 'vendor', 'manufacturer', 'maker',
  'product-image', 'gallery', 'hero-image', 'pdp-image', 'product-photo',
  'product-media', 'product-single', 'media-gallery',
  'ingredient', 'nutrition', 'weight', 'dimension', 'flavor', 'flavour',
  'sku', 'upc', 'ean', 'gtin',
  'specification', 'feature', 'attribute',
];

/** Pseudo-classes considered fragile/positional. */
const POSITIONAL_PSEUDO_RE = /:(?:nth-child|nth-of-type|first-child|last-child|nth-last-child|eq)\b/i;

/** Patterns that look like auto-generated IDs (React, CSS modules, etc.). */
const GENERATED_ID_RE = /^[a-f0-9]{8,}$|__|^_/;

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Validate and rank LLM-proposed selectors for every requested field.
 *
 * @param html - The sanitized snapshot HTML
 * @param fieldResults - The parsed LLM response, keyed by field key
 * @param fieldDefinitions - The requested field definitions
 * @returns A map of field key → validated suggestion
 */
export function validateAndRankSelectors(
  html: string,
  fieldResults: Record<string, LlmFieldResult>,
  fieldDefinitions: Array<{ key: string; valueType: string; multiple: boolean }>,
): Record<string, ValidatedCandidate> {
  const $ = cheerio.load(html);
  const result: Record<string, ValidatedCandidate> = {};
  const fieldDefMap = new Map(fieldDefinitions.map((d) => [d.key, d]));

  for (const [key, fieldResult] of Object.entries(fieldResults)) {
    const def = fieldDefMap.get(key);

    if (fieldResult.notFound || !fieldResult.candidates.length) {
      result[key] = {
        selector: null as unknown as string,
        status: 'not_found',
        validation: { syntaxValid: true, matchedCount: 0, visibleMatchedCount: null, unique: false },
        quality: 'unusable',
        warnings: [{ code: 'ZERO_MATCHES', severity: 'warning', message: 'No reliable selector was identified.', fieldKey: key }],
      };
      continue;
    }

    // Score each candidate and pick the best
    let bestCandidate: { candidate: LlmFieldResult['candidates'][0]; score: ValidatedCandidate } | null = null;

    for (const candidate of fieldResult.candidates.slice(0, 3)) {
      // HARD REJECTION: positional pseudo-classes are never valid
      if (hasForbiddenPositionalPseudo(candidate.selector)) {
        const bannedPseudo = extractBannedPseudo(candidate.selector);
        if (!bestCandidate) {
          bestCandidate = {
            candidate,
            score: {
              selector: candidate.selector,
              status: 'invalid',
              validation: { syntaxValid: true, matchedCount: 0, visibleMatchedCount: null, unique: false },
              quality: 'unusable',
              warnings: [{
                code: 'POSITIONAL_SELECTOR',
                severity: 'error',
                message: `Positional pseudo-class ${bannedPseudo} is forbidden — selectors must not depend on sibling order or tag-type position.`,
                fieldKey: key,
              }],
              explanation: candidate.evidence || undefined,
            },
          };
        }
        continue;
      }

      const scored = scoreCandidate($, candidate.selector, candidate.evidence, key, def);
      if (!bestCandidate || scoreValue(scored.quality) > scoreValue(bestCandidate.score.quality)) {
        bestCandidate = { candidate, score: scored };
      }
    }

    if (bestCandidate) {
      result[key] = bestCandidate.score;
    }
  }

  return result;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

interface ScoredResult {
  status: 'suggested' | 'invalid';
  selector: string;
  validation: { syntaxValid: boolean; matchedCount: number; visibleMatchedCount: number | null; unique: boolean };
  quality: 'high' | 'medium' | 'low' | 'unusable';
  warnings: SelectorWarning[];
  explanation?: string;
  preview?: {
    text?: string | null;
    values?: string[] | null;
    imageUrls?: string[] | null;
  };
}

function scoreCandidate(
  $: cheerio.CheerioAPI,
  selector: string,
  evidence: string,
  fieldKey: string,
  fieldDef?: { key: string; valueType: string; multiple: boolean },
): ScoredResult {
  const warnings: SelectorWarning[] = [];
  let totalScore = 0;
  const isImage = fieldDef?.valueType === 'image';

  // ── 1. Syntax check (20 points) ─────────────────────────────────────
  if (!selector || selector.length > MAX_SELECTOR_CHARS) {
    return {
      status: 'invalid',
      selector,
      validation: { syntaxValid: false, matchedCount: 0, visibleMatchedCount: null, unique: false },
      quality: 'unusable',
      warnings: [{ code: 'INVALID_CSS', severity: 'error', message: 'Selector exceeds maximum length or is empty.', fieldKey }],
    };
  }

  // Check for XPath or JS expressions
  if (
    selector.startsWith('/') ||
    selector.startsWith('//') ||
    selector.startsWith('xpath:') ||
    selector.startsWith('(')
  ) {
    return {
      status: 'invalid',
      selector,
      validation: { syntaxValid: false, matchedCount: 0, visibleMatchedCount: null, unique: false },
      quality: 'unusable',
      warnings: [{ code: 'INVALID_CSS', severity: 'error', message: 'XPath-style selectors are not supported.', fieldKey }],
    };
  }

  // Check for JS expressions
  if (selector.includes('document.querySelector') || selector.includes('() =>') || selector.includes('function(')) {
    return {
      status: 'invalid',
      selector,
      validation: { syntaxValid: false, matchedCount: 0, visibleMatchedCount: null, unique: false },
      quality: 'unusable',
      warnings: [{ code: 'INVALID_CSS', severity: 'error', message: 'JavaScript expressions are not valid CSS.', fieldKey }],
    };
  }

  // Check for unsupported pseudo-classes
  if (/:has\(|:is\(|:where\(|:focus|:hover/.test(selector)) {
    warnings.push({ code: 'INVALID_CSS', severity: 'error', message: 'Unsupported pseudo-class in selector.', fieldKey });
    return {
      status: 'invalid',
      selector,
      validation: { syntaxValid: false, matchedCount: 0, visibleMatchedCount: null, unique: false },
      quality: 'unusable',
      warnings,
    };
  }

  // Parse selector with Cheerio
  let nodes: cheerio.Cheerio<any>;
  try {
    nodes = $(selector);
  } catch {
    return {
      status: 'invalid',
      selector,
      validation: { syntaxValid: false, matchedCount: 0, visibleMatchedCount: null, unique: false },
      quality: 'unusable',
      warnings: [{ code: 'INVALID_CSS', severity: 'error', message: 'Invalid CSS selector syntax.', fieldKey }],
    };
  }

  totalScore += 20; // syntax passed

  // ── 2. Match count (0-20 points) ────────────────────────────────────
  const matchCount = nodes.length;
  const isSingle = fieldDef ? !fieldDef.multiple : true;

  if (matchCount === 0) {
    return {
      status: 'invalid',
      selector,
      validation: { syntaxValid: true, matchedCount: 0, visibleMatchedCount: null, unique: false },
      quality: 'unusable',
      warnings: [{ code: 'ZERO_MATCHES', severity: 'error', message: 'Selector matched no elements in the captured DOM.', fieldKey }],
    };
  }

  if (isSingle) {
    if (matchCount === 1) {
      totalScore += 20;
    } else if (matchCount <= 3) {
      totalScore += 10;
      warnings.push({ code: 'MULTIPLE_PRIMARY_MATCHES', severity: 'warning', message: `Expected one match but found ${matchCount}.`, fieldKey });
    } else {
      totalScore += 5;
      warnings.push({ code: 'TOO_MANY_MATCHES', severity: 'warning', message: `Selector matches ${matchCount} elements — too broad.`, fieldKey });
    }
  } else {
    // Multiple-value field
    if (matchCount >= 1) {
      totalScore += Math.min(20, matchCount * 5);
    }
  }

  // ── 3. Visibility estimation (0-10 points) ──────────────────────────
  let visibleCount = 0;
  let hasHidden = false;
  nodes.each((_idx: number, el: any) => {
    const $el = $(el);
    // Check for hidden signals on the element or its ancestors
    const isHidden =
      $el.is('[hidden]') ||
      $el.is('[aria-hidden="true"]') ||
      $el.css('display') === 'none' ||
      $el.css('visibility') === 'hidden' ||
      $el.parents('[hidden], [aria-hidden="true"]').length > 0;

    if (isHidden) {
      hasHidden = true;
    } else {
      visibleCount++;
    }
  });

  if (isSingle && matchCount > 0 && visibleCount > 0) {
    totalScore += 10;
  } else if (isSingle && matchCount > 0 && visibleCount === 0) {
    totalScore += 2;
    warnings.push({ code: 'HIDDEN_MATCH', severity: 'info', message: 'All matched elements are hidden.', fieldKey });
  } else if (!isSingle && visibleCount > 0) {
    totalScore += Math.min(10, visibleCount * 2);
  }

  // ── 4. Multiplicity (0-15 points) ───────────────────────────────────
  if (isImage && matchCount > 0) {
    totalScore += 15; // Images are expected to have multiple matches
  } else if (isSingle && matchCount === 1) {
    totalScore += 15;
  } else if (isSingle && matchCount <= 3) {
    totalScore += 8;
  } else if (!isSingle && matchCount >= 2) {
    totalScore += 15;
  } else if (!isSingle && matchCount === 1) {
    totalScore += 5;
    warnings.push({ code: 'MULTIPLE_PRIMARY_MATCHES', severity: 'info', message: 'Multi-value field matches only one element.', fieldKey });
  }

  // ── 5. Semantics (0-15 points) ──────────────────────────────────────
  const selectorLower = selector.toLowerCase();
  let semanticScore = 0;

  // Check for itemprop attribute selectors
  if (/\[itemprop\]/.test(selector)) {
    semanticScore += 8;
  }

  // Check for stable data-* attributes
  if (/\[data-(?:testid|test|cy|qa|product-)\]/.test(selector)) {
    semanticScore += 10;
  }

  // Check for semantic class hints
  const hasSemanticHint = SEMANTIC_HINTS.some((hint) => selectorLower.includes(hint));
  if (hasSemanticHint) {
    semanticScore += 5;
  }

  // Check for ID-based selectors (strong signal if not generated)
  if (selector.includes('#')) {
    const idMatch = selector.match(/#([\w-]+)/);
    if (idMatch && !GENERATED_ID_RE.test(idMatch[1])) {
      semanticScore += 12;
    } else if (idMatch) {
      warnings.push({ code: 'DYNAMIC_ID', severity: 'warning', message: 'Selector uses a generated-looking ID.', fieldKey });
      semanticScore += 2;
    }
  }

  totalScore += Math.min(15, semanticScore);

  // ── 6. Stability (0-20 points) ──────────────────────────────────────
  let stabilityScore = 20;

  // Positional pseudo-classes
  if (POSITIONAL_PSEUDO_RE.test(selector)) {
    warnings.push({ code: 'POSITIONAL_SELECTOR', severity: 'warning', message: 'Selector uses positional pseudo-classes which may break on DOM changes.', fieldKey });
    stabilityScore -= 8;
  }

  // Excessive combinator depth
  const combinatorDepth = (selector.match(/\s*[>+~]\s*/g) || []).length;
  if (combinatorDepth > 5) {
    warnings.push({ code: 'EXCESSIVE_SELECTOR_DEPTH', severity: 'warning', message: `Selector depth (${combinatorDepth} combinators) may be fragile.`, fieldKey });
    stabilityScore -= 5;
  }

  // Too many comma-separated groups
  const groups = selector.split(',').length;
  if (groups > MAX_SELECTOR_GROUPS) {
    warnings.push({ code: 'TOO_MANY_MATCHES', severity: 'warning', message: `Selector has ${groups} comma-separated groups.`, fieldKey });
    stabilityScore -= 5;
  }

  // Universal selectors
  if (/\*/.test(selector)) {
    stabilityScore -= 4;
  }

  // Generic selectors (just a tag name or very broad class)
  if (/^(?:div|span|a|p|ul|li|section|article|main|footer|header|nav|aside|form|table|body|html|h[1-6])\s*$/i.test(selector.trim())) {
    warnings.push({ code: 'TOO_GENERIC', severity: 'warning', message: 'Selector is a bare element — too generic.', fieldKey });
    stabilityScore -= 10;
  }

  totalScore += Math.max(0, stabilityScore);

  // ── 7. Check for duplicate selectors across fields ───────────────────
  // This is checked at the aggregate level, not per-candidate

  // ── Quality classification ───────────────────────────────────────────
  let quality: ScoredResult['quality'];
  if (totalScore >= 85) quality = 'high';
  else if (totalScore >= 65) quality = 'medium';
  else if (totalScore >= 40) quality = 'low';
  else quality = 'unusable';

  // ── Extract preview ─────────────────────────────────────────────────
  const preview = extractPreview($, selector, nodes, isImage);

  return {
    status: quality === 'unusable' ? 'invalid' : 'suggested',
    selector,
    validation: {
      syntaxValid: true,
      matchedCount: matchCount,
      visibleMatchedCount: visibleCount > 0 ? visibleCount : null,
      unique: isSingle ? matchCount === 1 : matchCount > 0,
    },
    quality,
    warnings,
    explanation: evidence || undefined,
    preview,
  };
}

// ─── Preview extraction ──────────────────────────────────────────────────────

function extractPreview(
  $: cheerio.CheerioAPI,
  selector: string,
  nodes: cheerio.Cheerio<any>,
  isImage: boolean,
): { text?: string | null; values?: string[] | null; imageUrls?: string[] | null } | undefined {
  if (nodes.length === 0) return;

  if (isImage) {
    const urls: string[] = [];
    const seen = new Set<string>();
    nodes.each((_idx: number, el: any) => {
      const $el = $(el);
      const candidateAttrs = ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-image', 'href'];
      for (const attr of candidateAttrs) {
        const value = $el.attr(attr);
        if (value && !seen.has(value) && !value.startsWith('data:') && !value.startsWith('blob:')) {
          seen.add(value);
          urls.push(value);
          break;
        }
      }
    });
    return { imageUrls: urls.slice(0, 10) };
  }

  // Text field: collect text content
  const values: string[] = [];
  nodes.each((_idx: number, el: any) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) values.push(text.slice(0, 500));
  });

  if (values.length === 0) return;
  if (values.length === 1) return { text: values[0] };
  return { text: values[0], values: values.slice(0, 10) };
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function scoreValue(quality: ScoredResult['quality']): number {
  switch (quality) {
    case 'high': return 5;
    case 'medium': return 4;
    case 'low': return 3;
    case 'unusable': return 1;
  }
}
