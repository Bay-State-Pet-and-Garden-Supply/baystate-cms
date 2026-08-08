/**
 * Pure tool-contract tests (PI-3): deterministic helpers and adapters that
 * need no database or network — GTIN validation, exact-match checks, identity
 * signal comparison, source priority, and page identity classification.
 */
import { describe, expect, it } from 'vitest';
import { classifyPageIdentity, jsonLdLeafProductProof, structuredSingleVariantProof, upcCheckDigit, variantProofFromSignals } from '../../product-intelligence/tools/contract';
import { checkExactGtinMatch, compareIdentitySignals, checkSourcePriority } from '../../product-intelligence/tools/verification-tools';
import { validateGtin } from '../../product-intelligence/tools/identity-tools';
import type { PiToolContext } from '../../product-intelligence/tools/contract';
import { testPolicy } from './product-intelligence/test-helpers';

const ctx: PiToolContext = {
  runId: 'run-1',
  workspaceId: 'ws-1',
  workspacePath: '/tmp/ws',
  policy: testPolicy(),
  signal: new AbortController().signal,
  remainingMs: 60_000,
};

/** Narrow the ok-branch data to a typed view. */
function okData<T>(result: { status: string; data?: unknown }, fallback: T): T {
  return result.status === 'ok' ? (result.data as T) : fallback;
}

describe('upcCheckDigit', () => {
  it('verifies a valid UPC check digit', () => {
    // UPC 036000291452: the classic example — prefix 03600029145 yields check 2.
    expect(upcCheckDigit('03600029145')).toBe(2);
  });

  it('rejects non-11-digit input', () => {
    expect(upcCheckDigit('123')).toBeNull();
  });
});

describe('validate_gtin', () => {
  it('normalizes and accepts a valid GTIN', async () => {
    const result = await validateGtin.execute({ gtin: '0-36000-29145-2' }, ctx);
    expect(result.status).toBe('ok');
    expect(okData(result, { normalized: '', length: 0, checkDigitValid: null })).toMatchObject({ normalized: '036000291452', length: 12, checkDigitValid: true });
  });

  it('flags a check-digit mismatch', async () => {
    const result = await validateGtin.execute({ gtin: '085000079580' }, ctx);
    expect(result.status).toBe('ok');
    expect(okData(result, { checkDigitValid: null }).checkDigitValid).toBe(false);
  });

  it('returns no_result for non-GTIN input', async () => {
    const result = await validateGtin.execute({ gtin: 'abc' }, ctx);
    expect(result.status).toBe('no_result');
  });

  it('rejects oversized input via schema (bounded inputs)', async () => {
    // The adapter's schema caps gtin at 64 chars; the registry rejects
    // malformed inputs — here we assert the adapter itself stays safe.
    const result = await validateGtin.execute({ gtin: 'x'.repeat(200) }, ctx);
    expect(result.status).toBe('no_result');
  });
});

describe('check_exact_gtin_match', () => {
  it('distinguishes exact GTIN from prefix similarity', async () => {
    const exact = await checkExactGtinMatch.execute({ requestedGtin: '085000079585', extractedGtins: ['085000079585'] }, ctx);
    expect(exact.status).toBe('ok');
    expect(okData(exact, { conclusion: '' }).conclusion).toBe('exact_match');

    const partial = await checkExactGtinMatch.execute({ requestedGtin: '085000079585', extractedGtins: ['085000079588'] }, ctx);
    expect(partial.status).toBe('ok');
    expect(okData(partial, { exactMatch: true, conclusion: '' }).exactMatch).toBe(false);
    // Same first 8 digits -> partial prefix match, NOT exact.
    expect(okData(partial, { conclusion: '' }).conclusion).toBe('partial_prefix_match');

    const none = await checkExactGtinMatch.execute({ requestedGtin: '085000079585', extractedGtins: ['123456789012'] }, ctx);
    expect(none.status).toBe('ok');
    expect(okData(none, { conclusion: '' }).conclusion).toBe('no_match');
  });
});

describe('compare_identity_signals', () => {
  it('detects aligned, conflicting, and variant-conflict states', async () => {
    const aligned = await compareIdentitySignals.execute(
      { expectedName: 'Stella & Chewys Chicken Broth 16oz', expectedBrand: 'Stella', pageTitle: 'Stella & Chewys Chicken Broth 16oz', pageBrand: 'stella & chewys', pageSize: '16oz', expectedSize: '16 oz' },
      ctx,
    );
    expect(aligned.status).toBe('ok');
    expect(okData(aligned, { conclusion: '' }).conclusion).toBe('aligned');

    const conflicting = await compareIdentitySignals.execute(
      { expectedName: 'Stella Chicken Broth 16oz', expectedBrand: 'Stella', pageTitle: 'Purina Dog Chow', pageBrand: 'Purina' },
      ctx,
    );
    expect(conflicting.status).toBe('ok');
    expect(okData(conflicting, { conclusion: '' }).conclusion).toBe('conflicting');

    const variant = await compareIdentitySignals.execute(
      { expectedName: 'Stella Chicken Broth 16oz', pageTitle: 'Stella Chicken Broth 8oz', expectedSize: '16oz', pageSize: '8oz' },
      ctx,
    );
    expect(variant.status).toBe('ok');
    expect(okData(variant, { conclusion: '' }).conclusion).toBe('variant_conflict');
  });
});

