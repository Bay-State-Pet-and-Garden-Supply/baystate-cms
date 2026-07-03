# Task for planner

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Create a combined plan for two related pieces of work:

## Part A: Fix the Visual Element Picker UX (Confirmation + Tooltip)

The current picker (`pick-element.ts`) opens a headful browser, the user clicks an element, and the browser immediately closes with zero feedback. We need:

1. **In-browser confirmation step**: After clicking, show a green checkmark badge on the selected element. Show a confirmation bar: "✓ Selected: h1.product-title — [Confirm] [Retry] [Cancel]". Only close on explicit Confirm.
2. **Hover tooltip**: When hovering, show a floating bar with: tag, classes, text preview (first 50 chars), and dimensions.
3. **State machine**: `hovering` → `candidate-selected` → confirm/retry/cancel. Keyboard: Enter=Confirm, Escape=Cancel.
4. **Frontend feedback**: After successful pick, show an inline confirmation card with the selector, a text preview, and a screenshot thumbnail.

## Part B: Extend Element Picker Beyond Title/Description/Images

### Current limitations:
- `ExtractorProfileSchema` has only 5 fixed fields: `titleSelector`, `priceSelector`, `descriptionSelector`, `brandSelector`, `imagesSelector`
- `SELECTOR_FIELDS` active set only manages 3 fields: `titleSelector`, `descriptionSelector`, `imagesSelector`
- `PickElementRequest.field` only accepts: `'title' | 'description' | 'images'`
- The visual picker cards in the Build tab are hardcoded to Title/Description/Images
- No mechanism for custom arbitrary fields like "Size", "Variant", "SKU", "Weight", "Dimensions"

### What we need:
Users need to be able to select ANY element on a product page, not just the 3-5 predefined fields. The profile should support arbitrary field→selector mappings. This means:

1. **Extend ExtractorProfile** to support custom fields (a `Record<string, string>` for additional selectors)
2. **Add a "Custom Field" mode** to the picker: users should be able to type a field name (e.g. "Size") and then pick the element via the visual picker
3. **Update the Build tab** to show the fixed fields (Title, Description, Images) plus allow adding custom fields
4. **Update the Review tab** to display and approve/reject custom field selectors
5. **Update extraction** (`page-extractor.ts`, `extract.ts`) to use custom field selectors and store the results
6. **Update `PickElementRequest.field`** to accept arbitrary field names (not just the 3 predefined ones)

### Key files to reference:
- `src/shared/schemas/onboarding.ts` — ExtractorProfileSchema, SelectorFieldEnum, SELECTOR_FIELDS, ExtractionDataSchema
- `src/onboarding/page-extractor.ts` — how custom selectors are applied during extraction (the `extractCustomSelectorsCheerio` function)
- `src/extraction-worker/routes/extract.ts` — the trusted profile runner
- `src/extraction-worker/routes/pick-element.ts` — the current picker with 3 fixed fields
- `src/client/components/ProfileBuilderWorkspace.tsx` — the Build tab with hardcoded cards
- `src/client/components/ProfileProposalDrawer.tsx` — the review drawer with per-field approval
- `src/shared/schemas/extraction-worker.ts` — PickElementRequest/Response
- `src/onboarding/profile-generator.ts` — GeneratedSelectorProfile interface
- `src/onboarding/profile-promoter.ts` — promotion of selectors to profiles

### Design questions to address:
1. Should custom fields be stored in a separate `customSelectors: Record<string, string>` map on the profile, or should the profile support arbitrary keys alongside the fixed ones?
2. How does the extraction pipeline handle custom fields — do they just get stored in `fieldProvenance` and `extractionData` as key-value pairs?
3. Should the user be able to name the field anything, or should there be a predefined set of "extra" fields?
4. How does the review/approval flow work for custom fields — same per-field approval?
5. Does adding custom fields require DB schema migration for `extractor_profiles` table?

### Output:
Create a numbered, actionable plan with exact file paths, changes, and acceptance criteria. Address both Part A and Part B together since they share the same picker code.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/587a8098/plan.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

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