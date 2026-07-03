/**
 * Decision 20 regression: generated-selector proposals must NEVER
 * affect the current extraction result.
 *
 * The integration path is:
 *   1. extraction produces a deterministic `ExtractionData`
 *   2. profile-generation trigger may fire
 *   3. LLM may produce a `GeneratedSelectorProfile` proposal
 *   4. proposal is validated and audited in `profile_generations`
 *   5. extraction result is UNCHANGED regardless of (3)/(4)
 *
 * The LLM client and DB repositories are mocked so the test runs
 * without network access and without `bun:sqlite`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  insertProfileGeneration,
  updateProfileGenerationStatus,
  getLlmConfig,
  callLlm,
} = vi.hoisted(() => {
  return {
    insertProfileGeneration: vi.fn((_input: unknown) => ({
      id: 'gen-123',
      domain: 'example.com',
      sourceUrl: 'https://example.com/products/sample',
      expectedName: 'SAMPLE PRODUCT',
      brandHint: null,
      selectors: {},
      fieldSamples: null,
      validation: null,
      status: 'proposed' as const,
      confidence: 0,
      llmProvider: 'mock',
      llmModel: 'mock',
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      promotedAt: null,
    })),
    updateProfileGenerationStatus: vi.fn(() => null),
    getLlmConfig: vi.fn(() => ({
      provider: 'mock',
      apiKey: 'mock',
      baseUrl: 'https://mock.invalid',
      model: 'mock-model',
    })),
    callLlm: vi.fn(async () =>
      JSON.stringify({
        titleSelector: 'h1.ai-generated-title',
        descriptionSelector: 'p.ai-generated-description',
        brandSelector: '.ai-generated-brand',
        imagesSelector: '.ai-generated-images img',
      }),
    ),
    getLlmConfigForTask: vi.fn(() => ({
      provider: 'mock',
      apiKey: 'mock',
      baseUrl: 'https://mock.invalid',
      model: 'mock-model',
    })),
    callLlmForTask: vi.fn(async () =>
      JSON.stringify({
        titleSelector: 'h1.ai-generated-title',
        descriptionSelector: 'p.ai-generated-description',
        brandSelector: '.ai-generated-brand',
        imagesSelector: '.ai-generated-images img',
      }),
    ),
    MissingLlmTaskConfigError: class MissingLlmTaskConfigError extends Error {},
    PROFILE_TASKS_REQUIRE_EXPLICIT: new Set(['profile_generation', 'profile_revision']),
  };
});

vi.mock('../../db/repositories/extractor-profile-repo', () => ({
  findProfileByDomain: vi.fn(() => null),
}));
vi.mock('../../db/repositories/brand-site-repo', () => ({
  findBrandSites: vi.fn(() => []),
}));
vi.mock('../../db/repositories/domain-status-repo', () => ({
  recordDomainStatus: vi.fn(),
}));
vi.mock('../../db/repositories/profile-generation-repo', () => ({
  insertProfileGeneration,
  updateProfileGenerationStatus,
}));
vi.mock('../../onboarding/llm-client', () => ({
  getLlmConfig,
  callLlm,
  getLlmConfigForTask: vi.fn(() => ({
    provider: 'mock',
    apiKey: 'mock',
    baseUrl: 'https://mock.invalid',
    model: 'mock-model',
  })),
  callLlmForTask: vi.fn(async () =>
    JSON.stringify({
      titleSelector: 'h1.ai-generated-title',
      descriptionSelector: 'p.ai-generated-description',
      brandSelector: '.ai-generated-brand',
      imagesSelector: '.ai-generated-images img',
    }),
  ),
  MissingLlmTaskConfigError: class MissingLlmTaskConfigError extends Error {},
  PROFILE_TASKS_REQUIRE_EXPLICIT: new Set(['profile_generation', 'profile_revision']),
}));

import { extractProductData } from '../../onboarding/page-extractor';

// Note: this HTML intentionally has NO description and NO brand in the
// deterministic layers (no og:description, no product:brand, no
// microdata, no heuristics). That guarantees:
//   1. The deterministic extraction returns title only.
//   2. `shouldAttemptProfileGeneration` fires (has improvement target).
//   3. The AI proposal gets validated and audited.
//   4. The extraction result is still the deterministic one.
const HTML_WITH_AI_SELECTORS = `<!doctype html>
<html>
  <head>
    <meta property="og:title" content="Sample Product">
    <meta property="og:image" content="https://example.com/deterministic-primary.png">
  </head>
  <body>
    <h1 class="real-title">Sample Product</h1>
    <div class="real-images">
      <img src="https://example.com/deterministic-1.png" alt="real 1">
      <img src="https://example.com/deterministic-2.png" alt="real 2">
    </div>
    <!-- The "AI-proposed" selectors. If applied, the extraction
         result would change to the text below. They must not. -->
    <h1 class="ai-generated-title">AI OVERWRITE TITLE</h1>
    <p class="ai-generated-description">AI OVERWRITE DESCRIPTION</p>
    <span class="ai-generated-brand">AI OVERWRITE BRAND</span>
    <div class="ai-generated-images">
      <img src="https://example.com/ai-overwrite.png" alt="ai overwrite">
    </div>
  </body>
</html>`;

function stubFetch(html: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })),
  );
}

describe('page-extractor profile generation (decision 20: proposal-only)', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.SHOPSITE_CMS_PROFILE_GENERATION_ENABLED;
    process.env.SHOPSITE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    insertProfileGeneration.mockClear();
    updateProfileGenerationStatus.mockClear();
    getLlmConfig.mockClear();
    callLlm.mockClear();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SHOPSITE_CMS_PROFILE_GENERATION_ENABLED;
    } else {
      process.env.SHOPSITE_CMS_PROFILE_GENERATION_ENABLED = originalEnv;
    }
    vi.unstubAllGlobals();
  });

  it('does not apply generated selectors to the current extraction result', async () => {
    stubFetch(HTML_WITH_AI_SELECTORS);

    const result = await extractProductData(
      'https://example.com/products/sample',
      { name: 'Sample Product', brandHint: null },
    );

    // Deterministic layered extraction values must be returned. The
    // AI-proposed selectors point to "AI OVERWRITE ..." elements on the
    // page; if they were ever applied, those values would appear here.
    expect(result.title).not.toContain('AI OVERWRITE');
    expect(result.title).toBe('Sample Product');
    expect(result.brand).toBeNull();
    expect(result.description).toBeNull();

    // The image set must come from the deterministic layer, not the
    // AI-proposed `.ai-generated-images` selector.
    const allImages = [
      ...(result.primaryImage ? [result.primaryImage] : []),
      ...(result.additionalImages ?? []),
    ];
    expect(allImages).not.toEqual(
      expect.arrayContaining([expect.stringContaining('ai-overwrite.png')]),
    );
  });

  it('does NOT create profile proposals during extraction (auto-generation disabled)', async () => {
    stubFetch(HTML_WITH_AI_SELECTORS);

    await extractProductData(
      'https://example.com/products/sample',
      { name: 'Sample Product', brandHint: null },
    );

    // Auto profile generation is disabled. Proposals are only created
    // when the operator explicitly clicks "Generate Profile" in the
    // Domain Configuration UI. Extraction must NEVER call
    // insertProfileGeneration.
    expect(insertProfileGeneration).not.toHaveBeenCalled();
  });
});
