# Phase 4+5 Handoff — Generated Profile Governance UI + Cleanup

## Summary

Implemented the requested Phase 4+5 scope from `generated-profile-governance-plan.md` tasks 19–28.

The settings UI now has two new domain-governance surfaces:

1. **AI Model Routing** (`LlmTaskConfigPanel`) — per-task provider/model routing for profile generation, profile revision, product-name consolidation, curation, and classification tasks. Profile tasks are marked **Required** because they fail closed without explicit task config.
2. **Generated Profile Governance** (`GeneratedProfilesPanel` + review components) — domain-scoped generated-profile queue, revision review, validation table, image previews, structured feedback, per-field approval/rejection, and rollback controls.

I also completed cleanup and documentation:

- Removed all `canAutoPromote`, `canPromote`, and `applyGeneratedProfileToCheerio` references from production/test source under `src`.
- Expanded `docs/generated-profile-governance.md` with the 20 locked product decisions and operational workflow.
- Tightened the generated-profile queue so it lists domains from generated proposals even before an active `extractor_profiles` row exists.
- Tightened backend image approval enforcement: `imagesSelector` approval now requires both `imagePreviewsReviewed = true` and at least 2 passing image validation samples with zero failures. This avoids relying on UI gating alone.

## Changed Files

Phase 4+5 files and directly related cleanup/fixes:

- `src/client/components/LlmTaskConfigPanel.tsx` — new per-task model routing UI.
- `src/client/components/GeneratedProfilesPanel.tsx` — new domain-level generated profile queue/history.
- `src/client/components/ProfileGenerationReview.tsx` — new single-generation review surface with field approval/rejection/rollback and revision feedback.
- `src/client/components/ProfileFieldValidationTable.tsx` — new per-field validation table.
- `src/client/components/ImagePreviewGrid.tsx` — new image preview/review grid.
- `src/client/components/ProfileRevisionFeedbackForm.tsx` — new structured store-manager feedback form with advanced CSS escape hatch.
- `src/client/components/OnboardingSettings.tsx` — integrated AI Model Routing and Generated Profile Governance sections.
- `src/client/onboarding-api.ts` — made `getProfileGenerations` support global proposal listing when no domain is provided.
- `src/server/routes/onboarding-routes.ts` — made `/settings/profile-generations` support global proposal listing when `domain` is omitted.
- `src/db/repositories/profile-generation-repo.ts` — added `listAllProfileGenerations()` and shared safe ordering helper.
- `src/onboarding/profile-governance-service.ts` — backend image approval now enforces 2+ passing image samples and zero failures, not just preview attestation.
- `src/tests/unit/profile-governance-service.test.ts` — added/updated image approval tests for the 2+ sample gate.
- `src/onboarding/profile-generator.ts` — removed stale `canPromote` wording from source comments.
- `docs/generated-profile-governance.md` — documented the full workflow, 20 locked decisions, model routing, approval flow, and rollback.

## Tests Added or Updated

- `src/tests/unit/profile-governance-service.test.ts`
  - Updated the success case for image approval to seed 2 passing image validation samples.
  - Added regression coverage proving image approval is rejected when previews are reviewed but fewer than 2 image samples passed.

No React component unit tests were added; validation for the UI work is TypeScript compile coverage plus backend route/service tests.

## Commands Run

| Command | Result | Summary |
|---|---|---|
| `bun run typecheck` | passed | `tsc --noEmit --skipLibCheck`, 0 errors |
| `bun test src/tests/unit/profile-governance-service.test.ts` | passed | 18/18 pass, 64 expect calls |
| `bun run test` | passed | vitest 138/138 + bun test 200/200, 0 failures |
| `bunx vitest run` | passed | 138/138 pass, 12 files |
| `grep -R "canAutoPromote\|canPromote\|applyGeneratedProfileToCheerio" src` | passed | no matches |
| `git status --short \| grep '^[A-Z]' || true` | passed | no staged files |

## Validation Output

- TypeScript compile passed after adding all new React components and wiring them into `OnboardingSettings.tsx`.
- Full configured test suite passed:
  - `bun run test`: 200 bun tests and 138 vitest tests across the configured split.
  - `bunx vitest run`: 138/138 pass.
- Governance image approval is now enforced in service code, with test coverage for:
  - preview checkbox missing -> image rejected,
  - preview checkbox present but <2 passing image samples -> image rejected,
  - preview checkbox present and 2+ passing image samples -> image approved.
- Proposal queue now includes generated-proposal domains even before a trusted active profile exists.
- Source grep confirms stale `canAutoPromote`, `canPromote`, and `applyGeneratedProfileToCheerio` references are gone from `src`.

## Residual Risks

