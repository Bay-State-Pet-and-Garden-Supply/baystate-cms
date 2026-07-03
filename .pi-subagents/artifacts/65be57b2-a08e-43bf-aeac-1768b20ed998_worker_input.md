# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement the approved profile-governance changes in the active worktree. User decisions/invariants:
1. AI-generated extractor profiles must ALWAYS require explicit human approval before affecting future extractions. No auto-promotion no matter confidence.
2. Approval must be per selector field, not whole-profile-only. Images are especially uncertain.

Current context:
- Existing generated-profile primitives were implemented in `src/onboarding/profile-generator.ts`, `src/onboarding/profile-promoter.ts`, `src/db/repositories/profile-generation-repo.ts`, and tests.
- `src/onboarding/page-extractor.ts` may still do in-memory retry when feature flag is enabled; that is okay because it does not affect future extractions, but any persistent promotion must require explicit approval.
- `src/onboarding/profile-promoter.ts` currently has `SHOPSITE_CMS_PROFILE_AUTO_PROMOTE_ENABLED` and a conservative/auto-promote path. Remove or neuter that path.

Implement:
1. Remove/neuter `SHOPSITE_CMS_PROFILE_AUTO_PROMOTE_ENABLED` and `isAutoPromoteEnabled()` so there is no environment-based auto-promotion path.
2. Update `promoteGeneratedProfile` (or create a replacement API-level helper if cleaner) to require an explicit list/map of approved fields, e.g. `{ titleSelector: true, descriptionSelector: true, imagesSelector: false }`. It should:
   - refuse promotion if no approved fields are provided,
   - only call merge-style `upsertProfile` with selectors for fields explicitly approved,
   - allow title-only, title+description, etc.,
   - never implicitly promote images or any other selector based on confidence,
   - mark the generation as `promoted` only if at least one approved field was written,
   - store/update validation or error metadata to indicate which fields were approved if the repository API supports it; otherwise document residual gap.
3. Adjust tests in `src/tests/unit/profile-promoter.test.ts`:
   - remove auto-promote env tests,
   - add approval-required tests,
   - add per-field approval tests showing unapproved fields are not written,
   - explicit image approval test if imagesSelector is allowed to be promoted manually,
   - no fields approved -> rejected/failure.
4. Update any exports/imports/callers/docs/comments referring to auto-promote.
5. Run `bun run typecheck`, `bun test src/tests/unit/profile-promoter.test.ts`, and `bun run test` if feasible.

Do not build UI yet. This worker only enforces the backend invariant and tests. Return changed files, commands, and residual risks.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/65be57b2-a08e-43bf-aeac-1768b20ed998/worker-handoffs/profile-approval-required.md
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