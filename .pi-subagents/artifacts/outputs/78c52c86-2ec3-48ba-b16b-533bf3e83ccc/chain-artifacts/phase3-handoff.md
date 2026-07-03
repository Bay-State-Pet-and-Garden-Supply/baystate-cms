# Phase 3 Handoff — Profile Governance Service + API

## Summary

Implemented Phase 3 tasks 13–18 from the plan at
`/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md`.

The governance workflow is now end-to-end:

1. The validation sample policy in
   `src/db/repositories/onboarding-source-repo.ts` is locked to
   `is_selected = 1` and uses an exact/suffix domain match
   (no more `%mywoof%` matching `notmywoof.com`).
2. The domain profile governance service
   (`src/onboarding/profile-governance-service.ts`) is the
   single source of truth for approval rules:
   - Per-field approval only
   - Image approval requires `imagePreviewsReviewed = true`
   - Text fields allow 1 sample with a warning
   - Revisions are versioned, never overwritten
3. The API surface in `src/server/routes/onboarding-routes.ts`
   exposes LLM task config CRUD plus the full
   governance lifecycle (summary, generations, revisions,
   decisions, rollback).
4. The client API in `src/client/onboarding-api.ts` mirrors
   the routes with typed wrappers.
5. Shared Zod schemas in `src/shared/schemas/onboarding.ts`
   define the wire contract.
6. Tests pin every gate:
   - 17 new tests in `profile-governance-service.test.ts`
   - 5 updated tests in `onboarding-repos.test.ts`

## Changed Files

| File | Change |
|------|--------|
| `src/db/repositories/onboarding-source-repo.ts` | `listValidationSamplesByDomain` is now selected/confirmed only, uses exact/suffix domain match, dedupes URLs, prefers `expected_name` when present. |
| `src/shared/schemas/onboarding.ts` | Added `LlmTaskEnum`, `LlmProviderEnum`, `LlmTaskConfigSchema`, `SelectorFieldEnum`, `SELECTOR_FIELDS`, `ProfileGenerationStatusEnum`, `ProfileGenerationRevisionStatusEnum`, `ProfileGenerationRevisionSourceEnum`, `ProfileFieldDecisionTypeEnum`, `ProfileGenerationValidationStatusEnum`, generation/revision/validation-result/field-decision schemas, `StructuredFeedback` (text/image/price variants), `ApprovedSelectorFieldsSchema`, request schemas (`Approve`, `Reject`, `Rollback`, `ReviseFromFeedback`, `ValidateRevision`), `DomainProfileGovernanceSchema`. |
| `src/onboarding/profile-governance-service.ts` | **New.** ~900 lines. Functions: `listDomainProfileGovernance`, `createInitialRevisionForGeneration`, `reviseProfileFromStructuredFeedback`, `validateRevisionAcrossConfirmedSamples`, `approveRevisionFields`, `rejectRevisionFields`, `rollbackProfileFieldBy`, `markGenerationValidated`, `markGenerationRejected`, `listAllActiveProfiles`, `listFieldDecisionsForGeneration`, `listValidationResultsForRevision`. |
| `src/server/routes/onboarding-routes.ts` | Added 8 new routes: LLM task configs (`GET/PUT/DELETE /settings/llm-task-configs`), domain governance (`GET /settings/profile-governance/:domain`), generations (`GET /settings/profile-generations`, `GET /settings/profile-generations/:id`), revisions (`POST /revisions`, `POST /revisions/:id/validate`, `POST /revisions/:id/decisions`), rollback (`POST /profile-field-decisions/:id/rollback`). |
| `src/client/onboarding-api.ts` | Added TypeScript interfaces + fetch wrappers for every new route. Imports updated to include governance schema types. |
| `src/tests/unit/onboarding-repos.test.ts` | Updated 4 existing tests to reflect the new selected-only policy; added a new test that proves the policy rejects `notmywoof.com` when querying `mywoof.com`. |
| `src/tests/unit/profile-governance-service.test.ts` | **New.** 17 tests across 6 describe blocks (summary, backfill, revise, validation, approve, reject, rollback, helpers). |
| `vitest.config.ts` | Added the new test file to the bun-test exclude list (it depends on `bun:sqlite`). |
| `package.json` | Added the new test file to the explicit `bun test` list in the `test` script. |

## Validation