- UI behavior is TypeScript-validated but not covered by browser/RTL component tests.
- The review UI is deliberately functional and inline-styled, matching the existing settings component style; it may need UX polish after real operator use.
- The “AI revision from structured feedback” route currently creates a new revision with feedback; the deeper LLM-based selector-revision loop depends on the backend service/model path built in earlier phases and may need additional product-specific prompt tuning.
- The repo has many pre-existing working-tree changes from earlier phases and other ongoing work. There are no staged files, but the worktree is not clean.

## No Staged Files

`git status --short | grep '^[A-Z]' || true` produced no output.

## Diff Summary

Implemented Phase 4+5 governance UI and cleanup. The domain settings page now exposes task-specific model routing and generated profile governance. Generated proposals are visible by domain/status, reviewable per generation, validated per field, approved/rejected per field, and rollbacks are exposed for approved decisions. Image previews and repeated/carousel warnings are surfaced in the validation table. Structured feedback is field-specific and store-manager friendly, with an advanced CSS escape hatch. Documentation now captures the full 20-decision governance contract.

## Review Findings

- no blockers
- minor: React UI lacks dedicated component tests; TypeScript and backend service tests cover contracts, but browser-level behavior should be validated manually or with future component tests.
- minor: UI inline styles are consistent with existing settings UI but could become unwieldy if this screen grows further.

## Manual Notes

The previous Phase 4+5 worker failed due to model quota after writing much of the UI. I verified that code, completed missing queue/backend-gate/docs cleanup, added the missing backend image sample enforcement, and ran the required validation commands successfully.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented Phases 4+5 tasks 19-28 without broadening beyond generated-profile governance UI, cleanup, docs, and required validation. Added the requested UI components, integrated them into OnboardingSettings, removed stale canAutoPromote/canPromote/applyGeneratedProfileToCheerio references from src, documented the workflow, and tightened image approval enforcement to match the approved product decisions."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Evidence includes changed-files list, tests-added/updated list, commands run with pass summaries, validation output, residual risks, no-staged-files status, and review findings. Required commands passed: bun run typecheck, bun run test, bunx vitest run."
    }
  ],
  "changedFiles": [
    "src/client/components/LlmTaskConfigPanel.tsx",
    "src/client/components/GeneratedProfilesPanel.tsx",
    "src/client/components/ProfileGenerationReview.tsx",
    "src/client/components/ProfileFieldValidationTable.tsx",
    "src/client/components/ImagePreviewGrid.tsx",
    "src/client/components/ProfileRevisionFeedbackForm.tsx",
    "src/client/components/OnboardingSettings.tsx",
    "src/client/onboarding-api.ts",
    "src/server/routes/onboarding-routes.ts",
    "src/db/repositories/profile-generation-repo.ts",
    "src/onboarding/profile-governance-service.ts",
    "src/onboarding/profile-generator.ts",
    "src/tests/unit/profile-governance-service.test.ts",
    "docs/generated-profile-governance.md"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/profile-governance-service.test.ts"
  ],
  "commandsRun": [
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "0 TypeScript errors"
    },
    {
      "command": "bun test src/tests/unit/profile-governance-service.test.ts",
      "result": "passed",
      "summary": "18 pass, 0 fail, 64 expect() calls"
    },
    {
      "command": "bun run test",
      "result": "passed",
      "summary": "vitest 138/138 + bun test 200/200, 0 failures"
    },
    {
      "command": "bunx vitest run",
      "result": "passed",
      "summary": "138/138 pass across 12 files"
    },
    {
      "command": "grep -R \"canAutoPromote\\|canPromote\\|applyGeneratedProfileToCheerio\" src",
      "result": "passed",
      "summary": "no matches found"
    },
    {
      "command": "git status --short | grep '^[A-Z]' || true",
      "result": "passed",
      "summary": "no staged files"
    }
  ],
  "validationOutput": [
    "typecheck clean",
    "bun run test: vitest 138/138 and bun test 200/200 passed",
    "bunx vitest run: 138/138 passed",
    "profile-governance-service image approval tests cover missing preview attestation, insufficient image samples, and 2+ passing image samples",
    "grep confirms no stale canAutoPromote/canPromote/applyGeneratedProfileToCheerio references under src"
  ],
  "residualRisks": [
    "UI components do not yet have dedicated browser/component tests",
    "The governance UI uses inline styles consistent with existing settings code but may need UX polish after real operator testing",
    "The worktree contains many pre-existing unstaged changes from earlier phases; no files are staged"
  ],
  "noStagedFiles": true,
  "diffSummary": "Added task-model routing UI and generated-profile governance UI; integrated panels into OnboardingSettings; added global generated-proposal listing; tightened backend image approval to require 2+ passing samples; removed stale promotion/helper terminology; documented the 20 locked governance decisions.",
  "reviewFindings": [
    "no blockers",
    "minor: add browser/component tests for the new React governance flow in a future pass"
  ],
  "manualNotes": "The previous Phase 4+5 worker hit model quota after writing much of the UI. This worker verified, completed, tightened, documented, and validated the result."
}
```
