# Profile-Governance Approval-Required — Worker Handoff

## Summary

Implemented the approved profile-governance invariant in the active worktree:

> **AI-generated extractor profiles ALWAYS require explicit human approval before
> affecting future extractions. No auto-promotion, no matter the confidence.**

> **Approval is per selector field, not whole-profile. Images are especially
> uncertain and require explicit opt-in.**

The promoter no longer reads any environment variable. It now requires a
mandatory `ApprovedSelectorFields` argument on every call and only writes the
selectors for which the operator passed `true`. Every approval/rejection is
recorded in the audit row's `validation` JSON, distinguishing structural
rejections (which flip the row to `rejected`) from approval-flow rejections
(which keep the row promotable for retry).

## Changed Files

| File | Change |
|------|--------|
| `src/onboarding/profile-promoter.ts` | Removed `isAutoPromoteEnabled()`, `MIN_AUTO_PROMOTE_CONFIDENCE`, the `SHOPSITE_CMS_PROFILE_AUTO_PROMOTE_ENABLED` env-var path, the auto-promote confidence/nth-of-type guards, and the legacy single-call "conservative: titleSelector only" mode. New `ApprovedSelectorFields` type and `SELECTOR_KEYS`/`SelectorKey` exports. `promoteGeneratedProfile(generationId, approvedFields)` now requires an explicit approval object; only selectors with `true` are written via merge-style `upsertProfile`. Approval-flow rejections leave the row's status untouched and append to `validation.approvalAttempts`. Successful promotions append to `validation.approvals`. The `PromotionResult` shape now reports `approvedFields` and `rejectedFields`. |
| `src/onboarding/profile-generator.ts` | Renamed `MultiSampleValidationResult.canAutoPromote` → `readyForReview` (added `canAutoPromote` as a deprecated alias for backward compatibility). Updated the doc comment for `MIN_MULTI_SAMPLE_PASS` and `validateProfileAcrossSamples` to reflect that the flag is advisory only and promotion still requires explicit per-field approval. |
| `src/db/repositories/onboarding-source-repo.ts` | Doc-comment update: clarified that `listValidationSamplesByDomain` output feeds advisory multi-sample validation; promotion still requires explicit per-field approval. (No behavioral change.) |
| `src/tests/unit/profile-promoter.test.ts` | Replaced `isAutoPromoteEnabled` / `MIN_AUTO_PROMOTE_CONFIDENCE` / `SHOPSITE_CMS_PROFILE_AUTO_PROMOTE_ENABLED` tests with the new approval-required surface. Added 21 tests covering: invariant check (the legacy symbols no longer exist), failure paths, per-field approval semantics, audit-trail entries, retry-after-rejection, image opt-in, merge-style preservation. |
| `src/tests/unit/profile-generator.test.ts` | Updated 4 `validateProfileAcrossSamples` tests to assert `readyForReview` (and to keep the deprecated `canAutoPromote` working as an alias). |

## Validation

| Command | Result |
|---------|--------|
| `bun run typecheck` | **0 errors** |
| `bun test src/tests/unit/profile-promoter.test.ts` | **21 pass, 0 fail, 102 expect() calls** |
| `bun run test` (vitest + bun test) | **All green**: vitest 140/140, bun test 130/130, exit code 0 |
| `bunx vitest run src/tests/unit/profile-generator.test.ts` | 62/62 pass |
| `bun test src/tests/unit/profile-promoter.test.ts` | 21/21 pass |

### Behavioral checks verified by tests

