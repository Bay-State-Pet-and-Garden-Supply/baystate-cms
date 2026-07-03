# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement Phase 3 (tasks 13-18) from /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md.

Read Phase 2 handoff at /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/395524bc-c010-4df6-976d-52426ae352cf/chain-artifacts/phase2-handoff.md for context.

Task 13: Create src/onboarding/profile-governance-service.ts with: listDomainProfileGovernance(domain), createInitialRevisionForGeneration(generationId), reviseProfileFromStructuredFeedback(feedback), validateRevisionAcrossConfirmedSamples(revisionId, domain), approveRevisionFields(input), rejectRevisionFields(input), rollbackProfileField(input). Centralize business rules: per-field gates, text 1-sample warning, images require 2+ samples+previews+checkbox, selected/confirmed samples only. Use existing repos (profile-generation-repo, profile-generation-revision-repo, profile-generation-field-decision-repo, onboarding-source-repo) and profile-promoter.ts's promoteGeneratedProfile.

Task 14: Fix src/db/repositories/onboarding-source-repo.ts validation sample query — is_selected=1 only, exact/suffix domain matching (not %domain%), deduplicate URLs, include item_id, expected_name, brand_hint, name fallback.

Task 15: Add governance API routes to src/server/routes/onboarding-routes.ts: GET/PUT/DELETE /onboarding/settings/llm-task-configs, GET /onboarding/settings/profile-governance/:domain, GET/POST /onboarding/settings/profile-generations, POST revisions, POST validate, POST decisions, POST rollback. Use shared Zod schemas.

Task 16: Update src/client/onboarding-api.ts with TypeScript interfaces and fetch functions for all new routes.

Task 17: Update src/shared/schemas/onboarding.ts with LlmTaskEnum, SelectorFieldEnum, revision/validation/decision schemas, structured feedback, approval request, rollback request.

Task 18: Create src/tests/unit/profile-governance-service.test.ts and update onboarding-repos.test.ts for fixed sample query.

Run bun run typecheck and bun run test. Return changed files, commands, residual risks.

---
Create and maintain progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/78c52c86-2ec3-48ba-b16b-533bf3e83ccc/progress.md

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/78c52c86-2ec3-48ba-b16b-533bf3e83ccc/chain-artifacts/phase3-handoff.md
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