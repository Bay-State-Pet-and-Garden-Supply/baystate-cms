# Implementation Plan

## Goal
Change discovery so the worker only auto-selects source URLs from mapped official brand domains, while still saving open-web candidates for manual review.

## Tasks
1. **Add official-domain matching helpers**: Add small helper functions near the top of `job-queue.ts` after `AUTO_STAGES`.
   - File: `src/onboarding/job-queue.ts`
   - Changes:
     - Import `findBrandSites` from `../db/repositories/brand-site-repo`.
     - Add `normalizeDiscoveryDomain(domain: string | null | undefined): string` that lowercases, trims, and strips leading `www.`.
     - Add exported helper `isOfficialDomainMatch(candidateDomain: string | null | undefined, officialDomain: string | null | undefined): boolean` returning true only when normalized domains are equal or `candidate.endsWith('.' + official)`.
     - Add `getOfficialDomainsForBrand(brandHint: string | null | undefined): string[]` that returns `[]` for blank brand hints and otherwise calls `findBrandSites(brandHint)` and normalizes non-empty domains.
     - Add `manualReviewReasonForDiscovery(item, bestSource, officialDomains): string` with reason strings starting with `needs_review:`:
       - no brand hint: `needs_review: no brand assigned for official-domain auto-selection`
       - no mapped domains: `needs_review: no official domain mapped for brand "<brand>"`
       - domain mismatch: `needs_review: top candidate domain "<domain>" does not match official domain(s): <domains>`
   - Acceptance: `notmywoof.com` does not match `mywoof.com`, while `mywoof.com` and `us.mywoof.com` do.

2. **Replace confidence-based auto-selection with official-domain policy**: Remove the `bestSource.confidence >= 0.95 || bestSource.confidence > 0.6` auto-select condition from `processDiscovery`.
   - File: `src/onboarding/job-queue.ts`
   - Changes:
     - Change the result summary log from saying `Auto-selected:` before the decision to saying `Top candidate:`.
     - Capture inserted sources: `const insertedSources = insertSources(item.id, sources);`.
     - Compute:
       - `const officialDomains = getOfficialDomainsForBrand(item.brandHint);`
       - `const shouldAutoSelect = officialDomains.some(domain => isOfficialDomainMatch(bestSource.domain, domain));`
     - If `shouldAutoSelect` is true:
       - Keep existing behavior by calling `setDiscoverySourceUrl(item.id, bestSource.url)`.
       - Mark the inserted top source selected. Prefer importing and using `selectSource(insertedSources[0].id)` from `onboarding-source-repo` instead of raw SQL; it preserves behavior and avoids relying on a second DB lookup.
       - Log: `✓ Auto-selected official source for "<name>" (<upc>): <url> (domain <candidate> matches <officialDomains>)`.
     - If `shouldAutoSelect` is false:
       - Do **not** call `setDiscoverySourceUrl`.
       - Do **not** mark any source row selected.
       - Call `updateItemStageStatus(item.id, 'completed', manualReviewReason)`.
       - Log: `⚠ Discovery needs manual review for "<name>" (<upc>): <manualReviewReason>. Top candidate: <url>`.
   - Acceptance: Products with no brand hint, no mapped domain, or a top result outside the mapped official domain complete discovery with candidates saved but `source_url` remaining `NULL`.

3. **Update the discovery SSE payload**: Make event data accurately reflect whether a URL was selected.
   - File: `src/onboarding/job-queue.ts`
   - Changes:
     - In the `sources.length > 0` event payload, replace unconditional `sourceUrl: bestSource.url` with `sourceUrl: shouldAutoSelect ? bestSource.url : null`.
     - Add:
       - `autoSelected: shouldAutoSelect`
       - `needsManualReview: !shouldAutoSelect`
       - `manualReviewReason: shouldAutoSelect ? null : manualReviewReason`
       - `bestCandidateUrl: bestSource.url`
       - `bestCandidateDomain: bestSource.domain ?? null`
       - `officialDomains`
     - Keep existing `consolidatedName`, `sourcesCount`, and `topConfidence` fields.
   - Acceptance: Frontend/SSE consumers can distinguish an official-domain auto-selection from a completed discovery that still needs operator selection.

4. **Keep no-source behavior unchanged except payload consistency**: Do not change behavior when discovery finds zero sources.
   - File: `src/onboarding/job-queue.ts`
   - Changes:
     - Leave `updateItemStageStatus(item.id, 'completed', 'No matching product pages found')` as-is.
     - Optionally add `needsManualReview: true` and `manualReviewReason: 'No sources found'` to this SSE payload for consistency, without changing DB behavior.
   - Acceptance: Zero-source items still complete discovery and show the existing warning.

