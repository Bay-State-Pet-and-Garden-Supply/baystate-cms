# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Apply the Phase 3 reviewer fixes for the click-to-select visual picker.

## Reviewer blockers/gaps to fix

### B1: Overlay script crashes because fieldLabel is not interpolated
File: `src/extraction-worker/routes/pick-element.ts`

In `buildOverlayScript(fieldLabel)`, the browser script currently references `fieldLabel` inside the injected script instead of interpolating the Node value. Fix:
- Replace the bad `JSON.stringify(fieldLabel)` usage inside the returned template string with `${JSON.stringify(fieldLabel)}`.
- Ensure `fieldLabel` is no longer flagged unused.

### B2: Cleanup removes the wrong stylesheet
File: `src/extraction-worker/routes/pick-element.ts`

The injected browser script uses `document.querySelector('style').remove()`, which may remove the page's own first stylesheet. Fix both click and cancel cleanup paths to use the local `highlightStyle.remove()` reference instead.

### G1: ProfileBuilderWorkspace discards picked selector
File: `src/client/components/ProfileBuilderWorkspace.tsx`

The snapshot tab picker buttons currently only `console.log` picked selectors. Add local UI state to display selected visual-picker selectors in the Snapshot tab.

Suggested minimal implementation:
- Add state:
  ```ts
  const [visualPickedSelectors, setVisualPickedSelectors] = useState<Record<string, { selector: string; stability: string; extractedText: string | null; matchCount: number }>>({});
  ```
- For Title/Description/Images `onPicked`, store under keys `titleSelector`, `descriptionSelector`, `imagesSelector`.
- Render a small table/card under the three picker buttons showing Field, Selector, Stability, Matches, Preview. Do not persist from this surface yet; make it clearly a preview/copy aid.
- Do not use console.log.

### G2: ProfileProposalDrawer picked selector is not persisted before approval
File: `src/client/components/ProfileProposalDrawer.tsx`

Currently visual picker only updates local `revisedSelectors`, but `handleApprove` still approves the existing revisionId, so the original selector gets promoted.

Implement a minimal safe persistence flow:
1. Add local state for current revision id:
   ```ts
   const [currentRevisionId, setCurrentRevisionId] = useState<string | null>(revisionId);
   ```
   Keep it synced if prop changes:
   ```ts
   useEffect(() => setCurrentRevisionId(revisionId), [revisionId]);
   ```
2. Use `currentRevisionId` instead of prop `revisionId` in `handleApprove` and `handleReject` and the "No revision ID" UI check.
3. In existing `handleSubmitFeedback`, after `createRevisionFromFeedback` succeeds, call `setCurrentRevisionId(result.revision.id)`.
4. In visual picker `onPicked`, persist the picked selector by calling `createRevisionFromFeedback(proposal.id, { parentRevisionId: currentRevisionId, feedback })`, where feedback includes an `Advanced selector hint: ${picked.selector}` note so `profile-governance-service.ts` applies it to selectors_json.

Feedback shape:
- title/description field:
  ```ts
  {
    kind: 'text',
    field: field as SelectorField,
    currentValueCorrect: false,
    expectedValue: picked.extractedText || undefined,
    notes: `Advanced selector hint: ${picked.selector}`,
  }
  ```
- images field:
  ```ts
  {
    kind: 'images',
    perImage: {},
    notes: `Advanced selector hint: ${picked.selector}`,
  }
  ```

After API success:
- set `currentRevisionId` to returned revision id
- update `revisedSelectors` from returned revision selectors if available, otherwise set the picked selector locally
- set a success message in existing `feedbackSuccess` state: "Visual selector saved as a new revision. Preview it, then approve the field."
- clear `actionError`

If API fails, set `actionError` and do not update `revisedSelectors`.

### Notes to fix if easy
- Remove `BAR_HEIGHT` and `pickResult` dead code in `pick-element.ts` if present.
- Ensure `bun run typecheck` passes.

## What NOT to do
- Do not add Phase 4 or broader UX changes.
- Do not modify tests unless required for typecheck.
- Do not bypass approval; visual selector must create a revision and still require explicit Approve.

Run `bun run typecheck` after fixes and report changed files.

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