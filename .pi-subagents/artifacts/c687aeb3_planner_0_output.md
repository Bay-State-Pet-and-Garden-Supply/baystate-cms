# Implementation Plan

## Goal
Implement a safe, auditable LLM-assisted CSS selector profile generation system for onboarding product page extraction without silently degrading existing extraction quality.

## Complexity Estimate
- **Overall:** Medium-high, mostly due to prompt/selector validation quality and safe integration into `page-extractor.ts`.
- **Phase 1:** Medium — database audit table, repository additions, and `upsertProfile` safety fix.
- **Phase 2:** Medium-high — DOM minimization, stable selector candidate generation, LLM JSON parsing, validation scoring.
- **Phase 3:** Medium-high — gated extractor integration, one-time retry behavior, and multi-sample validation/promotion guardrails.

## Tasks

### Phase 1 — Safety Foundation and Audit Storage

1. **Add selector proposal and audit persistence table**
   - File: `src/db/migrations.ts`
   - Changes:
     - Add `CREATE TABLE IF NOT EXISTS profile_generations (...)` in `runMigrations()`.
     - Suggested columns:
       - `id TEXT PRIMARY KEY`
       - `domain TEXT NOT NULL`
       - `source_url TEXT NOT NULL`
       - `expected_name TEXT`
       - `brand_hint TEXT`
       - `selectors_json TEXT NOT NULL`
       - `field_samples_json TEXT`
       - `validation_json TEXT`
       - `status TEXT NOT NULL` with values managed in code: `proposed`, `validated`, `rejected`, `promoted`, `failed`
       - `confidence REAL NOT NULL DEFAULT 0`
       - `llm_provider TEXT`
       - `llm_model TEXT`
       - `error_message TEXT`
       - `created_at TEXT NOT NULL`
       - `updated_at TEXT NOT NULL`
       - `promoted_at TEXT`
     - Add indexes on `(domain)`, `(status)`, and `(domain, status)`.
   - Acceptance:
     - Existing database migrations still run idempotently.
     - New table exists in fresh and existing test databases.

2. **Add profile generation repository**
   - New File: `src/db/repositories/profile-generation-repo.ts`
   - Changes:
     - Define `ProfileGenerationStatus` union and `ProfileGenerationRecord` interface.
     - Add functions:
       - `insertProfileGeneration(data)`
       - `updateProfileGenerationStatus(id, status, fields?)`
       - `findProfileGenerationById(id)`
       - `listProfileGenerationsByDomain(domain, options?)`
       - `listValidatedGenerationsByDomain(domain, limit?)`
     - Normalize domains the same way as `extractor-profile-repo.ts`.
     - Store selector and validation payloads as JSON strings; parse on read.
   - Acceptance:
     - Repository supports insert/read/status update.
     - JSON fields round-trip reliably.

3. **Fix partial selector updates so `upsertProfile` does not erase unspecified selectors**
   - File: `src/db/repositories/extractor-profile-repo.ts`
   - Changes:
     - For existing profiles, preserve existing selector values when a property is `undefined`.
     - Continue allowing explicit `null` to clear a selector.
     - For new profiles, default omitted selectors to `null`.
     - Optional but recommended: add `replaceProfile(domain, selectors)` only if current callers need full replacement semantics.
   - Acceptance:
     - `upsertProfile(domain, { titleSelector: 'new' })` preserves existing price/description/brand/images selectors.
     - `upsertProfile(domain, { priceSelector: null })` explicitly clears the price selector.

4. **Update extractor profile tests for merge-style behavior**
   - File: `src/tests/unit/extractor-profiles.test.ts`
   - Changes:
     - Update the current partial-update assertion that expects `priceSelector` to become `null`; it should now expect the previous `.test-price` value to be preserved.
     - Add a separate assertion that explicit `priceSelector: null` clears the selector.
   - Acceptance:
     - Test documents the safety behavior required before generated profiles are ever promoted.

5. **Add profile generation repository tests**
   - New File: `src/tests/unit/profile-generation-repo.test.ts`
   - Changes:
     - Initialize an isolated SQLite test DB.
     - Verify insert, domain normalization, status updates, and JSON round-trip.
   - Acceptance:
     - New tests pass independently with `vitest`.

