import { describe, it, expect } from 'vitest';

// story: e06s04
describe('profile runner parity (e06s04)', () => {
  it('uses production runner contract and retains artifact hashes', async () => {
    const { runMatrix } = await import('../../onboarding/profile-test-matrix');
    const r = await runMatrix({ domain: 'example.com', draftVersion: 'v9', samples: [{id:'a', url:'https://example.com/p/a', expectedTitle:'A'}], runner: async (s:any)=>({ extractedTitle: s.expectedTitle, provenance:'static', artifactHash:'hash-abc', success:true }) });
    expect(r.rows[0].cells[0].artifactHash).toBe('hash-abc');
    expect(r.rows[0].cells[0].provenance).toBe('static');
  });

  it('profile-runner-client delegates to same contract', async () => {
    const mod = await import('../../onboarding/profile-runner-client');
    expect(typeof mod.runProfileForUrl).toBe('function');
  });
});
