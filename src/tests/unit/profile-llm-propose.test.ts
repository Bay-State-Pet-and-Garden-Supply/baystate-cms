// story: e06s03 — LLM propose pipeline with provenance + deterministic discovery first
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/llm-task-config-repo', () => ({
  getLlmTaskConfig: vi.fn(() => ({ provider: 'openai', model: 'gpt-4o-mini', baseUrlOverride: null, configId: 'cfg_123' })),
}));
vi.mock('../../db/repositories/api-key-repo', () => ({
  getApiKey: vi.fn(() => ({ api_key: 'sk-test', base_url: null, model: null })),
}));

import { suggestSelectorsForField, explainValidationFailure, reviseSelectorsFromFeedback, generateSelectorsFromSuite } from '../../server/services/profile-builder/generateSelectorsService';

describe('profile-llm-propose — task buttons', () => {
  const sampleHtml = '<html><body><h1 class="product-title">Chicken Dinner</h1></body></html>';

  it('suggestSelectorsForField reuses sanitize→LLM→parse→validate pipeline and records provenance', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ pageAssessment: { pageType: 'product', usable: true }, fields: { titleSelector: { notFound: false, candidates: [{ selector: 'h1.product-title', evidence: 'h1' }] } }, customFields: [], warnings: [] }) } }]),
      text: async () => '',
    } as any);
    const res = await suggestSelectorsForField({ fieldKey: 'titleSelector', htmlRefs: ['.baystate-cms/artifacts/a/page.html'], snapshotHtmls: [sampleHtml], sourceUrl: 'https://acme.com/p/1', runtime: 'rendered' } as any, { userId: 'u1', requestId: 'r1' });
    expect(res.provenance.provider).toBeDefined();
    expect(res.provenance.configId).toBeDefined();
    expect(res.provenance.promptHash).toBeDefined();
    expect(typeof res.provenance.htmlLeftMachine).toBe('boolean');
    expect(res.provenance.disclosureBadge).toMatch(/HTML sent|local only/i);
    expect(res.fields.titleSelector).toBeDefined();
  });

  it('explainValidationFailure returns expanded reason with expected vs actual, provenance, artifact', () => {
    const reason = explainValidationFailure('titleSelector', { validation: { matchedCount: 0 }, expected: 'Chicken', actual: null, provenance: { artifact: 'job-1/page.html' } } as any);
    expect(reason).toMatch(/expected/i);
    expect(reason).toMatch(/artifact/i);
  });

  it('reviseSelectorsFromFeedback reuses pipeline with structured feedback', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ pageAssessment: { pageType: 'product', usable: true }, fields: { titleSelector: { notFound: false, candidates: [{ selector: 'h1.new', evidence: 'revised' }] } }, customFields: [], warnings: [] }) } }]),
      text: async () => '',
    } as any);
    const res = await reviseSelectorsFromFeedback({ feedback: { kind: 'text', field: 'titleSelector', issue: 'too generic' }, htmlRefs: ['.baystate-cms/artifacts/a/page.html'], snapshotHtmls: [sampleHtml], sourceUrl: 'https://acme.com/p/1', runtime: 'rendered' } as any, { userId: 'u1', requestId: 'r1' });
    expect(res.fields.titleSelector.selector).toBeDefined();
    expect(res.provenance.promptHash).toBeDefined();
  });

  it('generateSelectorsFromSuite handles 3 confirmed snapshots and aggregates deterministic discovery', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ pageAssessment: { pageType: 'product', usable: true }, fields: { titleSelector: { notFound: false, candidates: [{ selector: 'h1.product-title', evidence: 'stable across 3' }] } }, customFields: [], warnings: [] }) } }]),
      text: async () => '',
    } as any);
    const res = await generateSelectorsFromSuite({ htmlRefs: ['a', 'b', 'c'], snapshotHtmls: [sampleHtml, sampleHtml, sampleHtml], sourceUrl: 'https://acme.com/p/1', runtime: 'rendered', fields: [{ key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'text', multiple: false }] } as any, { userId: 'u1', requestId: 'r1' });
    expect(res.meta.requestedFieldCount).toBe(1);
    expect(res.provenance.htmlLeftMachine).toBeDefined();
  });
});
