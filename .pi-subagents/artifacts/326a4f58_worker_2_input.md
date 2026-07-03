# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Task: Update extraction to apply custom selectors (B6, B8)

### B6: page-extractor.ts
File: `src/onboarding/page-extractor.ts`

Find the `extractCustomSelectorsCheerio` function (or equivalent where profile selectors are applied via Cheerio). After the 5 fixed fields are extracted, add a loop over `profile.customSelectors`:

```typescript
// Extract custom selectors
if (profile.customSelectors) {
  for (const [fieldName, selector] of Object.entries(profile.customSelectors)) {
    if (!selector) continue;
    try {
      const val = profile.titleSelector ? $(selector).first().text().trim() || null : null;  // <-- need to use $ directly
      if (val) {
        data.customFields = data.customFields ?? {};
        data.customFields[fieldName] = val;
      }
    } catch { /* skip bad selectors */ }
  }
}
```

Read the file to find the exact location where profile selectors are applied.

### B8: Worker extract route
File: `src/extraction-worker/routes/extract.ts`

Find where the 5 fixed selectors are applied (around lines 360-530 for static path, 550-800 for rendered path). After each set of fixed field extractions, add custom selector extraction from `profile.customSelectors` or `selectors.customSelectors` (depending on how the worker receives the profile).

The worker receives the profile as `request.profile` which has a `selectors` object. If custom selectors are in there, loop over them:

```typescript
// For static path (around line 464-532)
if (selectors.customSelectors) {
  for (const [fieldName, selector] of Object.entries(selectors.customSelectors)) {
    if (!selector) continue;
    try {
      const val = $(selector).first().text().trim();
      if (val) {
        result.extractionData.customFields = result.extractionData.customFields ?? {};
        result.extractionData.customFields[fieldName] = val;
      }
    } catch { /* skip */ }
  }
}
```

Apply the same pattern for the rendered path (where Playwright extracts data).

Read both files, make targeted edits.

Verify with `bun run typecheck`.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/326a4f58/progress.md

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