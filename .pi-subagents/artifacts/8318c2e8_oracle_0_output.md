The diff is clean and targeted. Let me now provide the final oracle recommendation with the acceptance report.

## Oracle Recommendation

### Inherited decisions

1. **Layered extraction by design**: `page-extractor.ts` uses Custom CSS selectors → JSON-LD → meta tags → microdata → HTML heuristics. Profiles enhance but don't gate extraction.
2. **Trusted Profile Runner** (`extraction-worker/routes/extract.ts`): Requires a profile, NEVER falls back — but this is a separate route NOT used by the job queue.
3. **Badge depends on error message parsing**: `deriveProfileFailReason` in PipelineBoard checks `item.errorMessage` for "no profile" or "profile required" — but the main extraction path never produces this error.
4. **ProfileBuilderWorkspace IS wired in OnboardingSettings**: Line 1158 has an "Open Profile Builder" button in the Profiles tab → Domain Configuration table → Actions column. Line 1273 renders the workspace overlay. The visual picker IS reachable from Settings.
5. **The job queue has no profile awareness**: `processExtraction` calls `extractProductData` with no pre-check for profiles.

### Diagnosis

**Issue 1 — Badge never shows in PipelineBoard**: The extraction pipeline never fails with "profile required" because `page-extractor.ts` treats missing profiles as OK and falls through to generic strategies (JSON-LD, meta tags, etc.). The `deriveProfileFailReason` function can never return `'no_profile'` because the error message is never set. The badge and "Open Profile Builder →" link are dead code.

**Issue 2 — Visual picker seems absent**: It's actually present at OnboardingSettings → Profiles tab → Domain Configuration table → Actions column → "Open Profile Builder" button. But it's not discoverable from the PipelineBoard because the badge that would link to it never renders.

### Drift / contradiction check

The design intent (badge → link → profile builder) was never connected to the extraction pipeline. The `deriveProfileFailReason` function was written to detect a "no profile" error, but the code that would produce that error was never implemented. This is an incomplete integration, not a design contradiction.

### Recommendation

**Implemented: Add a profile-required fail-fast check in the job queue's `processExtraction` method.**

When an item enters extraction:
1. Derive the domain from the source URL
2. Look up the extractor profile via `findProfileByDomain(domain)`
3. If no profile exists → fail the item with `"No extractor profile for {domain} — profile required"`
4. This error message triggers `deriveProfileFailReason` → returns `'no_profile'` → badge renders → "Open Profile Builder →" link appears

This is the narrowest fix (15 lines in `job-queue.ts`) that makes the entire designed flow work end-to-end. The `ProfileBuilderWorkspace` was already wired in OnboardingSettings — the missing piece was the PipelineBoard entry point, which required the badge to render, which required the error message to be produced.

### Risks

1. **Breaking extraction for profile-less domains**: Domains that previously extracted fine via JSON-LD/meta tags will now fail until a profile is built. This is intentional — the user expects profiles to be required, not optional. The visual picker makes profile-building fast.
2. **The `findProfileByDomain` call adds a DB lookup per extraction item**: Negligible — it's a simple indexed query.
3. **Items already in extraction/completed won't be affected**: Only items entering extraction freshly (pending → in_progress) will hit the check. Existing completed items are unaffected.

### Need from main agent

None. The fix is implemented and verified.