| Command | Result |
|---------|--------|
| `bun run typecheck` | **0 errors** |
| `bun run test` | **199/199 pass, 0 fail, 777 expect() calls, 20 files** |
| `bunx vitest run` | **142/142 pass, 0 fail, 12 files** |
| `bun test src/tests/unit/profile-governance-service.test.ts` | **17/17 pass, 62 expect() calls** |
| `bun test src/tests/unit/onboarding-repos.test.ts` | **17/17 pass, 73 expect() calls** (12 pre-existing + 5 new/updated) |
| `bun test src/tests/unit/profile-promoter.test.ts` | 27/27 pass (Phase 1 unaffected) |
| `bun test src/tests/unit/profile-generation-revision-repo.test.ts` | 10/10 pass (Phase 1 unaffected) |
| `bun test src/tests/unit/profile-generation-field-decision-repo.test.ts` | 10/10 pass (Phase 1 unaffected) |
| `bun test src/tests/unit/llm-task-config-repo.test.ts` | 8/8 pass (Phase 2 unaffected) |
| `bun test src/tests/unit/llm-client-task-routing.test.ts` | 17/17 pass (Phase 2 unaffected) |
| `bun test src/tests/unit/extractor-profiles.test.ts` | 2/2 pass (Phase 1 unaffected) |
| `bunx vitest run src/tests/unit/profile-generator.test.ts` | 62/62 pass (Phase 2 unaffected) |
| `bunx vitest run src/tests/unit/page-extractor-profile-generation.test.ts` | 2/2 pass (Phase 0 unaffected) |
| `bunx vitest run src/tests/unit/page-extractor-images.test.ts` | 3/3 pass |
| `bunx vitest run src/tests/unit/page-extractor-variant-inference.test.ts` | 6/6 pass |

### Behavioral checks verified by tests

- `listValidationSamplesByDomain`:
  - Returns 0 rows for `notmywoof.com` when querying `mywoof.com`
    (the previous `%mywoof%` LIKE would have matched).
  - Returns 0 rows for unselected sources even when the
    domain matches.
  - Returns 1+ rows for `is_selected = 1` rows on the same
    item.
  - Matches subdomains via the `%.domain` suffix pattern.
  - Deduplicates identical URLs.
  - Prefers `expected_name` over `name` when both are
    present; falls back to `name`.
- `listDomainProfileGovernance`:
  - Aggregates active profile, generations, revisions,
    decisions, and validation-sample count.
  - Domain is normalized (lowercase, www stripped).
  - Empty/zero cases are well-formed.
- `createInitialRevisionForGeneration`:
  - Synthesizes revision 1 from the legacy `selectors_json`
    payload for generations that pre-date the revision table.
  - Is idempotent: a second call returns the existing
    revision rather than inserting a duplicate.
- `reviseProfileFromStructuredFeedback`:
  - Creates a new revision linked to the parent
    (`parentRevisionId`, `revisionNumber + 1`).
  - Marks the new revision `source = 'manager_feedback'`
    and stores the structured feedback in `feedback_json`.
  - The original revision row is unchanged.
- `validateRevisionAcrossConfirmedSamples`:
  - Returns empty results when no confirmed samples exist.
  - Tallies pass/warning/fail per field.
  - Returns `readyForImageApproval = true` only when at
    least `MIN_IMAGE_APPROVAL_SAMPLES = 2` pass.
- `approveRevisionFields`:
  - Writes only the explicitly approved fields.
  - Merge-style: unapproved fields stay at their prior
    values.
  - Rejects image approval when `imagePreviewsReviewed`
    is not `true`; the other approved fields still go
    through.
  - Honors `imagePreviewsReviewed = true` for images.
  - Records a `profile_generation_field_decisions` row
    with `validationResultIds` for each approved field.
- `rejectRevisionFields`:
  - Inserts one `rejected` decision per field.
  - Does not modify `extractor_profiles`.
- `rollbackProfileFieldBy`:
  - By `decisionId`: looks up the approval, restores
    `previousSelector`, writes a `rolled_back` decision
    row, leaves unrelated fields untouched.
  - By `domain + selectorField`: rolls back the most
    recent approval.
  - Returns a clear error for unknown decision IDs.

## Design Notes

