# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement Phases 4+5 from the plan at /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md (tasks 19-28).

Read the Phase 3 handoff at /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/78c52c86-2ec3-48ba-b16b-533bf3e83ccc/chain-artifacts/phase3-handoff.md for context on what was built in Phase 3.

Implement:

**Task 19: `src/client/components/LlmTaskConfigPanel.tsx`** — per-task model routing UI where store manager selects provider/model for each AI task (profile_generation, profile_revision, product_name_consolidation, etc.). Show "Required" label for profile tasks.

**Task 20: `src/client/components/GeneratedProfilesPanel.tsx`** — domain-scoped generated profile queue listing proposals by domain and status (proposed/validated/rejected).

**Task 21: `src/client/components/ProfileFieldValidationTable.tsx`** + `src/client/components/ImagePreviewGrid.tsx` — per-field validation table showing selector, sample URL, extracted value, pass/fail, image thumbnails, repeated-image warnings, carousel warnings.

**Task 22: `src/client/components/ProfileRevisionFeedbackForm.tsx`** — structured store-manager feedback controls per field: text fields have "This should be ___", images have mark-correct/exclude, advanced CSS toggle.

**Task 23: `src/client/components/ProfileGenerationReview.tsx`** — per-field approval checkboxes, reject with reason, rollback buttons, before/after diff.

**Task 24: Integrate** all panels into `src/client/components/OnboardingSettings.tsx`.

**Task 25: Remove** `applyGeneratedProfileToCheerio` from `src/onboarding/profile-generator.ts` if unused by governance service. Remove its exports and tests.

**Task 26: Remove** all stale `canAutoPromote`, `canPromote` terminology — grep and remove from production code, update any remaining references.

**Task 27: Create** `docs/generated-profile-governance.md` documenting the full workflow, 20 invariants, approval process, model routing, rollback.

**Task 28: Run** `bun run typecheck`, `bun run test`, `bunx vitest run`. Fix any failures.

Return changed files, commands, residual risks.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/8fe73d3a-c1b1-4388-bf7a-afca43f79474/worker-handoffs/phase4-handoff.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: optional by reviewer.

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