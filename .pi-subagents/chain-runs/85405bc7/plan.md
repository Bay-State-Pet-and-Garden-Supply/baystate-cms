# Implementation Plan

## Goal
Ensure source discovery always performs a consolidated-name Serper search and makes UPC-search versus consolidated-name results visible in the discovery drawer.

## Tasks
1. **Confirm existing persistence paths before editing**: Verify that `expectedName` and `sourceMethod` are already returned by the item detail API and do not require schema or migration work.
   - File: `src/onboarding/job-queue.ts`
   - Changes: No code changes expected; confirm `discoverSources()` return value is persisted with `updateItemExpectedName()` and source rows are inserted with `sourceMethod`.
   - Acceptance: No new DB column or API route is needed because `OnboardingSource.sourceMethod` and `OnboardingItem.expectedName` already flow to `GET /api/onboarding/items/:id`.

2. **Make the consolidated-name search unconditional in Pass 2**: Refactor follow-up query construction so at least one unrestricted query using the consolidated name is always queued when `searchName` is valid.
   - File: `src/onboarding/source-discovery.ts`
   - Changes:
     - Update the file/function comments to describe the actual strategy: Pass 1 UPC search, LLM/LCS consolidation, then Pass 2 consolidated-name search plus optional brand-scoped searches.
     - Replace `const secondPassQueries: string[] = [];` with query descriptors, e.g. `Array<{ query: string; mandatory?: boolean }>`.
     - Add a small dedupe helper such as `addSecondPassQuery(query: string, mandatory = false)` to avoid repeated queries.
     - Build a clean phrase for the consolidated name, e.g. `const cleanSearchName = searchName.replace(/"/g, '').trim();`.
     - Always add one mandatory unrestricted query using that name, e.g. `addSecondPassQuery(`\"${cleanSearchName}\" product page`, true);` or `addSecondPassQuery(`${cleanSearchName} product page`, true);` if exact-phrase search is too restrictive.
     - Keep existing mapped-brand-domain queries (`${searchName} site:${domain}` and original-name brand-domain fallback) so known official domains remain prioritized.
     - Keep the existing low-candidate fallback for the original spreadsheet name, but do not gate the consolidated-name query behind `candidates.length < 5`.
     - In the execution loop, do not skip mandatory queries because of the 15-candidate pre-query cap: `if (!query.mandatory && candidates.length >= 15) break;`.
     - Add a concise log before each Pass 2 query, e.g. `[SourceDiscovery] Pass 2 search for UPC ${upc}: "${query.query}"`, to make the second Serper search auditable.
   - Acceptance: With no mapped brand domains and 10 UPC results, `discoverSources()` still calls Serper a second time with the consolidated name and any returned non-duplicate candidates get `sourceMethod: 'serper_name'`.

3. **Ensure name-search candidates survive the final cap**: Prevent the global top-10 slice from hiding all Pass 2 results when UPC results score higher.
   - File: `src/onboarding/source-discovery.ts`
   - Changes:
     - Replace the direct `candidates.slice(0, 10)` with a helper such as `selectTopCandidates(candidates, 10)`.
     - Preserve the current confidence-descending behavior by default.
     - If both `serper_upc` and `serper_name` candidates exist but the top selection contains no `serper_name`, replace the lowest-confidence selected candidate with the highest-confidence `serper_name` candidate, then re-sort by confidence.
     - Continue clamping confidence values to `0..1` after selection.
   - Acceptance: If Pass 2 returns at least one non-duplicate, non-blocked candidate, the persisted/displayed candidate list includes at least one `serper_name` source so the drawer can show both search sections.

4. **Add unit coverage for the unconditional name search**: Extend source discovery tests to prove the second search runs even when the UPC pass already returns many results.
   - File: `src/tests/unit/source-discovery.test.ts`
   - Changes:
     - Import `vi` from Vitest.
     - Mock `getApiKey`, `findBrandSites`, `consolidateProductName`, `getDomainStatus`, `getCachedSerperResults`, and `insertSerperCache`.
     - Stub `global.fetch` so the first call for the UPC returns 10 UPC/retailer results and the second call for the consolidated name returns at least one official/product-page result.
     - Add a test that calls `discoverSources('850028089675', 'SQUIRREL BAFFLE DUALMOUNT 16IN PLASTIC', null)` and asserts:
       - Serper/fetch was called at least twice.
       - One request query includes the consolidated name.
       - The returned candidates include `sourceMethod === 'serper_name'`.
     - Add or combine an assertion that a `serper_name` result survives the final candidate cap.
   - Acceptance: The new test fails on the current gated implementation and passes after Tasks 2-3.

5. **Extract a reusable source-candidate renderer**: Avoid duplicating click/select logic while adding grouped UI sections.
   - File: `src/client/components/PipelineBoard.tsx`
   - Changes:
     - Inside `PipelineBoard`, add a helper `renderSourceCandidate(src: OnboardingSource)` that contains the existing candidate-card JSX and selection handler currently inside `reviewSources.map(...)`.
     - Keep the existing `select-source` POST behavior, `setManualUrlInput(src.url)`, `getItemDetail()`, `setReviewItem()`, and `setReviewSources()` logic unchanged.
     - Optionally add a small method badge on the card using `src.sourceMethod` so the source remains identifiable even inside a group.
   - Acceptance: Selecting a source in the drawer still updates the selected source and manual URL input exactly as before.