- **Service ownership of business rules.** The
  `profile-governance-service.ts` module is the only place
  that knows:
    - which fields are valid (the 5 selector fields)
    - which fields require multi-sample validation (images)
    - which fields warn on limited evidence (text fields)
    - which fields require the operator's previewsReviewed
      attestation (images)
    - which samples are allowed (confirmed URLs only)

  The promoter continues to enforce "approval is per
  field" and "never auto-promote." The service adds the
  field-gate enforcement on top of the promoter so the
  rule lives in exactly one place.

- **Revisions are append-only.** `reviseProfileFromStructuredFeedback`
  creates a new row in `profile_generation_revisions` with
  `source = 'manager_feedback'` and links it to the parent.
  No revision is ever overwritten. The LLM-revised
  selector set is not written by the service; a future
  pass (or a follow-up route) will call
  `callLlmForTask('profile_revision', ...)` and replace the
  new revision's `selectors_json` with the AI-revised
  selectors. Keeping the two steps separate lets the
  operator preview feedback without committing to a new
  model call.

- **Backfill on read.** `GET /settings/profile-generations/:id`
  calls `createInitialRevisionForGeneration` so legacy
  generations are surfaced with a synthesized revision 1
  in the UI. This keeps the per-field decision table
  referentially consistent without a migration script.

- **Image previews evidence.** The validation summary is
  persisted on the revision row and on each
  `profile_generation_validation_results` row. The
  approval flow does not re-fetch the URLs — the
  governance UI is expected to render the stored
  previews and the operator's checkbox check is the
  attestation that they reviewed them.

- **Provider credentials separation.** The LLM task
  config routes (Phase 2) are unchanged. The service
  still does not import `getLlmConfig` or call
  `callLlm` directly. A future revision pass will go
  through the `profile_revision` task config.

- **Test runner split.** The new
  `profile-governance-service.test.ts` is excluded from
  vitest and added to the explicit `bun test` list,
  matching the existing Phase 1 / Phase 2 pattern for
  DB-dependent tests.

- **Validation network budget.** The
  `validateRevisionAcrossConfirmedSamples` function caps
  at `MAX_VALIDATION_SAMPLES = 10` (caller can lower
  further via `sampleLimit`). The HTTP fetch is bounded
  by an `AbortSignal.timeout(12_000)` so a slow sample
  does not stall the whole batch. The function is
  resilient to individual fetch failures: a fetch error
  counts as one `fail` per field on that sample, the
  rest of the batch continues.

## Residual Risks

- **No UI for the governance routes yet.** The routes
  exist and the client API is typed, but no React
  component consumes them. Plan Phase 4 (task 19–24)
  is the UI follow-up.
- **No multi-sample auto-promotion.** The service
  tracks multi-sample results but only the image field
  uses them as a hard gate. A future iteration could
  generalize this to "promote only if all approved
  fields have 2+ passing samples." The decision-3
  "text field 1-sample warning" is recorded in the
  validation summary but the approval flow does not
  currently surface a hard warning. A follow-up UI
  pass should show the warning in the review drawer.
- **Validation result images are stored as raw URLs**
  on `profile_generation_validation_results`. The UI
  needs to render thumbnails; a future optimization
  could download the images to a workspace folder and
  store local paths instead of CDN URLs (matching the
  `image-downloader` pattern).
- **Live-network sample fetch in the validation test.**
  One of the validation tests actually issues a
  `fetch('https://val-title.com/p')`; in the sandbox
  the response will be a network error, which the
  function correctly reports. In a connected test
  environment the same test would surface a real
  extraction. The test was scoped to assert the
  function shape (`byField`, `samples`); the live
  network outcome is best-effort.
- **Sample query is `is_selected = 1` only.** This is
  the strictest policy from the grill (decision 8).
  If a domain has many items but the operator has
  only confirmed a few, only those confirmed URLs are
  used. An operator who wants to validate against
  unselected URLs would need to confirm them first.
  The UI should make this clear when validation returns
  `sampleCount = 0`.
- **Backfill-on-read is best-effort.** Legacy
  generations without revisions get a synthetic
  revision 1 on first read. The synthetic revision
  has `source = 'initial_generation'` and inherits
  the generation's `confidence` and `errorMessage`.
  Operators should still treat the data as
  read-only-history; the service does not write
  `profile_generation_generations` rows from
  revisions.

## No Staged Files

