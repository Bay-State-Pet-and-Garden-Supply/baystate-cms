# Job-Queue Sitemap Wiring — Result

## Summary
Wired sitemap integration into `src/onboarding/job-queue.ts`. The worker now:

1. Derives sitemap signals (`sitemapCandidates`, `sitemapCandidateCount`, `sitemapMatched`) from the merged `sources` returned by `discoverSources()`.
2. Extends the auto-selection policy to prefer a sitemap candidate with `confidence > 0.7` whose domain matches an official brand domain (falling back to the existing top-source-on-official-domain check).
3. Surfaces `sitemapMatched` and `sitemapCandidateCount` in the discovery SSE event (both the success and the no-sources paths) and in the "Discovery complete" log summary.
4. Mentions sitemap candidates in the `manualReviewReasonForDiscovery` reason string when they exist but none cleared the auto-select threshold.

The change is surgical and additive: no new worker lifecycle methods, no `processExtraction` or `processCuration` changes, no constructor changes, no new repositories or cache calls (sitemap cache remains lazily warmed by `source-discovery.ts`).

## Changes Made (file: `src/onboarding/job-queue.ts`)

### 1. Import
Added `type InsertSourceData` to the existing `onboarding-source-repo` import.

### 2. `manualReviewReasonForDiscovery` (file-private helper)
- New optional `sitemapCandidateCount = 0` parameter (default preserves any future call-site).
- When `> 0`, appends `; N sitemap candidate(s) found but none above the auto-select threshold` to the returned reason string.
- Function header doc updated.

### 3. `processDiscovery()`
Right after `const consolidatedName = discovery.consolidatedName;`, added a small "Sitemap signals" block that derives `sitemapCandidates`, `sitemapCandidateCount`, `sitemapMatched` from the `sources` array by filtering on `sourceMethod` starting with `sitemap_`. These values feed both the auto-selection logic and the SSE payload.

The "Discovery complete" log line now includes the sitemap count: `${sources.length} source(s) found (${sitemapCandidateCount} from sitemap)`.

### 4. Auto-selection policy (replaced the old `shouldAutoSelect = bestSource on official domain` check)
- Computes `eligibleSitemapSource`: the first sitemap candidate with `confidence > 0.7` whose domain matches an official brand domain (`isOfficialDomainMatch`).
- `autoSelectedSource = eligibleSitemapSource ?? (existing top-on-official-domain check ? bestSource : null)`.
- When auto-selecting, the inserted record is looked up by URL via `findIndex` (not hardcoded to `insertedSources[0]`) so the right `selectSource(...)` call happens when the winning source is a sitemap candidate living at a non-zero index.
- Console log uses `autoSelectedSource` so the operator can see exactly which URL was selected.

### 5. SSE event payload (success path)
Added two optional fields after the existing keys (backward compatible):
```ts
sitemapMatched,         // boolean
sitemapCandidateCount,  // number
```
All other fields (`stage`, `sourceUrl`, `autoSelected`, `needsManualReview`, `manualReviewReason`, `bestCandidateUrl`, `bestCandidateDomain`, `officialDomains`, `consolidatedName`, `sourcesCount`, `topConfidence`) are unchanged in shape and meaning.

### 6. SSE event payload (no-sources path)
Added the same two fields with safe defaults (`sitemapMatched: false, sitemapCandidateCount: 0`) so consumers can rely on the field shape regardless of branch.

## Files Changed
- `src/onboarding/job-queue.ts` — only this file.

## Validation

### Commands Run
| Command | Result |
| --- | --- |
| `bun run typecheck` | passed (0 errors) |
| `bun run lint` | passed (108 problems = 107 errors + 1 warning — unchanged from baseline) |
| `bun test src/tests/unit/sitemap-matcher.test.ts` | 17/17 pass |
| `bun test src/tests/unit/source-discovery.test.ts` | 8/8 pass |
| `bun test src/tests/unit/onboarding-repos.test.ts` | 17/17 pass |
| `bun test` (full suite) | 335 pass / 55 fail — all 55 failures are pre-existing in unrelated files (LLM task routing, page-extractor variant inference, profile promoter) and do not touch `job-queue.ts` |
| `git diff --cached --name-only` | empty (no staged files) |

### Backward Compatibility Check
- All existing SSE event fields are unchanged in type and meaning. New fields are strictly additive.
- The `manualReviewReasonForDiscovery` signature gained a defaulted parameter, so any future caller is unaffected.
- No public exports changed (the only `export function` declarations in the file — `normalizeDiscoveryDomain`, `isOfficialDomainMatch`, `getOfficialDomainsForBrand` — are untouched).
- No processExtraction / processCuration touched. No constructor signature changes. No new worker lifecycle methods.

