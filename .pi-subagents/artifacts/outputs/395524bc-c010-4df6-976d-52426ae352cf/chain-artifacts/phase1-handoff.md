# Phase 1 Handoff — Governance Schema, Repos, Promoter Refactor, Rollback

## Summary

Implemented Phase 1 (tasks 4-8) from the plan at
`/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md`.

The promoter no longer stores per-field decisions in the legacy
`profile_generations.validation` JSON blob. Three new normalized tables
now own the governance history:

- `profile_generation_revisions` — versioned history of selector proposals
  tied to a parent generation, with parent-chaining, source labels
  (`initial_generation` / `manager_feedback` / `manual_css` /
  `system_validation`), and a 4-state lifecycle (`draft`, `validated`,
  `rejected`, `superseded`).
- `profile_generation_validation_results` — per-revision / per-field /
  per-sample evidence rows. Each row carries the extracted value (or
  image previews), warnings, and a `pass | warning | fail` status.
- `profile_generation_field_decisions` — append-only per-field approval
  / rejection / rollback history. The `previous_selector` column is
  what `rollbackProfileField()` restores from.

The promoter now:
1. Resolves the latest validated revision (with a fallback to the
   legacy `profile_generations.selectors_json` payload for un-migrated
   rows).
2. Captures the previous active selector for every approved field
   **before** writing so rollback can restore it.
3. Writes one `profile_generation_field_decisions` row per approved
   field and per rejected field. Per-field approval IDs are returned
   in the result so a UI can immediately offer rollback.
4. Provides `rollbackProfileField(decisionId)` and
   `rollbackLatestApprovedField(domain, selectorField)` for
   per-field undo. Rollback writes a `rolled_back` decision and
   the active profile is restored to the prior value via merge-style
   `upsertProfile` so unrelated fields are untouched.
5. Keeps the legacy `profile_generations.status` column in sync for
   structural rejections (no title, `proposed` status) so existing
   UIs and tests that read the legacy column still work.

`findLatestApprovedFieldDecision()` excludes approvals that have a
subsequent `rolled_back` decision with a matching `previous_selector`
so a caller cannot double-roll-back the same approval.

## Changed Files

