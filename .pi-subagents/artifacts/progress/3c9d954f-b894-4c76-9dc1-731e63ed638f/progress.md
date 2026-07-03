# Progress

## Status
Complete

## Tasks
- [x] Read context, plan, and the previously integrated source-discovery.ts
- [x] Read current src/onboarding/job-queue.ts to understand processDiscovery()
- [x] Confirm InsertSourceData has optional `sourceMethod` string field; sitemap candidates use 'sitemap_name' / 'sitemap_upc'
- [x] Add `type InsertSourceData` to the existing onboarding-source-repo import
- [x] Extend `manualReviewReasonForDiscovery` with optional `sitemapCandidateCount` param and append a sitemap note
- [x] Compute `sitemapCandidates`, `sitemapCandidateCount`, `sitemapMatched` once in processDiscovery()
- [x] Update completion log to include sitemap count
- [x] Extend auto-selection policy to prefer sitemap candidates with confidence > 0.7 on an official brand domain (fallback to existing bestSource check)
- [x] Find the inserted counterpart of the auto-selected source by URL (handles sitemap-candidate-wins-over-top-Serper case)
- [x] Add `sitemapMatched` and `sitemapCandidateCount` to the success-path SSE event payload
- [x] Add `sitemapMatched: false, sitemapCandidateCount: 0` to the no-sources SSE event payload
- [x] Run typecheck — clean (0 errors)
- [x] Run lint — 108 problems unchanged from baseline (zero new errors)
- [x] Run sitemap-related + onboarding-repos tests — 42/42 pass
- [x] Verify no staged files (git diff --cached empty)
- [x] Write final handoff report

## Files Changed
- src/onboarding/job-queue.ts
  - Added `type InsertSourceData` to the existing onboarding-source-repo import
  - Extended `manualReviewReasonForDiscovery(item, bestSource, officialDomains, sitemapCandidateCount = 0)` — when sitemap candidates exist but none cleared the auto-select threshold, the reason string appends `; N sitemap candidate(s) found but none above the auto-select threshold`
  - Added a "Sitemap signals" block right after `consolidatedName` is assigned: derives `sitemapCandidates`, `sitemapCandidateCount`, `sitemapMatched` from the merged `sources` array (sourceMethod starting with `sitemap_`)
  - Updated the "Discovery complete" completion log to include the sitemap count: `N source(s) found (M from sitemap)`
  - Replaced the auto-selection policy with a two-step decision:
    1. Find an `eligibleSitemapSource` (sitemap candidate with confidence > 0.7 whose domain matches an official brand domain)
    2. If found → auto-select that source
    3. Otherwise fall back to the existing top-source-on-official-domain check
  - Auto-selected source is looked up by URL against `insertedSources` via `findIndex` so the right `selectSource` call happens even when the sitemap candidate wins over the top Serper result
  - Success-path SSE event now includes `sitemapMatched` (boolean) and `sitemapCandidateCount` (number) — existing fields unchanged, fully backward compatible
  - No-sources SSE event now includes `sitemapMatched: false, sitemapCandidateCount: 0` for shape consistency

## Validation
- `bun run typecheck`: 0 errors
- `bun run lint`: 108 problems (107 errors + 1 warning) — unchanged from baseline (no new errors introduced)
- `bun test src/tests/unit/sitemap-matcher.test.ts`: 17/17 pass
- `bun test src/tests/unit/source-discovery.test.ts`: 8/8 pass
- `bun test src/tests/unit/onboarding-repos.test.ts`: 17/17 pass
- `bun test` (full suite): 335 pass / 55 fail — the 55 failures are pre-existing in unrelated files (LLM task routing, page-extractor variant inference, profile promoter) and are not caused by this change
- `git diff --cached`: empty (no staged files)

## Notes
- The change is surgical and additive. No processExtraction or processCuration changes; no new worker lifecycle methods; no worker constructor changes.
- The new `autoSelectedSource` is `InsertSourceData | null`. The inserted record is looked up by URL with `findIndex`, so the auto-select path still marks the right source as selected even when the winning source is a sitemap candidate that lives at index > 0 in the merged list.
- `manualReviewReasonForDiscovery` has a default of 0 for the new sitemap parameter, so any other caller (none today) stays backward compatible.
- The SSE event payload keeps every existing field; the two new fields (`sitemapMatched`, `sitemapCandidateCount`) are optional additions and have the same shape in both the success and no-sources paths.
- Sitemap cache is warmed lazily inside `discoverSources` (the previous worker's responsibility). No new cache calls, fetches, or repository writes were added here.
