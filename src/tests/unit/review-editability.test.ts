// @vitest-environment node
// story: e10s02 — review editability matrix truth table + save payload builder
import { describe, expect, it } from 'vitest';
import {
  buildListingUpdatePayload,
  fieldEditability,
  listingFactValues,
  LISTING_FACTS_FIELDS,
} from '../../client/components/onboarding/review/review-editability';
import type { ReviewDraft } from '../../client/components/onboarding/review/review-types';

const baseDraft = (): ReviewDraft => ({
  curatedTitle: '  Atlas Dog Food  ',
  brandHint: ' Atlas ',
  curatedWeight: '15',
  curatedDescription: ' Rich protein recipe ',
  searchKeywords: '',
});

describe('fieldEditability // e10s02 matrix', () => {
  it('official_page: price and quantity editable, curated fields editable', () => {
    for (const field of [
      'curatedTitle',
      'brandHint',
      'curatedWeight',
      'curatedDescription',
      'searchKeywords',
      'price',
      'quantity',
    ] as const) {
      expect(fieldEditability('official_page', field)).toBe('editable');
    }
  });

  it('distributor_record: price EDITABLE (adjudication — item.price is the only promotion price authority), quantity readonly, curated fields editable', () => {
    for (const field of ['curatedTitle', 'brandHint', 'curatedWeight', 'curatedDescription', 'searchKeywords', 'price'] as const) {
      expect(fieldEditability('distributor_record', field)).toBe('editable');
    }
    expect(fieldEditability('distributor_record', 'quantity')).toBe('readonly');
  });

  it('treats null/unknown source type as official-page semantics', () => {
    expect(fieldEditability(null, 'price')).toBe('editable');
    expect(fieldEditability(undefined, 'quantity')).toBe('editable');
  });
});

describe('buildListingUpdatePayload // e10s02 save contract', () => {
  it('official_page: includes trimmed-or-null curation keys plus price/quantity', () => {
    const payload = buildListingUpdatePayload(
      { ...baseDraft(), price: ' $24.99 ', quantity: ' 12 ' },
      'official_page',
    );
    expect(payload.curation_data).toEqual({
      curatedTitle: 'Atlas Dog Food',
      curatedWeight: '15',
      curatedDescription: 'Rich protein recipe',
      searchKeywords: null,
    });
    expect(payload.brandHint).toBe('Atlas');
    expect(payload.price).toBe('$24.99'.trim());
    expect(payload.quantity).toBe(12);
  });

  it('distributor_record: sends the price key but NEVER a quantity key', () => {
    const payload = buildListingUpdatePayload(
      { ...baseDraft(), price: '19.99', quantity: '6' },
      'distributor_record',
    );
    // Adjudication: price must be fixable at review time for distributor
    // rows too (missing_price blocks; item.price is the promoter's only
    // distributor price source).
    expect(payload.price).toBe('19.99');
    expect('quantity' in payload).toBe(false);
  });

  it('unparseable quantity clears to null instead of sending garbage', () => {
    const payload = buildListingUpdatePayload({ ...baseDraft(), quantity: 'many' }, 'official_page');
    expect(payload.quantity).toBeNull();
  });

  it('empty quantity clears to null', () => {
    const payload = buildListingUpdatePayload({ ...baseDraft(), quantity: '' }, 'official_page');
    expect(payload.quantity).toBeNull();
  });

  it('empty price clears to null (explicit clear allowed for official items)', () => {
    const payload = buildListingUpdatePayload({ ...baseDraft(), price: '' }, 'official_page');
    expect(payload.price).toBeNull();
  });
});

describe('listing facts / passthrough tolerance // e10s02', () => {
  it('renders only known scalar listing-fact keys with non-empty values', () => {
    const rows = listingFactValues({
      dimensions: '12 x 8 x 4 in',
      manufacturerPartNumber: null,
      casePack: '',
      unitOfMeasure: 'each',
      ingredients: 'Chicken, rice',
      distributorCategory: 'Dog Food',
      unknownPassthroughKey: 'mystery',
      nestedUnknown: { a: 1 },
    });
    expect(rows.map(r => r.key).sort()).toEqual([
      'dimensions',
      'distributorCategory',
      'ingredients',
      'unitOfMeasure',
    ]);
  });

  it('tolerates null/undefined extraction payloads', () => {
    expect(listingFactValues(null)).toEqual([]);
    expect(listingFactValues(undefined)).toEqual([]);
  });

  it('known media/provenance keys are never generic-rendered as fact rows', () => {
    // Passthrough tolerance lives in listingFactValues: it iterates ONLY the
    // known LISTING_FACTS_FIELDS keys.
    const rows = listingFactValues({
      primaryImage: 'https://img.example/a.jpg',
      distributorImageApprovals: [{ imageUrl: 'x' }],
      productIntelligenceEvidence: [],
      dimensions: '1 in',
    } as unknown as Record<string, unknown>);
    expect(rows.map(r => r.key)).toEqual(['dimensions']);
  });

  it('exposes the plan §3 row-15 fact fields', () => {
    expect(LISTING_FACTS_FIELDS.map(f => f.key)).toEqual([
      'dimensions',
      'manufacturerPartNumber',
      'casePack',
      'unitOfMeasure',
      'ingredients',
      'distributorCategory',
    ]);
  });

  it('keeps distributor price editable so the missing_price blocker is fixable', () => {
    expect(fieldEditability('distributor_record', 'price')).toBe('editable');
  });
});
