import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// story: e35s10 — Brands tab composes overview (parallel phase keeps legacy)
describe('brands tab composition (e35s10)', () => {
  it('OnboardingSettings renders Brands tab backed by tabRegistry', () => {
    const file = resolve(process.cwd(), 'src/client/components/OnboardingSettings.tsx');
    const src = readFileSync(file, 'utf8');
    // must import from tabRegistry and handle brands in tab state
    expect(src).toContain('tabRegistry');
    expect(src).toContain('brands');
    // brands panel should compose SitemapHealthView (existing) and hub signals
    expect(src).toMatch(/brands/i);
    expect(src).toContain('SitemapHealthView');
  });

  it('brands panel is present alongside legacy panels during parallel phase', () => {
    const file = resolve(process.cwd(), 'src/client/components/OnboardingSettings.tsx');
    const src = readFileSync(file, 'utf8');
    expect(src).toContain("settingsTab === 'brands'");
    expect(src).toContain("settingsTab === 'sitemaps'");
    expect(src).toContain("settingsTab === 'profiles'");
  });
});
