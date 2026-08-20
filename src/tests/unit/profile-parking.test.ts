import { describe, it, expect, beforeEach } from 'vitest';

// story: e06s04
describe('profile parking (e06s04)', () => {
  beforeEach(async () => {
    const { resetParkingForTest } = await import('../../onboarding/profile-parking');
    const { resetProfileVersionsForTest } = await import('../../db/repositories/profile-version-repo');
    resetParkingForTest();
    resetProfileVersionsForTest();
  });

  it('parks official_page without active version as setup_required_profile', async () => {
    const { evaluateParking, getDomainTask, releaseParked } = await import('../../onboarding/profile-parking');
    const res = evaluateParking({ domain: 'example.com', sourceType: 'official_page', hasActiveVersion: false });
    expect(res.parked).toBe(true);
    expect(res.status).toBe('setup_required_profile');
    const task = getDomainTask('example.com');
    expect(task).toContain('Build profile for example.com');
    expect(task).toContain('unblocks');
  });

  it('releases parked items deterministically on activation', async () => {
    const { evaluateParking, releaseParked, getParkedCount } = await import('../../onboarding/profile-parking');
    evaluateParking({ domain: 'example.com', sourceType: 'official_page', hasActiveVersion: false });
    evaluateParking({ domain: 'example.com', sourceType: 'official_page', hasActiveVersion: false });
    expect(getParkedCount('example.com')).toBe(2);
    const released = releaseParked('example.com');
    expect(released).toBe(2);
    expect(getParkedCount('example.com')).toBe(0);
  });

  it('does not park official_page when active version exists', async () => {
    const { evaluateParking } = await import('../../onboarding/profile-parking');
    const r = evaluateParking({ domain: 'example.com', sourceType: 'official_page', hasActiveVersion: true });
    expect(r.parked).toBe(false);
  });
});
