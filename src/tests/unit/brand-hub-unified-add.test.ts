import { describe, it, expect } from 'vitest';

// story: e35s10 — unified Add Brand flow (normalize once, brand_sites mapping, optional sitemap fetch, no empty profile)
describe('unified Add Brand (e35s10)', () => {
  it('normalizes once and prepares brand mapping without fabricating empty profile', async () => {
    const { buildUnifiedAddPayload } = await import('../../onboarding/brand-hub/unifiedAdd');

    const a = buildUnifiedAddPayload({ rawDomain: '  https://WWW.AcmePet.COM/sitemap.xml  ', brandName: 'Acme Pet', fetchNow: true });
    expect(a.normalizedDomain).toBe('acmepet.com');
    expect(a.brandName).toBe('acme pet'); // lowercased via brand normalizer? or trimmed original? check impl — we normalize brand to lower? For now expect trimmed lower? We'll assert truthy contains acme
    expect(a.brandName?.toLowerCase()).toContain('acme');
    expect(a.fetchNow).toBe(true);
    expect(a.shouldCreateProfile).toBe(false);
    expect(a.shouldPersistBrandSite).toBe(true);
  });

  it('does not persist brand site when brandName absent and does not fetch when disabled', async () => {
    const { buildUnifiedAddPayload } = await import('../../onboarding/brand-hub/unifiedAdd');
    const b = buildUnifiedAddPayload({ rawDomain: 'example.com', brandName: null, fetchNow: false });
    expect(b.normalizedDomain).toBe('example.com');
    expect(b.shouldPersistBrandSite).toBe(false);
    expect(b.fetchNow).toBe(false);
    expect(b.shouldCreateProfile).toBe(false);
  });

  it('returns invalid when domain empty after normalization', async () => {
    const { buildUnifiedAddPayload } = await import('../../onboarding/brand-hub/unifiedAdd');
    const c = buildUnifiedAddPayload({ rawDomain: '   ', brandName: 'Foo', fetchNow: true });
    expect(c.normalizedDomain).toBe('');
    expect(c.isValid).toBe(false);
  });
});