| File | Change |
|------|--------|
| `src/db/migrations.ts` | Added three normalized tables: `profile_generation_revisions` (id, generation_id FK CASCADE, revision_number, parent_revision_id FK self-ref, source, feedback_json, selectors_json, field_samples_json, validation_summary_json, status, confidence, llm_task, llm_provider, llm_model, error_message, timestamps) with indexes on `generation_id`, `parent_revision_id`, `status`; `profile_generation_validation_results` (id, revision_id FK CASCADE, selector_field, sample_url, item_id, expected_name, brand_hint, extracted_value_json, image_previews_json, warnings_json, status, created_at) with indexes on `revision_id` and `(revision_id, selector_field)`; `profile_generation_field_decisions` (id, generation_id FK CASCADE, revision_id FK, domain, selector_field, decision, previous_selector, proposed_selector, approved_selector, feedback_json, validation_result_ids_json, decided_at, decided_by, notes) with indexes on `generation_id`, `revision_id`, `(domain, selector_field)`, `(domain, decision)`. All `IF NOT EXISTS`. |
| `src/db/repositories/profile-generation-revision-repo.ts` | **New.** 423 lines. Typed interfaces for `ProfileGenerationRevision`, `ProfileGenerationRevisionStatus`, `ProfileGenerationRevisionSource`, `ProfileGenerationValidationResult`, `ProfileGenerationValidationStatus`. Functions: `insertProfileGenerationRevision`, `findProfileGenerationRevisionById`, `listRevisionsByGeneration`, `findLatestValidatedRevision`, `updateProfileGenerationRevisionStatus`, `insertRevisionValidationResult`, `insertRevisionValidationResults` (batch), `listValidationResultsByRevision`. JSON round-trip helpers. |
| `src/db/repositories/profile-generation-field-decision-repo.ts` | **New.** 249 lines. Typed interfaces for `ProfileGenerationFieldDecision`, `ProfileGenerationFieldDecisionType`. Functions: `insertProfileFieldDecision`, `findProfileFieldDecisionById`, `listFieldDecisionsByDomain` (with `selectorField` and `decision` filters and ordering), `listFieldDecisionsByGeneration`, `findLatestApprovedFieldDecision` (NOT EXISTS subquery to exclude rolled-back approvals). Domain normalization matches `extractor-profile-repo.ts`. |
| `src/onboarding/profile-promoter.ts` | Refactored. The new `promoteGeneratedProfile()`: (1) resolves selectors from the latest validated revision (or falls back to the legacy `selectors_json` blob), (2) captures `previous_selector` from `findProfileByDomain()` before `upsertProfile()`, (3) records per-field decision rows (approved or rejected) for every operator action, (4) returns `approvalDecisionIds` and `rejectionDecisionIds` for UI use. `rollbackProfileField(decisionId)` reads the prior `approved_selector` as the rollback target, calls merge-style `upsertProfile()` to restore only that one field, and inserts a `rolled_back` decision row. `rollbackLatestApprovedField(domain, selectorField)` is a convenience wrapper for the "rollback latest" UI button. The legacy `profile_generations.status` column is updated to `rejected` for structural rejections (no title, `proposed` status) so existing UI/test behavior is preserved. |
| `src/tests/unit/profile-promoter.test.ts` | Updated 3 audit-trail tests to assert against `profile_generation_field_decisions` (instead of the legacy `validation.approvals` / `validation.approvalAttempts` JSON blobs). Updated the "missing generation id" test to reflect that no decision rows can be recorded when the domain is unknown. Added a new `rollback` describe block with 6 tests: full-merge rollback restores prior active selector and writes a `rolled_back` decision; rollback clears a selector when the field had no prior value; rollback is rejected for non-approval decisions; rollback of an unknown id is rejected; `rollbackLatestApprovedField` finds the most recent unrolled-back approval; partial rollback preserves unrelated fields via merge-style upsert. |
| `src/tests/unit/profile-generation-revision-repo.test.ts` | **New.** 10 tests covering: insert/find round-trip, parent revision chaining, status filter, latest-validated lookup, missing-validated null case, status update + `updated_at` bump, validation result round-trip, batch validation insertion, FK cascade on parent generation deletion, complex JSON round-trip. Uses isolated SQLite DB with `runMigrations()`. |
| `src/tests/unit/profile-generation-field-decision-repo.test.ts` | **New.** 10 tests covering: insert/find round-trip, domain normalization (lowercase + strip www.), JSON round-trip of `feedback` and `validationResultIds`, list/filter by domain+field+decision, list by generation, latest-approved lookup (most recent unrolled-back), latest-approved excludes rolled-back approvals, latest-approved null when empty, `decided_by` and `notes` round-trip. |
| `package.json` | Added `src/tests/unit/profile-generation-revision-repo.test.ts` and `src/tests/unit/profile-generation-field-decision-repo.test.ts` to the explicit `bun test` list in the `test` script. |
| `vitest.config.ts` | Added both new test files to the vitest exclude list so they only run under `bun test` (they use `bun:sqlite`). |

## Validation

| Command | Result |
|---------|--------|
| `bun run typecheck` | **0 errors** |
| `bunx vitest run` | **142/142 pass** (12 files) |
| `bun test` (per `package.json` test script) | **156/156 pass** (17 files) |
| `bun test src/tests/unit/profile-promoter.test.ts` | 27/27 pass (21 pre-existing + 6 new rollback) |
| `bun test src/tests/unit/profile-generation-revision-repo.test.ts` | 10/10 pass |
| `bun test src/tests/unit/profile-generation-field-decision-repo.test.ts` | 10/10 pass |
| `bun test src/tests/unit/profile-generation-repo.test.ts` | 21/21 pass (pre-existing, unchanged) |
| `bunx vitest run src/tests/unit/page-extractor-images.test.ts` | 3/3 pass |
| `bunx vitest run src/tests/unit/page-extractor-variant-inference.test.ts` | 6/6 pass |
| `bunx vitest run src/tests/unit/page-extractor-profile-generation.test.ts` | 2/2 pass |
| `bunx vitest run src/tests/unit/profile-generator.test.ts` | 62/62 pass |

### Behavioral checks verified by tests

- **Normalization:** `WWW.DecNorm.com` and `decnorm.com` resolve to the
  same decision row; `findProfileByDomain` was unchanged so
  `previousSelector` capture in the promoter uses the canonical
  lowercase form.
- **JSON round-trip:** `feedback`, `validation_result_ids`,
  `selectors`, `field_samples`, `validation_summary` all round-trip
  exactly through the SQLite TEXT columns.