### Phase 2 — Profile Generator Core

6. **Create profile generator types and feature flag helper**
   - New File: `src/onboarding/profile-generator.ts`
   - Changes:
     - Define exported types:
       - `GeneratedSelectorProfile` with optional `titleSelector`, `priceSelector`, `descriptionSelector`, `brandSelector`, `imagesSelector`; require `titleSelector` at validation time.
       - `SelectorCandidate` with `selector`, `tag`, `attributes`, `textSnippet`, `nearbyLabels`, and `kindHints`.
       - `GeneratedProfileValidation` with `valid`, `confidence`, `status`, `reason`, `fieldSamples`, `selectors`, and `canPromote`.
     - Add `isProfileGenerationEnabled()` reading `process.env.SHOPSITE_CMS_PROFILE_GENERATION_ENABLED` and accepting only explicit truthy values like `true`, `1`, or `yes`.
   - Acceptance:
     - Profile generation is disabled by default.
     - No LLM calls happen unless the flag is enabled.

7. **Implement `getMinimizedDom(html)`**
   - New File: `src/onboarding/profile-generator.ts`
   - Changes:
     - Use Cheerio to parse HTML.
     - Remove non-product/noisy tags: `style`, `svg`, `iframe`, `noscript`, `template`, `header`, `footer`, `nav`, plus common modal/announcement selectors where safe.
     - Remove most `script` tags, but preserve:
       - `script[type="application/ld+json"]`
       - scripts containing product-relevant assignments such as `productJSON`, `variants`, `ShopifyAnalytics`, or obvious product objects.
     - Return a size-bounded minimized string, preferably from `main`, product containers, or `body` after cleanup.
   - Acceptance:
     - Product JSON-bearing scripts are preserved.
     - Tracking/scripts/styles/navigation/footer are removed.
     - Output is materially shorter than input on fixture HTML.

8. **Implement stable selector candidate generation**
   - New File: `src/onboarding/profile-generator.ts`
   - Changes:
     - Add `buildSelectorCandidates(html)`.
     - Generate candidates from minimized DOM, not raw DOM.
     - Include likely product elements:
       - Titles: `h1`, `h2`, `[itemprop="name"]`, `[data-testid*=title]`, classes/ids containing `title`, `name`, `product`.
       - Prices: `[itemprop="price"]`, text matching currency, classes/ids/data attrs containing `price`, `amount`, `sale`.
       - Descriptions: `[itemprop="description"]`, product description containers, tabs/accordions containing meaningful text.
       - Brands: `[itemprop="brand"]`, classes/ids containing `brand`, `vendor`, `manufacturer`.
       - Images: product/gallery image selectors and `srcset`/lazy-load attributes.
     - Add internal helper `buildStableSelector($, el)` with priority:
       1. unique `#id` if not obviously generated
       2. stable `data-*` attributes such as `data-testid`, `data-test`, `data-product-*`
       3. `itemprop` / schema attributes
       4. semantic class combinations with generated-class filtering
       5. short ancestor + child selector
       6. `nth-of-type` only as last resort and mark as lower confidence
     - Limit candidates to a practical number, e.g. top 80-120, sorted by kind confidence.
   - Acceptance:
     - Fixture product HTML returns title, price, description, brand, and image candidates.
     - Generated selectors work in Cheerio against the fixture.
     - Candidate output is compact enough for LLM prompts.

9. **Add LLM JSON generation path**
   - New File: `src/onboarding/profile-generator.ts`
   - Changes:
     - Add `generateExtractorProfile(url, html, expected)`.
     - Use existing `getLlmConfig()` and `callLlm()` from `src/onboarding/llm-client.ts`.
     - Prompt the model to choose selectors only from the provided candidates where possible.
     - Require strict JSON with these fields only:
       - `titleSelector`
       - `priceSelector`
       - `descriptionSelector`
       - `brandSelector`
       - `imagesSelector`
     - In the system prompt, prohibit JavaScript, XPath, browser-only pseudo-selectors, markdown, and explanatory prose.
     - Parse JSON robustly by stripping fenced-code wrappers before `JSON.parse`.
     - Validate selector shape before applying selectors; reject empty strings and unsupported selector syntax.
     - If no LLM config exists or the LLM fails, return a failed/proposed record shape and persist the failure audit if called from integration.
   - Acceptance:
     - Mock LLM JSON produces a selector profile object.
     - Markdown-wrapped JSON is tolerated.
     - Invalid JSON or missing title selector fails closed.

