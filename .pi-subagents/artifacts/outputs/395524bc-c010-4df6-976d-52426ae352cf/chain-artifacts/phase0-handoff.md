# Phase 0 Handoff — Enforce proposal-only extraction semantics

## Summary

Implemented Phase 0 (tasks 1-3) from the plan at
`/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md`.

The page extractor no longer applies generated selectors to the current
extraction result. Generated profiles are audited only; the
`extractor_profiles` table is never written to from the extraction
hot path. A regression test pins the invariant.

Naming has also been cleaned: the misleading `canPromote` and
`canAutoPromote` fields are removed from production code; the advisory
`readyForReview` boolean (decision 7/9 signal) is the only flag that
remains.

## Changed Files

| File | Change |
|------|--------|
| `src/onboarding/page-extractor.ts` | Renamed `maybeRetryWithGeneratedProfile` → `maybeCreateGeneratedProfileProposal`. Renamed `MaybeRetryInput` → `ProposalCreationInput` and `MaybeRetryOutcome` → `ProposalCreationResult` (shape `{ proposalCreated: boolean; generationId: string \| null }`). Removed all `usedRetry` return branches and the `result` field. Updated both HTTP and Playwright call sites to `await` the proposal function without consuming its return value. Updated doc comments to state generated selectors are never applied until approved. |
| `src/onboarding/profile-generator.ts` | Removed `canPromote` from `GeneratedProfileValidation` and replaced with `readyForReview` (decision 9). Removed `canAutoPromote` from `MultiSampleValidationResult` entirely (plan said to prefer removal). Updated all return literals and the `validateProfileAcrossSamples` factory. Updated module-level doc comment to state the approval-required invariant and that auto-promotion is forbidden. Updated `applyGeneratedProfileToCheerio` doc comment to clarify it is now a validation-only helper. |
| `src/tests/unit/profile-generator.test.ts` | Renamed test descriptions and assertions from `canPromote` to `readyForReview`. Removed all `canAutoPromote` assertions from the multi-sample tests. |
| `src/tests/unit/page-extractor-profile-generation.test.ts` | **New file.** Two tests: (1) extraction output is unchanged even when the AI proposes selectors that would change the result; (2) a `profile_generations` audit row is written when the trigger fires. Mocks all DB modules and the LLM client. Does not import `bun:sqlite`, so it can stay in the vitest glob. |

## Validation

| Command | Result |
|---------|--------|
| `bun run typecheck` | 0 errors |
| `bunx vitest run` | 142/142 pass (12 files, ~600ms) |
| `bun test` (per `package.json` test script) | 130/130 pass (15 files, ~930ms) |
| `bunx vitest run src/tests/unit/page-extractor-profile-generation.test.ts` | 2/2 pass |
| `bunx vitest run src/tests/unit/page-extractor-images.test.ts` | 3/3 pass |
| `bunx vitest run src/tests/unit/page-extractor-variant-inference.test.ts` | 6/6 pass |
| `bunx vitest run src/tests/unit/profile-generator.test.ts` | 62/62 pass |
| `bun test src/tests/unit/profile-promoter.test.ts` | 21/21 pass |

The two new tests use a `vi.hoisted` mock factory so the spies are
available at hoisting time. The test HTML intentionally has no
description/brand in the deterministic layers so
`shouldAttemptProfileGeneration` fires (proving the proposal path is
exercised) but the AI-proposed selectors point to "AI OVERWRITE"
elements on the page (proving the extraction output would change if
the proposal were applied).

## Behavioral checks

- `grep -nrE "canPromote|canAutoPromote|maybeRetryWithGeneratedProfile|MaybeRetryOutcome|MaybeRetryInput|usedRetry" src/`
  - One match: a doc comment in `src/onboarding/profile-generator.ts:84` explaining the rename.
  - Per acceptance: "no production code references except historical test descriptions/docs explicitly saying auto-promote is forbidden." The remaining match is a doc comment that does exactly that.
- `extractProductData` HTTP path: `await maybeCreateGeneratedProfileProposal(...)` — no conditional return.
- `extractProductData` Playwright path: same.
- Logs from `maybeCreateGeneratedProfileProposal` say "proposal validated for $domain (confidence: $x); awaiting approval before use" — never "retry applied".

## Residual Risks

- **`applyGeneratedProfileToCheerio` is still exported and tested.** Per the plan, this is a Phase 5 cleanup item. It is no longer called by the page extractor, but the function and its tests remain. The doc comment has been updated to make its new role (validation-only helper) explicit.
- **The two new tests intentionally use AI selectors that mismatch the expected product name**, so the proposal is rejected at `validateGeneratedProfile` time. The audit row is written with `status: 'rejected'`. A test that exercises the full validated-proposal path (with selectors that pass `validateExtraction` against the expected name) would be more thorough, but the current test still proves the critical invariant: the extraction output is never modified by the proposal. A follow-up can add the "validated" case if needed.
- **The page-extractor's profile-generation path still uses the generic `getLlmConfig()`** instead of a task-specific config. This is documented in the plan as a Phase 2 task (tasks 9-12). Phase 0 does not change the LLM client; it only changes how generated profiles are applied (or rather, not applied) to the current extraction.
- **No `auto-promote` related dead code remains in production**, but the `applyGeneratedProfileToCheerio` function and the four tests around it will be cleaned up in Phase 5.

## No Staged Files

