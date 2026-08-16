import { describe, it, expect } from 'vitest';
import {
  getAttentionActions,
  getAttentionActionConsequence,
} from '../../client/components/onboarding/attention/attention-logic';

describe('getAttentionActions — retry-first resolution (audit HIGH 4)', () => {
  it('offers retry FIRST for extraction_profile_failed, setup second', () => {
    expect(getAttentionActions('extraction_profile_failed')).toEqual([
      'retry_extraction',
      'setup_extractor_profile',
    ]);
  });

  it('offers only setup for extractor_profile_required', () => {
    expect(getAttentionActions('extractor_profile_required')).toEqual([
      'setup_extractor_profile',
    ]);
  });

  it('maps url reasons to their verify/choose actions', () => {
    expect(getAttentionActions('verify_official_url')).toEqual(['verify_official_url']);
    expect(getAttentionActions('no_official_url')).toEqual(['verify_official_url']);
    expect(getAttentionActions('choose_official_url')).toEqual(['choose_official_url']);
  });

  it('maps a Curation semantic conflict to the findings-resolution action', () => {
    expect(getAttentionActions('semantic_validation_blocked')).toEqual([
      'resolve_semantic_conflict',
    ]);
  });

  it('is deterministic for every known reason and never empty', () => {
    const reasons = [
      'verify_official_url',
      'no_official_url',
      'choose_official_url',
      'extractor_profile_required',
      'extraction_profile_failed',
      'source_conflict',
      'processing_failed',
      'semantic_validation_blocked',
    ] as const;
    for (const reason of reasons) {
      expect(getAttentionActions(reason).length).toBeGreaterThan(0);
      expect(getAttentionActions(reason)).toEqual(getAttentionActions(reason));
    }
  });

  it('returns an empty list for unknown/null reasons', () => {
    expect(getAttentionActions(null)).toEqual([]);
    expect(getAttentionActions(undefined)).toEqual([]);
  });
});

describe('getAttentionActionConsequence — plain-language outcomes', () => {
  it('explains what happens after retrying extraction', () => {
    expect(getAttentionActionConsequence('retry_extraction')).toMatch(/extraction runs again/);
  });

  it('explains setup releases the domain', () => {
    expect(getAttentionActionConsequence('setup_extractor_profile')).toMatch(
      /other blocked products/i,
    );
  });

  it('never returns a fallback/empty consequence for a known action', () => {
    const actions = [
      'verify_official_url',
      'choose_official_url',
      'setup_extractor_profile',
      'retry_extraction',
      'resolve_source_conflict',
      'retry_processing',
      'resolve_semantic_conflict',
    ] as const;
    for (const action of actions) {
      const text = getAttentionActionConsequence(action);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('explains that resolving the findings re-runs the family Curation', () => {
    expect(getAttentionActionConsequence('resolve_semantic_conflict')).toMatch(
      /re-runs Curation/,
    );
    expect(getAttentionActionConsequence('resolve_semantic_conflict')).toContain(
      'returns to Review',
    );
  });
});
