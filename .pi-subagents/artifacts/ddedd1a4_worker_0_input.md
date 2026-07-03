# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
# Profile Proposal Drawer Implementation

## Goal
Replace the current inline AI Proposal section in the domain accordion with a slide-out drawer that gives the operator enough space to see image thumbnails, detailed extraction results, and approve/reject per field.

## Current State
In `src/client/components/OnboardingSettings.tsx`:
- The `DomainDetailPanel` component has an inline "🤖 AI Proposal" section with:
  - A table of Current Selector vs Proposed Selector
  - Inline Approve/Reject buttons
  - A "Preview Proposal" button next to "Test Selectors"
  - Side-by-side text comparison

## What needs to change

### 1. Simplify the inline proposal section in DomainDetailPanel
Replace the verbose inline table with a compact summary:
- Show only: proposal status badge, source URL, confidence
- Two buttons: **"🤖 Generate Profile"** (already exists) and **"Review Proposal →"** (new, only when a proposal exists)
- Remove: the selector comparison table, inline Approve/Reject, Preview Proposal button, side-by-side comparison
- The "Review Proposal →" button opens the drawer

### 2. Fix the test/profile preview to show images
The `testExtractorProfile` API endpoint (`POST /api/onboarding/extractor-profiles/test`) currently uses Playwright and returns extracted text values. We need it to also return image URLs. 

Check `src/server/routes/onboarding-routes.ts` at the `POST /api/onboarding/extractor-profiles/test` route. Currently it evaluates selectors and returns text. For `imagesSelector`, it should return the actual image URLs (src attributes). Update the route so that when `imagesSelector` is provided, the response includes resolved image URLs.

### 3. Create the ProfileProposalDrawer component
Create a new file `src/client/components/ProfileProposalDrawer.tsx` that:
- Slides in from the right side of the screen (full-height, ~600px wide)
- Receives: `domain`, `proposal` (ProfileGenerationGeneration), `activeProfile` (ExtractorProfile | null), `onClose`, `onChange` (callback for when fields are approved/rejected)

Inside the drawer:
- Header: domain name + close button
- **Section: Proposal Summary** — proposed selectors displayed read-only (like the current inline table)
- **Section: Preview against URL**
  - URL input + "Preview" button
  - Runs `testExtractorProfile` TWICE: once for active profile, once for proposal selectors
  - Shows side-by-side results:
    - Text fields: extracted value directly
    - Images: a scrollable row of `<img>` thumbnails (max-height 120px, with src fallback handling)
  - Persists each run visually in a "Validation runs" list below
- **Section: Per-field approval**
  - For each of the 5 selector fields, a row showing:
    - Field name
    - Current active selector
    - Proposed selector
    - "Preview value" from the last validation run
    - Approve / Reject buttons (only when proposed differs from active)
  - Calls `approveRevisionFields` / `rejectRevisionFields` from the API
  - After approval, calls `onChange` to refresh the domain view

### Key API functions available (from `../onboarding-api`):
```typescript
import {
  testExtractorProfile,
  approveRevisionFields,
  rejectRevisionFields,
  getProfileGenerationDetail,
} from '../onboarding-api';
```

`testExtractorProfile({ url, titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector })` returns `{ success, extracted: { title?, price?, description?, brand?, images?: string[] } }`

### Important constraints
- The drawer should NOT duplicate the existing `ProfileGenerationReview` — that component serves a different purpose (generation-level review with revisions, decisions, rollback)
- Keep the drawer focused on the BUILD + TEST + APPROVE workflow
- Image thumbnails must use `<img>` tags with the URL directly (the images come from the target domain)
- Loading states for all async operations
- Error states for failed preview runs
- `bun run typecheck` must pass

### Files to modify/create
- `src/client/components/OnboardingSettings.tsx` — simplify inline proposal section, add drawer trigger
- `src/client/components/ProfileProposalDrawer.tsx` — NEW: the drawer component
- `src/server/routes/onboarding-routes.ts` — update POST /test route to return image URLs for imagesSelector
- `src/client/onboarding-api.ts` — ensure `ExtractorTestResult` type includes `images?: string[]`

Read all relevant files first before making changes. Run `bun run typecheck` after.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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