- `isAutoPromoteEnabled` and `MIN_AUTO_PROMOTE_CONFIDENCE` are not exported by `src/onboarding/profile-promoter.ts` (asserted explicitly in the new "invariant" test).
- `promoteGeneratedProfile(id, {})` returns `promoted: false` with `approvedFields: []`; **no** selector is written; the row's status is preserved as `validated` so a subsequent real-approval call can succeed.
- `promoteGeneratedProfile(id, { titleSelector: true })` writes only the title; the other four selectors stay `null` for a brand-new row and are preserved at their existing values for a merge row.
- `promoteGeneratedProfile(id, { titleSelector: true, imagesSelector: true })` writes both; the operator must opt in to images.
- `promoteGeneratedProfile(id, { titleSelector: true, descriptionSelector: true })` writes both; the operator can mix any combination.
- An approval-flow rejection does NOT poison the row's `status` or `errorMessage`. A later call with a real approval succeeds.
- A structural rejection (e.g. generation has no `titleSelector`) DOES flip the row to `rejected` with the reason in `errorMessage`.
- Successful promotions append a `{ approvedFields, rejectedFields, approvedAt }` entry to `validation.approvals`.
- Rejected approval attempts (empty approval, no-value approval) append a `{ outcome, reason, attemptedAt }` entry to `validation.approvalAttempts`.
- `canAutoPromote` is still present on `MultiSampleValidationResult` for backward compatibility but now reflects `readyForReview`.

## Design Notes

- **Approval flow rejections do not change the row's status.** The previous
  implementation marked the row `rejected` for any rejection, including "no
  fields approved". That was a UX bug: a later call with a real approval
  would then be blocked by the `status === 'rejected'` check. The new
  implementation distinguishes:
  - *Approval-flow rejections* (empty approval, approved-but-no-value):
    row stays `validated`, errorMessage untouched, audit attempt recorded in
    `validation.approvalAttempts`. A subsequent call can still succeed.
  - *Structural rejections* (no title selector, never validated, upsert
    threw): row marked `rejected` with reason in `errorMessage` and audit
    attempt in `validation.approvalAttempts`. A subsequent call still fails
    until the generation itself is fixed.

- **The promoter no longer depends on confidence at all.** The old auto-
  promote path used a `MIN_AUTO_PROMOTE_CONFIDENCE = 0.9` threshold. With
  the new invariant, confidence is still recorded in the audit row for the
  operator to see, but it never decides whether to write. Only the
  operator's `true` value does.

- **Per-field merge behavior is preserved.** When an operator approves
  `{ descriptionSelector: true }` on a row that already has a
  `titleSelector`, only the description is written. The merge-style
  `upsertProfile` keeps all other selectors at their previous values. This
  was the existing Phase 1 contract; the new promoter simply rides on top
  of it.

- **`canAutoPromote` kept as a deprecated alias.** The Phase 2 multi-sample
  validation reports a flag indicating "this profile has been validated
  across 2+ same-domain pages". To stay honest with the new invariant, I
  renamed that field to `readyForReview` and updated the docs. I kept
  `canAutoPromote` as a deprecated alias so any out-of-tree consumer does
  not break. Tests for `validateProfileAcrossSamples` now assert both
  fields, and the source-doc comment explains the advisory-only semantic.

- **No new tables or columns.** The audit trail is appended to the existing
  `profile_generations.validation` JSON column. The schema already supports
  this; the repository's `UpdateProfileGenerationStatusFields` interface
  accepts an arbitrary `validation` blob.

- **The `page-extractor.ts` retry path is unchanged.** That path applies
  generated selectors in memory only and never writes to
  `extractor_profiles`. Its audit row records a `validated` or `rejected`
  status. The new promoter is a separate, operator-driven path; the two do
  not conflict.

## Residual Risks

- **The `canAutoPromote` alias is a documented foot-gun.** Any UI or
  pipeline that currently reads `MultiSampleValidationResult.canAutoPromote`
  will still see a boolean. That boolean no longer means "the system will
  auto-promote this"; it now means "this is ready for human review". The
  deprecation comment in `profile-generator.ts` explains this, but a
  follow-up UI audit pass should verify no operator is reading the field
  with the old intent.

- **No UI calls `promoteGeneratedProfile` yet.** The promoter is only
  exercised by tests in this commit. The follow-up work to wire a real
  review/approval UI is out of scope for this worker.

- **`validation.approvals` and `validation.approvalAttempts` grow
  monotonically.** Each call appends. If a single generation row is
  revisited many times the JSON payload gets large. Mitigation: a future
  cleanup can cap or roll the array; the current scale (one row per
  generation) makes this a non-issue.