5. **Add targeted unit coverage for domain matching and worker decision branches**: Create focused tests for the policy without changing discovery/search behavior.
   - File: `src/tests/unit/job-queue-discovery-auto-select.test.ts`
   - Changes:
     - Use Vitest `vi.mock` to mock:
       - `../../onboarding/source-discovery` (`discoverSources`)
       - `../../db/repositories/brand-site-repo` (`findBrandSites`)
       - `../../db/repositories/onboarding-item-repo` (`updateItemStageStatus`, `setDiscoverySourceUrl`, `incrementRetryCount`, `updateItemExpectedName`, `getPendingItemsByStage`)
       - `../../db/repositories/onboarding-source-repo` (`insertSources`, `deleteSourcesByItem`, `selectSource`)
       - `../../onboarding/sse-emitter` (`onboardingEvents.emitItemStatus`)
     - Import `OnboardingWorker` and `isOfficialDomainMatch` after mocks are installed.
     - Test `isOfficialDomainMatch` exact/suffix/non-match cases:
       - `mywoof.com` vs `mywoof.com` => true
       - `us.mywoof.com` vs `mywoof.com` => true
       - `www.mywoof.com` vs `mywoof.com` => true
       - `notmywoof.com` vs `mywoof.com` => false
     - Test auto-select path by calling `(worker as any).processDiscovery(item)` with:
       - `item.brandHint = 'Woof'`
       - `findBrandSites` returning `{ domain: 'mywoof.com' }`
       - top candidate domain `us.mywoof.com`
       - assert `setDiscoverySourceUrl(item.id, bestUrl)` and `selectSource(insertedTopSource.id)` were called, and SSE has `autoSelected: true`, `needsManualReview: false`.
     - Test no-brand manual-review path with `brandHint = null`:
       - assert sources are inserted, `setDiscoverySourceUrl` and `selectSource` are not called, `updateItemStageStatus(item.id, 'completed', expect.stringContaining('needs_review'))` is called, and SSE has `needsManualReview: true`, `sourceUrl: null`.
     - Test mapped-brand wrong-domain path:
       - brand maps to `mywoof.com`, top candidate domain is `retailer.com`
       - assert no auto-selection, warning mentions both `retailer.com` and `mywoof.com`.
   - Acceptance: Tests fail under the current confidence-based implementation and pass after Tasks 1-3.

6. **Run validation**: Validate the narrow worker change.
   - File: project root
   - Changes: No code changes.
   - Acceptance:
     - `bun run test -- src/tests/unit/job-queue-discovery-auto-select.test.ts` passes.
     - `bun run typecheck` passes.
     - Optional full suite `bun run test` passes if time allows.

## Files to Modify
- `src/onboarding/job-queue.ts` - replace confidence-based auto-selection with official-domain-only policy, add exact/suffix domain helpers, update logs and SSE payload.

## New Files
- `src/tests/unit/job-queue-discovery-auto-select.test.ts` - focused unit tests for official-domain matching and discovery auto-selection/manual-review branches.

## Dependencies
- Task 2 depends on Task 1 helper functions.
- Task 3 depends on Task 2 because the SSE payload needs the `shouldAutoSelect`, `officialDomains`, and `manualReviewReason` values.
- Task 5 depends on Tasks 1-3 to test the final behavior.
- Task 6 depends on all implementation and test changes.

## Risks
- `updateItemStageStatus(..., 'completed', 'needs_review: ...')` stores a warning in `error_message`; existing UI may render `errorMessage` in red even though the stage completed. This matches the requested lightweight warning approach but may need a later UI refinement.
- Completed discovery items without `sourceUrl` can still be advanced to extraction by existing bulk controls, where extraction will fail with `No confirmed source URL`. Preventing advancement would require a separate UI/stage-policy change and is intentionally out of scope.
- Wrong brand-domain mappings become trusted; exact/suffix matching avoids broad domain false positives but cannot detect incorrect operator-entered domains.
- This plan intentionally does not change `source-discovery.ts`; open-web candidates are still collected for manual review.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Created a narrow implementation plan limited to the onboarding worker auto-selection policy, with exact file-level changes and tests. No source code implementation was performed by this planning subagent."
    }
  ],
  "changedFiles": [
    "/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/fafe0a31/plan.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read requested code context from src/onboarding/job-queue.ts, src/db/repositories/brand-site-repo.ts, src/db/repositories/onboarding-item-repo.ts, and src/db/repositories/onboarding-source-repo.ts.",
    "The requested context file /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/fafe0a31/context.md was missing (ENOENT); plan was based on the task details and live code reads."
  ],
  "residualRisks": [
    "Existing UI may display completed-stage manual-review warnings as red error text because the warning is stored in error_message.",
    "Existing advancement controls may allow completed discovery items with no sourceUrl to move to extraction, where they will fail until manually selected."
  ],
  "noStagedFiles": true,
  "diffSummary": "Planning artifact only; no project source files changed by this subagent.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "This is a planning-only result per subagent role. Implementation should modify only job-queue.ts plus a focused new unit test file unless the parent explicitly widens scope."
}
```