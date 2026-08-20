// story: e06s03 — selectorValidator 3-sample deterministic validation
import { describe, it, expect } from 'vitest';
import { validateAndRankSelectors, validateAcrossConfirmedSuite } from '../../server/services/profile-builder/selectorValidator';

describe('selectorValidator — 3-sample suite', () => {
  const html = '<html><body><h1 class="product-title">Test</h1><div class="price">$9</div></body></html>';
  const fields = [{ key: 'titleSelector', valueType: 'text', multiple: false }];

  it('validates single snapshot deterministically', () => {
    const res = validateAndRankSelectors(html, { titleSelector: { notFound: false, candidates: [{ selector: 'h1.product-title', evidence: 'h1' }] } }, fields);
    expect(res.titleSelector.status).toBe('suggested');
    expect(res.titleSelector.quality).not.toBe('unusable');
  });

  it('validates across 3 confirmed snapshots with cross-sample warnings', () => {
    const htmls = [html, html.replace('Test', 'Test 2'), html];
    const res = validateAcrossConfirmedSuite(htmls, { titleSelector: { notFound: false, candidates: [{ selector: 'h1.product-title', evidence: 'stable' }] } }, fields);
    expect(res.titleSelector.status).toBe('suggested');
    expect(res.titleSelector.validation.matchedCount).toBe(1);
  });
});
