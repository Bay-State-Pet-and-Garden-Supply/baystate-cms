/**
 * e09 Phase C — goldset-driven validation tests (FROZEN production-attested v2).
 *
 * Fixture under test: src/tests/fixtures/family-title-page-goldset-v2.json
 * Status: FROZEN export from durable product-family-v1 cohorts of batch
 * NEWFORNICK081226 (2026-08-22 incident census + 2026-08-23 convention lint),
 * signed off by the Store Manager. 98 production families / 140 members,
 * by-family train/test/holdout splits, stable verified Page GUIDs, per-member
 * evidenceBacking provenance, tamper-evident goldsetHash, plus a SEPARATE
 * syntheticExamples block (3 legacy synthetic scaffold families).
 *
 * These tests enforce the freeze contract (hash, schema, splits, Page-ID
 * stability) AND execute the real Focus 1 / Focus 2 validators against the
 * adjudicated expectations.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { validateFamilyTitleSet } from '../../classification/family-title-consistency';
import type { TitleFrozenFacts } from '../../classification/family-title-consistency';
import { validateCategoryPageAssignment } from '../../classification/category-page-correctness';
import type { PageCorrectnessInput } from '../../classification/category-page-correctness';

// ─── Fixture ────────────────────────────────────────────────────────────────

interface GoldsetMember {
  onboardingItemId: string;
  upc: string;
  rawTitle?: string;
  frozenEvidenceHash: string;
  frozenEvidence?: Record<string, unknown>;
  expectedTitle: string;
  expectedPrimaryPageIds: string[];
  allowedSecondaryPageIds?: string[];
  evidenceBacking?: 'strong' | 'partial' | 'adjudicated';
  unevidencedTokens?: string[];
  repairedInCensus?: boolean;
}
interface GoldsetFamily {
  familyId: string;
  groupKey: string;
  groupingVersion: string;
  membershipHash: string;
  isSynthetic: boolean;
  isIncidentFamily?: boolean;
  expectedTitleSkeleton?: string;
  adjudicationRationale: string;
  reviewer: string;
  reviewTimestamp: string;
  reviewStatus: string;
  members: GoldsetMember[];
}
interface Goldset {
  version: number;
  status: string;
  activePageImportHash: string;
  reviewer: string;
  reviewTimestamp: string;
  skeleton: string;
  goldsetHash: string;
  splitCounts: Record<string, number>;
  evidenceBackingCounts: Record<string, number>;
  familyCount: number;
  memberCount: number;
  splits: { strategy: string; train: string[]; test: string[]; holdout: string[] };
  families: GoldsetFamily[];
  syntheticExamples: GoldsetFamily[];
}

const fixturePath = path.join(__dirname, '..', 'fixtures', 'family-title-page-goldset-v2.json');
const goldset: Goldset = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

const metricsPath = path.join(__dirname, '..', '..', '..', 'specs', 'metrics', 'family-title-page-eval-v1.json');
const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8')) as { goldsetName: string; goldsetHash: string };

// ─── Tamper-evident hash ────────────────────────────────────────────────────

function recomputedHash(): string {
  const { goldsetHash: _ignored, ...rest } = goldset;
  return 'sha256-' + createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

// ─── Frozen-facts derivation (documented approach) ──────────────────────────
//
// The pure validator derives each member's title skeleton from typed
// TitleFrozenFacts. The goldset stores raw + expected titles rather than typed
// slots, so — exactly like the prior synthetic-scaffold test — we derive the
// minimal typed facts FROM the adjudicated expected titles themselves,
// consistent with the ratified skeleton (Brand → Line → Form → Flavor → Size):
//
// - brand            := longest common word prefix of the family's expected
//                       titles (canonical shared head; T3 checks it appears
//                       exactly once per title).
// - formOrSpecies    := the LEADING density word (soft|hard|classic|medium)
//                       when the title opens with one (BetterBone-style).
//                       Mapping it to the {form} slot — checked BEFORE size
//                       matching, so a leading "Medium" is never eaten as
//                       {size} — lets density variants share one skeleton
//                       with Soft/Hard siblings.
// - flavor           := first remaining content token; a trailing sub-line
//                       modifier (classic/hypoallergenic) folds into
//                       extraFlavorTokens so the round-3 adjacent-placeholder
//                       collapse unifies "{flavor} {flavor}" → "{flavor}".
// - sizeOrCount      := the size/weight/count expression (ordered rules:
//                       compound "Medium/Large", X-Small/X-Large, XL/XS,
//                       Small/Medium/Large/Mini, "Size N", "N lb/oz",
//                       "N Count/Pack").
// - modifiers        := all false (every variant word is carried by the slots
//                       above, so T4 fidelity still applies through them).

const DENSITY_LEAD_WORDS = new Set(['soft', 'hard', 'classic', 'medium']);
const SUB_LINE_WORDS = new Set(['classic', 'hypoallergenic', 'hypo']);
// Preparation descriptors (e.g. "Sous-Vide") occupy the Form slot, mirroring
// production's form/species classification. Hyphenated compounds stay whole:
// the validator's tokenRegExp treats "Sous-Vide" as a single title token
// (hyphen-aware boundaries), so splitting it for T4 counting would never match.
const FORM_PREP_WORDS = new Set(['sous-vide', 'freeze-dried']);
const GENERIC_TOKENS = new Set([
  'chew', 'dog', 'toy', 'toys', 'cat', 'treats', 'food', 'recipe',
  'and', 'with', 'for', 'the', 'of', 'in', 'flavor', 'pack', 'count',
]);

function words(s: string): string[] {
  return s.trim().replace(/\s+/g, ' ').split(/\s+/);
}

function commonWordPrefix(titles: string[]): number {
  const w = titles.map(words);
  let i = 0;
  loop: while (w[0][i] !== undefined) {
    for (let j = 1; j < w.length; j++) {
      if (w[j][i] !== w[0][i]) break loop;
    }
    i++;
  }
  return Math.max(1, i);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SIZE_RULES: RegExp[] = [
  /\bmedium\/large\b/i,
  /\bx-small\b/i,
  /\bx-large\b/i,
  /\b(?:xl|xs)\b/i,
  /\b(?:small|medium|large|mini)\b/i,
  /\bsize\s+\d+\b/i,
  /\d+(?:\.\d+)?\s*\.?\s*(?:lbs?|oz)\b/i,
  /\b\d+\s*-\s*(?:count|pack)\b/i,
  /\b\d+\s+(?:count|pack)\b/i,
];

function findSize(rest: string): string | null {
  for (const rule of SIZE_RULES) {
    const m = rest.match(rule);
    if (m) return m[0];
  }
  return null;
}

function frozenFactsFor(family: GoldsetFamily, member: GoldsetMember): TitleFrozenFacts {
  const titles = family.members.map(m => m.expectedTitle);
  const prefixLen = commonWordPrefix(titles);
  const rests = family.members.map(m => words(m.expectedTitle).slice(prefixLen));

  // When EVERY member opens its tail with a variant word (density OR size),
  // map all leads uniformly onto {form} so "White Medium" / "White X-Large"
  // style tails share one skeleton instead of splitting {form} vs {size}.
  const VARIANT_TAIL_WORDS = new Set([...DENSITY_LEAD_WORDS, 'small', 'medium', 'large', 'mini', 'xl', 'xs', 'x-large', 'x-small']);
  const isVariantTail = (w: string | undefined) => !!w && VARIANT_TAIL_WORDS.has(w.toLowerCase());
  const uniformVariantTails = rests.every(r => isVariantTail(r[0]));

  const myRest = rests[family.members.indexOf(member)];
  let form: string | undefined;
  let scanFrom = myRest.join(' ');
  const lead = myRest[0]?.toLowerCase() ?? '';
  if ((DENSITY_LEAD_WORDS.has(lead)) || (uniformVariantTails && isVariantTail(lead))) {
    form = myRest[0];
    scanFrom = myRest.slice(1).join(' ');
  }

  // Leading variant word wins the {form} slot before any size matching.
  const sizeMatch = findSize(scanFrom);
  const sizeNorm = sizeMatch ? sizeMatch.toLowerCase().replace(/\s+/g, ' ').trim() : null;
  const restNoSize = sizeMatch ? scanFrom.replace(new RegExp(escapeRe(sizeMatch), 'i'), ' ') : scanFrom;

  const tokens = restNoSize.split(/[^A-Za-z0-9'&+/-]+/).filter(Boolean);

  let flavor: string | undefined;
  const extraFlavors: string[] = [];

  for (const tk of tokens) {
    const l = tk.toLowerCase();
    // Preparation descriptors take the Form slot (or are skipped when a
    // density word already occupies it) — never the flavor slot.
    if (FORM_PREP_WORDS.has(l)) {
      if (!form) form = tk;
      continue;
    }
    // Trailing sub-line words (Classic/Hypoallergenic) join the flavor slot
    // so "...Veggie Hypoallergenic..." collapses onto "...{flavor}...".
    if (SUB_LINE_WORDS.has(l)) {
      extraFlavors.push(tk);
      continue;
    }
    if (GENERIC_TOKENS.has(l)) continue;
    if (!flavor) flavor = tk;
    else extraFlavors.push(tk);
  }

  return {
    brand: words(member.expectedTitle).slice(0, prefixLen).join(' '),
    productLine: '',
    formOrSpecies: form,
    flavorOrColorOrSubline: flavor,
    extraFlavorTokens: extraFlavors,
    sizeOrCount: sizeNorm ?? undefined,
    modifiers: { soft: false, hard: false, classic: false, hypoallergenic: false },
  };
}

// ─── Verified-catalog stub built from the fixture's own Page GUIDs ──────────
//
// The fixture carries STABLE PAGE IDS only (names are display data and are
// deliberately absent). The validator tolerates name-less catalog entries:
// with empty names, pageSpecies/pageCategory token sets are empty, so the
// semantic P5 contradictions cannot fire — identity (P2), brand-as-primary
// (P7), and dual-species guard (P3) remain exercised. This mirrors the
// production invariant that identity alone is necessary-but-not-sufficient
// while meaning checks run against real page names upstream.

const allPageIds = [
  ...new Set(
    goldset.families.flatMap(f =>
      f.members.flatMap(m => [...(m.expectedPrimaryPageIds ?? []), ...(m.allowedSecondaryPageIds ?? [])]),
    ),
  ),
];

const CATALOG: PageCorrectnessInput['verifiedPageCatalog'] = allPageIds.map(id => ({
  id,
  name: '',
  parentId: null,
}));

function pageInput(member: GoldsetMember, primaryPageId: string | null, secondaryPageIds: string[]): PageCorrectnessInput {
  const evidence = {
    ...(member.frozenEvidence ?? {}),
    species: (member.frozenEvidence?.species as string[] | undefined) ?? ['Dog'],
    title: (member.frozenEvidence?.title as string | undefined) ?? member.rawTitle ?? member.expectedTitle,
  };
  return {
    member: {
      onboardingItemId: member.onboardingItemId,
      frozenEvidenceHash: member.frozenEvidenceHash,
      frozenEvidence: evidence as PageCorrectnessInput['member']['frozenEvidence'],
    },
    candidate: { primaryPageId, secondaryPageIds, primaryPageName: null },
    verifiedPageCatalog: CATALOG,
    activePageImportHash: goldset.activePageImportHash,
    expectedActivePageImportHash: null, // promotion gate owns P11 enforcement
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── §12 freeze contract ────────────────────────────────────────────────────

describe('e09 goldset v2 — frozen production-attested fixture contract', () => {
  it('is FROZEN and its goldsetHash matches a recomputed SHA-256 (tamper-evidence)', () => {
    expect(goldset.status).toBe('FROZEN');
    expect(goldset.goldsetHash).toMatch(/^sha256-/);
    expect(recomputedHash()).toBe(goldset.goldsetHash);
  });

  it('metrics file references the same frozen goldset hash', () => {
    expect(metrics.goldsetName).toBe('family-title-page-goldset-v2');
    expect(metrics.goldsetHash).toBe(goldset.goldsetHash);
  });

  it('schema integrity: every production family and member carries the full contract fields', () => {
    expect(goldset.version).toBe(2);
    expect(goldset.reviewer).toMatch(/Store Manager/);
    expect(goldset.reviewTimestamp).toBeTruthy();
    expect(goldset.skeleton).toMatch(/Brand/);
    expect(goldset.familyCount).toBe(goldset.families.length);
    expect(goldset.memberCount).toBe(goldset.families.reduce((n, f) => n + f.members.length, 0));

    const familyIds = new Set<string>();
    const memberIds = new Set<string>();
    for (const family of goldset.families) {
      expect(family.isSynthetic).toBe(false);
      expect(family.groupingVersion).toBe('product-family-v1');
      expect(family.membershipHash).toBeTruthy();
      expect(family.reviewStatus).toBe('approved');
      expect(family.reviewer).toBeTruthy();
      expect(family.reviewTimestamp).toBeTruthy();
      expect(family.adjudicationRationale).toBeTruthy();
      expect(familyIds.has(family.familyId)).toBe(false);
      familyIds.add(family.familyId);

      for (const member of family.members) {
        expect(member.onboardingItemId).toBeTruthy();
        expect(member.upc).toBeTruthy();
        expect(member.rawTitle).toBeTruthy();
        expect(member.frozenEvidenceHash).toBeTruthy();
        expect(member.expectedTitle).toBeTruthy();
        expect(Array.isArray(member.expectedPrimaryPageIds)).toBe(true);
        expect(typeof member.evidenceBacking).toBe('string');
        expect(['strong', 'partial', 'adjudicated']).toContain(member.evidenceBacking);
        expect(memberIds.has(member.onboardingItemId)).toBe(false);
        memberIds.add(member.onboardingItemId);
      }
    }
  });

  it('by-family splits partition every family exactly once and match splitCounts', () => {
    expect(goldset.splits.strategy).toBe('by-family');
    const familyIds = goldset.families.map(f => f.familyId).sort();
    const splitIds = [...goldset.splits.train, ...goldset.splits.test, ...goldset.splits.holdout].sort();
    expect(splitIds).toEqual(familyIds);
    expect(new Set(splitIds).size).toBe(splitIds.length);
    for (const key of ['train', 'test', 'holdout'] as const) {
      expect(goldset.splits[key].length).toBe(goldset.splitCounts[key]);
    }
  });

  it('Page references are stable verified GUIDs, unique per member — never names', () => {
    for (const family of goldset.families) {
      for (const member of family.members) {
        const ids = [...(member.expectedPrimaryPageIds ?? []), ...(member.allowedSecondaryPageIds ?? [])];
        for (const id of ids) expect(id).toMatch(UUID_RE);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('synthetic examples live in a separate block and never count as production families', () => {
    expect(goldset.syntheticExamples.length).toBe(3);
    for (const synth of goldset.syntheticExamples) {
      expect(synth.isSynthetic).toBe(true);
    }
    for (const family of goldset.families) {
      expect(family.isSynthetic).toBe(false);
      expect(goldset.splits.train.concat(goldset.splits.test, goldset.splits.holdout)).toContain(family.familyId);
    }
  });
});

// ─── Focus 1 execution: validateFamilyTitleSet ──────────────────────────────

describe('e09 goldset v2 — title contract execution (Focus 1)', () => {
  it('every multi-member family passes validateFamilyTitleSet under the derived frozen facts', () => {
    const multi = goldset.families.filter(f => f.members.length > 1);
    expect(multi.length).toBeGreaterThan(15);
    for (const family of multi) {
      const result = validateFamilyTitleSet({
        familyId: family.familyId,
        members: family.members.map(member => ({
          onboardingItemId: member.onboardingItemId,
          upc: member.upc,
          frozenEvidenceHash: member.frozenEvidenceHash,
          frozenFacts: frozenFactsFor(family, member),
        })),
        candidateTitles: family.members.map(member => ({
          upc: member.upc,
          title: member.expectedTitle,
        })),
      });
      expect(result.valid, `${family.groupKey}: ${result.reason ?? ''}`).toBe(true);
    }
  });

  it('the 22-member BetterBone incident family shares one skeleton with density + sub-line variants unified', () => {
    const betterbone = goldset.families.find(f => f.members.length === 22);
    expect(betterbone).toBeDefined();
    expect(betterbone!.groupKey).toBe('betterbone::better bone');
    const result = validateFamilyTitleSet({
      familyId: betterbone!.familyId,
      members: betterbone!.members.map(member => ({
        onboardingItemId: member.onboardingItemId,
        upc: member.upc,
        frozenEvidenceHash: member.frozenEvidenceHash,
        frozenFacts: frozenFactsFor(betterbone!, member),
      })),
      candidateTitles: betterbone!.members.map(member => ({
        upc: member.upc,
        title: member.expectedTitle,
      })),
    });
    expect(result.valid, result.reason).toBe(true);
    // Density (Soft/Hard/Classic/Medium) and sub-line (Veggie Hypoallergenic)
    // variants unify onto one skeleton; each member retains its own flavor +
    // density + size (no sibling leakage, always-visible modifiers).
    expect(result.skeleton).toMatch(/^\{brand\} \{form\} \{flavor\} chew dog toy \{size\}$/);
  });
});

// ─── Focus 2 execution: validateCategoryPageAssignment ──────────────────────

describe('e09 goldset v2 — category page contract execution (Focus 2)', () => {
  it('members with an adjudicated primary Page resolve to "assigned" against their own stable GUIDs', () => {
    let assignedChecked = 0;
    for (const family of goldset.families) {
      for (const member of family.members) {
        const primaries = member.expectedPrimaryPageIds ?? [];
        if (primaries.length === 0) continue;
        assignedChecked++;
        const result = validateCategoryPageAssignment(
          pageInput(member, primaries[0], member.allowedSecondaryPageIds ?? []),
        );
        expect(result.outcome, `${member.upc}: ${result.reason ?? ''}`).toBe('assigned');
        expect(result.valid).toBe(true);
      }
    }
    // The refined batch left many members pageless (see the P3/P10 pin below);
    // 46 members DO carry an adjudicated primary and must validate cleanly.
    expect(assignedChecked).toBeGreaterThan(40);
  });

  it('members WITHOUT an adjudicated primary Page fail closed as needs_input (P3/P10 pin)', () => {
    const pageless = goldset.families.flatMap(f => f.members).filter(
      m => (m.expectedPrimaryPageIds ?? []).length === 0,
    );
    // The census exported the batch honestly: some refined members reached
    // review completion without a Page decision. The gate MUST refuse those —
    // this pins the fail-closed behavior the review-completion gate relies on.
    expect(pageless.length).toBeGreaterThan(0);
    for (const member of pageless.slice(0, 10)) {
      const result = validateCategoryPageAssignment(pageInput(member, null, []));
      expect(result.outcome).toBe('needs_input');
      expect(result.valid).toBe(false);
    }
  });

  it('secondary Pages stay within the verified catalog and never displace the primary (P7)', () => {
    for (const family of goldset.families) {
      for (const member of family.members) {
        const primaries = member.expectedPrimaryPageIds ?? [];
        const secondaries = member.allowedSecondaryPageIds ?? [];
        if (primaries.length === 0 || secondaries.length === 0) continue;
        const result = validateCategoryPageAssignment(pageInput(member, primaries[0], secondaries));
        expect(result.outcome, `${member.upc}: ${result.reason ?? ''}`).toBe('assigned');
      }
    }
  });
});

// ─── Evidence-backing provenance ────────────────────────────────────────────

describe('e09 goldset v2 — evidenceBacking provenance', () => {
  it('member counts match the declared evidenceBackingCounts and non-strong members cite their gaps', () => {
    const counts: Record<string, number> = { strong: 0, partial: 0, adjudicated: 0 };
    for (const family of goldset.families) {
      for (const member of family.members) {
        const level = member.evidenceBacking ?? 'strong';
        counts[level]++;
        if (level !== 'strong') {
          expect(Array.isArray(member.unevidencedTokens)).toBe(true);
          expect((member.unevidencedTokens ?? []).length).toBeGreaterThan(0);
        }
      }
    }
    expect(counts).toEqual(goldset.evidenceBackingCounts);
    expect(counts.strong / (counts.strong + counts.partial + counts.adjudicated)).toBeGreaterThan(0.8);
  });
});
