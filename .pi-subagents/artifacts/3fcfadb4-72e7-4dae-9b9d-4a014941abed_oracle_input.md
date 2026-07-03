# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Review the proposed refactor for domain extractor profiles in the ShopSite CMS project.

## Current State (Problem)

The project has an `extractor_profiles` SQLite table that maps domain → CSS selectors (titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector, sitemapProductUrlPattern). These are used as Layer 0 in the page extractor — when extracting product data from a URL, if a profile exists for that domain, the custom selectors are applied first before falling back to JSON-LD, meta tags, microdata, and HTML heuristics.

There's also a separate AI-generated profile system (`profile_generations` table) that auto-proposes selectors during extraction and requires human approval per-field before promotion to active profiles.

### Specific Problems Found:

1. **Manual profile creation UI is dead code.** The `Onboarding.tsx` component has `handleSaveSelectorProfile()`, `handleTestSelectors()`, `loadSelectorProfileForUrl()`, and all 5 selector state variables — but the JSX rendering was removed when the review drawer was refactored into `PipelineBoard.tsx`. PipelineBoard has zero profile code. There's no way for users to create/edit manual profiles.

2. **Wrong conceptual location.** Even when it existed, the selector profile editor lived in the item review drawer. But profiles are domain-level configuration, not per-item.

3. **Three disconnected profile surfaces:**
   - Settings → Custom Extractor Profiles: view/delete table only, no create/edit
   - Settings → Generated Profile Governance: AI proposals only
   - Onboarding.tsx: dead code, orphaned handlers

4. **API gap.** `POST /api/onboarding/settings/extractor-profiles` doesn't accept `sitemapProductUrlPattern`, and there's no `PUT` for explicit updates.

### Proposed Refactor:

1. **Add full CRUD to Settings → Custom Extractor Profiles:**
   - "+ New Profile" button → inline form with domain, 5 selectors, sitemap pattern
   - "Test Selectors" with a sample product URL (reuses existing `POST /api/onboarding/extractor-profiles/test`)
   - Edit button on existing rows → inline editing
   - Delete button (already exists)

2. **Add `sitemapProductUrlPattern` to the API** POST body

3. **Remove dead code from Onboarding.tsx:** All selector state, `handleTestSelectors`, `handleSaveSelectorProfile`, `loadSelectorProfileForUrl`, and unused imports (`saveExtractorProfile`, `testExtractorProfile`)

4. **Keep Generated Profile Governance as-is** — it handles AI proposals

### Key files involved:
- `src/client/components/OnboardingSettings.tsx` — add create/edit UI
- `src/client/components/Onboarding.tsx` — remove dead code  
- `src/client/onboarding-api.ts` — possibly update `saveExtractorProfile`
- `src/server/routes/onboarding-routes.ts` — add sitemapProductUrlPattern to POST

Challenge my assumptions. Are there better patterns? Should manual profiles and generated profiles be unified somehow? Is the Settings page the right home?

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```