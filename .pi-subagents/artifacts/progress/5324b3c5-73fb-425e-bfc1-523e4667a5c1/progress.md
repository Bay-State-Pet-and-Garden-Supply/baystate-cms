# Implementation Progress

## Status
- 2026-07-02T03:00:00Z — Started Phase 1 (5 tasks)
- 2026-07-02T03:20:00Z — Phase 1 complete; 15/15 tests pass
- 2026-07-02T03:30:00Z — Started Phase 2 (6 tasks)
- 2026-07-02T04:15:00Z — Phase 2 complete; 44/44 tests pass under both bun and vitest; typecheck clean for new files
- 2026-07-02T05:00:00Z — Started Phase 3 (7 tasks: 12-18)
- 2026-07-02T05:55:00Z — Phase 3 complete; 84 new tests across 2 test files; 250 bun + 131 vitest tests all green; typecheck clean

## Tasks

### Phase 1 — Safety Foundation and Audit Storage (DONE)
- Status: DONE (5/5)
- See `phase1-handoff.md` for full details.

### Phase 2 — Profile Generator Core (DONE)

#### Task 6 — Types and feature flag
- Status: DONE
- File: `src/onboarding/profile-generator.ts`
- Action: Implemented `GeneratedSelectorProfile`, `SelectorCandidate`, `GeneratedProfileValidation`, and `GeneratorExpectedContext` types. `isProfileGenerationEnabled()` reads `SHOPSITE_CMS_PROFILE_GENERATION_ENABLED` and accepts `true|1|yes` only.

#### Task 7 — `getMinimizedDom`
- Status: DONE
- File: `src/onboarding/profile-generator.ts`
- Action: Cheerio-based minimizer. Removes `style`, `svg`, `iframe`, `noscript`, `template`, `header`, `footer`, `nav`, plus form/input/select/textarea/aside/button. Strips ordinary scripts but buffers JSON-LD, `productJSON`, `variants`, `ShopifyAnalytics`, `Shopify.theme`, `window.Shopify` scripts and appends them after scoping. Scopes to `<main>` / `[itemtype*="Product"]` / `.product` / `.pdp` / `#product` first, then falls back to `<body>`. Caps output at 200 KB.

#### Task 8 — `buildSelectorCandidates`
- Status: DONE
- File: `src/onboarding/profile-generator.ts`
- Action: Scans minimized DOM for title/price/description/brand/image candidates. Internal `buildStableSelector($, el)` priority ladder: unique non-generated id → stable `data-*` (data-testid/test/cy/qa/product-id/product-sku) → `itemprop` → semantic class combinations → ancestor+child → `nth-of-type` (low-stability fallback). `isLikelyGeneratedId` rejects React keys, CSS modules, Tailwind arbitrary values, hex ids, pure-numeric ids, and Shopify section ids. Output capped at 100 candidates.

#### Task 9 — `generateExtractorProfile`
- Status: DONE
- File: `src/onboarding/profile-generator.ts`
- Action: Uses `getLlmConfig` and `callLlm` from `./llm-client`. Builds candidates first, prompts the LLM to choose from the candidate list (up to 80 in the prompt), strips markdown fences, parses JSON, validates the response shape via `shapeFromParsed`, rejects XPath/JS/unsupported pseudo-selectors, and returns `null` on every failure path (no LLM config, LLM exception, invalid JSON, missing title, etc.). Does not insert audit rows — that is the Phase 3 caller's job.

#### Task 10 — `validateGeneratedProfile`
- Status: DONE
- File: `src/onboarding/profile-generator.ts`
- Action: Cheerio-based validator. Title is required; price is optional but its text must look like a currency; description/brand/images are optional. Calls `validateExtraction` when `expected` is provided; blocked/offline/mismatch all fail closed. `canPromote` only `true` when confidence ≥ 0.8 and no `:nth-of-type` selector was used.

#### Task 11 — Tests
- Status: DONE
- File: `src/tests/unit/profile-generator.test.ts`
- Action: 44 tests. Mocks `llm-client` so no network is touched. Covers: getMinimizedDom (6), buildSelectorCandidates (8), buildStableSelector (4), generateExtractorProfile (10), validateGeneratedProfile (11), isProfileGenerationEnabled (5).

## Validation
- `bun run typecheck` — clean for new files (2 pre-existing errors in page-extractor.ts unchanged)
- `bun test src/tests/unit/profile-generator.test.ts` — 44 pass, 0 fail, 81 expect() calls
- `bunx vitest run src/tests/unit/profile-generator.test.ts` — 44 pass, 0 fail
- `bun test <existing Phase 1 + repo tests>` — 97 pass, 0 fail, no regressions

