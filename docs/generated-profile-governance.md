# Generated Profile Governance

This document explains the rules, data model, and operational
workflow for AI-generated extractor profile proposals in
`baystate-cms`.

It is intended for engineers maintaining the onboarding
extractor, operators reviewing proposals, and reviewers auditing
the audit trail.

## Why this exists

The onboarding pipeline scrapes product pages from manufacturer
sites. The page extractor has six layers (custom CSS selectors,
JSON-LD, meta tags, microdata, HTML heuristics, Shopify
productJSON). For some sites the first five layers miss the
title, description, brand, or images, or they hit recommendation
carousels instead of product media.

The system can ask an LLM to propose CSS selectors for a given
domain. The proposal is a **plan**, not an action. The
governance rules in this document ensure the proposal cannot
silently affect extraction quality without a human being in
the loop.

## Locked product decisions

These are the 20 decisions that define the feature. They are the
source of truth for future changes.

1. AI-generated profiles are draft proposals only; human approval is always required.
2. Approval is per selector field, never all-or-nothing.
3. Image-selector approval requires multi-product validation with image previews.
4. Approved generated fields write into `extractor_profiles`; `profile_generations` remains proposal/audit/history.
5. Generated-profile review belongs in domain/profile management, not product drawers.
6. The canonical profile key is domain, not brand.
7. Images require 2+ same-domain samples; text fields prefer 2+ samples but may be approved from one sample with a warning; price is cautionary because brand pages often omit price.
8. Validation samples must be selected/confirmed source URLs with expected product names.
9. Approval UI must show a domain-level validation table with selector, sample URL, extracted value, checks, image previews, repeated-image warnings, and carousel warnings.
10. Approved profile changes need per-field history and rollback.
11. Store managers should not need CSS knowledge; advanced selector editing is an escape hatch only.
12. Revision feedback should be structured field-level feedback, not open-ended chat.
13. AI selector revisions are versioned, never overwritten.
14. Revision and decision history belongs in normalized tables, not only JSON blobs.
15. LLM/model selection is task-specific.
16. Profile generation and profile revision use separate model configs.
17. Provider credentials stay in `api_keys`; task routing lives in `llm_task_configs`.
18. LLM task configs are workspace/store-specific.
19. Profile generation/revision fail closed without explicit task config; product-name consolidation may fall back.
20. Unapproved generated selectors must not affect even the current extraction result.

## Hard invariants

These rules are enforced by `src/onboarding/profile-governance-service.ts`
and the `src/onboarding/profile-promoter.ts` module. They must
not be weakened.

### 1. AI-generated profiles are proposals only

`promoteGeneratedProfile(generationId, approvedFields)` is the
single write path for selector data. It requires an explicit
`approvedFields` object. The promoter:

- rejects empty approval payloads (status preserved as
  `validated`)
- rejects generation rows in `proposed` / `rejected` / `failed`
  status (status flipped to `rejected` with reason)
- rejects when the resolved revision/generation has no
  `titleSelector` (flipped to `rejected` with reason)
- writes **only** the selector fields whose approval value is
  explicitly `true`
- uses the merge-style `upsertProfile` so unapproved selectors
  on the active profile are preserved

There is **no** "auto-promote" path. There is no confidence
threshold above which a profile is automatically applied. A
"promote" call without explicit per-field approval returns
`{ promoted: false, reason: ... }` and writes nothing to
`extractor_profiles`.

### 2. Approval is per field

The `ApprovedSelectorFields` type is
`Partial<Record<SelectorKey, boolean>>`. The promoter:

- writes only the selectors set to `true`
- records a `profile_generation_field_decisions` row for every
  approved field (decision = `approved`)
- records a `rejected` decision row for every other selector
  field the caller did not approve
- does **not** approve sibling fields when the caller approves
  one. Approving `{ titleSelector: true }` writes only the
  title; images, description, brand, and price stay at their
  previous values.

### 3. Image-selector approval requires multi-product validation

`profile-governance-service.ts::approveRevisionFields` enforces:

- `imagesSelector === true` requires `imagePreviewsReviewed === true`
  on the approval call. Without that flag, the image approval is
  silently downgraded to a rejection; the other approved fields
  still go through.
