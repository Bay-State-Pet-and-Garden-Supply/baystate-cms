import { describe, it, expect, beforeEach } from 'vitest';

// story: e06s04
describe('profile test matrix (e06s04)', () => {
  beforeEach(async () => {
    const { resetTestMatrixForTest } = await import('../../onboarding/profile-test-matrix');
    resetTestMatrixForTest();
  });

  it('binds matrix result to exact draft version', async () => {
    const { runMatrix, getMatrixResult } = await import('../../onboarding/profile-test-matrix');
    const r5 = await runMatrix({ domain: 'example.com', draftVersion: 'v5', samples: [{id:'a', url:'https://example.com/p/a', expectedTitle:'A'},{id:'b', url:'https://example.com/p/b', expectedTitle:'B'},{id:'c', url:'https://example.com/p/c', expectedTitle:'C'}], runner: async (s: any) => ({ extractedTitle: s.expectedTitle, provenance:'static', artifactHash:'h-'+s.id, success:true }) });
    expect(r5.draftVersion).toBe('v5');
    expect(r5.rows).toHaveLength(3);
    expect(r5.rows[0].cells[0].provenance).toBeTruthy();
    expect(r5.rows[0].cells[0].artifactHash).toBeTruthy();
    const fetched = getMatrixResult('example.com', 'v5');
    expect(fetched?.draftVersion).toBe('v5');
    // re-execution creates new bound result, v5 unchanged
    const r6 = await runMatrix({ domain: 'example.com', draftVersion: 'v6', samples: [{id:'a', url:'https://example.com/p/a', expectedTitle:'A'},{id:'b', url:'https://example.com/p/b', expectedTitle:'B'},{id:'c', url:'https://example.com/p/c', expectedTitle:'C'}], runner: async (s:any)=>({extractedTitle:s.expectedTitle, provenance:'static', artifactHash:'h-'+s.id, success:true}) });
    expect(getMatrixResult('example.com', 'v5')?.draftVersion).toBe('v5');
    expect(r6.draftVersion).toBe('v6');
  });

  it('cells expand to extracted vs expected + provenance + artifact + failure reason', async () => {
    const { runMatrix } = await import('../../onboarding/profile-test-matrix');
    const r = await runMatrix({ domain: 'example.com', draftVersion: 'v5', samples: [{id:'a', url:'https://example.com/p/a', expectedTitle:'A'}], runner: async () => ({ extractedTitle: null, provenance:'rendered', artifactHash:'art-1', success:false, failureReason:'selector missed' }) });
    expect(r.rows[0].cells[0].extracted).toBeNull();
    expect(r.rows[0].cells[0].expected).toBe('A');
    expect(r.rows[0].cells[0].failureReason).toContain('missed');
    expect(r.rows[0].cells[0].artifactHash).toBe('art-1');
  });
});
