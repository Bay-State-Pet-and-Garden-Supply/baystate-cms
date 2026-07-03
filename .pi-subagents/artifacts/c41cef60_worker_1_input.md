# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Handle unused exports from shared/schemas/ files — these are FALSE POSITIVES (Zod schema exports used by external consumers).

Add suppression comments to the schema files:

1. `src/shared/schemas/onboarding.ts` — 38 false positives. Add `// fallow-ignore-file unused-exports` at the top after the header comment.
2. `src/shared/schemas/classification.ts` — 21 false positives. Same.
3. `src/shared/schemas/extraction-worker.ts` — 12 false positives. Same.
4. `src/shared/schemas/product.ts` — 9 false positives. Same.
5. `src/shared/schemas/change-set.ts` — 2 false positives. Same.
6. `src/shared/schemas/field-registry.ts` — 2 false positives. Same.
7. `src/shared/schemas/sync.ts` — 2 false positives. Same.
8. `src/shared/schemas/validation.ts` — 1 false positive. Same.
9. `src/shared/schemas/workspace.ts` — 2 false positives. Same.

Read each file first to find where the JSDoc or header comments end, then add `// fallow-ignore-file unused-exports` on its own line right after the closing `*/` of the file header comment (or at the top if no header comment).

Do NOT delete any exports. The goal is just suppression.

Verify with `bun run typecheck` after.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/c41cef60/progress.md

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