- The governance validation service
  (`validateRevisionAcrossConfirmedSamples`) sets
  `readyForImageApproval = true` only when at least
  `MIN_IMAGE_APPROVAL_SAMPLES = 2` samples passed and zero
  failed. The UI shows this as a soft lock on the
  "I reviewed image previews" checkbox.

### 4. Text-selector approval with one sample gets a warning

Text fields (`titleSelector`, `descriptionSelector`,
`brandSelector`) allow approval with a single confirmed
sample. The validation service sets
`textFieldsHaveLimitedEvidence = true` in this case; the UI is
expected to surface a "Limited evidence (1 sample)" warning
near the approval buttons. Operators may still approve, but
the warning is in their face.

### 5. Validation samples are confirmed URLs only

`src/db/repositories/onboarding-source-repo.ts::listValidationSamplesByDomain`
returns **only** sources with `is_selected = 1`. Random
high-confidence but unselected URLs are excluded. Domain
matching is exact or suffix-only (`mywoof.com` matches
`us.mywoof.com` but not `notmywoof.com`). URLs are deduplicated
within the result set.

### 6. Selector revisions are versioned, not overwritten

`profile-governance-service.ts::reviseProfileFromStructuredFeedback`
inserts a **new** row in `profile_generation_revisions` with
`source = 'manager_feedback'`, `revisionNumber = parent + 1`,
and `parentRevisionId = parent.id`. The old revision is
preserved verbatim. A follow-up AI call (out of scope for this
document) rewrites the new revision's `selectors_json`; the
parent stays unchanged.

### 7. Approved field decisions carry `previous_selector`

`promoteGeneratedProfile` captures the prior active profile
value for each approved field **before** writing. The value is
persisted in `profile_generation_field_decisions.previous_selector`.
This is what rollback restores.

### 8. Profile generation and revision must not apply in memory

The page extractor (`src/onboarding/page-extractor.ts`) used to
apply generated selectors to the current extraction result via
`maybeRetryWithGeneratedProfile`. That helper has been
refactored:

- It is now `maybeCreateGeneratedProfileProposal` (a proposal
  creation path, not a retry path).
- The result is never spliced into the current extraction
  output. Even when the proposal validates cleanly, the
  extraction returns the original deterministic result.
- A future re-run of extraction can pick up the approved
  selectors via the normal `extractor_profiles` lookup.

## Data model

```
extractor_profiles                  profile_generations                  profile_generation_revisions
┌─────────────────────┐             ┌──────────────────────┐             ┌───────────────────────────┐
│ id (uuid)           │             │ id (uuid)            │             │ id (uuid)                 │
│ domain (unique)     │◀────┐       │ domain               │◀────┐       │ generation_id (FK)        │
│ title_selector      │     │       │ source_url           │     │       │ revision_number          │
│ price_selector      │     │       │ expected_name        │     │       │ parent_revision_id (FK)  │
│ description_selector│     │       │ brand_hint           │     │       │ source                   │
│ brand_selector      │     │       │ selectors_json       │     │       │ feedback_json            │
│ images_selector     │     │       │ status               │     │       │ selectors_json           │
│ created_at          │     │       │ confidence           │     │       │ field_samples_json       │
│ updated_at          │     │       │ llm_provider        │     │       │ validation_summary_json  │
└─────────────────────┘     │       │ llm_model            │     │       │ status                   │
                            │       │ error_message        │     │       │ confidence               │
                            │       │ created_at           │     │       │ llm_task                 │
                            │       │ updated_at           │     │       │ llm_provider             │
                            │       │ promoted_at          │     │       │ llm_model                │
                            │       └──────────────────────┘     │       │ error_message            │
                            │                                   │       │ created_at               │
                            │       profile_generation_         │       │ updated_at               │
                            │       validation_results          │       └───────────────────────────┘
                            │       ┌──────────────────────┐     │
                            │       │ id (uuid)            │     │
                            │       │ revision_id (FK)     │     │
                            │       │ selector_field       │     │
                            │       │ sample_url           │     │       profile_generation_field_decisions
                            │       │ item_id              │     │       ┌──────────────────────────────────────┐
                            │       │ expected_name        │     │       │ id (uuid)                            │
                            │       │ brand_hint           │     │       │ generation_id (FK)                   │
                            │       │ extracted_value_json │     │       │ revision_id (FK, nullable)          │
                            │       │ image_previews_json  │     │       │ domain (FK, indexed)                 │
                            │       │ warnings_json        │     │       │ selector_field (indexed)             │
                            │       │ status (pass/warn/   │     │       │ decision (approved/rejected/         │
                            │       │   fail)              │     │       │   rolled_back)                       │
                            │       │ created_at           │     │       │ previous_selector                    │
                            │       └──────────────────────┘     │       │ proposed_selector                    │
                            │                                   │       │ approved_selector                    │
                            │       llm_task_configs             │       │ feedback_json                        │
                            │       ┌──────────────────────┐     │       │ validation_result_ids_json           │
                            │       │ id (uuid)            │     │       │ decided_at                           │
                            │       │ task (unique)        │     │       │ decided_by                           │
                            │       │ provider             │     │       │ notes                                │
                            │       │ model                │     │       └──────────────────────────────────────┘
                            │       │ base_url_override    │     │
                            │       │ temperature          │     │
                            │       │ created_at           │     │
                            │       │ updated_at           │     │
                            │       └──────────────────────┘     │
                            │                                   │
                            │  api_keys (existing)              │
                            │  ┌──────────────────────┐         │
                            └──│ service               │         │
                               │ api_key               │         │
                               │ base_url              │         │
                               │ model                 │         │
                               │ created_at / updated_at│        │
                               └──────────────────────┘         │
```