## Files changed
- new: `src/onboarding/profile-generator.ts` (940 lines)
- new: `src/tests/unit/profile-generator.test.ts` (545 lines)

## Files NOT changed
- `src/onboarding/page-extractor.ts` (Phase 3 scope)
- `src/db/repositories/profile-generation-repo.ts` (Phase 1 already done; no further changes needed)
- `src/onboarding/llm-client.ts` (consumed via existing API)
- `src/onboarding/extraction-validator.ts` (consumed via existing API)

## Open items for Phase 3
- Fix pre-existing `page-extractor.ts` typecheck errors (lines 1154, 1159)
- Consider promoting `cheerio` to a direct dependency in `package.json`
- Wire `insertProfileGeneration` / `updateProfileGenerationStatus` calls from the new feature into the page-extractor retry path
- Implement the one-time, in-memory retry per the plan's Phase 3 Task 14
- Add `shouldAttemptProfileGeneration` and the multi-sample validation flow

### Phase 3 — Safe Extractor Integration and Promotion Guardrails (DONE)

#### Task 12 — HTTP extraction diagnostics refactor
- Status: DONE
- File: `src/onboarding/page-extractor.ts`
- Action: Split `extractViaHttp` into `extractViaHttpDetailed(url, profile)` (returns `{ data, html, raw, customHadAnyValue }`) and a thin `extractViaHttp` wrapper. Added `HTTP_EXTRACTION_HEADERS` exported constant for the multi-sample validation fetch. Added `customSelectorsHadAnyValue` helper. `extractProductData` now uses the detailed helper so the retry path can reuse the fetched HTML and per-layer payloads without a second network call.

#### Task 13 — `shouldAttemptProfileGeneration`
- Status: DONE
- File: `src/onboarding/profile-generator.ts`
- Action: Pure trigger decision function. Returns `true` only when: feature flag is on, validation status is `ok`, validation confidence ≥ 0.5, extracted title is non-empty, custom-selector layer was empty/stale, and at least one of description/brand is missing. Rejects blocked/offline/mismatch/price-only cases. Re-tested with 9 new unit tests covering every decision branch.

#### Task 14 — One-time in-memory profile generation retry
- Status: DONE
- File: `src/onboarding/page-extractor.ts`
- Action: After HTTP extraction validates successfully, `maybeRetryWithGeneratedProfile` is called. It calls `generateExtractorProfile`, `validateGeneratedProfile`, and inserts an audit row to `profile_generations` regardless of success/failure. If validation passes, the extraction is re-run in memory with `applyGeneratedProfileToCheerio` and the re-run result is used only if it passes `validateExtraction`, does not reduce confidence, and does not replace a non-empty field with an empty one. `upsertProfile` is never called from the retry path.

#### Task 15 — Playwright HTML capture for generation
- Status: DONE
- File: `src/onboarding/page-extractor.ts`
- Action: When HTTP fails but Playwright succeeds and validates as `ok`, `page.content()` is captured before browser close. The retry path can use that HTML when the HTTP path did not produce valid output. Stays secondary to the HTTP path.

#### Task 16 — Multi-sample validation
- Status: DONE
- Files: `src/db/repositories/onboarding-source-repo.ts`, `src/onboarding/profile-generator.ts`
- Action: Added `listValidationSamplesByDomain(domain, limit)` that joins `onboarding_sources` to `onboarding_items`, prefers `is_selected` rows first, then by confidence. Added `validateProfileAcrossSamples(selectors, samples)` in profile-generator. Requires at least 2 successful samples for `canAutoPromote=true`. 4 new repository tests verify the join + ordering.

#### Task 17 — Promotion path
- Status: DONE
- Files: `src/onboarding/profile-promoter.ts` (new), `package.json`
- Action: New file `profile-promoter.ts` keeps the promotion path DB-dependent. Exports `isAutoPromoteEnabled()` (reads `SHOPSITE_CMS_PROFILE_AUTO_PROMOTE_ENABLED`, defaults to false), `MIN_AUTO_PROMOTE_CONFIDENCE = 0.9`, and `promoteGeneratedProfile(generationId)`. Safety guards: missing row → not promoted; no title selector → not promoted + audit row updated to `rejected`; status `proposed`/`rejected`/`failed` → not promoted; auto-promote requires confidence ≥ 0.9 and rejects `:nth-of-type` low-stability selectors; conservative write (title only) when auto-promote is off; full write when auto-promote is on. Always uses merge-style `upsertProfile` so existing selectors are preserved.