- **FK CASCADE:** deleting a `profile_generations` row removes its
  revisions and validation results.
- **Latest-approved excludes rolled-back:** even with a fresh
  `rolled_back` decision pointing at the same `previous_selector`,
  the `findLatestApprovedFieldDecision` lookup returns the next
  un-rolled-back approval (or null).
- **Per-field rollback isolation:** rolling back the title selector
  does not alter the description or price selectors.
- **Approval IDs returned to caller:** the `PromotionResult.approvalDecisionIds`
  array is consumed by the rollback test to fetch a specific field
  decision for rollback without scanning.
- **No collateral writes to `extractor_profiles`:** the promoter
  still uses `upsertProfile` (merge-style), so unapproved fields
  retain their prior values. The "merge-style preservation" test
  pins this invariant for the new code path.

## Design Notes

- **Source of truth.** The normalized `profile_generation_field_decisions`
  table is the audit source of truth. The legacy
  `profile_generations.status` column is kept in sync for structural
  rejections only (no title, `proposed` status) so existing UIs and
  tests that read it continue to work without changes.
- **Backward compatibility.** The promoter still resolves selectors
  from the legacy `selectors_json` payload when no
  `profile_generation_revisions` row exists for the generation. This
  means existing rows from before this migration continue to be
  promotable; the next governance service revision (Phase 3) can
  backfill the first revision for each generation lazily.
- **Field-level rollback chain.** When a field is approved, then
  rolled back, then re-approved with a new selector, the
  `findLatestApprovedFieldDecision` lookup returns the most recent
  approval that has NOT been rolled back. Future rollback can target
  that specific approval, and a chained rollback from there would
  restore the value before the most recent approval. The
  `findLatestApprovedFieldDecision` is built around
  `NOT EXISTS (rolled_back WHERE previous_selector = approved.approved_selector)`
  so the matching is precise and does not accidentally mark unrelated
  approvals as rolled-back.
- **Per-field decisions are append-only.** Each `promoteGeneratedProfile()`
  call writes one decision row per field. A field that is approved in
  call #1 and re-approved (with a different selector) in call #2 will
  produce two `approved` rows. UI code that wants the "current" value
  per field should use `findLatestApprovedFieldDecision` (which
  excludes rolled-back approvals) or the merged active profile
  (which is the source of truth for the live extraction).
- **Dynamic `require` for legacy status updates.** The promoter uses
  `require('../db/repositories/profile-generation-repo')` inside the
  `updateGenerationStatusBestEffort` helper to avoid a circular
  import between the promoter and the legacy repo. This is the same
  pattern the legacy promoter used; the dynamic require is hidden
  behind a single helper so the call sites are clear.
- **`InsertValidationResultInput.revisionId` is optional in the
  type but required at runtime.** The batch helper
  `insertRevisionValidationResults` takes items without `revisionId`
  and fills it in; the single-insertion helper throws if it is
  missing. The doc comment explains the asymmetry.

## Residual Risks

- **Legacy status column drift.** The promoter only updates
  `profile_generations.status` for structural rejections. A
  generated proposal that is audited but never reviewed will not
  change the legacy `status` column from `proposed` to `validated`/
  `rejected` — the page-extractor's own write path handles that. If
  the page-extractor path is later bypassed (e.g. via a manual
  operator flow), the legacy status could fall out of sync. The
  governance UI should treat the normalized tables as the source of
  truth.
- **No backfill for pre-existing generations.** Existing rows in
  `profile_generations` from before this migration have no
  corresponding revision. `resolveSelectors` falls back to the
  legacy `selectors_json` blob, which keeps those rows promotable,
  but a follow-up could add a `createInitialRevisionForGeneration()`
  helper to backfill the first revision lazily. This is in plan
  Phase 3 (task 13) and is intentionally deferred.
- **No `listRevisionsByDomain` helper.** The current repo can list
  revisions by `generationId` or look up the latest validated
  revision for a generation, but cannot list all revisions across
  all generations for a domain. The governance service (Phase 3)
  will need a join through `profile_generations`. For now,
  `listRevisionsByGeneration` is sufficient.