10. **Implement generated selector validation**
    - New File: `src/onboarding/profile-generator.ts`
    - Changes:
      - Add `validateGeneratedProfile(html, selectors, expected)`.
      - Use Cheerio to execute selectors.
      - Require `titleSelector` to extract a non-empty title.
      - If `expected` is provided, call `validateExtraction()` with extracted title/source URL and reject `blocked`, `offline`, and `mismatch` outcomes.
      - Treat `priceSelector` as optional; if present, require extracted text to contain a numeric currency-like value.
      - Treat `descriptionSelector`, `brandSelector`, and `imagesSelector` as optional but include sample values and confidence boosts when present.
      - Return confidence based on title validity, expected-name validation, selector stability, optional field extraction, and price validity if proposed.
      - Set `canPromote` only when validation is high-confidence and not based on brittle selectors.
    - Acceptance:
      - Valid fixture selectors pass.
      - Missing title fails.
      - Price selector with non-price text lowers confidence or fails that field without failing the entire profile if price is optional.
      - Blocked/offline/mismatch expected-validation results fail closed.

11. **Add unit tests for generator core**
    - New File: `src/tests/unit/profile-generator.test.ts`
    - Changes:
      - Test `getMinimizedDom()` removes noise and preserves product JSON scripts.
      - Test `buildSelectorCandidates()` finds stable title/price/description/image candidates.
      - Mock `llm-client.ts` and test `generateExtractorProfile()` with valid JSON, fenced JSON, invalid JSON, and no title selector.
      - Test `validateGeneratedProfile()` pass/fail cases.
    - Acceptance:
      - Tests run without network access.
      - LLM behavior is fully mocked.

### Phase 3 — Safe Extractor Integration and Promotion Guardrails

12. **Refactor HTTP extraction to expose diagnostics without changing public behavior**
    - File: `src/onboarding/page-extractor.ts`
    - Changes:
      - Add an internal helper such as `extractViaHttpDetailed(url, profile)` returning:
        - `data: ExtractionData`
        - `html: string`
        - `raw: RawExtraction`
        - `customHadAnyValue: boolean`
      - Keep exported `extractViaHttp(url, profile)` as a wrapper returning only `data`.
      - Use the detailed helper inside `extractProductData()` so generation can reuse the fetched HTML and raw custom-selector diagnostics.
    - Acceptance:
      - Existing callers of `extractViaHttp()` are unaffected.
      - Existing extraction behavior remains the same when profile generation is disabled.

13. **Add explicit trigger decision function**
    - New File or File: `src/onboarding/profile-generator.ts` preferred
    - Changes:
      - Add `shouldAttemptProfileGeneration(input)` as a pure function taking:
        - domain
        - existing profile or null
        - extraction result
        - validation result
        - `customHadAnyValue`
      - Return `true` only when:
        - feature flag is enabled
        - validation status is `ok`
        - page has a non-empty validated title from non-custom layers, or custom selectors are empty/stale
        - missing/improvable fields include title from custom selectors, description, brand, or images
      - Return `false` for:
        - `blocked`
        - `offline`
        - `mismatch`
        - only missing price
        - missing/invalid expected context
    - Acceptance:
      - Unit tests prove blocked/offline/mismatch/price-only cases do not trigger generation.
      - Valid page with empty stale custom selectors does trigger generation.