describe('check_source_priority', () => {
  it('is non-authoritative: agent assertions never mint official/supplier tiers (round-8)', async () => {
    // With no DB (pure vitest) the trusted brand-site registry is unavailable,
    // and agent-supplied sourceKind/officialDomains are advisory only — they
    // can never mint official/manufacturer authority.
    const officialClaim = await checkSourcePriority.execute({ url: 'https://www.stellachewys.com/p/1', officialDomains: ['stellachewys.com'] }, ctx);
    expect(officialClaim.status).toBe('ok');
    expect(okData(officialClaim, { tier: '' }).tier).not.toBe('official');
    expect(okData(officialClaim, { tier: '' }).tier).toBe('unknown');
    expect((officialClaim as { evidence?: Array<{ kind: string }> }).evidence?.[0]?.kind).not.toBe('official_evidence');

    const supplierClaim = await checkSourcePriority.execute({ url: 'https://distributor.example.com/p/1', sourceKind: 'supplier' }, ctx);
    expect(supplierClaim.status).toBe('ok');
    expect(okData(supplierClaim, { tier: '' }).tier).not.toBe('supplier');

    const retailer = await checkSourcePriority.execute({ url: 'https://www.chewy.com/p/1' }, ctx);
    expect(retailer.status).toBe('ok');
    expect(okData(retailer, { tier: '' }).tier).toBe('retailer');

    const unknown = await checkSourcePriority.execute({ url: 'https://random-blog.example.com/p/1' }, ctx);
    expect(unknown.status).toBe('ok');
    expect(okData(unknown, { tier: '' }).tier).toBe('unknown');
  });
});

describe('classifyPageIdentity', () => {
  it('returns exact_match when the exact GTIN is on a page affirmatively proven single-variant', () => {
    const result = classifyPageIdentity({
      requestedGtin: '085000079585',
      extractedGtins: ['085000079585'],
      sku: null,
      productName: 'Anything',
      expectedName: 'x',
      variantSignals: [],
      hasAnyField: true,
      singleVariantProof: true,
      selectedVariantLinkage: false,
    });
    expect(result.status).toBe('exact_match');
  });

  it('returns exact_match when the exact GTIN is on a page with positive selected-variant linkage', () => {
    const result = classifyPageIdentity({
      requestedGtin: '085000079585',
      extractedGtins: ['085000079585'],
      sku: null,
      productName: 'Anything',
      expectedName: 'x',
      variantSignals: [{ kind: 'variant_match' }],
      hasAnyField: true,
      singleVariantProof: false,
      selectedVariantLinkage: true,
    });
    expect(result.status).toBe('exact_match');
  });

  it('refuses exact_match for an exact GTIN without positive variant proof (P0-5)', () => {
    // Exact GTIN establishes the entity is REPRESENTED, not that the page
    // currently displays that variant — no proof => conservative probable.
    const result = classifyPageIdentity({
      requestedGtin: '085000079585',
      extractedGtins: ['085000079585'],
      sku: null,
      productName: 'Anything',
      expectedName: 'x',
      variantSignals: [],
      hasAnyField: true,
      singleVariantProof: false,
      selectedVariantLinkage: false,
    });
    expect(result.status).toBe('probable_match');
    expect(result.reasons.join(' ')).toContain('variant status unproven');
  });

  it('returns parent_product_only for an exact GTIN on a parent page with no proof', () => {
    const result = classifyPageIdentity({
      requestedGtin: '085000079585',
      extractedGtins: ['085000079585'],
      sku: null,
      productName: 'Anything',
      expectedName: 'x',
      variantSignals: [{ kind: 'parent_page' }],
      hasAnyField: true,
      singleVariantProof: false,
      selectedVariantLinkage: false,
    });
    expect(result.status).toBe('parent_product_only');
  });

  it('returns wrong_variant on variant mismatch even with name alignment', () => {
    const result = classifyPageIdentity({
      requestedGtin: '085000079585',
      extractedGtins: [],
      sku: 'SKU1',
      productName: 'Stella Chicken Broth',
      expectedName: 'Stella Chicken Broth',
      variantSignals: [{ kind: 'variant_mismatch' }],
      hasAnyField: true,
      singleVariantProof: false,
      selectedVariantLinkage: false,
    });
    expect(result.status).toBe('wrong_variant');
  });

  it('returns parent_product_only for variant selectors without the exact variant', () => {
    const result = classifyPageIdentity({
      requestedGtin: '085000079585',
      extractedGtins: [],
      sku: null,
      productName: 'Stella Broth (all sizes)',
      expectedName: 'Stella Broth 16oz',
      variantSignals: [{ kind: 'parent_page' }],
      hasAnyField: true,
      singleVariantProof: false,
      selectedVariantLinkage: false,
    });
    expect(result.status).toBe('parent_product_only');
  });

  it('returns insufficient_evidence when nothing extractable', () => {
    const result = classifyPageIdentity({
      requestedGtin: '085000079585',
      extractedGtins: [],
      sku: null,
      productName: null,
      expectedName: 'x',
      variantSignals: [],
      hasAnyField: false,
      singleVariantProof: false,
      selectedVariantLinkage: false,
    });
    expect(result.status).toBe('insufficient_evidence');
  });

  it('returns probable_match on name alignment without GTIN', () => {
    const result = classifyPageIdentity({
      requestedGtin: '085000079585',
      extractedGtins: [],
      sku: null,
      productName: 'Stella & Chewys Chicken Broth 16 oz',
      expectedName: 'STELLA CHKN BROTH 16OZ',
      variantSignals: [],
      hasAnyField: true,
      singleVariantProof: false,
      selectedVariantLinkage: false,
    });
    expect(result.status).toBe('probable_match');
  });
});

