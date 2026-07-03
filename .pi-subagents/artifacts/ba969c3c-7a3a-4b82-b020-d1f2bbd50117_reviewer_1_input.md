# Task for reviewer

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/progress.md]

Review the domain extractor profile refactor for code quality and maintainability:

Check these 5 files:
1. src/shared/schemas/onboarding.ts — is the schema change minimal and correct?
2. src/client/onboarding-api.ts — is the type change consistent with the schema?
3. src/server/routes/onboarding-routes.ts — is the route handler change clean?
4. src/client/components/OnboardingSettings.tsx — is the new UI code well-structured? Check: consistent with existing patterns, no duplication, proper inline styles, state management follows existing conventions, form reset/edit logic is clean
5. src/client/components/Onboarding.tsx — is the cleanup thorough? Any remaining dead references?

Flag: unnecessary complexity, missed cleanup, inconsistent patterns, missing error handling, state management issues. Do not modify files.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/ba969c3c-7a3a-4b82-b020-d1f2bbd50117/validation-quality.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

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