import { describe, it, expect } from 'vitest';

// story: e06s01
describe('profile readiness derivation (e06s01)', () => {
  it('derives Not configured when no profile and no index', async () => {
    const { deriveReadinessState } = await import('../../onboarding/profile-readiness');
    const s = deriveReadinessState({ hasProfile: false, hasIndex: false, hasDraft: false, confirmedCount: 0, testsPass: false, isActive: false, needsRevalidation: false, productCount: 0 });
    expect(s.overall).toBe('Not configured');
    expect(s.steps[0].status).toBe('pending');
  });

  it('derives 6 steps with correct statuses for verified indexed case', async () => {
    const { deriveReadinessState } = await import('../../onboarding/profile-readiness');
    const s = deriveReadinessState({ hasProfile: true, hasIndex: true, hasDraft: true, confirmedCount: 3, testsPass: true, isActive: false, needsRevalidation: false, productCount: 42 });
    expect(s.steps).toHaveLength(6);
    expect(s.steps[0].label).toContain('Official domain');
    expect(s.steps[1].label).toContain('Product URLs indexed');
    expect(s.steps[2].label).toContain('representative');
    expect(s.steps[5].label).toContain('Human approval');
  });

  it('renders Degraded when legacy profile needs revalidation', async () => {
    const { deriveReadinessState } = await import('../../onboarding/profile-readiness');
    const s = deriveReadinessState({ hasProfile: true, hasIndex: true, hasDraft: false, confirmedCount: 0, testsPass: false, isActive: true, needsRevalidation: true, productCount: 10 });
    expect(s.overall).toBe('Degraded');
  });
});
