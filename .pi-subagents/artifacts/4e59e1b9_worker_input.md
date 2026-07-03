# Task for worker

You are reviving a previous subagent conversation.

Original run: 395524bc-c010-4df6-976d-52426ae352cf
Original agent: worker
Original session file: /Users/nickborrello/.pi/agent/sessions/--Users-nickborrello-Desktop-Projects-shopsite-cms--/2026-07-02T10-04-26-706Z_019f2249-72d2-7ee6-af3a-f836428d2613.jsonl

Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.

Follow-up:
Phase 1 completed successfully (acceptance parser false positive — the work is done). Continue to Phase 2: implement LLM task routing (tasks 9-12). Read /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/395524bc-c010-4df6-976d-52426ae352cf/chain-artifacts/phase1-handoff.md for the Phase 1 handoff, then implement the Phase 2 plan from the original plan at /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md.

Tasks 9-12:
- llm_task_configs table in migrations
- llm-task-config-repo.ts
- getLlmConfigForTask + callLlmForTask in llm-client.ts
- Update profile-generator.ts, llm-client.ts callers
- Tests for task routing

Run bun run typecheck and bun run test after. Return summary.

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