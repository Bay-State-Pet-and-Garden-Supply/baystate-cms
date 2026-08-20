// story: e06s03 — SaveBar governance guard
import { describe, it, expect } from 'vitest';
import { canSaveProfile } from '../../onboarding/profile-governance-helpers';

describe('SaveBar — governance guard via canSaveProfile', () => {
  it('blocks Save when per-field decision pending', () => {
    expect(canSaveProfile({ titleSelector: 'pending' } as any, { hasThreeConfirmed: true })).toBe(false);
  });
  it('allows Save when all decisions accepted and no pending', () => {
    expect(canSaveProfile({ titleSelector: 'accepted', brandSelector: 'accepted' } as any, { hasThreeConfirmed: true })).toBe(true);
  });
  it('unsupported does not block', () => {
    expect(canSaveProfile({ titleSelector: 'unsupported' } as any, { hasThreeConfirmed: true })).toBe(true);
  });
});
