import { describe, it, expect, beforeEach } from 'vitest';

// story: e06s04
describe('profile versioning (e06s04)', () => {
  beforeEach(async () => {
    const { resetProfileVersionsForTest } = await import('../../db/repositories/profile-version-repo');
    resetProfileVersionsForTest();
  });

  it('inserts immutable version and moves pointer atomically', async () => {
    const repo = await import('../../db/repositories/profile-version-repo');
    const v1 = repo.createVersion({ domain: 'example.com', selectors: { titleSelector: 'h1' }, runtime: 'rendered', sampleIds: ['a','b','c'], artifactHashes: ['h1'], validationSummary: { ok: true }, provenance: { provider: 'openai', model: 'gpt', configId: 'c1' }, approver: 'op', reason: 'activate' });
    expect(v1.domain).toBe('example.com');
    expect(v1.version).toBe(1);
    repo.setActiveVersion('example.com', v1.id);
    expect(repo.getActiveVersion('example.com')?.id).toBe(v1.id);
    const v2 = repo.createVersion({ domain: 'example.com', selectors: { titleSelector: 'h2' }, runtime: 'rendered', sampleIds: ['a'], artifactHashes: ['h2'], validationSummary: { ok:true }, provenance: { provider:'openai', model:'gpt', configId:'c1'}, approver:'op', reason:'activate' });
    expect(v2.version).toBe(2);
    // v1 immutable
    expect(repo.getVersionById(v1.id)?.selectors.titleSelector).toBe('h1');
  });

  it('lists versions ordered and shows legacy degraded', async () => {
    const repo = await import('../../db/repositories/profile-version-repo');
    const legacy = repo.migrateLegacyProfile({ domain: 'legacy.com', selectors: { titleSelector: '.old' } });
    expect(legacy.provenance.provider).toBe('legacy-migration');
    const active = repo.getActiveVersion('legacy.com');
    expect(active).toBeNull(); // not grandfathered — no active until re-pass
    const state = repo.getVersionState('legacy.com');
    expect(state).toBe('Degraded');
  });
});