- **Approval-flow rejection still touches `updated_at`.** The repository's
  `updateProfileGenerationStatus` always refreshes `updated_at`. The
  approval-flow audit path uses that mechanism. The row's status and
  `errorMessage` are preserved (no write), but the `updated_at` timestamp
  changes. This is correct behavior (the audit row WAS updated), but
  callers that key on `updated_at` to detect "new generation" may want to
  filter on `created_at` instead.

- **`recordApprovalFlowAttempt` may receive an unknown status string.** The
  function defensively checks against the five known statuses and falls
  back to `validated` if it sees an unknown value. In practice the row
  status is always one of the five (DB-enforced), so this is belt-and-
  suspenders. The `as KnownStatus` cast keeps TypeScript happy.

## No Staged Files

`git status --short | grep '^[A-Z]'` returns nothing related to this work.
The promoter and its tests are untracked (they were created in earlier
uncommitted work); only their content changed in this commit.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Removed isAutoPromoteEnabled and MIN_AUTO_PROMOTE_CONFIDENCE from src/onboarding/profile-promoter.ts; deleted the SHOPSITE_CMS_PROFILE_AUTO_PROMOTE_ENABLED env-var path; deleted the auto-promote confidence/nth-of-type guards; added the mandatory ApprovedSelectorFields argument to promoteGeneratedProfile; wrote only selectors with explicit true via merge-style upsertProfile; never implicitly promoted images; no new exports beyond SELECTOR_KEYS/SelectorKey/ApprovedSelectorFields/PromotionResult. PromotionResult now reports approvedFields and rejectedFields. No edits to page-extractor.ts, llm-client.ts, extraction-validator.ts, llm-client, llm-configs, or any out-of-scope file. Renamed canAutoPromote to readyForReview on MultiSampleValidationResult (kept canAutoPromote as a deprecated alias for backward compatibility) and updated its doc to reflect advisory-only semantics."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Evidence returned: changed-files list with diff descriptions; tests-added list with the new 21 promoter tests and the 4 updated profile-generator tests; commands-run with exit codes and pass counts; validationOutput summarizing what each new test verifies; residualRisks enumerated; noStagedFiles confirmed via git status. typecheck: 0 errors. bun run test: vitest 140/140, bun test 130/130, exit 0. The invariant test 'promoter module does not export any auto-promote helper' explicitly asserts isAutoPromoteEnabled and MIN_AUTO_PROMOTE_CONFIDENCE are undefined on the module, and it passes."
    }
  ],
  "changedFiles": [
    "src/onboarding/profile-promoter.ts",
    "src/onboarding/profile-generator.ts",
    "src/db/repositories/onboarding-source-repo.ts",
    "src/tests/unit/profile-promoter.test.ts",
    "src/tests/unit/profile-generator.test.ts"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/profile-promoter.test.ts",
    "src/tests/unit/profile-generator.test.ts"
  ],
  "commandsRun": [
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "0 errors. Pre-existing test file dependencies remain compatible."
    },
    {
      "command": "bun test src/tests/unit/profile-promoter.test.ts",
      "result": "passed",
      "summary": "21 pass, 0 fail, 102 expect() calls. Covers invariant, failure paths, per-field approval, audit trail, retry, image opt-in, merge-style preservation."
    },
    {
      "command": "bunx vitest run src/tests/unit/profile-generator.test.ts",
      "result": "passed",
      "summary": "62/62 pass. The 4 validateProfileAcrossSamples tests now assert readyForReview (and verify the deprecated canAutoPromote alias)."
    },
    {
      "command": "bun run test",
      "result": "passed",
      "summary": "vitest 140/140 + bun test 130/130 = 270 pass, 0 fail. exit code 0."
    },
    {
      "command": "git status --short | grep '^[A-Z]'",
      "result": "passed",
      "summary": "no staged files. profile-promoter.ts, profile-generator.ts, and their tests are untracked (created in earlier uncommitted work); only their content was modified."
    }
  ],
  "validationOutput": [
    "Invariant test: 'promoter module does not export any auto-promote helper' asserts isAutoPromoteEnabled and MIN_AUTO_PROMOTE_CONFIDENCE are undefined on src/onboarding/profile-promoter.ts. Passes.",
    "Empty approval: 'rejects when no fields are approved (empty object) but leaves row promotable for retry' asserts promoted=false, approvedFields=[], status remains 'validated', errorMessage null. Passes.",
    "Title-only approval on a new row: writes only the title selector, leaves the other four null. Passes.",
    "Title+description approval: writes both, leaves the other three null. Passes.",
    "Images not written without explicit opt-in: approving only title leaves imagesSelector null even with 0.99 confidence. Passes.",
    "Images written only when explicitly approved: approving title+images writes both. Passes.",
    "Merge-style preservation: approving only title on a row with all selectors already populated leaves the other four at their existing values. Passes.",
    "Approving description only on a merge row: writes the description, leaves title/price/brand/images at existing values. Passes.",
    "Retry after approval-flow rejection: a first call with {} leaves status=validated; a second call with { titleSelector: true } succeeds. Passes.",
    "Structural rejection: a generation with titleSelector=null is marked 'rejected' with errorMessage. Passes.",
    "Audit trail: successful promotion appends a { approvedFields, rejectedFields, approvedAt } entry to validation.approvals. Passes.",
    "Audit trail: approval-flow rejection appends a { outcome, reason, attemptedAt } entry to validation.approvalAttempts WITHOUT flipping status. Passes.",
    "Audit trail: structural rejection (no title selector) appends to validation.approvalAttempts AND flips status. Passes."
  ],
  "residualRisks": [
    "canAutoPromote remains a deprecated alias on MultiSampleValidationResult for backward compatibility. Any UI or external consumer that reads it with the old 'the system will auto-promote this' intent needs a follow-up audit pass.",
    "No UI calls promoteGeneratedProfile yet. The promoter is exercised only by tests in this commit. A follow-up review/approval UI is out of scope.",
    "validation.approvals and validation.approvalAttempts grow monotonically per generation row. Large arrays could become a concern at high volumes, but the current scale (one row per generation) makes this a non-issue.",
    "Approval-flow rejection still updates updated_at even though status and errorMessage are preserved. Callers keying on updated_at to detect 'new generation' may want to filter on created_at instead."
  ],
  "noStagedFiles": true,
  "diffSummary": "Removed the entire auto-promote path from src/onboarding/profile-promoter.ts (env var, isAutoPromoteEnabled, MIN_AUTO_PROMOTE_CONFIDENCE, conservative-title-only-mode, auto-promote confidence/nth-of-type guards). Added ApprovedSelectorFields type and SELECTOR_KEYS/SelectorKey exports. promoteGeneratedProfile now requires a mandatory per-field approval object and only writes the explicitly approved fields via merge-style upsertProfile. PromotionResult reports approvedFields and rejectedFields. Approval-flow rejections (empty approval, approved-but-no-value) keep the row's status as 'validated' so a subsequent real-approval call can succeed; structural rejections (no title selector, never validated, upsert threw) flip the row to 'rejected'. Successful promotions append {approvedFields, rejectedFields, approvedAt} to validation.approvals; rejected attempts append to validation.approvalAttempts. Renamed MultiSampleValidationResult.canAutoPromote to readyForReview (kept canAutoPromote as a deprecated alias). Replaced the promoter test suite with 21 tests covering the new invariant, failure paths, per-field approval, audit trail, retry, image opt-in, and merge-style preservation.",
  "reviewFindings": [
    "no blockers",
    "minor: the deprecated canAutoPromote alias on MultiSampleValidationResult could mislead a future reader; the deprecation comment in profile-generator.ts explains the new advisory-only semantic but a follow-up UI audit should confirm no operator relies on the old name.",
    "minor: recordApprovalFlowAttempt's defensive status fallback ('validated' for unknown values) is a belt-and-suspenders guard against future schema drift. The cast as KnownStatus keeps TypeScript happy. Documented in the function's design notes."
  ],
  "manualNotes": "This worker enforces the backend invariant end-to-end. The next concrete follow-up is a review/approval UI in src/client/components that calls promoteGeneratedProfile with an explicit { titleSelector, descriptionSelector, ... } map populated from checkboxes per generated field. Until that UI lands, the promoter is reachable only via a script or future API endpoint. The page-extractor.ts in-memory retry path is unchanged and does not conflict with the new invariant; it only writes to in-memory extraction results, never to extractor_profiles."
}
```