14. **Integrate one-time profile generation retry in HTTP path**
    - File: `src/onboarding/page-extractor.ts`
    - Changes:
      - After HTTP extraction validates successfully, call `shouldAttemptProfileGeneration()`.
      - If true:
        1. Call `generateExtractorProfile(url, html, expected)`.
        2. Call `validateGeneratedProfile(html, selectors, expected)`.
        3. Insert an audit row into `profile_generations` regardless of success/failure.
        4. If validation passes, re-run extraction once with the generated selectors in memory only.
        5. Use the re-run result only if it also passes `validateExtraction()` and does not reduce confidence or replace non-empty fields with empty values.
      - Do **not** call `upsertProfile()` here by default.
      - Add log messages that identify generated profile status without printing sensitive API keys or full DOM.
    - Acceptance:
      - With feature flag off, no generation occurs.
      - With feature flag on and mocked generator, extraction retries at most once.
      - Failed generated selectors are audited but never applied.

15. **Optionally support Playwright-generated HTML after a valid browser extraction**
    - File: `src/onboarding/page-extractor.ts`
    - Changes:
      - If HTTP fails but Playwright succeeds and validates as `ok`, capture `await page.content()` before browser close.
      - Apply the same generation flow only if the trigger decision allows it.
      - Keep this secondary to HTTP integration to avoid widening the first implementation.
    - Acceptance:
      - Browser-only pages can generate proposed profiles, but still do not auto-promote.
      - Blocked/offline/mismatch browser results still do not trigger generation.

16. **Add multi-sample validation support before promotion**
    - New or Modified File: `src/db/repositories/onboarding-source-repo.ts`
    - Changes:
      - Add a query such as `listValidationSamplesByDomain(domain, limit)` joining `onboarding_sources` to `onboarding_items` to return URLs plus expected item names/brand hints for selected or confirmed sources on the same domain.
    - New File or File: `src/onboarding/profile-generator.ts`
    - Changes:
      - Add `validateProfileAcrossSamples(selectors, samples)`.
      - Fetch each sample HTML using the same headers as `page-extractor.ts` or a shared fetch helper.
      - Require at least 2 successful samples before any automatic promotion is allowed.
      - If fewer than 2 samples exist, leave the profile generation record as `validated`/`proposed`, not promoted.
    - Acceptance:
      - Single-sample generated profiles are never auto-promoted.
      - Multi-sample validation rejects selectors that overfit one product page.

17. **Add explicit promotion path with conservative auto-promotion option**
    - Files:
      - `src/onboarding/profile-generator.ts`
      - `src/db/repositories/extractor-profile-repo.ts`
      - `src/db/repositories/profile-generation-repo.ts`
    - Changes:
      - Add `promoteGeneratedProfile(generationId)` that:
        - reads the validated generation
        - revalidates selectors if needed
        - calls merge-style `upsertProfile()`
        - marks generation `promoted`
      - Add a separate optional env flag, e.g. `SHOPSITE_CMS_PROFILE_AUTO_PROMOTE_ENABLED`, default false.
      - Only auto-promote when:
        - generation validation confidence is above a high threshold, e.g. `>= 0.9`
        - at least 2-3 same-domain samples passed
        - selectors are not brittle/nth-only
        - no existing selector is replaced by a lower-confidence selector
    - Acceptance:
      - Default behavior stores pending/validated proposals only.
      - Auto-promotion requires a second explicit flag and strict validation.
      - Existing profile fields are preserved unless explicitly replaced by validated selectors.

18. **Add integration-focused unit tests for trigger and one-retry behavior**
    - Files:
      - `src/tests/unit/profile-generator.test.ts`
      - Optional New File: `src/tests/unit/page-extractor-profile-generation.test.ts`
    - Changes:
      - Prefer testing pure helpers (`shouldAttemptProfileGeneration`, validation, promotion eligibility) to avoid network/browser flakiness.
      - If adding page extractor integration tests, mock fetch/LLM/repository calls so no external network or browser launch is required.
    - Acceptance:
      - Tests cover feature flag off/on.
      - Tests cover stale custom selectors.
      - Tests cover blocked/offline/mismatch/price-only no-trigger cases.
      - Tests cover failed generated selectors audited but not applied.

19. **Run validation commands**
    - Files: N/A
    - Changes: N/A
    - Commands:
      - `bun run test:unit`
      - `bun run typecheck`
      - `bun run lint` if lint runtime is acceptable in the environment
    - Acceptance:
      - Unit tests pass.
      - TypeScript passes.
      - Any lint findings are fixed or documented.