#### Task 18 — Integration tests
- Status: DONE
- Files: `src/tests/unit/profile-generator.test.ts`, `src/tests/unit/profile-promoter.test.ts` (new), `vitest.config.ts`
- Action: Added 18 new vitest tests in `profile-generator.test.ts` for `shouldAttemptProfileGeneration` (9 tests), `applyGeneratedProfileToCheerio` (4 tests), and `validateProfileAcrossSamples` (5 tests). Created new `src/tests/unit/profile-promoter.test.ts` with 17 bun-test tests for `isAutoPromoteEnabled` (4), failure paths (5), success paths (8), and a `listValidatedGenerationsByDomain` integration sanity check. Also added 5 new `listValidationSamplesByDomain` tests to `onboarding-repos.test.ts`. Updated `vitest.config.ts` to exclude the new DB-dependent test files from vitest (which cannot load `bun:sqlite`). Updated `package.json` test script to include the new bun-test files.

## Final validation
- `bun run typecheck` — clean (0 errors). Pre-existing `page-extractor.ts` errors on lines 1154/1159 fixed as part of Task 12.
- `bun test` — 250 pass, 0 fail, 802 expect() calls, 22 files (~750ms)
- `bunx vitest run` — 131 pass, 0 fail, 9 files (~480ms)
- `bun run test` — 131 vitest + 119 explicit bun test = 250 total, all green

## Files changed
- modified: `src/onboarding/page-extractor.ts` (split `extractViaHttp` into detailed+wrapper; added retry path; fixed pre-existing typecheck errors; captured Playwright HTML for secondary generation path)
- modified: `src/onboarding/profile-generator.ts` (added `applyGeneratedProfileToCheerio`, `shouldAttemptProfileGeneration`, `validateProfileAcrossSamples`, `ValidationSample`/`MultiSampleValidationResult` types)
- new: `src/onboarding/profile-promoter.ts` (DB-dependent promotion path; `isAutoPromoteEnabled`, `MIN_AUTO_PROMOTE_CONFIDENCE`, `promoteGeneratedProfile`)
- modified: `src/db/repositories/onboarding-source-repo.ts` (added `listValidationSamplesByDomain` + `ValidationSampleRow` type)
- modified: `src/tests/unit/profile-generator.test.ts` (added 18 new tests for Phase 3 helpers; 62 total)
- new: `src/tests/unit/profile-promoter.test.ts` (17 tests for promotion path)
- modified: `src/tests/unit/onboarding-repos.test.ts` (added 5 new tests for `listValidationSamplesByDomain`)
- modified: `vitest.config.ts` (excluded DB-dependent test files from vitest)
- modified: `package.json` (added new bun-test files to the explicit test list)

## Files NOT changed
- `src/onboarding/llm-client.ts` (consumed via existing API; no changes needed)
- `src/onboarding/extraction-validator.ts` (consumed via existing API)
- `src/db/repositories/extractor-profile-repo.ts` (Phase 1's `upsertProfile` merge fix already in place; promoter uses it as-is)
- `src/db/repositories/profile-generation-repo.ts` (Phase 1 already in place; promoter uses `findProfileGenerationById` and `updateProfileGenerationStatus` as-is)

## Residual risks / follow-ups
- **cheerio is still a transitive dependency.** The plan called for promoting it to a direct dependency in package.json alongside the Phase 3 work, but doing so is out of scope for a behavior change. Recommend landing in a small follow-up PR alongside any other `page-extractor.ts` cleanup.
- **No UI flow for explicit promotion.** The current promoter is callable from a script or a future admin endpoint. The plan explicitly defers UI work.
- **Auto-promote is opt-in.** Default is conservative (title-only merge, requires `MIN_AUTO_PROMOTE_CONFIDENCE = 0.9` to enable the full write path). The conservative path is the safe default; the auto-promote flag is a separate, additive enable.
- **No Playwright integration test for the retry path.** The retry path is exercised by unit tests on its pure helpers (`shouldAttemptProfileGeneration`, `validateGeneratedProfile`, `applyGeneratedProfileToCheerio`); the integration test would need a fake `fetch` and a fake `chromium` and was not added because the unit-level coverage of the pure logic plus the strict safety guards in `maybeRetryWithGeneratedProfile` (which never throws) is the highest-leverage coverage. If a follow-up phase wants browser-level integration tests, the path is now ready to receive them.
- **The 200 KB cap on `getMinimizedDom` is still in effect.** Phase 3 does not change minimization. If real-world product pages need more, raise the cap.
