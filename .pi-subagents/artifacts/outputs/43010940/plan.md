# Implementation Plan

## Goal
Unify product image source collection and Shopify URL deduping between production extraction and profile-governance validation previews so governance image previews stop showing duplicate low-res carousel thumbnails without changing selector schemas or LLM prompts.

## Tasks
1. **Create shared image utility with current extractor behavior**
   - File: `src/onboarding/image-utils.ts`
   - Changes:
     - New exported helpers:
       - `export function parseSrcsetCandidates(srcset: string | null | undefined): string[]`
       - `export function isUsableImageSource(src: string | null | undefined): src is string`
       - `export function collectImageSourcesFromElement($: cheerio.CheerioAPI, el: cheerio.Element | any): string[]`
       - `export function addImageSource(src: string, seen: Set<string>, images: string[]): void`
       - `export function canonicalizeUrl(urlStr: string, baseUrl?: string): string`
       - `export function cleanAndDeduplicateImages(urls: string[], baseUrl?: string): string[]`
     - Move the existing Cheerio/static helpers from `src/onboarding/page-extractor.ts` into this file:
       - `parseSrcsetCandidates`
       - `isUsableImageSource`
       - `collectImageSourcesCheerio` renamed to `collectImageSourcesFromElement`
       - `addImageSource`
       - `canonicalizeUrl`
       - `cleanAndDeduplicateImages`
     - Keep the extractor semantics intact during the move: same direct attributes (`src`, `data-src`, `data-lazy-src`, `data-original`, `data-image`, `data-zoom-image`), same srcset attrs (`srcset`, `data-srcset`), same SVG/data URI filtering, same Shopify `width=1200` normalization.
     - Optional but recommended inside the helper: expose a small internal/exported canonical-base duplicate predicate, e.g. `export function hasRepeatedCanonicalImageBases(urls: string[], baseUrl?: string): boolean`, only if it simplifies governance warnings. If added, keep it utility-only; do not change schemas.
   - Acceptance:
     - `src/onboarding/image-utils.ts` compiles with no circular imports.
     - Public helper signatures are typed and usable from both `page-extractor.ts` and `profile-governance-service.ts`.

2. **Replace duplicated helper definitions in the page extractor**
   - File: `src/onboarding/page-extractor.ts`
   - Changes:
     - Add import near existing onboarding-local imports:
       ```ts
       import {
         addImageSource,
         canonicalizeUrl,
         cleanAndDeduplicateImages,
         collectImageSourcesFromElement,
       } from './image-utils';
       ```
     - Remove local definitions of:
       - `parseSrcsetCandidates`
       - `isUsableImageSource`
       - `collectImageSourcesCheerio`
       - `addImageSource`
       - `canonicalizeUrl`
       - `cleanAndDeduplicateImages`
     - Update call sites:
       - In `extractCustomSelectorsCheerio`, replace `collectImageSourcesCheerio($, el)` with `collectImageSourcesFromElement($, el)`.
       - In `extractImagesCheerio`, replace `collectImageSourcesCheerio($, el)` with `collectImageSourcesFromElement($, el)`.
       - Keep `cleanAndDeduplicateImages(...)` and `canonicalizeUrl(...)` call sites unchanged except for imported source.
     - Do **not** modify the browser `page.evaluate` image helper in `extractImages`; those functions run inside browser context and cannot directly import Node/shared helpers.
   - Acceptance:
     - Existing `page-extractor-images.test.ts` continues to pass.
     - No intended production extraction behavior changes from the refactor itself.

