# Task for reviewer

Review the Phase 3 (Click-to-Select Visual Picker) implementation.

## What was implemented

### Backend (Tasks 14-18)

**New file: `src/extraction-worker/routes/pick-element.ts`**
Worker route `POST /profile-tooling/pick-element` that:
- Accepts `{ url, field, allowParentContainer }`
- Launches **headful** Playwright Chromium
- Navigates to the URL, injects a JS overlay with:
  - A top bar with field label ("Click on the product title element") and Cancel button
  - Mouseover highlight with blue outline
  - Click handler that captures outerHTML + attributes + text + bounding rect
  - Callback via `page.exposeFunction('__elementPicked', ...)`
- 120s timeout waiting for user interaction
- On pick: gets full page HTML, finds element via Cheerio, calls `buildStableSelector`
- Takes screenshot for confirmation
- Returns `PickElementResponse` with selector, stability, extracted text/images, screenshot ref

**Modified: `src/extraction-worker/server.ts`**
- Imports `handlePickElement`
- Registers `POST /profile-tooling/pick-element`

**Modified: `src/server/extraction-worker-client.ts`**
- Imports `PickElementRequest/Response` types and schemas
- Adds `pickElement()` with 120s timeout

**Modified: `src/server/routes/onboarding-routes.ts`**
- Imports `PickElementRequestSchema` and `pickElement`
- Adds proxy route `POST /api/onboarding/settings/profile-tooling/pick-element`

**Modified: `src/client/onboarding-api.ts`**
- Imports `PickElementRequest/Response`
- Adds `pickElementVisually()` API function

### Frontend (Tasks 19-21)

**New file: `src/client/components/ElementPickerButton.tsx`**
- Props: `{ field, url, onPicked, onCancel, disabled }`
- onClick: calls `pickElementVisually({ url, field, allowParentContainer: true })`
- Shows "Opening browser window…" status, error messages
- Handles cancellation (empty selector + "cancel" warning)
- On success: calls `onPicked(result)`
- Purple button with 🖱️ icon

**Modified: `src/client/components/ProfileProposalDrawer.tsx`**
- Imports `ElementPickerButton`
- Adds picker button per field (before "Suggest Revision" button)
- On picked: calls `setRevisedSelectors` to update the proposal display
- Shows a brief status message with the generated selector

**Modified: `src/client/components/ProfileBuilderWorkspace.tsx`**
- Imports `ElementPickerButton`
- Adds 3 picker buttons (Title, Description, Images) in the Snapshot tab
- Uses `snapshotResult.finalUrl || snapshotResult.url` as the target URL

## What to review

1. **Correctness**: Does the full flow work end-to-end? Client clicks button → API call → Bun proxy → worker → launches headful Playwright → user clicks → selector generated → returned to client → displayed in UI.

2. **Pattern consistency**: Does the worker route follow the exact same handler pattern as snapshot.ts and generate-selector.ts? (Body parsing, schema validation, error handling, fallback response)

3. **Security**: Is the injected overlay JS safe? Does it use `stopImmediatePropagation()` to prevent the target page from reacting to the pick click? Is the overlay visually unobtrusive? Are all callbacks properly cleaned up?

4. **Browser lifecycle**: Is the Playwright browser properly closed in all paths (success, cancel, error)? Is there a timeout for the user interaction?

5. **Element matching**: When the user clicks an element in the live browser and we need to find it in the Cheerio-loaded `page.content()` HTML, how does the matching work? What if the live DOM has dynamic attributes (React keys) that differ from `page.content()`?

6. **Image gallery case**: What happens when the user clicks a single `<img>` for the "images" field? Is there handling for preferring the parent container?

7. **Client UX**: Does the ElementPickerButton component handle loading, error, and success states? Is there a cancellation flow? Is the picker disabled when no URL is available?

8. **ProfileProposalDrawer integration**: Does the visual picker bypass the per-field approval invariant? Or does it set the selector in `revisedSelectors` and still require the user to click "Approve"?

9. **BuilderWorkspace integration**: Are the picker buttons placed sensibly in the Snapshot tab? Are they only rendered when a snapshot result exists?

10. **Phase 1 & 2 invariants**: Are all previous invariants still intact? (Never auto-promote, per-field approval, versioned revisions, worker is Node.js-only, client doesn't talk to worker directly)

## Files to read

- `src/extraction-worker/routes/pick-element.ts`
- `src/extraction-worker/server.ts` (just the route registration)
- `src/server/extraction-worker-client.ts` (just the new function)
- `src/server/routes/onboarding-routes.ts` (just the pick-element proxy)
- `src/client/onboarding-api.ts` (just the pick-element function)
- `src/client/components/ElementPickerButton.tsx`
- `src/client/components/ProfileProposalDrawer.tsx` (just the picker integration)
- `src/client/components/ProfileBuilderWorkspace.tsx` (just the picker integration)

Report findings with file paths and line numbers. Call out any issues clearly.

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