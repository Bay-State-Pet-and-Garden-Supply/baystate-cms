# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Task: Rewrite the picker overlay with confirmation flow (Part A1)

File: `src/extraction-worker/routes/pick-element.ts`

Replace the `buildOverlayScript` function with a state-machine-driven overlay that provides:

1. **Hover tooltip**: On hover, show a floating bottom bar with element info:
   `"Hovering: " + tag + "." + classes + " - \"" + textPreview.slice(0,50) + "\""`
2. **Click → candidate-selected state**: Green outline (3px solid #22c55e) + checkmark badge on the clicked element. Bottom bar changes to confirmation buttons.
3. **Confirm/Retry/Cancel**: Three buttons in the bottom bar. Only "Confirm" triggers `window.__elementPicked(data)`. "Retry" clears selection back to hover. "Cancel" sends null.
4. **Keyboard**: Enter to confirm, Escape to cancel/return.

Read the file first, then make targeted edits to the `buildOverlayScript` function. The function returns a string of JavaScript that gets injected via `page.evaluate()`.

Verify with `bun run typecheck`.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/18ac4a47/progress.md

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