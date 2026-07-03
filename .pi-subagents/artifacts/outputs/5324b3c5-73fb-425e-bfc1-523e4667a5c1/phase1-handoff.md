# Phase 1 Handoff — Safety Foundation and Audit Storage

## Summary

Implemented all 5 Phase 1 tasks from `/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/c687aeb3_planner_0_output.md`. The deliverables are:

1. A new `profile_generations` SQLite table for auditing every LLM-generated selector proposal before it is ever considered for promotion.
2. A new `profile-generation-repo` repository with insert/update/find/list functions, status lifecycle (`proposed` → `validated` → `rejected`/`promoted`/`failed`), and safe JSON round-trip.
3. A safety fix to `upsertProfile` so a partial update with `undefined` selectors **preserves** existing values (only explicit `null` clears) — preventing a future LLM-assisted auto-promotion from accidentally zeroing out selectors the caller didn't mean to touch.
4. Tests covering all of the above.

## Changed Files

| File | Change |
|------|--------|
| `src/db/migrations.ts` | Added `CREATE TABLE IF NOT EXISTS profile_generations (...)` block with 16 columns plus 3 indexes (`domain`, `status`, `domain+status`). Idempotent and follows the existing pattern for `extractor_profiles` and `domain_status`. |
| `src/db/repositories/extractor-profile-repo.ts` | New `resolve()` helper inside `upsertProfile` distinguishes `undefined` (preserve existing) vs `null` (clear) vs `string` (update). New rows still default omitted selectors to `null`. Added docstring describing the merge semantics. |
| `src/db/repositories/profile-generation-repo.ts` (new) | `ProfileGenerationStatus` union, `ProfileGenerationRecord` interface, and 5 functions: `insertProfileGeneration`, `updateProfileGenerationStatus`, `findProfileGenerationById`, `listProfileGenerationsByDomain` (with status filter, limit, orderBy, orderDirection), `listValidatedGenerationsByDomain`. Domain normalization (lowercase, strip `www.`) matches `extractor-profile-repo`. JSON fields serialized with `JSON.stringify` and deserialized defensively. SQL ordering uses `rowid` as a stable tiebreaker when timestamps collide. |
| `src/tests/unit/extractor-profiles.test.ts` | Split the old "should support upserting…" test. Added 3 new tests: (a) partial update with undefined selectors must preserve existing values; (b) explicit `null` selector clears that selector and preserves others; (c) new profile defaults omitted selectors to null. |
| `src/tests/unit/profile-generation-repo.test.ts` (new) | 10 tests: insert+find, domain normalization, JSON round-trip (selectors/fieldSamples/validation), status update refreshes `updated_at`, `promoted_at` set on promotion, failure status + error message, missing id returns null, default DESC ordering, status filter, `listValidatedGenerationsByDomain` returns only `validated`+`promoted`. |

## Validation

| Command | Result |
|---------|--------|
| `bun run typecheck` | Clean for all Phase 1 files. Two pre-existing errors remain in `src/onboarding/page-extractor.ts:1154` and `:1159` (`primaryImage possibly null`); they are part of an in-progress worktree modification unrelated to this phase. |
| `bun test src/tests/unit/extractor-profiles.test.ts src/tests/unit/profile-generation-repo.test.ts` | **15 pass, 0 fail**, 62 `expect()` calls, ~88ms total. |

## Design Decisions / Notes

- **JSON round-trip is defensive.** `safeParseJson` returns `null` on parse failure rather than throwing — this matches the rest of the codebase's posture toward tolerating malformed historical rows.
- **Status is a string union, not a separate table.** This is consistent with `domain_status` and keeps the audit table self-contained. Allowed values are exported as `PROFILE_GENERATION_STATUSES` for callers that need to validate input.
- **Ordering uses `rowid DESC` as a tiebreaker.** Discovered during testing: three records inserted in the same millisecond share an ISO `created_at`, so SQLite's order is non-deterministic. `rowid` is monotonically increasing in SQLite, so it gives stable insertion-order results regardless of clock resolution.
- **`updateProfileGenerationStatus` returns the refreshed record.** Callers (the profile generator in Phase 2) get back the post-update state in one call without a follow-up read.
- **`updateProfileGenerationStatus` revalidates `id` exists and returns `null` if not.** This avoids silent no-ops that could mask bugs in the caller.
- **No new npm dependencies** — everything uses Bun's built-in `crypto.randomUUID`, `bun:sqlite` (via the existing `Database` driver), and standard library JSON.

