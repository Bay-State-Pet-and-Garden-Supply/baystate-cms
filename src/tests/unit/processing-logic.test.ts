/**
 * Epic #46 Phase 5 — processing-logic unit tests (pure derivation).
 */
import { describe, it, expect } from 'vitest';
import type { OnboardingWorkState } from '../../shared/schemas/onboarding-work-state';
import { groupByActivity, statusText, activityTitle } from '../../client/components/onboarding/processing/processing-logic';

function item(partial: Partial<OnboardingWorkState>): OnboardingWorkState {
  return {
    itemId: 'item-1',
    category: 'processing',
    activity: null,
    label: 'Processing',
    detail: null,
    attentionReason: null,
    attentionAction: null,
    family: null,
    reviewState: null,
    stage: 'extraction',
    stageStatus: 'in_progress',
    upc: '012345678905',
    name: 'Test Product',
    brand: null,
    sourceType: 'official_page',
    domain: 'example.com',
    ...partial,
  } as OnboardingWorkState;
}

describe('groupByActivity', () => {
  it('groups items by activity in deterministic pipeline order', () => {
    const items = [
      item({ itemId: 'a', activity: 'extraction', name: 'Extract Me' }),
      item({ itemId: 'b', activity: 'distributor_lookup', name: 'Lookup Me' }),
      item({ itemId: 'c', activity: 'curation', name: 'Curate Me' }),
      item({ itemId: 'd', activity: 'extraction', name: 'Extract Me 2' }),
    ];
    const groups = groupByActivity(items);
    expect(groups.map((g) => g.activity)).toEqual(['distributor_lookup', 'extraction', 'curation']);
    expect(groups.map((g) => g.title)).toEqual([
      'Distributor Lookup',
      'Extracting Product Data',
      'Curating Product Family',
    ]);
    expect(groups[1].items.map((i) => i.itemId)).toEqual(['a', 'd']);
  });

  it('renders null/unknown activities as Other, last', () => {
    const groups = groupByActivity([
      item({ itemId: 'a', activity: 'curation' }),
      item({ itemId: 'b', activity: null }),
      item({ itemId: 'c', activity: 'unknown_activity' as never }),
    ]);
    expect(groups.map((g) => g.activity)).toEqual(['curation', null, 'unknown_activity' as never]);
    expect(groups[1].title).toBe('Other');
    expect(groups[2].title).toBe('Other');
  });

  it('returns an empty array for no items', () => {
    expect(groupByActivity([])).toEqual([]);
  });

  it('does not mutate or duplicate input items', () => {
    const items = [item({ itemId: 'a', activity: 'curation' })];
    const groups = groupByActivity(items);
    expect(groups[0].items).toEqual(items);
    expect(items).toHaveLength(1);
  });
});

describe('activityTitle', () => {
  it('maps known activities to human-facing titles', () => {
    expect(activityTitle('distributor_lookup')).toBe('Distributor Lookup');
    expect(activityTitle('official_site_search')).toBe('Official Site Search');
    expect(activityTitle('extraction')).toBe('Extracting Product Data');
    expect(activityTitle('curation')).toBe('Curating Product Family');
  });

  it('falls back to Other for null and unknown values', () => {
    expect(activityTitle(null)).toBe('Other');
    expect(activityTitle('future_activity' as never)).toBe('Other');
  });
});

describe('statusText', () => {
  it('prefers the server-derived label', () => {
    expect(statusText(item({ label: 'Materializing distributor data' }))).toBe(
      'Materializing distributor data',
    );
  });

  it('falls back to the activity title when label is empty', () => {
    expect(statusText(item({ label: '', activity: 'extraction' }))).toBe('Extracting Product Data');
  });
});