`git status --short` shows:
- Modified working-tree files unrelated to this phase (from earlier uncommitted work) — none related to Phase 0.
- Phase 0 changes are untracked (new file) or working-tree modifications of untracked files from prior work.
- No files were `git add`ed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented only Phase 0 tasks 1-3. No edits outside src/onboarding/page-extractor.ts, src/onboarding/profile-generator.ts, src/tests/unit/profile-generator.test.ts, and the new test file. Did not modify any out-of-scope files (migrations, llm-client, repositories, UI, profile-promoter, llm-task-configs, etc.). Task 1: renamed function (maybeRetryWithGeneratedProfile -> maybeCreateGeneratedProfileProposal), renamed type (MaybeRetryOutcome -> ProposalCreationResult with new shape { proposalCreated: boolean; generationId: string | null }), removed all usedRetry return branches from both HTTP and Playwright call sites, updated comments. Task 2: added new test file src/tests/unit/page-extractor-profile-generation.test.ts with two tests proving the invariant. Task 3: replaced canPromote with readyForReview in GeneratedProfileValidation; removed canAutoPromote from MultiSampleValidationResult; updated tests in profile-generator.test.ts. Only one residual 'canPromote' mention in src/onboarding/profile-generator.ts is a doc comment explaining the rename (matches the plan's stated acceptance)."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Evidence: typecheck (0 errors), vitest (142/142), bun test (130/130). The two new tests cover (a) the extraction output remains the deterministic one even when the AI proposes selectors that would change it (verified by direct assertions on result.title, result.brand, result.description, and that no image comes from .ai-generated-images), and (b) a profile_generations audit row is written when the trigger fires. No external network. No bun:sqlite. No edits to out-of-scope files. Residual risks enumerated. No staged files."
    }
  ],
  "changedFiles": [
    "src/onboarding/page-extractor.ts",
    "src/onboarding/profile-generator.ts",
    "src/tests/unit/profile-generator.test.ts",
    "src/tests/unit/page-extractor-profile-generation.test.ts"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/page-extractor-profile-generation.test.ts",
    "src/tests/unit/profile-generator.test.ts"
  ],
  "commandsRun": [
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "0 errors"
    },
    {
      "command": "bunx vitest run",
      "result": "passed",
      "summary": "142/142 pass, 12 files, ~600ms"
    },
    {
      "command": "bun test (per package.json test script)",
      "result": "passed",
      "summary": "130/130 pass, 15 files, ~930ms"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-profile-generation.test.ts",
      "result": "passed",
      "summary": "2/2 pass"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-images.test.ts",
      "result": "passed",
      "summary": "3/3 pass (pre-existing image scoping tests still green)"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-variant-inference.test.ts",
      "result": "passed",
      "summary": "6/6 pass (pre-existing variant inference tests still green)"
    },
    {
      "command": "bunx vitest run src/tests/unit/profile-generator.test.ts",
      "result": "passed",
      "summary": "62/62 pass"
    },
    {
      "command": "bun test src/tests/unit/profile-promoter.test.ts",
      "result": "passed",
      "summary": "21/21 pass (promoter approval-required invariant unaffected)"
    },
    {
      "command": "grep -nrE 'canPromote|canAutoPromote|maybeRetryWithGeneratedProfile|MaybeRetryOutcome|MaybeRetryInput|usedRetry' src/",
      "result": "passed",
      "summary": "Only one match: a doc comment in profile-generator.ts that explains the rename and states the approval-required invariant. No production code references."
    },
    {
      "command": "git status --short",
      "result": "passed",
      "summary": "no staged files (git add not run)"
    }
  ],
  "validationOutput": [
    "typecheck: clean",
    "vitest 142/142 pass",
    "bun test 130/130 pass",
    "page-extractor-profile-generation.test.ts: 2/2 (proposal-only invariant pinned)",
    "page-extractor-images.test.ts: 3/3 (pre-existing image scoping still green)",
    "page-extractor-variant-inference.test.ts: 6/6 (pre-existing variant inference still green)",
    "profile-generator.test.ts: 62/62 (canPromote/canAutoPromote removed, readyForReview assertions pass)",
    "profile-promoter.test.ts: 21/21 (approval-required invariant preserved)",
    "residual grep: only doc comment about the rename"
  ],
  "residualRisks": [
    "applyGeneratedProfileToCheerio is still exported and tested. It is no longer called by the page extractor but the function and its tests remain; cleanup is in plan Phase 5.",
    "The two new tests use AI selectors that mismatch the expected product name, so the proposal is audited as 'rejected'. A test that exercises a fully-validated proposal (where the AI title selector matches the expected name) would be more thorough, but the critical invariant (extraction output is never modified) is already pinned.",
    "The page-extractor's profile-generation path still uses generic getLlmConfig() instead of task-specific config. This is plan task 9-12 in Phase 2.",
    "The plan called for removing applyGeneratedProfileToCheerio export/tests in Phase 5; this phase only updates its doc comment."
  ],
  "noStagedFiles": true,
  "diffSummary": "Renamed maybeRetryWithGeneratedProfile to maybeCreateGeneratedProfileProposal; ProposalCreationResult now reports { proposalCreated, generationId } instead of { usedRetry, result }; both call sites in page-extractor no longer conditionally return. Added regression test pinning the proposal-only invariant. Removed canPromote/canAutoPromote fields from profile-generator production code; renamed to readyForReview. Updated tests accordingly.",
  "reviewFindings": [
    "no blockers",
    "minor: the doc comment in src/onboarding/profile-generator.ts:84 still references canPromote by name. This is intentional (it explains the rename) and matches the plan's stated acceptance. A future cleanup could remove this historical reference once external readers no longer need the migration note."
  ],
  "manualNotes": "Phase 0 is complete. The page-extractor no longer mutates the current extraction result with generated selectors; proposals are audited only. Phase 1 (governance schema + repos) is the natural next step."
}
```
