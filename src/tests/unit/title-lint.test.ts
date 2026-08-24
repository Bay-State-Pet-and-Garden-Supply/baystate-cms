/**
 * Title Lint unit tests — e09 follow-through.
 *
 * Every case encodes a REAL defect from the 2026-08-22 census / 2026-08-23
 * cohort re-run regression (see docs/plans/family-title-category-page-
 * requirements-plan.md and src/tests/fixtures/family-title-page-goldset-v2.json).
 */
import { describe, it, expect } from 'vitest';
import {
  lintCandidateTitle,
  lintTitleSet,
  DEFAULT_BRAND_CASE_MAP,
  TITLE_LINT_VERSION,
} from '../../classification/title-lint';

describe('title-lint', () => {
  it('exposes a lint version', () => {
    expect(TITLE_LINT_VERSION).toBe('v1');
  });

  // ── R1 units ─────────────────────────────────────────────────────────────

  it('expands unexpanded # sizes (census: Wholesomes "20#")', () => {
    const r = lintCandidateTitle({
      upc: '034846550535',
      candidateTitle: 'Wholesomes Rewards Sensitive Salmon Small 20#',
      rawTitle: 'WHOLESOMES REWARDS SENSTIVE SLMN SM 20#',
      extractionStrings: ['sensitive salmon small breed dog treats', '20'],
    });
    expect(r.blocked).toBe(false);
    expect(r.title).toBe('Wholesomes Rewards Sensitive Salmon Small 20 lb.');
    expect(r.appliedRules).toContain('R1:units');
    expect(r.changed).toBe(true);
  });

  it('normalizes tight lb/oz/ct units idempotently', () => {
    const once = lintCandidateTitle({
      upc: null, candidateTitle: 'Wellness Core+ Salmon Recipe 4lb',
      rawTitle: 'WELLNESS CORE+ SENSITIVE SLMN 4LB', extractionStrings: ['4lb dry food'],
    });
    expect(once.title).toBe('Wellness Core+ Salmon Recipe 4 lb.');
    const twice = lintCandidateTitle({ upc: null, candidateTitle: once.title, rawTitle: 'X', extractionStrings: ['4'] });
    expect(twice.title).toBe(once.title);
    expect(twice.changed).toBe(false);

    const oz = lintCandidateTitle({ upc: null, candidateTitle: 'Churu Tube 1.05oz', rawTitle: 'CHURU TUBE 105 OZ', extractionStrings: ['1.05oz'] });
    expect(oz.title).toBe('Churu Tube 1.05 oz.');
    const ct = lintCandidateTitle({ upc: null, candidateTitle: 'Earthbath Eye Wipes Aloe 30ct', rawTitle: 'EARTHBATH EYE WIPES 30CT', extractionStrings: ['30 wipes'] });
    expect(ct.title).toBe('Earthbath Eye Wipes Aloe 30-Count');
  });

  // ── R2 leading-zero decimals ─────────────────────────────────────────────

  it('adds leading zeros to decimals (census: Churu Terrine ".53 oz.")', () => {
    const r = lintCandidateTitle({
      upc: '810100858353',
      candidateTitle: 'Inaba Churu Terrine Chicken/Cheese 4 Tubes .53 oz.',
      rawTitle: 'CHURU TERRINE CHKN/CHEESE 4 TUBES .53 OZ',
      extractionStrings: ['.53 oz per tube'],
    });
    expect(r.title).toBe('Inaba Churu Terrine Chicken/Cheese 4 Tubes 0.53 oz.');
    expect(r.appliedRules).toContain('R2:decimal');
  });

  // ── R4 duplicate trailing size ───────────────────────────────────────────

  it('drops a duplicated trailing size word (census: "...Lamb Medium 3lb Medium")', () => {
    const r = lintCandidateTitle({
      upc: '034846550139',
      candidateTitle: 'Wholesomes Rewards Sensitive Lamb Medium 3lb Medium',
      rawTitle: 'WHOLESOMES REWARDS SENSITIVE LAMB MD 3LB',
      extractionStrings: ['lamb medium breed biscuits 3 pound bag'],
    });
    expect(r.title).toBe('Wholesomes Rewards Sensitive Lamb Medium 3 lb.');
    expect(r.appliedRules).toContain('R1:units');
    expect(r.appliedRules).toContain('R4:dup-size');
  });

  it('keeps distinct density+size words (BetterBone "Medium ... Large")', () => {
    const r = lintCandidateTitle({
      upc: '850028916575',
      candidateTitle: 'BetterBone Medium Beef Chew Dog Toy Large',
      rawTitle: 'BETTER BONE MD BEEFLG',
      extractionStrings: ['BetterBone Medium Beef Chew Dog Toy Large'],
    });
    expect(r.blocked).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.title).toBe('BetterBone Medium Beef Chew Dog Toy Large');
  });

  // ── R5 brand casing ──────────────────────────────────────────────────────

  it('applies the default brand casing dictionary (census: "kong Squeakz")', () => {
    const r = lintCandidateTitle({
      upc: '035585014852',
      candidateTitle: 'kong Squeakz Stick Large',
      rawTitle: 'KONG SQUEAKZ STICK LG',
      extractionStrings: ['KONG Squeakz Stick dog toy'],
    });
    expect(r.title).toBe('KONG Squeakz Stick Large');
    expect(r.appliedRules).toContain('R5:brand-casing');
  });

  it('honors caller brandCaseMap overrides over defaults', () => {
    const r = lintCandidateTitle(
      // rawTitle must differ from the candidate (else B1 blocks before R5 runs)
      { upc: null, candidateTitle: 'acme Brand Chewy Small', rawTitle: 'ACME BRAND CHEWY SM', extractionStrings: ['acme small breed'] },
      { brandCaseMap: { acme: 'AcMe Pet' } },
    );
    expect(r.blocked).toBe(false);
    expect(r.title).toBe('AcMe Pet Brand Chewy Small');
    expect(DEFAULT_BRAND_CASE_MAP.kong).toBe('KONG');
  });

  // ── B1 all-caps fallback leak ────────────────────────────────────────────

  it('BLOCKS an all-caps spreadsheet fallback leaking as final title', () => {
    const r = lintCandidateTitle({
      upc: '035585014890',
      candidateTitle: 'KONG SQUEAKZ WHEEL LG',
      rawTitle: 'KONG SQUEAKZ WHEEL LG',
      extractionStrings: ['Easy-to-grab shape for fetching'],
    });
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe('spreadsheet_fallback_leak');
    expect(r.changed).toBe(false);
  });

  it('does NOT block a cleaned title that merely shares tokens with the sheet name', () => {
    const r = lintCandidateTitle({
      upc: '035585014890',
      candidateTitle: 'KONG Squeakz Wheel Dog Toy Large',
      rawTitle: 'KONG SQUEAKZ WHEEL LG',
      extractionStrings: [],
    });
    expect(r.blocked).toBe(false);
  });

  // ── B2 phantom weights ───────────────────────────────────────────────────

  it('BLOCKS a phantom weight absent from raw title AND extraction evidence', () => {
    const r = lintCandidateTitle({
      upc: '035585506760',
      candidateTitle: 'KONG Rewards ZooLoozelephant Medium 2.64 oz',
      rawTitle: 'KONG REWARDS ZOOLOOZELEPHANT MD',
      extractionStrings: ['plush dog toy with squeaker', 'medium'],
    });
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe('unevidenced_weight:2.64oz');
  });

  it('BLOCKS a leading-dot phantom weight (".99 oz" unevidenced — round-2 gap)', () => {
    const r = lintCandidateTitle({
      upc: null,
      candidateTitle: 'Acme Treat .99 oz',
      rawTitle: 'ACME TREAT',
      extractionStrings: ['crunchy treats for dogs'],
    });
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe('unevidenced_weight:.99oz');
  });

  it('PASSES a weight backed by extraction evidence', () => {
    const r = lintCandidateTitle({
      upc: '769949610236',
      candidateTitle: 'Instinct Cat Flaked Chicken Split 2.64 oz',
      rawTitle: 'INSTINCT CAT FLAKEDCHKN SPLIT 2.64OZ',
      extractionStrings: ['flaked chicken recipe in broth'],
    });
    expect(r.blocked).toBe(false);
    expect(r.title).toBe('Instinct Cat Flaked Chicken Split 2.64 oz.');
  });

  it('skips B2 entirely when no extraction evidence is supplied (legacy callers)', () => {
    const blocked = lintCandidateTitle({
      upc: null,
      candidateTitle: 'Mystery Product Chew Toy 2.64 oz',
      rawTitle: 'MYSTERY PRODUCT CHEW TOY',
      extractionStrings: [],
    });
    expect(blocked.blocked).toBe(false);
    const noField = lintCandidateTitle({
      upc: null,
      candidateTitle: 'Mystery Product Chew Toy 2.64 oz',
      rawTitle: 'MYSTERY PRODUCT CHEW TOY',
    });
    expect(noField.blocked).toBe(false);
  });

  it('accepts substring decimal evidence (".64" matches inside "2.64")', () => {
    const r = lintCandidateTitle({
      upc: null,
      candidateTitle: 'Tiny Treats Bites .64 oz',
      rawTitle: 'TINY TREATS BITES',
      extractionStrings: ['net weight 2.64 oz'],
    });
    // Evidence matching is substring-based: after R2 the number is "0.64"; its
    // alternate spelling ".64" occurs inside "2.64" in the extraction corpus,
    // so the weight counts as evidenced. Deliberately lenient — a false BLOCK
    // fails a whole cohort closed, while this only tolerates near-miss decimals.
    expect(r.blocked).toBe(false);
    expect(r.title).toBe('Tiny Treats Bites 0.64 oz.');
  });

  // ── Idempotency + set aggregation ────────────────────────────────────────

  it('is idempotent: lint(lint(x)) === lint(x)', () => {
    const input = {
      upc: '034846550139',
      candidateTitle: 'Wholesomes Rewards Sensitive Lamb Medium 3lb Medium',
      rawTitle: 'WHOLESOMES REWARDS SENSITIVE LAMB MD 3LB',
      extractionStrings: ['3 pound bag'],
    };
    const once = lintCandidateTitle(input);
    const twice = lintCandidateTitle({ ...input, candidateTitle: once.title });
    expect(twice.title).toBe(once.title);
    expect(twice.changed).toBe(false);
    expect(twice.appliedRules).toHaveLength(0);
  });

  it('aggregates set results: anyBlocked / anyChanged', () => {
    const set = lintTitleSet([
      { upc: 'A', candidateTitle: 'Brand One Small Breed 3lb', rawTitle: 'BRAND ONE SM BREED 3LB', extractionStrings: ['3 pound bag'] },
      { upc: 'B', candidateTitle: 'BRAND TWO THING XL', rawTitle: 'BRAND TWO THING XL', extractionStrings: [] },
      { upc: 'C', candidateTitle: 'Brand Three Toy 2.64 oz', rawTitle: 'BRAND THREE TOY', extractionStrings: ['plush toy'] },
    ]);
    expect(set.anyBlocked).toBe(true);
    expect(set.anyChanged).toBe(true);
    expect(set.results[0].blocked).toBe(false);
    expect(set.results[0].title).toBe('Brand One Small Breed 3 lb.');
    expect(set.results[1].blocked).toBe(true);
    expect(set.results[2].blockReason).toContain('unevidenced_weight');
  });

  it('returns unchanged/clean for an already-linted healthy set', () => {
    const set = lintTitleSet([
      { upc: 'A', candidateTitle: 'BetterBone Soft Beef Chew Dog Toy Small', rawTitle: 'BETTER BONE SOFT BEEF SM', extractionStrings: ['soft beef chew'] },
      { upc: 'B', candidateTitle: 'BetterBone Soft Beef Chew Dog Toy Large', rawTitle: 'BETTER BONE SOFT BEEF LG', extractionStrings: ['soft beef chew large'] },
    ]);
    expect(set.anyBlocked).toBe(false);
    expect(set.anyChanged).toBe(false);
  });
});
