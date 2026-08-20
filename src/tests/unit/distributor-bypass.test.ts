import { describe, it, expect, beforeEach } from 'vitest';

// story: e06s04
describe('distributor bypass (e06s04)', () => {
  beforeEach(async () => {
    const { resetParkingForTest } = await import('../../onboarding/profile-parking');
    resetParkingForTest();
  });

  it('never parks distributor_record even without active version', async () => {
    const { evaluateParking, getParkedCount, getDomainTask } = await import('../../onboarding/profile-parking');
    const r = evaluateParking({ domain: 'example.com', sourceType: 'distributor_record', hasActiveVersion: false });
    expect(r.parked).toBe(false);
    expect(r.status).not.toBe('setup_required_profile');
    expect(getParkedCount('example.com')).toBe(0);
    expect(getDomainTask('example.com')).toBeNull();
  });

  it('bypasses gate and proceeds to profile-free extraction', async () => {
    const { evaluateParking } = await import('../../onboarding/profile-parking');
    const r = evaluateParking({ domain: 'example.com', sourceType: 'distributor_record', hasActiveVersion: true });
    expect(r.parked).toBe(false);
  });
});