## Files to Modify
- `src/db/migrations.ts` - create `profile_generations` audit table and indexes idempotently.
- `src/db/repositories/extractor-profile-repo.ts` - make `upsertProfile()` merge-style for existing profiles and preserve unspecified selectors.
- `src/db/repositories/onboarding-source-repo.ts` - add same-domain validation sample query for multi-sample promotion guardrail.
- `src/onboarding/page-extractor.ts` - expose HTTP extraction diagnostics internally and add feature-flagged, one-time in-memory profile generation retry after valid extraction.
- `src/tests/unit/extractor-profiles.test.ts` - update partial update expectations and add explicit-null clearing test.

## New Files
- `src/db/repositories/profile-generation-repo.ts` - repository for audit trail of generated selector proposals, validation results, and promotion state.
- `src/onboarding/profile-generator.ts` - DOM minimization, selector candidate building, LLM prompt/JSON parsing, selector validation, trigger decision, multi-sample validation, and promotion helpers.
- `src/tests/unit/profile-generation-repo.test.ts` - tests for audit repository persistence and JSON/status behavior.
- `src/tests/unit/profile-generator.test.ts` - tests for minimization, candidate generation, mocked LLM generation, validation, trigger decisions, and promotion eligibility.
- Optional: `src/tests/unit/page-extractor-profile-generation.test.ts` - mocked integration tests for feature flag and one-retry behavior if pure helper coverage is insufficient.

## Dependencies
- Phase 2 depends on Phase 1's repository and `upsertProfile()` safety fix.
- Phase 3 depends on Phase 2's generator/validator and Phase 1 audit persistence.
- Multi-sample validation depends on access to same-domain source samples from `onboarding_sources`/`onboarding_items`.
- Auto-promotion, if enabled later, depends on merge-style `upsertProfile()` and multi-sample validation.
- No new external package should be required; Cheerio is already used by `page-extractor.ts`. If dependency resolution reveals Cheerio is only transitive, add it explicitly to `package.json` in the implementation PR.

## Risks
- **Prompt injection from HTML:** Mitigate by sending compact candidate data rather than raw DOM, and instructing the model to output JSON only.
- **Selector overfitting:** Mitigate with candidate stability scoring and require multi-sample validation before promotion.
- **Silent extraction degradation:** Mitigate by disabling generation by default, auditing every attempt, retrying in memory only, and requiring the re-run result to pass validation without lowering confidence.
- **Wrong trigger category:** Do not generate profiles for `blocked`, `offline`, `mismatch`, or price-only missing cases.
- **Current `upsertProfile()` behavior is unsafe:** Must be fixed before any promotion path is implemented.
- **LLM provider metadata:** Existing `callLlm()` returns only text; implementation should read `getLlmConfig()` before calling so audit rows can store provider/model.
- **Browser path complexity:** Playwright support should be secondary; HTTP path should be implemented and tested first.
- **Cheerio selector compatibility:** Reject browser-only pseudo-selectors or XPath because validation and HTTP extraction use Cheerio.

## Explicit Non-Scope for Initial Implementation
- No fully automatic live profile overwrites by default.
- No UI for approving/rejecting proposals unless requested later.
- No broad crawler framework rewrite.
- No price-only remediation; existing `supplementPrice()` remains the intended mechanism for manufacturer pages without prices.
- No external web calls in unit tests.

## Suggested Validation Matrix
- Existing profile + stale selectors + valid JSON-LD title → generation allowed, audited, in-memory retry only.
- No profile + valid page + heuristic title → generation allowed, audited, in-memory retry only.
- Cloudflare title/block page → generation not attempted.
- 404/offline page → generation not attempted.
- Catalog mismatch → generation not attempted.
- Valid title but missing price only → generation not attempted.
- Generated title selector valid, optional price missing → profile can be validated but not necessarily promoted.
- Generated price selector returns non-price text → price field rejected, confidence lowered.
- One sample only → no auto-promotion.
- Two or more same-domain samples valid → promotion eligible only if separate auto-promote flag is enabled.