3. **Update governance image validation to use shared collection and cleanup**
   - File: `src/onboarding/profile-governance-service.ts`
   - Changes:
     - Add import:
       ```ts
       import {
         addImageSource,
         canonicalizeUrl,
         cleanAndDeduplicateImages,
         collectImageSourcesFromElement,
       } from './image-utils';
       ```
       Use `canonicalizeUrl` only if implementing the repeated-base warning directly in the service.
     - In `evaluateSelectorOnSample`, replace the `imagesSelector` block around the current direct-`src` extraction with shared extraction:
       ```ts
       const rawImages: string[] = [];
       const seenRaw = new Set<string>();
       $(selector).each((_, el) => {
         for (const src of collectImageSourcesFromElement($, el)) {
           addImageSource(src, seenRaw, rawImages);
         }
       });
       const images = cleanAndDeduplicateImages(rawImages, sampleUrl);
       ```
     - Preserve the zero-selector behavior before this block (`Selector matched zero elements`).
     - Return deduped/normalized `images` as both:
       - `extractedImages`
       - later persisted `imagePreviews` via existing validation result mapping.
     - Keep the carousel/repeated-base warning as informational after cleanup:
       - Compute it from `rawImages` vs canonical groups, not from already-deduped previews.
       - Add warning when `rawImages.length > images.length` or when multiple raw URLs map to the same `canonicalizeUrl(raw, sampleUrl)`.
       - Keep existing warning text if possible for UI continuity: `Image selector returned repeated base paths — may include recommendation/carousel images`.
     - Set status from cleaned previews: `status: images.length > 0 ? 'pass' : 'fail'`.
   - Acceptance:
     - Governance previews now include srcset/data-srcset candidates.
     - Governance previews are absolute, deduped, and Shopify-normalized like production extraction.
     - Duplicate carousel matches still produce a warning, but previews do not show every low-res duplicate.

4. **Add focused unit tests for the shared image utility**
   - File: `src/tests/unit/image-utils.test.ts`
   - Changes:
     - New Vitest file importing:
       ```ts
       import * as cheerio from 'cheerio';
       import {
         canonicalizeUrl,
         cleanAndDeduplicateImages,
         collectImageSourcesFromElement,
         isUsableImageSource,
         parseSrcsetCandidates,
       } from '../../onboarding/image-utils';
       ```
     - Test cases:
       1. `parseSrcsetCandidates` extracts just URLs and drops descriptors from mixed `165w`, `2x`, and whitespace cases.
       2. `isUsableImageSource` rejects empty strings, `data:` URIs, and `.svg` URLs even with query strings.
       3. `collectImageSourcesFromElement` reads direct image attrs and both `srcset` and `data-srcset` from an `img`, `source`, or wrapping `picture`/gallery element.
       4. `canonicalizeUrl` collapses Shopify-style size suffixes:
          - `_80x80`
          - `_150x150_crop_center`
          - `_compact`
          - `_thumb` / `_small` if practical.
       5. `cleanAndDeduplicateImages` dedupes duplicate canonical groups and normalizes Shopify URLs to `width=1200` while preserving `v` query params.
       6. High-res/unsized duplicate group test:
          - If strict “page-extractor behavior unchanged” is required, assert deduping based on the first accepted URL and document first-seen behavior.
          - If a product decision allows improving the helper, update `cleanAndDeduplicateImages` to prefer the best candidate per canonical group (unsized/highest width over thumbnail) and assert that behavior.
   - Acceptance:
     - New unit test file covers the Shopify URL patterns requested by the task.
     - Tests document the exact dedupe preference behavior so future changes are intentional.

5. **Add a governance validation integration-style unit test**
   - File: `src/tests/unit/profile-governance-service.test.ts`
   - Changes:
     - Add `vi` to the Vitest import if needed: `import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';`.
     - Add a test under `describe('validateRevisionAcrossConfirmedSamples', ...)` that:
       - Seeds a confirmed sample URL for a unique domain.
       - Creates a generation/revision with selectors like `{ titleSelector: 'h1', imagesSelector: '.product-gallery img, .product-gallery source' }` or a wrapper selector if testing `picture` handling.
       - Stubs `globalThis.fetch` to return HTML containing:
         - `<h1>...</h1>`
         - a product gallery with low-res direct thumbnail URL (`_80x80` or `_150x150_crop_center`)
         - a srcset/data-srcset with duplicate higher/lower candidates.
       - Calls `validateRevisionAcrossConfirmedSamples(rev.id, domain, { sampleLimit: 1 })`.
       - Asserts the `imagesSelector` sample/result has deduped `extractedImages` / `imagePreviews` and includes `width=1200` for Shopify CDN URLs.
       - Asserts duplicate raw candidates produce a warning.
       - Uses `try/finally { vi.unstubAllGlobals(); }` to avoid fetch-stub bleed into other shared-DB tests.
   - Acceptance:
     - The governance path is tested through its public API, not a private helper.
     - The test proves validation previews use the shared cleanup behavior.