describe('variant proof helpers (P0-5)', () => {
  it('variantProofFromSignals: single-variant proof requires a positive platform count', () => {
    expect(variantProofFromSignals([], 1)).toEqual({ singleVariantProof: true, selectedVariantLinkage: false });
    expect(variantProofFromSignals([], 2)).toEqual({ singleVariantProof: false, selectedVariantLinkage: false });
    // Absence of signals is never proof.
    expect(variantProofFromSignals([], undefined)).toEqual({ singleVariantProof: false, selectedVariantLinkage: false });
    // A variant_match signal is positive selected-child linkage.
    expect(variantProofFromSignals([{ kind: 'variant_match' }], undefined)).toEqual({
      singleVariantProof: false,
      selectedVariantLinkage: true,
    });
  });

  it('structuredSingleVariantProof requires an affirmative leaf Product with a single offer and no variant affordances', () => {
    // A parsed leaf Product with a single offers object IS affirmative proof.
    const leaf =
      '<script type="application/ld+json">{"@type":"Product","name":"A","gtin":"1","offers":{"price":"1"}}</script>';
    expect(structuredSingleVariantProof(leaf)).toBe(true);
    // A leaf Product WITHOUT an offer declaration is NOT proof (absence).
    const leafNoOffer =
      '<script type="application/ld+json">{"@type":"Product","name":"A","gtin":"1"}</script>';
    expect(structuredSingleVariantProof(leafNoOffer)).toBe(false);
    // An offers ARRAY (multi-offer) is not a single-offer declaration.
    const leafOfferArray =
      '<script type="application/ld+json">{"@type":"Product","name":"A","gtin":"1","offers":[{"price":"1"},{"price":"2"}]}</script>';
    expect(structuredSingleVariantProof(leafOfferArray)).toBe(false);
    // ProductGroup pages are never single-variant proof.
    const group =
      '<script type="application/ld+json">{"@type":"ProductGroup","hasVariant":[{"@type":"Product"}]}</script>';
    expect(structuredSingleVariantProof(group)).toBe(false);
    // hasVariant markers anywhere invalidate the proof even with a leaf node.
    const group2 =
      '<script type="application/ld+json">{"@type":"Product","name":"A","hasVariant":[{},{}]}</script>';
    expect(structuredSingleVariantProof(group2)).toBe(false);
    // isVariantOf marks a child of a group — not single-variant proof.
    const child =
      '<script type="application/ld+json">{"@type":"Product","name":"A","gtin":"1","offers":{"price":"1"},"isVariantOf":{"@type":"ProductGroup"}}</script>';
    expect(structuredSingleVariantProof(child)).toBe(false);
    // variants markers invalidate the proof (parent page carrying default data).
    const variants =
      '<script id="__NEXT_DATA__" type="application/json">{"product":{"variants":[]}}</script>';
    expect(structuredSingleVariantProof(variants)).toBe(false);
    // No Product declaration at all: absence is not proof.
    expect(structuredSingleVariantProof('<html><body>nothing</body></html>')).toBe(false);
  });

  it('jsonLdLeafProductProof only accepts @type Product with a single offer and without variant keys', () => {
    expect(jsonLdLeafProductProof({ '@type': 'Product', name: 'A', offers: { price: '1' } })).toBe(true);
    expect(jsonLdLeafProductProof({ '@type': 'Product', name: 'A' })).toBe(false);
    expect(jsonLdLeafProductProof({ '@type': 'Product', name: 'A', offers: [] })).toBe(false);
    expect(jsonLdLeafProductProof({ '@type': 'Product', hasVariant: [] })).toBe(false);
    expect(jsonLdLeafProductProof({ '@type': 'Product', variants: [{}] })).toBe(false);
    expect(jsonLdLeafProductProof({ '@type': 'Product', offers: { price: '1' }, isVariantOf: { '@type': 'ProductGroup' } })).toBe(false);
    expect(jsonLdLeafProductProof({ '@type': 'ProductGroup', hasVariant: [] })).toBe(false);
    expect(jsonLdLeafProductProof({ '@type': ['Product', 'ItemPage'], offers: { price: '1' } })).toBe(true);
    expect(jsonLdLeafProductProof(null)).toBe(false);
  });
});