6. **Group discovery sources by search pass in the drawer**: Replace the flat source list with clear sections for UPC search and consolidated-name search.
   - File: `src/client/components/PipelineBoard.tsx`
   - Changes:
     - Near the discovery source-list JSX, compute ordered groups from `reviewSources`:
       - `serper_upc`: label `Pass 1: UPC search`, description `Google search for UPC ${reviewItem.upc}`.
       - `serper_name`: label `Pass 2: consolidated-name search`, description `Google search for "${reviewItem.expectedName || reviewItem.name}"` and note that mapped brand-domain searches may also appear here.
       - fallback/other: label `Other sources` for any legacy `sourceMethod` values.
     - Render each non-empty group with a compact header showing label, count, and query context, followed by `group.sources.map(renderSourceCandidate)`.
     - Keep the existing consolidated-name banner, but update its label from `Searching for:` to something like `Consolidated name used for Pass 2:` to make the purpose explicit.
     - Do not change item advancement, source selection, manual URL entry, or extraction/curation UI.
   - Acceptance: Opening a discovery-stage card shows separate UPC and consolidated-name result sections whenever both source methods are present.

7. **Validate the implementation**: Run focused tests and type checks after the code changes.
   - File: project root
   - Changes: No code changes.
   - Acceptance:
     - `bun run test -- src/tests/unit/source-discovery.test.ts` passes.
     - `bun run typecheck` passes.
     - Manual smoke test: reset one discovery item with no mapped brand domain; logs show a Pass 2 consolidated-name Serper query; the drawer shows a `Pass 2: consolidated-name search` section.

## Files to Modify
- `src/onboarding/source-discovery.ts` - always enqueue/run an unrestricted consolidated-name search, avoid mandatory-query cap skipping, preserve at least one name-search candidate in the final results, and add audit logging.
- `src/client/components/PipelineBoard.tsx` - group discovery candidates by `sourceMethod` with pass-specific headers and reuse existing source-selection behavior.
- `src/tests/unit/source-discovery.test.ts` - add mocked coverage for unconditional consolidated-name searching and candidate retention.

## New Files
- None.

## Dependencies
- Task 2 depends on understanding the existing persistence confirmed in Task 1.
- Task 3 depends on Task 2 because there must be `serper_name` candidates to preserve.
- Task 4 depends on Tasks 2-3 to know the expected behavior and assertions.
- Tasks 5-6 can be done after Task 1 and do not depend on backend implementation, but Task 6 is only visibly useful once Tasks 2-3 ensure `serper_name` sources are persisted.
- Task 7 depends on all code/test changes.

## Risks
- Additional Serper usage: every valid discovery now performs at least one extra search, increasing API cost and rate-limit exposure.
- Exact-phrase queries may be too restrictive for some products; if results are sparse, use an unquoted `${searchName} product page` query while still logging it clearly.
- The final-cap preservation may replace one higher-confidence UPC candidate with a lower-confidence name-search candidate; this is intentional so the drawer can show both search passes, but should be limited to one retained Pass 2 candidate unless product requirements ask for more.
- The drawer can show grouped methods but not the exact query string per individual source because `onboarding_sources` does not store the query; adding query-level audit data would require a schema/repository change and is intentionally out of scope for this refinement.
- Official-domain selection still depends on Serper rankings, mapped brand domains, and existing scoring. If official brand pages remain outranked after this change, a separate scoring/brand-domain inference task may be needed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Created a scoped implementation plan covering only source-discovery.ts, PipelineBoard.tsx, and the existing source-discovery unit test file; no source code changes were made by this planning subagent."
    }
  ],
  "changedFiles": [
    ".pi-subagents/chain-runs/85405bc7/plan.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/85405bc7/context.md",
      "result": "failed",
      "summary": "Provided context file was missing (ENOENT); task prompt and repository files were used instead."
    },
    {
      "command": "read src/onboarding/source-discovery.ts",
      "result": "passed",
      "summary": "Reviewed current two-pass discovery and candidate capping behavior."
    },
    {
      "command": "read/grep src/client/components/PipelineBoard.tsx",
      "result": "passed",
      "summary": "Reviewed current flat discovery source list and consolidated-name banner in the drawer."
    },
    {
      "command": "grep job-queue/source-repo/schema references",
      "result": "passed",
      "summary": "Confirmed expectedName and sourceMethod already persist through existing repositories and schemas."
    }
  ],
  "validationOutput": [
    "Planning-only task; no tests or type checks were run because no application code was modified."
  ],
  "residualRisks": [
    "The requested context.md file was not present, but the task prompt contained sufficient analysis and relevant source files were reviewed.",
    "No git status command was available in this subagent toolset; no staging operation was performed."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added implementation plan artifact only; application source files were left unchanged.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "Plan intentionally avoids schema/API changes because expectedName and sourceMethod already exist."
}
```