6. **Update or extend existing page extractor image tests only if refactor reveals breakage**
   - File: `src/tests/unit/page-extractor-images.test.ts`
   - Changes:
     - Keep existing tests intact.
     - Add assertions only if necessary to prove `page-extractor.ts` still uses `srcset` from product-gallery scoped images and still excludes global recommendation srcsets.
   - Acceptance:
     - Existing `page-extractor-images.test.ts` passes without weakening assertions.

7. **Run targeted validation commands**
   - File: N/A
   - Changes: N/A
   - Acceptance:
     - Run:
       - `bun run typecheck`
       - `bunx vitest run src/tests/unit/image-utils.test.ts src/tests/unit/page-extractor-images.test.ts src/tests/unit/profile-governance-service.test.ts`
     - If time allows before handoff, also run `bun run test`.
     - Confirm no accidental schema, prompt, or route changes.

## Files to Modify
- `src/onboarding/page-extractor.ts` - remove duplicated static image helpers and import/use shared helpers; keep browser-context image extraction unchanged.
- `src/onboarding/profile-governance-service.ts` - replace simplified governance image selector extraction with shared source collection and deduped normalized previews; preserve warning semantics.
- `src/tests/unit/profile-governance-service.test.ts` - add a public-API validation test for deduped image previews and srcset/data-srcset collection.
- `src/tests/unit/page-extractor-images.test.ts` - only update if needed to preserve/refine current image extraction regression coverage.

## New Files
- `src/onboarding/image-utils.ts` - shared static image source collection, URL usability, canonicalization, and deduping helpers.
- `src/tests/unit/image-utils.test.ts` - focused unit tests for srcset parsing, source collection, Shopify canonicalization, and deduping behavior.

## Dependencies
- Task 2 depends on Task 1 because `page-extractor.ts` imports the new utility.
- Task 3 depends on Task 1 because `profile-governance-service.ts` imports the new utility.
- Task 4 depends on Task 1 because it tests exported helper signatures.
- Task 5 depends on Tasks 1 and 3 because it validates governance wiring.
- Task 7 depends on Tasks 1–6.

## Risks
- **Behavior unchanged vs best-candidate preference ambiguity:** The task says `page-extractor.ts` behavior must remain unchanged, but also requests tests for high-res/unsized duplicate groups. Existing `cleanAndDeduplicateImages` is mostly first-seen within each canonical group. If worker tests reveal low-res-first inputs still return low-res filenames, either document that behavior or request/confirm a product decision before changing the utility to prefer unsized/highest-quality candidates, because that would affect production extraction too.
- **Static HTML limitation remains:** Cheerio cannot know rendered `naturalWidth`/visibility; URL normalization reduces duplicates but cannot perfectly distinguish every thumbnail implementation.
- **Selector wrappers:** `collectImageSourcesFromElement` currently uses the element itself if it is `img`/`source`, otherwise the first descendant `img,source`. If governance selectors match a wrapper containing multiple images, this will only collect the first descendant per wrapper. This preserves current extractor behavior, but if the desired governance previews need every descendant from a wrapper selector, that is a separate scope decision because it could change profile extraction behavior.
- **Relative URL handling:** Shared `cleanAndDeduplicateImages` should always receive `sampleUrl`/`sourceUrl` in governance and production merge paths so relative image URLs resolve correctly.
- **Test isolation:** `profile-governance-service.test.ts` uses a shared SQLite DB for the file; use unique domains and restore fetch stubs to avoid cross-test pollution.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Created a scoped implementation plan that limits work to shared image utilities, page-extractor/governance wiring, and focused tests; explicitly excludes selector schema and LLM prompt changes."
    }
  ],
  "changedFiles": [
    ".pi-subagents/artifacts/outputs/43010940/plan.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Planning task only; no code validation commands were run."
  ],
  "residualRisks": [
    "Ambiguity remains around whether cleanAndDeduplicateImages may change from first-seen dedupe to highest-quality candidate preference, because the task asks for unchanged page-extractor behavior but also high-res/unsized duplicate tests."
  ],
  "noStagedFiles": true,
  "diffSummary": "Wrote implementation plan artifact only; no project source files modified.",
  "reviewFindings": [
    "no blockers in planning artifact"
  ],
  "manualNotes": "This subagent is planning-only per role instructions. Implementation workers should make the code/test changes and run validation commands."
}
```