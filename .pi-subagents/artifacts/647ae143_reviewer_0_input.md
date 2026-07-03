# Task for reviewer

Review all code changes from this session's commits.

## Commits to review

Recent commits on main:
- `5dfb312` — redesign: make visual selection the primary profile builder experience
- `1aeafcd` — fix: prevent ProfileProposalDrawer and ProfileBuilderWorkspace from rendering simultaneously
- `4520941` — fix: fail extraction with 'profile required' when no domain profile exists (job-queue.ts)
- `07e1efb` — fix: remove broken modal wrapper around ProfileBuilderWorkspace in Settings
- `ab9c495` — feat: add resetItemsToStage API
- `04c98c9` — chore: suppress remaining fallow false positives
- `6431ca5`, `44fd140`, `4842e38` — fallow cleanups

## Key files changed

### src/client/components/ProfileBuilderWorkspace.tsx (major redesign)
The entire profile builder was redesigned:
- TabId type changed from `'overview' | 'snapshot' | 'review'` to `'build' | 'review' | 'advanced'`
- Default tab changed from `'overview'` to `'build'`
- The old `renderSnapshot` function was replaced with `renderBuild` — a new hero-driven layout with:
  - Purple CTA section with URL input + "Load Page" button
  - 3 visual select cards in a grid (Title, Description, Images) with ElementPickerButton
  - Progress indicator showing selection status
  - Technical details collapsed in a `<details>` element (JSON-LD, images, signals)
- The old `renderOverview` renamed to `renderAdvanced` — "Quick Actions" section replaced with "Get Started" redirect + deprecated AI proposal tucked in a collapsed `<details>`
- All string references to old tab names updated

### src/onboarding/job-queue.ts (profile-required fail-fast fix)
- Added `import { findProfileByDomain }` from extractor-profile-repo
- In `processExtraction()`, before running extraction: derive domain from sourceUrl, look up extractor profile, fail with `"No extractor profile for {domain} — profile required"` if none exists
- This makes the PipelineBoard's `deriveProfileFailReason` function trigger, which renders the "⚠ Profile required" badge and "Open Profile Builder →" link

### src/client/components/OnboardingSettings.tsx (overlay fixes)
- ProfileBuilderWorkspace wrapper: removed nested fixed-position scrollable div, now renders ProfileBuilderWorkspace directly (same pattern as Onboarding.tsx)
- Mutual exclusion: clicking "Open Profile Builder" clears drawerState first; opening a proposal drawer clears workspaceDomain; both guards added to all three overlay triggers (drawer, workspace, retry preview)
- Fixed arrow function syntax error in `onReviewProposal` prop

### src/db/repositories/onboarding-item-repo.ts (new function)
- Added `resetItemsToStage(itemIds, targetStage)` — resets items to a specific pipeline stage with `stage_status = 'completed'`, preserving all existing extraction/curation data

### src/server/routes/onboarding-routes.ts (new route)
- Added `POST /api/onboarding/items/reset-to-stage` route with validation for targetStage

### src/client/onboarding-api.ts (new API function)
- Added `resetItemsToStage(itemIds, targetStage)` client function

## What to review

1. **ProfileBuilderWorkspace redesign** — Does the new JSX compile correctly? Are all state variables properly referenced? Are the imports correct? Does the tab switching work? Is the `pickedSelectors` state properly managed?

2. **job-queue.ts profile check** — Is `findProfileByDomain` imported from the right path? Does the error message format match what `deriveProfileFailReason` checks for? Is the domain extraction from URL correct? Is the early return properly structured?

3. **OnboardingSettings overlay fixes** — Are the three overlays now mutually exclusive? Are there any remaining cases where both could render? Is the function syntax correct?

4. **resetItemsToStage** — Does the SQL update query look correct? Does the route validation properly check targetStage? Are the types correct?

Focus on:
- TypeScript correctness
- Logic errors or edge cases
- Consistency with existing patterns
- Whether the profile-required badge will actually render when extraction fails with the new error message

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

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