/**
 * Pure family title consistency validator — Phase B1 (e09, T1-T10).
 *
 * No I/O, no DB. Validates a candidate title set for an existing product-family-v1
 * cohort before any durable write. ALL-OR-NOTHING per T7: a single invalid
 * member makes the whole set invalid — the caller must write zero durable
 * rows and may retry a deterministic fallback (which must also pass this
 * validator before commit). T10 grouping boundary: never calls
 * extractNameStem / familyGroupingIdentityFor / grouping version.
 */

// T8: bumped to v2 — the deterministic Title Lint (title-lint.ts) is now a
// post-processing rule applied to every candidate/fallback set before this
// validator runs, so linted sets are a new authority revision.
export const FAMILY_TITLE_CONSISTENCY_VERSION = 'v2' as const;

export interface TitleFrozenFacts {
  brand: string;
  productLine: string;
  formOrSpecies?: string;
  flavorOrColorOrSubline?: string;
  sizeOrCount?: string;
  /**
   * Additional flavor/color/sub-line tokens occupying the SAME {flavor} slot
   * (e09 round-3 fix: a second distinct flavor word is normalized into the
   * slot instead of being silently dropped).
   */
  extraFlavorTokens?: string[];
  /**
   * Additional size/weight/count tokens occupying the SAME {size} slot
   * (e09 round-3 fix: a weight match must NOT displace a size word — both
   * normalize into the single adjudicated Size/Weight/Count slot, so a
   * member carrying "Small 5 lb" and a sibling carrying "5 lb" produce the
   * same skeleton).
   */
  extraSizeTokens?: string[];
  modifiers: {
    soft?: boolean;
    hard?: boolean;
    classic?: boolean;
    hypoallergenic?: boolean;
  };
}

export interface TitleValidationInput {
  familyId: string;
  members: Array<{
    onboardingItemId: string;
    upc: string | null;
    frozenEvidenceHash: string;
    frozenFacts: TitleFrozenFacts;
  }>;
  candidateTitles: Array<{ upc: string | null; title: string }>;
}

export interface TitleValidationResult {
  valid: boolean;
  reason?: string;
  skeleton?: string;
  perMember: Array<{ upc: string | null; valid: boolean; reason?: string }>;
}

