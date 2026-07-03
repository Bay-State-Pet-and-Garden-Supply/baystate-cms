# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Handle unused files from fallow analysis.

Delete or move these unused files:
1. `scratch/analyze-run.ts` — delete
2. `scratch/check-forager.ts` — delete
3. `scratch/print-scores.ts` — delete
4. `scratch/test-curation-stage.ts` — delete
5. `scratch/test-forager-score.ts` — delete
6. `scratch/verify-extraction-remedies.ts` — delete
7. `scripts/migrate-additional-images.ts` — delete
8. `scripts/migrate-from-live-xml.ts` — delete
9. `scripts/search-strategy-test.ts` — delete

For the 3 unused client components, they are used by routes/other components so they are FALSE POSITIVES — add supression comments:
10. `src/client/components/GeneratedProfilesPanel.tsx` — add `// fallow-ignore-file unused-exports` at the top (after the header comment)
11. `src/client/components/ProfileFieldValidationTable.tsx` — add `// fallow-ignore-file unused-exports` at the top (after the header comment)
12. `src/client/components/SearchableBrandSelector.tsx` — add `// fallow-ignore-file unused-exports` at the top (after the header comment)

Use `rm` to delete files. For the TSX files, read them first to find the right place for the suppression comment.

Verify with `bun run typecheck` after.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/c41cef60/progress.md

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