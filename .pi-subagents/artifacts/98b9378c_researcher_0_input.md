# Task for researcher

Research interactive element selection approaches for a local CMS tool that uses Playwright for browser automation.

## Context

We have a visual element picker (`src/extraction-worker/routes/pick-element.ts`) that:
1. Opens a headful Playwright Chromium browser
2. Injects a JavaScript overlay that highlights elements on hover (blue outline) and captures clicks
3. When the user clicks an element, the browser immediately closes and sends the outerHTML back
4. A React `ElementPickerButton` component triggers this flow

**The core problem**: The browser closes abruptly after clicking with zero in-browser feedback. The user doesn't know if their selection was received, what was selected, or whether it was correct. There's no confirmation step, no undo, no preview.

**Constraints**:
- Local tool (127.0.0.1), so CORS/security isn't a concern
- Playwright Chromium is already installed
- The extraction worker is a Node.js HTTP server
- The frontend is React
- Headful mode is acceptable (required for visual interaction)

## What to Research

### 1. Open-source libraries for visual element selection
- Browser extension element pickers (SelectorsHub, ChroPath, PICK)
- CSS selector generation libraries that work in-browser
- Visual testing tools with element picking features
- Web scraping tools with visual selectors

### 2. UX patterns for in-browser element picking
- How Chrome DevTools element picker works (the inspect icon flow)
- How no-code browser automation tools handle element selection
- Confirmation patterns — what happens after a user clicks an element?
- Two-step flows: click → confirm → proceed

### 3. Alternative technical approaches
- **iframe-based**: Embed target page in an iframe, use `elementFromPoint()` on clicks
- **Screenshot-based**: Full-page screenshot, let user draw bounding box, find elements at coordinates
- **Two-phase**: First phase opens browser for exploration and recording, second phase replays
- **Hybrid**: Paste HTML (already built) + visual picker as secondary option
- **Playwright Inspector**: Can Playwright's own codegen/recording tools be repurposed?

### 4. In-browser confirmation patterns
- How to show a confirmation dialog in the target page before closing
- How to let the user preview and confirm the selected element
- How to show element info (tag, classes, text preview) on hover tooltip
- How to handle "this is wrong, let me click again"

## Output Requirements

Provide a clear recommendation with:
1. **Best approach** — What library/pattern/flow we should use with rationale
2. **UX mockup** — Text description of the improved user flow from start to finish
3. **Implementation sketch** — High-level code structure (2-3 paragraphs)
4. **Alternatives considered** — 2-3 other approaches with pros/cons
5. **Reference links** — URLs to libraries/tools with one-line summaries

This is for a production application. Focus on practical, implementable solutions that would work in a real browser automation context.


---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/98b9378c/research.md
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