function normLower(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Standalone-token matcher shared by counting AND skeleton substitution.
 * Hyphen-adjacent exclusion: "large" must NOT match inside "X-Large" (\b treats the hyphen
 * as a boundary, but hyphenated compounds are single title tokens). A variant token only
 * counts when it is a standalone word, not a fragment of a hyphenated compound (T5 fix,
 * round-3 boundary consistency: deriveSkeleton uses the SAME rule so X-Large survives
 * Large substitution).
 */
function tokenRegExp(needle: string): RegExp {
  return new RegExp(`(?<![\\w-])${escRe(needle)}(?![\\w-])`, 'gi');
}

function countWord(haystack: string, needle: string): number {
  if (!needle) return 0;
  const m = haystack.match(tokenRegExp(needle));
  return m ? m.length : 0;
}

function deriveSkeleton(title: string, facts: TitleFrozenFacts): string {
  let s = title.trim().replace(/\s+/g, ' ').toLowerCase();
  const reps: Array<[string, string]> = [];
  if (facts.brand) reps.push([facts.brand, '{brand}']);
  if (facts.productLine && normLower(facts.productLine) !== normLower(facts.brand)) reps.push([facts.productLine, '{line}']);
  if (facts.modifiers.soft) reps.push(['soft', '{mod}']);
  if (facts.modifiers.hard) reps.push(['hard', '{mod}']);
  if (facts.modifiers.classic) reps.push(['classic', '{mod}']);
  if (facts.modifiers.hypoallergenic) {
    reps.push(['hypoallergenic', '{mod}']);
    reps.push(['hypo', '{mod}']);
  }
  if (facts.formOrSpecies) reps.push([facts.formOrSpecies, '{form}']);
  if (facts.flavorOrColorOrSubline) reps.push([facts.flavorOrColorOrSubline, '{flavor}']);
  for (const extra of facts.extraFlavorTokens ?? []) reps.push([extra, '{flavor}']);
  if (facts.sizeOrCount) reps.push([facts.sizeOrCount, '{size}']);
  for (const extra of facts.extraSizeTokens ?? []) reps.push([extra, '{size}']);
  reps.sort((a, b) => b[0].length - a[0].length);
  for (const [token, placeholder] of reps) {
    if (!token) continue;
    s = s.replace(tokenRegExp(token.trim().toLowerCase()), placeholder);
  }
  // Same-slot unification (round-3): several tokens expressing ONE logical slot
  // (e.g. "Small" + "5 lb" → "{size} {size}") collapse onto a single placeholder
  // so slot-identical families compare equal. Only ADJACENT duplicates collapse;
  // non-adjacent repeats of the same placeholder stay distinct and fail T2.
  s = s.replace(/(\{(?:brand|line|form|flavor|size|mod)\})( \1)+/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

function variantTokensFor(facts: TitleFrozenFacts): Set<string> {
  const set = new Set<string>();
  if (facts.modifiers.soft) set.add('soft');
  if (facts.modifiers.hard) set.add('hard');
  if (facts.modifiers.classic) set.add('classic');
  if (facts.modifiers.hypoallergenic) { set.add('hypoallergenic'); set.add('hypo'); }
  if (facts.formOrSpecies) set.add(normLower(facts.formOrSpecies));
  if (facts.flavorOrColorOrSubline) set.add(normLower(facts.flavorOrColorOrSubline));
  for (const extra of facts.extraFlavorTokens ?? []) set.add(normLower(extra));
  if (facts.sizeOrCount) set.add(normLower(facts.sizeOrCount));
  for (const extra of facts.extraSizeTokens ?? []) set.add(normLower(extra));
  return set;
}

/**
 * Validate a candidate title set — pure, deterministic.
 * T1: assumes caller passed the frozen cohort membership; does not regroup.
 * T2: shared skeleton identical after placeholder substitution.
 * T3: canonical brand/productLine identical across family, present in titles.
 * T4: always-visible variant fidelity (soft/hard/classic/hypo + flavor/size).
 * T5: no sibling leakage.
 * T6: no invention for indistinguishable frozenFacts.
 * T7: all-or-nothing (caller writes zero rows on valid=false).
 * T8: version FAMILY_TITLE_CONSISTENCY_VERSION participates in cohort-title hash (see cohort-title-hash.ts).
 * T10: no grouping call.
 */
export function validateFamilyTitleSet(input: TitleValidationInput): TitleValidationResult {
  const perMember: Array<{ upc: string | null; valid: boolean; reason?: string }> = [];
  if (input.members.length === 0) return { valid: true, skeleton: '', perMember };
  if (input.members.length !== input.candidateTitles.length) {
    return { valid: false, reason: 'candidateTitles length must equal members length', perMember: [] };
  }
  const titleByUpc = new Map<string | null, string>();
  for (const c of input.candidateTitles) {
    // Use string key; null UPC maps to '__null__' but we also keep per-upc lookup via member UPC
    titleByUpc.set(c.upc ?? '__null__', c.title);
  }
  // T3 canonical brand/line
  const brands = input.members.map(m => normLower(m.frozenFacts.brand));
  const lines = input.members.map(m => normLower(m.frozenFacts.productLine));
  const canonicalBrand = brands[0];
  const canonicalLine = lines[0];
  const brandMismatch = brands.some(b => b !== canonicalBrand);
  const lineMismatch = lines.some(l => l !== canonicalLine);

  // T6: indistinguishable frozenFacts groups
  const factsKey = (f: TitleFrozenFacts) => JSON.stringify({
    brand: normLower(f.brand),
    line: normLower(f.productLine),
    form: normLower(f.formOrSpecies),
    flavor: normLower(f.flavorOrColorOrSubline),
    extraFlavors: (f.extraFlavorTokens ?? []).map(normLower).sort(),
    size: normLower(f.sizeOrCount),
    extraSizes: (f.extraSizeTokens ?? []).map(normLower).sort(),
    soft: !!f.modifiers.soft, hard: !!f.modifiers.hard, classic: !!f.modifiers.classic, hypo: !!f.modifiers.hypoallergenic,
  });
  const groups = new Map<string, typeof input.members>();
  for (const m of input.members) {
    const k = factsKey(m.frozenFacts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(m);
  }
  let inventionReason: string | null = null;
  for (const [, grp] of groups) {
    if (grp.length > 1) {
      const titles = grp.map(m => normLower(titleByUpc.get(m.upc ?? '__null__') ?? ''));
      const distinct = new Set(titles);
      if (distinct.size > 1) inventionReason = 'indistinguishable frozenFacts but titles differ — invention to force uniqueness (T6)';
    }
  }

  // Pre-compute skeletons
  const skeletons: string[] = [];
  for (const m of input.members) {
    const raw = titleByUpc.get(m.upc ?? '__null__') ?? '';
    skeletons.push(deriveSkeleton(raw, m.frozenFacts));
  }
  const canonicalSkeleton = skeletons[0];
  const skeletonMismatch = skeletons.some(s => s !== canonicalSkeleton);

  // T5 sibling token sets
  const allVariantTokens = input.members.map(m => variantTokensFor(m.frozenFacts));

  let overallValid = true;
  let overallReason: string | undefined;

  if (brandMismatch) { overallValid = false; overallReason = 'canonical brand differs across family (T3)'; }
  else if (lineMismatch) { overallValid = false; overallReason = 'canonical productLine differs across family (T3)'; }
  else if (skeletonMismatch) { overallValid = false; overallReason = `shared skeleton mismatch (T2): ${skeletons.join(' | ')}`; }
  else if (inventionReason) { overallValid = false; overallReason = inventionReason; }

  for (let i = 0; i < input.members.length; i++) {
    const m = input.members[i];
    const raw = titleByUpc.get(m.upc ?? '__null__') ?? '';
    const normTitle = raw.trim().replace(/\s+/g, ' ');
    const lowerTitle = normTitle.toLowerCase();
    let valid = true;
    let reason: string | undefined;

    // T3: brand/line present in title
    if (normLower(m.frozenFacts.brand) && countWord(lowerTitle, normLower(m.frozenFacts.brand)) !== 1) {
      valid = false; reason = `brand "${m.frozenFacts.brand}" must appear exactly once (T3)`;
    } else if (normLower(m.frozenFacts.productLine) && normLower(m.frozenFacts.productLine) !== normLower(m.frozenFacts.brand) && countWord(lowerTitle, normLower(m.frozenFacts.productLine)) !== 1) {
      valid = false; reason = `productLine "${m.frozenFacts.productLine}" must appear exactly once (T3)`;
    }
    // T4 variant fidelity
    if (valid) {
      const checks: Array<[boolean | undefined, string]> = [
        [m.frozenFacts.modifiers.soft, 'soft'],
        [m.frozenFacts.modifiers.hard, 'hard'],
        [m.frozenFacts.modifiers.classic, 'classic'],
        [m.frozenFacts.modifiers.hypoallergenic, 'hypoallergenic'],
      ];
      for (const [flag, token] of checks) {
        if (!flag) continue;
        if (token === 'hypoallergenic') {
          // T4: accepts "hypoallergenic" or standalone "hypo" — word boundaries keep the counts separate
          if (countWord(lowerTitle, 'hypoallergenic') === 0 && countWord(lowerTitle, 'hypo') === 0) {
            valid = false; reason = `modifier "${token}" must appear exactly once (T4)`; break;
          }
        } else if (countWord(lowerTitle, token) !== 1) { valid = false; reason = `modifier "${token}" must appear exactly once (T4)`; break; }
      }
    }
    if (valid && m.frozenFacts.flavorOrColorOrSubline) {
      if (countWord(lowerTitle, normLower(m.frozenFacts.flavorOrColorOrSubline)) !== 1) {
        valid = false; reason = `flavor "${m.frozenFacts.flavorOrColorOrSubline}" must appear exactly once (T4)`;
      }
    }
    for (const extra of valid ? (m.frozenFacts.extraFlavorTokens ?? []) : []) {
      if (countWord(lowerTitle, normLower(extra)) !== 1) {
        valid = false; reason = `flavor "${extra}" must appear exactly once (T4)`; break;
      }
    }
    if (valid && m.frozenFacts.sizeOrCount) {
      if (countWord(lowerTitle, normLower(m.frozenFacts.sizeOrCount)) !== 1) {
        valid = false; reason = `size "${m.frozenFacts.sizeOrCount}" must appear exactly once (T4)`;
      }
    }
    for (const extra of valid ? (m.frozenFacts.extraSizeTokens ?? []) : []) {
      if (countWord(lowerTitle, normLower(extra)) !== 1) {
        valid = false; reason = `size "${extra}" must appear exactly once (T4)`; break;
      }
    }
    if (valid && m.frozenFacts.formOrSpecies) {
      if (countWord(lowerTitle, normLower(m.frozenFacts.formOrSpecies)) !== 1) {
        valid = false; reason = `form "${m.frozenFacts.formOrSpecies}" must appear exactly once (T4)`;
      }
    }
    // T5 no sibling leakage
    if (valid) {
      const own = allVariantTokens[i];
      const siblingOnly = new Set<string>();
      for (let j = 0; j < allVariantTokens.length; j++) {
        if (j === i) continue;
        for (const tok of allVariantTokens[j]) if (!own.has(tok)) siblingOnly.add(tok);
      }
      for (const tok of siblingOnly) {
        if (countWord(lowerTitle, tok) > 0) { valid = false; reason = `sibling leakage: title contains "${tok}" not in this member's frozenFacts (T5)`; break; }
      }
    }
    // Overall skeleton/brand/invention also invalidates per-member
    if (!overallValid) valid = false;
    if (!valid) overallValid = false;
    perMember.push({ upc: m.upc, valid, reason: valid ? undefined : (reason ?? overallReason) });
  }

  return { valid: overallValid, reason: overallValid ? undefined : (overallReason ?? perMember.find(p => !p.valid)?.reason), skeleton: canonicalSkeleton, perMember };
}
