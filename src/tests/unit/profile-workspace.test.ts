import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// story: e06s01
// story: e07s02
describe('profile workspace shell (e06s01)', () => {
  it('evidence rail placeholder and history shell exist', () => {
    const page = resolve(process.cwd(), 'src/client/components/profile-workspace/ProfileWorkspacePage.tsx');
    const src = readFileSync(page, 'utf8');
    expect(src).toContain('EvidenceRail');
    expect(src).toContain('HistoryShell');
  });

  it('single builder path — ProfileBuilder rendered inside workspace, no drawer/modal regression', () => {
    const page = resolve(process.cwd(), 'src/client/components/profile-workspace/ProfileWorkspacePage.tsx');
    const src = readFileSync(page, 'utf8');
    expect(src).toContain('ProfileBuilder');
    // workspace should not use Drawer/Modal for builder
    expect(src.includes('Drawer')).toBe(false);
    const overlay = resolve(process.cwd(), 'src/client/components/ProfileBuilderWorkspace.tsx');
    const overlaySrc = readFileSync(overlay, 'utf8');
    // overlay should delegate to workspace or be deprecated comment, not duplicate builder
    expect(overlaySrc.includes('ProfileWorkspacePage') || overlaySrc.includes('deprecated')).toBe(true);
  });

  it('preserves query return context', () => {
    const mod = resolve(process.cwd(), 'src/client/components/profile-workspace/route.ts');
    const src = readFileSync(mod, 'utf8');
    expect(src).toContain('return');
    expect(src).toContain('encodeURIComponent');
  });

  it('suite panel renders clusters, suggested reps, override and waiver (e07s02)', () => {
    const p = resolve(process.cwd(), 'src/client/components/profile-workspace/SuitePanel.tsx');
    const src = readFileSync(p, 'utf8');
    expect(src).toContain('Clusters');
    expect(src).toContain('Suggested reps');
    expect(src).toContain('Use suggested');
    expect(src).toContain('Merge');
    expect(src).toContain('Split');
    expect(src).toContain('Replace');
    expect(src).toContain('filtered as parked');
    expect(src).toContain('cluster-overrides');
    // waiver still present
    expect(src).toContain('Create waiver');
    expect(src).toContain('Reason for waiver');
  });
});