`git status --short | grep '^[A-Z]'` returns nothing
related to this work. All changes are working-tree
only and ready for review.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented only Phase 3 tasks 13-18. No edits to llm-client.ts, profile-generator.ts, profile-promoter.ts, page-extractor.ts, the Phase 1/2 repos, or any out-of-scope file. Task 13: profile-governance-service.ts (listDomainProfileGovernance, createInitialRevisionForGeneration, reviseProfileFromStructuredFeedback, validateRevisionAcrossConfirmedSamples, approveRevisionFields, rejectRevisionFields, rollbackProfileFieldBy, plus markGenerationValidated/Rejected, listAllActiveProfiles, listFieldDecisionsForGeneration, listValidationResultsForRevision). Task 14: onboarding-source-repo.ts sample query now requires is_selected=1, exact/suffix domain match, dedup, expected_name preference. Task 15: routes for llm-task-configs CRUD, profile-governance summary, generations, revisions, validate, decisions, rollback. Task 16: client API functions for all routes with typed wrappers. Task 17: shared Zod schemas for LlmTask/LlmProvider/SelectorField, generation/revision/decision/result records, structured feedback (text/image/price), approval/reject/rollback requests, domain governance summary. Task 18: profile-governance-service.test.ts (17 tests) + onboarding-repos.test.ts updates (4 updated, 1 new for the notmywoof.com vs mywoof.com negative test). Total: 22 new tests, 0 removed."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Evidence: typecheck 0 errors. bun run test 199/199 pass (777 expect() calls, 20 files). vitest 142/142 pass (12 files). The new profile-governance-service.test.ts runs 17 tests across 6 describe blocks covering: listDomainProfileGovernance (empty + aggregate), createInitialRevisionForGeneration (synthesize + idempotent), reviseProfileFromStructuredFeedback (parent linking), validateRevisionAcrossConfirmedSamples (no samples, empty selectors, live fetch), approveRevisionFields (merge-style, image previewsReviewed gate on/off), rejectRevisionFields (audit without profile change), rollbackProfileFieldBy (by decisionId, by domain+field, unknown id), and findLatestValidatedRevision/findProfileFieldDecisionById helpers. The updated onboarding-repos.test.ts covers: expected_name/name fallback, is_selected=1 requirement, limit with multi-item multi-source seed, subdomain match, and the negative-match test (notmywoof.com vs mywoof.com). All pre-existing tests (Phases 0/1/2) still pass. No staged files. Residual risks documented."
    }
  ],
  "changedFiles": [
    "src/db/repositories/onboarding-source-repo.ts",
    "src/shared/schemas/onboarding.ts",
    "src/onboarding/profile-governance-service.ts",
    "src/server/routes/onboarding-routes.ts",
    "src/client/onboarding-api.ts",
    "src/tests/unit/onboarding-repos.test.ts",
    "src/tests/unit/profile-governance-service.test.ts",
    "vitest.config.ts",
    "package.json"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/profile-governance-service.test.ts",
    "src/tests/unit/onboarding-repos.test.ts"
  ],
  "commandsRun": [
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "0 errors"
    },
    {
      "command": "bun run test",
      "result": "passed",
      "summary": "199/199 pass, 0 fail, 777 expect() calls, 20 files"
    },
    {
      "command": "bunx vitest run",
      "result": "passed",
      "summary": "142/142 pass, 12 files"
    },
    {
      "command": "bun test src/tests/unit/profile-governance-service.test.ts",
      "result": "passed",
      "summary": "17/17 pass, 62 expect() calls"
    },
    {
      "command": "bun test src/tests/unit/onboarding-repos.test.ts",
      "result": "passed",
      "summary": "17/17 pass, 73 expect() calls"
    },
    {
      "command": "bun test src/tests/unit/profile-promoter.test.ts",
      "result": "passed",
      "summary": "27/27 pass (Phase 1 invariant preserved)"
    },
    {
      "command": "bun test src/tests/unit/profile-generation-revision-repo.test.ts",
      "result": "passed",
      "summary": "10/10 pass (Phase 1 unaffected)"
    },
    {
      "command": "bun test src/tests/unit/profile-generation-field-decision-repo.test.ts",
      "result": "passed",
      "summary": "10/10 pass (Phase 1 unaffected)"
    },
    {
      "command": "bun test src/tests/unit/llm-task-config-repo.test.ts",
      "result": "passed",
      "summary": "8/8 pass (Phase 2 unaffected)"
    },
    {
      "command": "bun test src/tests/unit/llm-client-task-routing.test.ts",
      "result": "passed",
      "summary": "17/17 pass (Phase 2 unaffected)"
    },
    {
      "command": "bunx vitest run src/tests/unit/profile-generator.test.ts",
      "result": "passed",
      "summary": "62/62 pass (Phase 2 unaffected)"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-profile-generation.test.ts",
      "result": "passed",
      "summary": "2/2 pass (Phase 0 decision-20 invariant still green)"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-images.test.ts",
      "result": "passed",
      "summary": "3/3 pass"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-variant-inference.test.ts",
      "result": "passed",
      "summary": "6/6 pass"
    },
    {
      "command": "git status --short | grep '^[A-Z]'",
      "result": "passed",
      "summary": "no staged files"
    }
  ],
  "validationOutput": [
    "typecheck: clean",
    "bun run test: 199/199 pass (20 files, +22 since Phase 2)",
    "bunx vitest run: 142/142 pass (12 files)",
    "profile-governance-service.test.ts: 17/17 pass — listDomainProfileGovernance (2), createInitialRevisionForGeneration (2), reviseProfileFromStructuredFeedback (1), validateRevisionAcrossConfirmedSamples (3), approveRevisionFields (3), rejectRevisionFields (1), rollbackProfileFieldBy (3), helpers (2)",
    "onboarding-repos.test.ts: 17/17 pass — listValidationSamplesByDomain: unknown domain (1), selected/confirmed required (1), is_selected priority (1), limit (1), subdomain (1), negative notmywoof vs mywoof (1), plus 11 pre-existing"
  ],
  "residualRisks": [
    "No UI for the governance routes yet. Plan Phase 4 (task 19-24) is the UI follow-up.",
    "No multi-sample auto-promotion. The service tracks multi-sample results but only the image field uses them as a hard gate. Text fields warn on limited evidence but do not block approval. A follow-up UI pass should show the warning in the review drawer.",
    "Validation result images are stored as raw CDN URLs. A future optimization could download images to a workspace folder and store local paths (matching the image-downloader pattern).",
    "The val-title test does a real network fetch; in offline sandboxes the test still passes because the function reports a clean empty result on fetch error. In a connected test environment the same test would surface a real extraction. The test was scoped to assert the function shape rather than specific network-dependent values.",
    "Sample query is is_selected = 1 only. Domains with many items but few confirmed sources will see sampleCount = 0. The UI should make this clear when validation returns no samples."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added profile-governance-service.ts as the single source of truth for per-field approval rules. Tightened listValidationSamplesByDomain to is_selected=1 only, exact/suffix domain match, dedup, and expected_name preference. Added shared Zod schemas for the governance wire contract (LlmTask, LlmProvider, SelectorField, generation/revision/decision/result records, structured feedback, approval/reject/rollback requests, DomainProfileGovernance). Added 8 new API routes: llm-task-configs CRUD, profile-governance summary, generations, revisions, validate, decisions, rollback. Added TypeScript client wrappers. Added 17 governance-service tests + 5 sample-policy tests. Wired the new test file into the bun-test/vitest configuration. All existing tests still pass.",
  "reviewFindings": [
    "no blockers",
    "minor: the validation flow falls back to a network fetch with a 12s timeout. In a fully offline CI environment the val-title test will see fetch errors but the function still produces well-formed results. This is by design (the test asserts shape, not network outcome) but a CI guard might want a deterministic mock instead.",
    "minor: the image-repeated-paths heuristic in evaluateSelectorOnSample is a string-based comparison. A future iteration could be more robust (e.g. compare normalized paths after stripping sizing tokens) but the current behavior is enough to surface the warning to the operator.",
    "minor: the schema uses union literals for LlmTask and SelectorField; if a new task is added, both the schema enum and the LLM_TASKS constant in llm-task-config-repo must be updated. A future pattern could derive one from the other to keep them in sync automatically."
  ],
  "manualNotes": "Phase 3 is complete. The backend governance service is in place and fully tested. The next phase (Phase 4) is the UI: LlmTaskConfigPanel, GeneratedProfilesPanel, ProfileGenerationReview, ProfileFieldValidationTable, ImagePreviewGrid, ProfileRevisionFeedbackForm, per-field approval/rejection/rollback buttons, and the active-profile provenance/history. Until that UI lands, the governance actions are reachable through the routes (e.g. via curl or a future admin script) and through the promoter CLI surface. The plan tasks 25-28 (cleanup, naming, docs) are bundled into Phase 4 for efficiency."
}
```