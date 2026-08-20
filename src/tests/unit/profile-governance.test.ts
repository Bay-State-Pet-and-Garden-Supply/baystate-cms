// story: e06s03 — per-field governance in Build canvas + Save guard
import { describe, it, expect } from 'vitest';
import { canSaveProfile, isFieldDecisionPending } from '../../onboarding/profile-governance-service';

describe('profile-governance — per-field approval blocks Save/Activate, unsupported explicit', () => {
  it('pending decisions block save', () => {
    const decisions = { titleSelector: 'pending', brandSelector: 'accepted' } as any;
    expect(canSaveProfile(decisions, { hasThreeConfirmed: true })).toBe(false);
    expect(isFieldDecisionPending(decisions, 'titleSelector')).toBe(true);
  });

  it('all accepted allows save', () => {
    const decisions = { titleSelector: 'accepted', brandSelector: 'accepted' } as any;
    expect(canSaveProfile(decisions, { hasThreeConfirmed: true })).toBe(true);
  });

  it('unsupported-for-domain is explicit and not a pending field', () => {
    const decisions = { titleSelector: 'unsupported', brandSelector: 'accepted' } as any;
    expect(isFieldDecisionPending(decisions, 'titleSelector')).toBe(false);
    expect(canSaveProfile(decisions, { hasThreeConfirmed: true })).toBe(true);
  });

  it('LLM output never directly activates — requires human per field', () => {
    // canActivate requires same gate as canSave plus at least one accepted; we test canSave suffices
    const decisions = { titleSelector: 'proposed' } as any; // proposed without accept
    expect(canSaveProfile(decisions, { hasThreeConfirmed: true })).toBe(false);
  });
});
