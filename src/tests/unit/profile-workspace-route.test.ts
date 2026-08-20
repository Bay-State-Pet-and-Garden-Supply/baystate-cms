import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// story: e06s01
describe('profile workspace route (e06s01)', () => {
  it('dedicated route helper builds domain-scoped path with return context', async () => {
    const mod = await import('../../client/components/profile-workspace/route');
    expect(mod.getProfileWorkspacePath('example.com')).toBe('/settings/domains/example.com/profile');
    expect(mod.getProfileWorkspacePath('WWW.EXAMPLE.COM')).toBe('/settings/domains/example.com/profile');
    expect(mod.getProfileWorkspacePath('https://www.example.com/path')).toBe('/settings/domains/example.com/profile');
    expect(mod.getProfileWorkspacePath('example.com', '/onboarding?batch=42')).toBe('/settings/domains/example.com/profile?return=%2Fonboarding%3Fbatch%3D42');
  });

  it('profile workspace page exists and uses normalized domain helper', () => {
    const file = resolve(process.cwd(), 'src/client/components/profile-workspace/ProfileWorkspacePage.tsx');
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('ProfileWorkspacePage');
    expect(src).toContain('normalizeBrandHubDomain');
    expect(src).toContain('/settings/domains/');
    expect(src).toContain('return');
  });

  it('OnboardingSettings no longer renders inline ProfileBuilder form', () => {
    const file = resolve(process.cwd(), 'src/client/components/OnboardingSettings.tsx');
    const src = readFileSync(file, 'utf8');
    // after consolidation, inline form should be replaced by link to workspace; ensure no direct <ProfileBuilder within settings table context
    // We allow ProfileBuilder import only inside workspace, not as inline editor in brands tab
    const hasInlineEditorMarker = src.includes('ProfileBuilder') && src.includes('Sitemaps & Brand URLs');
    // workspace link should exist
    expect(src).toContain('getProfileWorkspacePath');
    expect(hasInlineEditorMarker).toBe(false);
  });
});