## Task-specific model routing

The `llm_task_configs` table maps an AI task
(`product_name_consolidation`, `profile_generation`,
`profile_revision`, `product_curation`,
`category_classification`,
`classification_evidence_extraction`) to a provider and model.
Provider credentials stay in `api_keys`. The resolution path is
in `src/onboarding/llm-client.ts::getLlmConfigForTask`:

1. Look up the `llm_task_configs` row for the task to find the
   provider + model + optional base URL override.
2. Look up the matching `api_keys` row for the API key.
3. If either step is missing, the resolution falls through.

The two profile tasks (`profile_generation`,
`profile_revision`) **fail closed** when no
`llm_task_configs` row exists. They throw
`MissingLlmTaskConfigError`. The other tasks return `null`
(no throw) and may fall back to the legacy generic
`getLlmConfig()`.

The settings UI exposes one row per task. Profile rows are
marked **Required** and turn red when unconfigured. The
extraction UI shows a "configure model" message when the
operator has not yet set up the routing.

## Operational workflow

The typical lifecycle:

1. **Discovery** — extraction runs and produces a deterministic
   result.
2. **Proposal** — if the page-extractor trigger function
   (`shouldAttemptProfileGeneration`) says "yes," the
   generator asks the LLM for a selector set. The proposal
   is inserted as a `profile_generations` row in `validated`
   or `rejected` status. **No selectors are written to
   `extractor_profiles` at this step.**
3. **Validation** — an operator (or a scheduled job) calls
   `validateRevisionAcrossConfirmedSamples(revisionId,
   domain)`. The service fetches the HTML of every
   `is_selected = 1` source URL, runs each selector against
   it, and stores the per-field/per-sample result. The
   revision's `status` becomes `validated`.
4. **Review** — the operator opens the Settings page → AI
   Model Routing section → Generated Profile Governance. They
   see a list of domains, each with a count of proposals by
   status. They open a domain, pick a generation, and see the
   per-field validation table.
5. **Per-field approval / rejection** — the operator checks
   the image previews (mandatory for image approval) and
   selects "Approve" or "Reject" per field. Approved fields
   write to `extractor_profiles`; rejected fields do not.
6. **Revision (optional)** — if a proposal is mostly correct
   but wrong on one field, the operator uses the "Revise from
   feedback" form. The form does not expose CSS; it lets the
   operator say "this value should be X" or mark each image
   as correct / exclude. The form creates a new revision; the
   old one is preserved.
7. **Rollback (optional)** — if a later approved field turns
   out to be wrong, the operator clicks "Rollback" on the
   field decision. The previous selector is restored from
   the decision's `previous_selector` column, and a
   `rolled_back` decision row is appended.

## API surface