## Open Risks / Follow-ups

- The plan mentioned an optional `replaceProfile` helper for full-replacement semantics. I did **not** add it in this phase because the only existing caller of `upsertProfile` in the codebase is the LLM-assisted generator we are about to add (Phase 2/3) — and that generator will use the new merge behavior. If any future code path needs full-replacement, it can be added later.
- The two pre-existing typecheck errors in `page-extractor.ts` are out of scope for Phase 1 but will be relevant for Phase 3 (which touches the same file). The plan should account for that.
- The `profile_generations` table does **not** yet have a foreign-key relationship to `extractor_profiles`. This is intentional: audit rows must outlive the profile they reference (e.g., when a profile is later deleted, we want the history). The `promoted_at` column is the soft link.

## No Staged Files

`git status --short | grep '^[A-Z]'` returns nothing. All Phase 1 changes are working-tree only and ready for review.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented only the 5 Phase 1 tasks from the plan; did not touch Phase 2 or Phase 3 work, page-extractor.ts, llm-client.ts, or any other out-of-scope file. The diff is bounded to migrations.ts, extractor-profile-repo.ts, the two new files, and the existing extractor-profiles.test.ts."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "15/15 unit tests pass (62 expect() calls). typecheck is clean for all five Phase 1 files. The two pre-existing page-extractor.ts errors are unchanged from before this work and are explicitly out of scope."
    }
  ],
  "changedFiles": [
    "src/db/migrations.ts",
    "src/db/repositories/extractor-profile-repo.ts",
    "src/db/repositories/profile-generation-repo.ts",
    "src/tests/unit/extractor-profiles.test.ts",
    "src/tests/unit/profile-generation-repo.test.ts"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/extractor-profiles.test.ts",
    "src/tests/unit/profile-generation-repo.test.ts"
  ],
  "commandsRun": [
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "0 errors in Phase 1 files; 2 pre-existing errors in src/onboarding/page-extractor.ts unchanged by this work"
    },
    {
      "command": "bun test src/tests/unit/extractor-profiles.test.ts src/tests/unit/profile-generation-repo.test.ts",
      "result": "passed",
      "summary": "15 pass, 0 fail, 62 expect() calls, ~88ms"
    },
    {
      "command": "git status --short | grep '^[A-Z]'",
      "result": "passed",
      "summary": "no staged files"
    }
  ],
  "validationOutput": [
    "extractor-profiles.test.ts: 5/5 pass — covers insert, partial-merge preservation, explicit-null clear, new-profile default, list+delete",
    "profile-generation-repo.test.ts: 10/10 pass — covers insert/find, domain normalization, JSON round-trip, status updates, promoted_at, failure status, missing id, default ordering, status filter, validated list"
  ],
  "residualRisks": [
    "Two pre-existing TypeScript errors in src/onboarding/page-extractor.ts (lines 1154 and 1159) remain; they are in an unrelated in-progress worktree modification and are out of scope for Phase 1, but Phase 3 will touch the same file and may need to address them.",
    "The optional replaceProfile helper from the plan was not added; only upsertProfile is implemented. No current caller needs full-replacement semantics, so this is acceptable for Phase 1."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added a new profile_generations audit table and repository; fixed the upsertProfile merge bug so undefined selectors preserve existing values; added 13 new tests across the two test files.",
  "reviewFindings": [
    "no blockers",
    "minor: ordering test originally failed because three inserts in the same millisecond shared a created_at; fixed by adding rowid DESC as a stable SQL tiebreaker (defensive against clock-resolution collisions, not just test timing)"
  ],
  "manualNotes": "Phase 1 is complete and Phase 2 (profile-generator.ts) can now build on top of the audit repository. Suggested next step: launch a worker for Phase 2 tasks 6-11, pointing it to the plan file and the new repo for reference."
}
```
