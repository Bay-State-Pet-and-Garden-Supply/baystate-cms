/**
 * Deterministic Title Lint — e09 follow-through.
 *
 * Pure, no I/O, no DB. Normalizes mechanically-repairable title defects and
 * blocks unverifiable garbage BEFORE the family-consistency gate sees a
 * candidate set (T7 all-or-nothing is enforced by the caller: a blocked or
 * changed member means the caller re-validates the whole LINTED set and only
 * a linted+revalidated set may commit durably).
 *
 * Rule provenance: every rule encodes a defect class observed twice in
 * production cohorts (2026-08-22 census + 2026-08-23 re-run regression):
 * - R1 tight/unexpanded units ("3lb", "20#", "30ct")
 * - R2 leading-zero-less decimals (".53 oz.")
 * - R3 whitespace noise
 * - R4 duplicated trailing size word ("Medium 3lb Medium" after R1)
 * - R5 brand casing drift ("kong", "nylabone", "FROMM")
 * - B1 all-caps spreadsheet fallback leaking as a final title
 * - B2 phantom weight ("2.64 oz" injected into unrelated families) — blocked,
 *   not stripped, because absence of evidence cannot prove which value IS
 *   correct; fail closed per plan §3.
 */

export const TITLE_LINT_VERSION = 'v1' as const;

export interface LintMemberInput {
  upc: string | null;
  candidateTitle: string;
  rawTitle: string;
  /**
   * Where this candidate came from. B1 (spreadsheet_fallback_leak) applies
   * ONLY to "llm" candidates: an LLM echoing the spreadsheet name verbatim is
   * a defect, but the deterministic fallback is DERIVED from rawTitle by
   * construction (formatDeterministicTitle), so a clean Title Case sheet
   * round-trips byte-identically by design and must never be blocked.
   * Default when omitted: "llm" (the stricter reading).
   */
  candidateSource?: 'llm' | 'deterministic_fallback';
  /**
   * Frozen extraction evidence strings for this member (extraction title,
   * description, OCR fields...). Absent/empty disables B2 phantom-weight
   * blocking entirely — legacy callers without evidence must never
   * false-block; they simply do not get phantom protection.
   */
  extractionStrings?: string[];
}

export interface LintResult {
  upc: string | null;
  title: string;
  changed: boolean;
  blocked: boolean;
  blockReason?: string;
  appliedRules: string[];
}

export interface LintOptions {
  /** lower-case brand key -> canonical rendering; overrides DEFAULT_BRAND_CASE_MAP */
  brandCaseMap?: Record<string, string>;
}

/**
 * Default brand casing dictionary (census-derived). Callers may extend via
 * `options.brandCaseMap` (e.g. canonical spellings derived from batch brand
 * data); entries there win over these defaults.
 */
export const DEFAULT_BRAND_CASE_MAP: Record<string, string> = {
  kong: 'KONG',
  nylabone: 'Nylabone',
  wellness: 'Wellness',
  fromm: 'Fromm',
  // NOTE: no contiguous "threedogbakery" key — R5 matches whole tokens only,
  // so a contiguous key can never hit spaced "Three Dog Bakery" text. Real
  // brands are covered by caller-supplied maps (brandCaseMapFor).
};

const CANONICAL_SIZE: Record<string, string> = {
  sm: 'small', small: 'small',
  md: 'medium', medium: 'medium',
  lg: 'large', large: 'large',
};