| Route | Purpose |
|-------|---------|
| `GET /api/onboarding/settings/llm-task-configs` | List all task routing rows |
| `PUT /api/onboarding/settings/llm-task-configs/:task` | Upsert a single task's provider/model |
| `DELETE /api/onboarding/settings/llm-task-configs/:task` | Remove a task's routing |
| `GET /api/onboarding/settings/profile-governance/:domain` | Domain-level summary (active profile, generations, revisions, decisions, sample count) |
| `GET /api/onboarding/settings/profile-generations?domain=&status=` | List generations for a domain |
| `GET /api/onboarding/settings/profile-generations/:id` | Single generation detail (auto-backfills revision 1) |
| `POST /api/onboarding/settings/profile-generations/:id/revisions` | Create a new revision from structured feedback |
| `POST /api/onboarding/settings/profile-generations/:id/revisions/:revisionId/validate` | Re-run cross-sample validation |
| `POST /api/onboarding/settings/profile-generations/:id/revisions/:revisionId/decisions` | Approve or reject selected fields |
| `POST /api/onboarding/settings/profile-field-decisions/:decisionId/rollback` | Roll back an approved decision |

All write paths validate the body with a Zod schema from
`src/shared/schemas/onboarding.ts`.

## Tests

The governance rules are covered by `bun test`:

- `src/tests/unit/profile-promoter.test.ts` (27 tests) — Phase 1
  per-field approval invariant, rollback, merge-style
  preservation.
- `src/tests/unit/profile-generation-revision-repo.test.ts`
  (10 tests) — Phase 1 revision repo.
- `src/tests/unit/profile-generation-field-decision-repo.test.ts`
  (10 tests) — Phase 1 field decision repo.
- `src/tests/unit/llm-task-config-repo.test.ts` (8 tests) —
  Phase 2 task routing.
- `src/tests/unit/llm-client-task-routing.test.ts` (17 tests)
  — Phase 2 fail-closed for profile tasks, cross-task split.
- `src/tests/unit/profile-governance-service.test.ts` (17
  tests) — Phase 3 service rules, image gate, rollback.
- `src/tests/unit/onboarding-repos.test.ts` (17 tests) —
  Phase 3 sample policy, negative match.

Run them with:

```bash
bun run test
```

The vitest suite is a separate set of tests that do not depend
on `bun:sqlite` and run via `bunx vitest run`. They cover the
generator's pure helpers, the page-extractor proposal path,
and the image-scoping / variant-inference behavior.

## Migration / compatibility

Existing `profile_generations` rows from before the governance
schema may lack revisions. The `GET .../profile-generations/:id`
route calls `createInitialRevisionForGeneration` on read to
backfill revision 1 from the legacy `selectors_json` payload.
The backfill is idempotent: a second call returns the existing
revision. The backfilled revision has
`source = 'initial_generation'` and inherits the generation's
`confidence` and `errorMessage`.

Operators who see legacy generations can re-validate them and
approve fields per the normal flow; no separate migration
script is required.

## For future maintainers

- If you add a new selector field to
  `SELECTOR_FIELDS`, also add it to:
  1. `src/shared/schemas/onboarding.ts::SelectorFieldEnum`
  2. `src/db/repositories/extractor-profile-repo.ts`
     (the `ExtractorProfile` interface)
  3. `src/onboarding/profile-promoter.ts::SELECTOR_KEYS`
  4. `src/onboarding/profile-generator.ts::GeneratedSelectorProfile`
- If you add a new AI task, also add it to:
  1. `src/db/repositories/llm-task-config-repo.ts::LLM_TASKS`
  2. `src/shared/schemas/onboarding.ts::LlmTaskEnum`
  3. The `PROFILE_TASKS_REQUIRE_EXPLICIT` set in
     `src/onboarding/llm-client.ts` if it should fail closed.
- Do **not** remove or rename `readyForReview`. The legacy
  `canPromote` / `canAutoPromote` names are gone; the schema
  is advisory only.
- Do **not** add an auto-promote path. There is no code path
  that writes a selector to `extractor_profiles` without
  passing through `promoteGeneratedProfile`, and that function
  requires an explicit `ApprovedSelectorFields` object. Any
  new write path must enforce the same rule.
