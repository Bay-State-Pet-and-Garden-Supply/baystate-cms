# Task for worker

You are reviving a previous subagent conversation.

Original run: 78c52c86-2ec3-48ba-b16b-533bf3e83ccc
Original agent: worker
Original session file: /Users/nickborrello/.pi/agent/sessions/--Users-nickborrello-Desktop-Projects-shopsite-cms--/2026-07-02T10-34-26-053Z_019f2264-e785-79a0-aa4b-9cde4cad1fb2.jsonl

Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.

Follow-up:
Phase 3 completed successfully (199 tests pass, typecheck clean — acceptance parser false positive). Continue to Phase 4+5: implement UI and cleanup (tasks 19-28). Read /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/78c52c86-2ec3-48ba-b16b-533bf3e83ccc/chain-artifacts/phase3-handoff.md for the Phase 3 handoff, then implement from the plan at /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md.

Tasks 19-28:
- LlmTaskConfigPanel.tsx, GeneratedProfilesPanel.tsx, ProfileFieldValidationTable.tsx, ImagePreviewGrid.tsx, ProfileRevisionFeedbackForm.tsx, ProfileGenerationReview.tsx
- Integrate into OnboardingSettings.tsx
- Remove applyGeneratedProfileToCheerio if unused; remove all stale canAutoPromote/canPromote terminology
- Create docs/generated-profile-governance.md
- Run bun run typecheck, bun run test, bunx vitest run

Return changed files, commands, residual risks.

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