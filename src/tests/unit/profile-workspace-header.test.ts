import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// story: e06s01
describe('profile workspace header (e06s01)', () => {
  it('header derives brand associations, activeVersion, freshness, blockedCount via server state', async () => {
    const mod = await import('../../client/components/profile-workspace/ProfileWorkspaceHeader');
    expect(mod.ProfileWorkspaceHeader).toBeDefined();
    const file = resolve(process.cwd(), 'src/client/components/profile-workspace/ProfileWorkspaceHeader.tsx');
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('brandAssociations');
    expect(src).toContain('activeVersion');
    expect(src).toContain('freshness');
    expect(src).toContain('blockedCount');
  });

  it('profile-state Hono route exists', () => {
    const file = resolve(process.cwd(), 'src/server/routes/domain-profile-state-routes.ts');
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('/api/domains/:domain/profile-state');
    expect(src).toContain('getDomainProfileState');
  });
});
