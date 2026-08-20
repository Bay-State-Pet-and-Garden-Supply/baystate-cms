import { describe, it, expect } from 'vitest';

// story: e06s04
describe('profile activation gate (e06s04)', () => {
  it('blocks when title fails on 1 of 3', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    const r = evaluateGate({ requiredResults: [{field:'title', success:true},{field:'title', success:true},{field:'title', success:false}], wrongProduct:false, wrongVariant:false, waiver:false, confirmedCount:3, imageRuleOk:true });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toContain('title');
    expect(r.reviseAction).toBeTruthy();
  });

  it('allows when all required fields pass on all 3', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    const r = evaluateGate({ requiredResults: [{field:'title', success:true},{field:'title', success:true},{field:'title', success:true}], wrongProduct:false, wrongVariant:false, waiver:false, confirmedCount:3, imageRuleOk:true });
    expect(r.allowed).toBe(true);
  });

  it('blocks without waiver when <3 and allows with waiver provenance', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    const blocked = evaluateGate({ requiredResults: [{field:'title', success:true},{field:'title', success:true}], wrongProduct:false, wrongVariant:false, waiver:false, confirmedCount:2, imageRuleOk:true });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockReason).toContain('waiver');
    const allowed = evaluateGate({ requiredResults: [{field:'title', success:true},{field:'title', success:true}], wrongProduct:false, wrongVariant:false, waiver:true, confirmedCount:2, imageRuleOk:true });
    expect(allowed.allowed).toBe(true);
  });

  it('blocks on wrong_product and wrong_variant', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    expect(evaluateGate({ requiredResults:[{field:'title', success:true},{field:'title', success:true},{field:'title', success:true}], wrongProduct:true, wrongVariant:false, waiver:false, confirmedCount:3, imageRuleOk:true }).allowed).toBe(false);
    expect(evaluateGate({ requiredResults:[{field:'title', success:true},{field:'title', success:true},{field:'title', success:true}], wrongProduct:false, wrongVariant:true, waiver:false, confirmedCount:3, imageRuleOk:true }).allowed).toBe(false);
  });

  it('requires passing run for exact draft version', async () => {
    const { canActivateVersion } = await import('../../onboarding/profile-activation-gate');
    expect(canActivateVersion({ draftVersion: 'v5', passingVersion: 'v4' })).toBe(false);
    expect(canActivateVersion({ draftVersion: 'v5', passingVersion: 'v5' })).toBe(true);
  });
});