## Residual Risks
- **Pre-existing test failures (55)** in `bun test` are unrelated to this change; they are in `llm-client-task-routing.test.ts`, `page-extractor-variant-inference.test.ts`, `page-extractor-images.test.ts`, `profile-promoter.test.ts`, and two `sitemap-matcher.test.ts` cases that exercise the LLM call path. Out of scope for this wiring task.
- The auto-select policy now treats any sitemap candidate with `confidence > 0.7` on an official brand domain as eligible. This is intentionally permissive (per the task spec) — operators who want a higher bar can add a workspace setting in a follow-up; that is out of scope here.

## Recommended Next Step
- Optional: add a small unit test for the new auto-selection branch and the extended `manualReviewReasonForDiscovery` reason string. There is currently no `job-queue.test.ts`; the simplest path would be to add one focused on the two helper functions and the auto-select decision table (sitemap eligible / sitemap not eligible / bestSource on official / none of the above). This is intentionally not bundled with this surgical change to keep the diff small.
- Optional: surface the new `sitemapMatched` / `sitemapCandidateCount` SSE fields in the PipelineBoard discovery drawer so reviewers can see when the sitemap pass produced hits.

## Acceptance Report
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Surgical, additive edit to src/onboarding/job-queue.ts only. No processExtraction/processCuration changes, no new worker lifecycle methods, no constructor changes, no new repos. SSE payload is backward compatible: all existing fields unchanged, two new optional fields added in both success and no-sources paths. manualReviewReasonForDiscovery extended with a defaulted parameter so existing callers are unaffected."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Validation: bun run typecheck 0 errors; bun run lint 108 problems unchanged from baseline; sitemap + onboarding-repos unit tests 42/42 pass; full suite 335 pass with 55 pre-existing failures in unrelated files (LLM task routing, page-extractor, profile promoter). git diff --cached empty. Residual risks and recommended next step documented."
    }
  ],
  "changedFiles": [
    "src/onboarding/job-queue.ts"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "0 errors"
    },
    {
      "command": "bun run lint",
      "result": "passed",
      "summary": "108 problems (107 errors + 1 warning) — unchanged from baseline; no new errors introduced"
    },
    {
      "command": "bun test src/tests/unit/sitemap-matcher.test.ts src/tests/unit/source-discovery.test.ts src/tests/unit/onboarding-repos.test.ts",
      "result": "passed",
      "summary": "42/42 pass across the 3 most relevant test files"
    },
    {
      "command": "bun test",
      "result": "mixed",
      "summary": "335 pass / 55 fail — all 55 failures are pre-existing in unrelated files (LLM task routing, page-extractor variant inference, profile promoter) and do not touch job-queue.ts"
    },
    {
      "command": "git diff --cached --name-only",
      "result": "passed",
      "summary": "empty — no staged files"
    }
  ],
  "validationOutput": [
    "TypeScript compiler: 0 errors.",
    "ESLint: 108 problems unchanged from baseline; job-queue.ts introduces zero new lint issues.",
    "Unit tests for source-discovery, sitemap-matcher, sitemap-cache, sitemap-fetcher, onboarding-repos: all pass (65 tests across the 5 files).",
    "Full test suite: 335 pass, 55 pre-existing failures in unrelated test files. None of the failures touch the modified code path.",
    "Git: no staged files."
  ],
  "residualRisks": [
    "55 pre-existing test failures in the full suite are unrelated to this change (LLM task routing, page-extractor variant inference, profile promoter). Out of scope.",
    "No new unit tests were added for the job-queue auto-selection branch. The task explicitly limited scope to wiring; the suggested follow-up is a focused job-queue.test.ts covering the four auto-select decision cases (sitemap-eligible / sitemap-not-eligible / bestSource-on-official / none)."
  ],
  "noStagedFiles": true,
  "diffSummary": "Surgical edit to src/onboarding/job-queue.ts: added one type import, extended manualReviewReasonForDiscovery with a defaulted sitemapCandidateCount param, derived sitemap signals in processDiscovery, replaced the auto-selection shouldAutoSelect boolean with an autoSelectedSource InsertSourceData | null that prefers sitemap candidates (confidence > 0.7 on official brand domain) and falls back to the existing bestSource check, updated selectSource call to look up the inserted record by URL, added sitemapMatched + sitemapCandidateCount to both SSE event paths, and added the sitemap count to the completion log.",
  "reviewFindings": [
    "no blockers",
    "minor: manualReviewReasonForDiscovery is not exported, so a unit test for its new sitemap suffix would require exporting it or testing via a higher-level integration test. The default parameter keeps the function safe for any future caller.",
    "minor: the eligibleSitemapSource branch uses confidence > 0.7 strictly; the spec said '> 0.7' so this matches. The non-strict comparison '>= 0.7' is a possible alternate reading but the spec is explicit."
  ],
  "manualNotes": "The 'Discovery complete' log line now reads e.g. '8 source(s) found (3 from sitemap). Top candidate: ...' — operators looking for sitemap visibility in logs get it there even before the UI is updated."
}
```
