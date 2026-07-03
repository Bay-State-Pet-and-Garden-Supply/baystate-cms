# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Task: Update ProfileProposalDrawer for custom field approval (B10)

File: `src/client/components/ProfileProposalDrawer.tsx`

The drawer currently shows approve/reject for 3 fixed fields (titleSelector, descriptionSelector, imagesSelector). Custom fields need the same treatment.

Add a new section below the existing approval table labeled "Custom Fields" that:
1. Shows each custom field from `proposedSelectors.customSelectors` or `proposedSelectors` (check the data shape)
2. Has the same approve/reject buttons per custom field
3. Has a "Suggest Revision" button per field

Actually, the simpler approach: custom selectors are stored on the `ExtractorProfile` level (not on the generation level). The drawer shows proposed vs active selectors. Custom fields from the proposal's selectors should appear alongside the fixed ones.

Read the file to understand the existing `SELECTOR_FIELDS` iteration, then extend it to also show custom fields from the proposal's selectors (if any exist).

The key insight: `proposedSelectors` is a `Record<string, string | null>` already. If custom fields are in that record (e.g. "Size": "span.size-selector"), they'd show automatically if the field name starts with `custom_` or similar. But it depends on how they're stored.

Actually, the simplest approach: after the fixed fields table, add a section that lists entries from `proposedSelectors` that aren't in the fixed `SELECTOR_FIELDS` list. This way any custom field selectors that end up in the proposal will automatically appear.

Check how `SELECTOR_FIELDS` and `proposedSelectors` work in the component, then add a new table section.

Read the file first, then make targeted edits.

Verify with `bun run typecheck`.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/33529cab/progress.md

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