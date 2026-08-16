/**
 * Token-level normalization for deterministic family grouping (epic #46
 * review round — Package A).
 *
 * Distributor export names are abbreviation-heavy, all-caps, and typo-prone
 * ("BETTER BONE MD VNSNLG"). Before a name stem is computed, this module
 * expands known abbreviations and splits attached size tokens so siblings
 * with different flavors/sizes produce the SAME stem.
 *
 * These transforms are for GROUPING/COMPARISON ONLY — they never rewrite
 * customer-facing titles (the curated title pipeline is separate).
 */

// ─── Abbreviation dictionary ──────────────────────────────────────────────────

/**
 * Bounded, conservative expansion map — keys are lowercase whole tokens.
 * Only entries that are unambiguous in a pet-supply product context are
 * included. Expansion makes the token match the existing `FLAVOR_WORDS`
 * regex (venison/chicken/turkey/salmon) or normalizes a non-flavor token
 * (barley) so siblings agree.
 */
export const EXPAND_ABBREVIATIONS: Record<string, string> = {
  vnsn: 'venison',
  chkn: 'chicken',
  ckn: 'chicken',
  trky: 'turkey',
  slmn: 'salmon',
  brly: 'barley',
  vgg: 'veggie',
  frzn: 'frozen',
};

/**
 * Token-level abbreviation expansion (word-boundary aware). Unknown tokens
 * are passed through untouched.
 */
export function expandAbbreviations(text: string): string {
  return text.replace(
    /[a-z]+/g,
    token => EXPAND_ABBREVIATIONS[token] ?? token,
  );
}

// ─── Attached size tokens ─────────────────────────────────────────────────────

/** Trailing size tokens that may be glued to a preceding word (all-caps
 *  distributor names): "VNSNLG" → "VNSN LG", "VNSNSM" → "VNSN SM". */
const ATTACHED_SIZE_SUFFIX = /([A-Za-z]{3,})(SM|MD|LG|XL|XXL)\b/g;

/**
 * Split size tokens glued to a preceding word so the standalone
 * `SIZE_ADJECTIVES` pass can strip them. Conservative rules:
 * - the whole token must be ALL-CAPS (distributor export style), OR
 * - the preceding part must be abbreviation-like (no vowel — e.g. "vnsn").
 * Mixed-case words ("Prism", "ClassicLg") are never split.
 * Existing handled forms (SM5CT, MD2CT, 2.64OZ) are untouched — they carry
 * a digit/unit and never match the letter-only suffix here.
 */
export function splitAttachedSizeTokens(text: string): string {
  return text.replace(ATTACHED_SIZE_SUFFIX, (match, pre: string, size: string) => {
    const whole = pre + size;
    if (/^[A-Z0-9]+$/.test(whole) || !/[aeiou]/i.test(pre)) {
      return `${pre} ${size}`;
    }
    return match;
  });
}

// ─── Edit distance (typo tolerance) ───────────────────────────────────────────

/**
 * Classic Levenshtein edit distance. Used ONLY for the constrained family
 * stem merge (single-token, length >= 4, distance <= 1) — never for
 * arbitrary fuzzy grouping.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Constrained family-stem typo tolerance: two stems merge when they differ
 * in EXACTLY ONE token, that token is length >= 4 in both stems, and its
 * edit distance is <= 1 ("veggie" vs "vegggie"). "soft" vs "softer"
 * (distance 2), "duck" vs "duckling" (distance 4), or extra tokens
 * ("hard" vs "hard beef") never merge.
 */
export function stemsWithinTypoTolerance(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const ta = a.split(' ');
  const tb = b.split(' ');
  if (Math.abs(ta.length - tb.length) > 1) return false;
  const len = Math.max(ta.length, tb.length);
  let diffs = 0;
  for (let i = 0; i < len; i++) {
    const wa = ta[i] ?? '';
    const wb = tb[i] ?? '';
    if (wa === wb) continue;
    diffs++;
    if (diffs > 1) return false;
    if (wa.length < 4 || wb.length < 4) return false;
    if (levenshtein(wa, wb) > 1) return false;
  }
  return diffs === 1;
}
