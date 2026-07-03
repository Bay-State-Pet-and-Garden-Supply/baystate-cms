# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Task: Update extractor profile repo for custom selectors (B9)

File: `src/db/repositories/extractor-profile-repo.ts`

The repo needs to read/write the new `custom_selectors_json` column.

Read the file first. Find:
1. The `ExtractorProfileRow` interface — add `custom_selectors_json: string | null`
2. The `mapRowToProfile` function — parse `custom_selectors_json` into `customSelectors`
3. The `upsertProfile` function — write `customSelectors` as JSON to the column
4. The `insertProfile` function — same

Example pattern:
```typescript
// In ExtractorProfileRow:
custom_selectors_json: string | null;

// In mapRowToProfile:
customSelectors: row.custom_selectors_json ? JSON.parse(row.custom_selectors_json) : {},

// In upsertProfile SQL:
custom_selectors_json = ?,
// And the run params: JSON.stringify(profile.customSelectors ?? {}),

// In insertProfile SQL:
custom_selectors_json,
// And run params: JSON.stringify(profile.customSelectors ?? {}),
```

Read the file to find the exact SQL column lists and row mappings, then make targeted edits.

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