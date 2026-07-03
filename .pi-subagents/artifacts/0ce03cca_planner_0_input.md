# Task for planner

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Here is the oracle's full recommendation. Build a detailed implementation plan from it.

## Oracle Recommendation

Adopt a three-layer hybrid, built incrementally:

### Layer 1 (existing): AI Proposes
Keep the current LLM-based profile generation as the starting point.

### Layer 2 (new, quick win): Paste-Element-to-Selector
Add a flow where the user pastes an element's outerHTML (copied from DevTools) into the existing manualSelectorHint field. The system runs buildStableSelector on the pasted HTML to generate a stable selector, shows a live extraction preview, and lets the user approve it through the existing per-field flow.

### Layer 3 (new, ideal end state): Click-to-Select Visual Picker
Add a new worker route (/profile-tooling/pick-element) that launches headful Playwright, navigates to the product URL, injects a JavaScript overlay that highlights elements on hover and captures clicks, returns the selector + extracted text/images.

### Priority: Do Phase 1 first, then Phase 2, then Phase 3.

## Phases from Oracle

### Phase 1: Extract buildStableSelector into a shared module
- Move buildStableSelector, isLikelyGeneratedId, STABLE_DATA_ATTRS, SEMANTIC_HINT_SUBSTRINGS, classSet, attrSelector, and snippetOf from profile-generator.ts into a new src/shared/selector-utils.ts (with no Bun-dependent imports)
- Update profile-generator.ts to import from the new module
- Add unit tests for the extracted module

### Phase 2: Paste-Element-to-Selector
- Add a new worker route POST /profile-tooling/generate-selector that accepts { html: string, outerHTML: string } and returns { selector: string, stability: string, extractedText: string }
- Add a Bun server proxy route
- Update ProfileRevisionFeedbackForm to accept pasted HTML, call the endpoint, and show the generated selector + extraction preview
- Wire the generated selector into the existing revision creation flow

### Phase 3: Click-to-Select Visual Picker
- Add a new worker route POST /profile-tooling/pick-element that launches headful Playwright, injects an overlay, captures clicks
- Add a Bun server proxy route
- Add a new client component ElementPickerButton
- Integrate into ProfileProposalDrawer
- Handle the image-gallery case

## Invariants to preserve
1. Never auto-promote — visually-selected selectors go through revision → validation → per-field approval → promotion path
2. Per-field approval — picker operates on one field at a time
3. Image approval needs 2+ samples + attestation
4. Revisions are versioned — visually-corrected selector creates a new revision (source: manual_css)
5. Worker is Node.js-only — shared module must have no Bun dependencies
6. Client never talks to worker directly — new picker calls go through Bun server proxy

## Key files to read
- src/onboarding/profile-generator.ts (buildStableSelector, isLikelyGeneratedId, etc. at ~line 318)
- src/extraction-worker/routes/snapshot.ts (existing worker route pattern)
- src/extraction-worker/server.ts (worker server setup)
- src/server/routes/onboarding-routes.ts (Bun proxy routes)
- src/client/onboarding-api.ts (client API layer)
- src/client/components/ProfileRevisionFeedbackForm.tsx (feedback form with manualSelectorHint)
- src/client/components/ProfileProposalDrawer.tsx (drawer with per-field preview/approve)
- src/client/components/ProfileBuilderWorkspace.tsx (builder UI)
- src/shared/schemas/extraction-worker.ts (worker request/response schemas)
- src/shared/schemas/onboarding.ts (profile schemas)
- src/onboarding/profile-promoter.ts (promotion invariants)

Create a concrete, numbered, actionable plan with exact file paths and acceptance criteria per task.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/0ce03cca/plan.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

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