function stripPunct(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

function letterTokens(s: string): string[] {
  return stripPunct(s).split(' ').filter(t => /^[A-Z]{3,}$/.test(t));
}

/** B2 evidence corpus: rawTitle + extraction strings, case-insensitive. */
function evidenceCorpus(input: LintMemberInput): string {
  return [input.rawTitle, ...(input.extractionStrings ?? [])].join(' ').toLowerCase();
}

export function lintCandidateTitle(
  input: LintMemberInput,
  options: LintOptions = {},
): LintResult {
  // NOTE: bump FAMILY_TITLE_CONSISTENCY_VERSION (family-title-consistency.ts)
  // whenever these rules change — the lint participates in the cohort title
  // authority hash via TITLE_LINT_VERSION (cohort-title-hash.ts), but the
  // committed-set contract keys on the family-consistency version.
  const appliedRules: string[] = [];
  const original = String(input.candidateTitle ?? '');
  const t = original;
  // Unit-level contract: an empty candidateTitle returns unchanged and
  // unblocked. Callers never rely on this in production —
  // validateCohortResponse guarantees non-empty titles upstream — but the
  // lint itself must be total (never throw on any string input).

  // ── Block checks first: blocked members are never normalized ─────────────

  // B1 all-caps spreadsheet fallback leak: candidate carries no information
  // beyond the raw spreadsheet name (punctuation/case aside). Only meaningful
  // for "llm" candidates — see candidateSource doc on LintMemberInput.
  const rawNorm = stripPunct(input.rawTitle ?? '');
  const b1Applies = input.candidateSource !== 'deterministic_fallback';
  if (b1Applies && rawNorm.length > 0 && stripPunct(t) === rawNorm && letterTokens(t).length >= 2) {
    return {
      upc: input.upc, title: input.candidateTitle, changed: false, blocked: true,
      blockReason: 'spreadsheet_fallback_leak', appliedRules: [],
    };
  }

  // B2 phantom weight: a numeric weight/count token whose number appears
  // nowhere in the member's frozen evidence. Skipped when no evidence was
  // supplied (legacy callers).
  const hasEvidence = Array.isArray(input.extractionStrings) && input.extractionStrings.length > 0;
  if (hasEvidence) {
    const corpus = evidenceCorpus(input);
    const weightTokens = t.matchAll(/(\d+(?:\.\d+)?|\.\d+)\s*[- ]?(lbs?|oz|ct|count|pack)\b/gi);
    for (const m of weightTokens) {
      const num = m[1];
      const numAlt = num.startsWith('.') ? '0' + num : num.replace(/^0+(?=\.)/, ''); // "0.53" vs ".53" spellings
      if (!corpus.includes(num) && !corpus.includes(numAlt)) {
        return {
          upc: input.upc, title: input.candidateTitle, changed: false, blocked: true,
          blockReason: `unevidenced_weight:${num}${m[2].toLowerCase()}`, appliedRules: [],
        };
      }
    }
  }

  // ── Normalize ────────────────────────────────────────────────────────────

  // R1 unit normalization (idempotent: already-normalized forms round-trip)
  let s = t.replace(/(\d)\s*#/g, '$1 lb.');
  s = s.replace(/(\d)[\s-]*lbs?\b\.?/gi, '$1 lb.');
  s = s.replace(/(\d)[\s-]*oz\b\.?/gi, '$1 oz.');
  s = s.replace(/(\d)[\s-]*ct\b\.?/gi, '$1-Count');
  if (s !== t) appliedRules.push('R1:units');

  // R2 leading-zero-less decimals (".53 oz." -> "0.53 oz.")
  const beforeR2 = s;
  s = s.replace(/\s\.(\d)/g, ' 0.$1');
  if (s !== beforeR2) appliedRules.push('R2:decimal');

  // R3 whitespace collapse + trim
  const beforeR3 = s;
  s = s.replace(/\s+/g, ' ').trim();
  if (s !== beforeR3) appliedRules.push('R3:whitespace');

  // R4 duplicate trailing size word: drop the trailing token when the SAME
  // canonical size (small|medium|large incl. sm/md/lg abbreviations) already
  // appears earlier in the title.
  const tokensBeforeR4 = s.split(' ');
  if (tokensBeforeR4.length >= 2) {
    const trailingRaw = tokensBeforeR4[tokensBeforeR4.length - 1];
    const trailingCanon = CANONICAL_SIZE[trailingRaw.toLowerCase()];
    if (trailingCanon) {
      const earlier = tokensBeforeR4.slice(0, -1).some(tok => CANONICAL_SIZE[tok.toLowerCase()] === trailingCanon);
      if (earlier) {
        s = tokensBeforeR4.slice(0, -1).join(' ');
        appliedRules.push('R4:dup-size');
      }
    }
  }

  // R5 brand casing dictionary (word-boundary, case-insensitive)
  const caseMap = { ...DEFAULT_BRAND_CASE_MAP, ...(options.brandCaseMap ?? {}) };
  const beforeR5 = s;
  for (const [key, canonical] of Object.entries(caseMap)) {
    if (!key) continue;
    s = s.replace(new RegExp(`(?<![\\w-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi'), canonical);
  }
  if (s !== beforeR5) appliedRules.push('R5:brand-casing');

  return {
    upc: input.upc,
    title: s,
    changed: appliedRules.length > 0 && s !== original,
    blocked: false,
    appliedRules,
  };
}

export function lintTitleSet(
  members: LintMemberInput[],
  options: LintOptions = {},
): { results: LintResult[]; anyBlocked: boolean; anyChanged: boolean } {
  const results = members.map(m => lintCandidateTitle(m, options));
  return {
    results,
    anyBlocked: results.some(r => r.blocked),
    anyChanged: results.some(r => r.changed),
  };
}
