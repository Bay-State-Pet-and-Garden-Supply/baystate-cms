# Task for planner

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Create an implementation plan from 20 locked product decisions for the ShopSite CMS generated-profile governance system. Read the current codebase state first.

## 20 Locked Decisions

1. **Approval always required** — AI-generated extractor profiles must ALWAYS require explicit human approval; never auto-promote.
2. **Per-field approval** — approval is per selector field (title, description, images, brand, price), not whole-profile.
3. **Image approval = multi-sample + previews** — imagesSelector requires 2+ same-domain product samples and thumbnail previews before approval.
4. **Approved fields → extractor_profiles** — approved fields write to the active `extractor_profiles` table; `profile_generations` remains proposal history.
5. **Profiles live in domain settings, not product drawers** — brand-level config, not per-product.
6. **Canonical key = domain** (not brand).
7. **Validation sample policy**: text fields prefer 2+ samples, allow 1 with warning; images require 2+; price special caution.
8. **Validation samples = selected/confirmed source URLs** with expected product names.
9. **Approval screen = per-field validation table** with selector, extracted values, samples, pass/fail, image previews, warnings.
10. **Per-field rollback** — preserve previous active selector values; show diff; allow reversion.
11. **Store managers don't edit CSS** — AI revises selectors from structured feedback; advanced CSS editor as escape hatch only.
12. **Revision UI = structured field feedback** not open chat — "This should be ___", "Exclude this image", etc.
13. **Revisions are versioned** — not overwritten; preserve original + feedback + revised + validation per attempt.
14. **Normalized tables** — separate tables for revisions (`profile_generation_revisions`) and field decisions (`profile_generation_field_decisions`).
15. **Task-specific LLM model routing** — separate configs for each AI task (profile_generation, profile_revision, product_name_consolidation, etc.).
16. **Profile generation vs revision = separate model configs**.
17. **Provider creds in `api_keys`, task routing in new `llm_task_configs` table**.
18. **llm_task_configs = workspace/store-specific**.
19. **Profile generation/revision fail closed** — no fallback to generic config; require explicit task config. Product name consolidation may fallback.
20. **Unapproved selectors never affect any extraction** — even in-memory retry is disallowed. Proposals only until approved.

## Already Implemented

- `profile_generations` audit table and repo (Phase 1)
- `profile-generator.ts` core (DOM minimization, candidate building, LLM generation, validation)
- `profile-promoter.ts` with per-field approval router (auto-promote path removed)
- `shouldAttemptProfileGeneration` trigger logic with fail-safe categories
- `promoteGeneratedProfile` now requires explicit `ApprovedSelectorFields` map
- Woof variant image fix in page-extractor (richer product JSON, expected-name variant inference)
- `extractor_profiles` merge-style upsert (Phase 1)
- Profile test endpoint in onboarding routes
- Active profile management UI in OnboardingSettings

## Recently Changed (by direct edit, verify/adjust)

- `src/onboarding/page-extractor.ts`: removed the in-memory retry that applied generated selectors to current extraction. Now generation → audit only → returns original result. The `applyGeneratedProfileToCheerio` import was removed from page-extractor.

## Remaining Gaps

- **Decision 14**: normalized tables `profile_generation_revisions`, `profile_generation_field_decisions` not yet created.
- **Decision 15-19**: `llm_task_configs` table, task-specific routing (`getLlmConfigForTask`), fail-closed for profile tasks.
- **Decision 20**: verify the in-memory retry removal is complete and all callers/tests are consistent.
- **Decisions 5,6,9,10,11,12,13**: UI work (Generated Profiles queue in domain settings, per-field validation table, structured feedback, store-manager revision flow, rollback).
- **Decision 9**: image thumbnails/previews from multi-sample validation.
- `applyGeneratedProfileToCheerio` is still exported from `profile-generator.ts` and tested — remove if unused by extractor.
- Any remaining references to auto-promote or `canAutoPromote` in codebase.

## Request

Produce a phased implementation plan with concrete file changes. UI can be a separate phase. Prioritize backend schema and model routing first, then profile-review backend API, then UI.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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