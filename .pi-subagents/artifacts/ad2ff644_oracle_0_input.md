# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Context

We've built two methods for users to create extractor profiles:

### Phase 2: Paste-element-to-selector (WORKING ✅)
Users open DevTools, find the element, right-click → Copy → Copy outerHTML, paste it into a textarea in the app, click "Generate Selector". The system runs `buildStableSelector` on the pasted HTML and returns a stable CSS selector.

This is reliable but requires the user to know how to use browser DevTools.

### Phase 3: Visual Click-to-Select (BROKEN ❌)
Users click 🖱️ in the app, a headful Playwright Chromium opens, they hover to highlight elements, click to select, then confirm. The system generates a stable CSS selector from the clicked element.

This has been plagued by bugs:
1. Original: browser closed immediately on click with no confirmation (UX broken)
2. Fixed: Added 3-state confirmation flow (hover → candidate → confirm/retry/cancel)
3. Fixed: onclick handlers referenced wrong function names (called window.confirm instead of confirmSel)
4. Current: missing 'function' keyword on reset() caused the entire injected overlay script to fail silently (just fixed)

The user is frustrated and asking: should we keep debugging the Playwright overlay approach, or have users just paste elements?

### Current overlay complexity
The injected script is ~4KB of minified JavaScript that:
- Creates a style element with 15 CSS rules
- Creates a floating bottom bar with dynamic content
- Manages a 3-state machine (hovering/selected)
- Listens to mouseover, mouseout, click, and keydown events
- Builds element info tooltips dynamically
- Adds/removes CSS classes and DOM elements

### Alternatives
1. **Paste-element flow** (Phase 2) — already built, works reliably. User copies outerHTML from DevTools, pastes into textarea, clicks Generate.
2. **Keep debugging** — find the remaining bugs in the overlay injection approach. The current bug was a missing `function` keyword from a botched regex fix.
3. **Simplify the overlay** — strip the confirmation flow, go back to click-immediately-sends approach but add better frontend feedback.
4. **Use a library** — inject `@botanicastudios/element-selector` or `js-element-picker` via `page.addScriptTag()` instead of writing our own overlay.

### Question
Should we keep trying with the custom Playwright overlay approach, or take a different path?

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