- **No `rolled_back` decision auto-marks the prior approval.** The
  `findLatestApprovedFieldDecision` exclusion is based on
  `previous_selector = approved.approved_selector` matching. If a
  field is approved, the active profile value is changed externally
  (not via rollback), and then the same field is approved again with
  a new selector, the original approval's `approved_selector` may
  no longer match the new `previous_selector` of any rollback. This
  is rare in practice but documented for completeness.
- **The legacy `updateProfileGenerationStatus` is still called for
  structural rejections.** It writes both the new status and a
  (now redundant) `errorMessage`. Future cleanup can remove the
  `errorMessage` write from the legacy repo if the normalized
  decisions row is sufficient.

## No Staged Files

`git status --short` shows pre-existing uncommitted modifications from
prior phases. Phase 1 changes are part of that working tree but no
files were `git add`ed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented only Phase 1 tasks 4-8. No edits to llm-client.ts, profile-generator.ts, page-extractor.ts, the routes layer, the UI layer, llm-task-config-repo (Phase 2), or the governance service (Phase 3). Task 4: three new normalized tables in src/db/migrations.ts with IF NOT EXISTS and indexes. Task 5: two new repo files with typed interfaces, JSON round-trip helpers, all required functions (insertProfileGenerationRevision, findProfileGenerationRevisionById, listRevisionsByGeneration, findLatestValidatedRevision, updateProfileGenerationRevisionStatus, insertRevisionValidationResults, listValidationResultsByRevision, insertProfileFieldDecision, listFieldDecisionsByDomain, listFieldDecisionsByGeneration, findProfileFieldDecisionById, findLatestApprovedFieldDecision with rolled-back exclusion). Task 6: profile-promoter.ts now resolves the latest validated revision, captures previous_selector before upsertProfile, and writes per-field decisions via the new repo. Task 7: rollbackProfileField and rollbackLatestApprovedField added with merge-style upsert. Task 8: two new DB-dependent test files plus package.json and vitest.config.ts wiring."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "typecheck: 0 errors. vitest: 142/142 pass (12 files). bun test: 156/156 pass (17 files). The 20 new test cases cover insert/find round-trip, parent revision chaining, status filter, latest-validated lookup (with and without rolled-back exclusion), FK cascade, JSON round-trip, batch validation result insertion, normalization, list/filter by domain+field+decision, partial rollback preservation, full-merge rollback, rollback-clears-null case, non-approval rejected, unknown-id rejected, latest-approved helper. Pre-existing tests (21 promoter + 21 profile-generation-repo + others) all still pass with no regressions. The plan's explicit acceptance criteria for each task are all verified by the new tests."
    }
  ],
  "changedFiles": [
    "src/db/migrations.ts",
    "src/db/repositories/profile-generation-revision-repo.ts",
    "src/db/repositories/profile-generation-field-decision-repo.ts",
    "src/onboarding/profile-promoter.ts",
    "src/tests/unit/profile-promoter.test.ts",
    "src/tests/unit/profile-generation-revision-repo.test.ts",
    "src/tests/unit/profile-generation-field-decision-repo.test.ts",
    "package.json",
    "vitest.config.ts"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/profile-generation-revision-repo.test.ts",
    "src/tests/unit/profile-generation-field-decision-repo.test.ts",
    "src/tests/unit/profile-promoter.test.ts"
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
      "summary": "142/142 pass, 12 files"
    },
    {
      "command": "bun test (per package.json test script)",
      "result": "passed",
      "summary": "156/156 pass, 17 files"
    },
    {
      "command": "bun test src/tests/unit/profile-promoter.test.ts",
      "result": "passed",
      "summary": "27/27 pass (21 pre-existing + 6 new rollback)"
    },
    {
      "command": "bun test src/tests/unit/profile-generation-revision-repo.test.ts",
      "result": "passed",
      "summary": "10/10 pass"
    },
    {
      "command": "bun test src/tests/unit/profile-generation-field-decision-repo.test.ts",
      "result": "passed",
      "summary": "10/10 pass"
    },
    {
      "command": "bun test src/tests/unit/profile-generation-repo.test.ts",
      "result": "passed",
      "summary": "21/21 pass (pre-existing, unchanged)"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-images.test.ts",
      "result": "passed",
      "summary": "3/3 pass (pre-existing recommendation srcset test still green)"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-variant-inference.test.ts",
      "result": "passed",
      "summary": "6/6 pass (pre-existing variant inference test still green)"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-profile-generation.test.ts",
      "result": "passed",
      "summary": "2/2 pass (Phase 0 decision-20 invariant still green)"
    },
    {
      "command": "bunx vitest run src/tests/unit/profile-generator.test.ts",
      "result": "passed",
      "summary": "62/62 pass (Phase 0 canPromote/canAutoPromote rename still green)"
    }
  ],
  "validationOutput": [
    "typecheck: clean (0 errors)",
    "vitest: 142/142 pass (12 files, including 8 new test cases from the previous Phase 0 page-extractor-profile-generation suite and the 2 pre-existing page-extractor images/variant tests)",
    "bun test: 156/156 pass (17 files)",
    "promoter tests: 27/27 (audit-trail tests now assert against the new field_decisions table; 6 new rollback tests cover merge-style preservation, null-clear case, non-approval rejection, unknown-id rejection, latest-approved helper, partial rollback)",
    "revision repo tests: 10/10 (insert, parent chaining, status filter, latest-validated lookup, null when none validated, status update + updated_at bump, validation result round-trip, batch insertion, FK cascade, JSON round-trip)",
    "field decision repo tests: 10/10 (insert, find, normalization, JSON round-trip, list/filter, list-by-generation, latest-approved with and without rolled-back exclusion, null when empty, decided_by + notes round-trip)",
    "all pre-existing tests still pass with no regressions"
  ],
  "residualRisks": [
    "Legacy profile_generations.status column is only updated for structural rejections. The normalized decisions table is the source of truth; the legacy column is a mirror for backward compatibility with existing UIs.",
    "No backfill of pre-existing generation rows into the new revisions table. The promoter falls back to the legacy selectors_json blob for un-migrated rows, so they remain promotable. Plan Phase 3 task 13 introduces createInitialRevisionForGeneration() for lazy backfill.",
    "findLatestApprovedFieldDecision's NOT EXISTS exclusion is precise per approved_selector value. If an approval's approved_selector value is changed externally (not via the promoter), the exclusion may miss subsequent rollbacks. Rare in practice but documented.",
    "The updateGenerationStatusBestEffort helper uses a dynamic require to update the legacy profile_generations row for structural rejections. This is the same pattern the legacy promoter used, but it does add a small runtime cost and could be replaced with a static import in a follow-up."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added three normalized governance tables (profile_generation_revisions, profile_generation_validation_results, profile_generation_field_decisions) with FK CASCADE and indexes. Created two typed repos with full CRUD plus latest-validated/latest-approved lookups (with rolled-back exclusion). Refactored profile-promoter.ts to resolve selectors from the latest validated revision, capture previous_selector before upsert, and write per-field decision rows (approved/rejected) for every operator action. Added rollbackProfileField and rollbackLatestApprovedField with merge-style restoration. Updated existing promoter audit-trail tests to assert against the new tables and added 6 new rollback tests. Added 20 new DB-dependent test cases across two new test files. Wired the new tests into package.json and vitest.config.ts.",
  "reviewFindings": [
    "no blockers",
    "minor: the InsertValidationResultInput interface marks revisionId as optional but the runtime requires it for single insertion. The doc comment explains the asymmetry. Could be split into a separate InsertValidationResultBatchItem type for clarity in a follow-up.",
    "minor: the legacy updateProfileGenerationStatus is still called for structural rejections. This means the legacy profile_generations.status column can change without a corresponding entry in profile_generation_field_decisions (e.g. a row marked 'rejected' by a no-title structural rejection that was never promoted). The plan explicitly keeps the legacy column as a mirror, so this is by design; a future governance UI should treat the normalized tables as the source of truth.",
    "minor: rollbackProfileField uses a dynamic require to avoid a circular import. This is the same pattern the legacy promoter used; a follow-up could refactor to a static import if the dependency graph allows."
  ],
  "manualNotes": "Phase 1 is complete. The promoter now writes per-field decisions to a normalized table and supports per-field rollback. The page-extractor still only audits proposals (decision 20 from Phase 0) — no auto-promotion. The next phase (Phase 2) introduces task-specific LLM routing via the new llm_task_configs table and the getLlmConfigForTask helper. Phase 3 introduces the governance service that orchestrates backfill, validation across confirmed samples, and the approval/rollback workflows that consume the new tables. The data model in this phase is intentionally a superset of the legacy JSON-blob model so existing extraction results continue to work without a migration step."
}
