# e06s04 — Test matrix + activation gate + release — 3-sample hard-block, immutable versions, park as setup_required_profile, distributor bypass

## Story
- **ID:** e06s04
- **Epic:** e06 — Brand Domain Profile Workspace + Guided Setup
- **Status:** planned
- **BCPs:** 8
- **Risk:** P0
- **Type:** feat

## Context
Stitch the downstream edge of the guided setup: after a domain workspace draft exists, operators must prove the draft against real indexed products before it can be activated, and activation must deterministically release queued extraction work. Today `src/onboarding/job-queue.ts:1631` rejects `official_page` items only after they enter Extraction and `src/onboarding/extraction/profile-blockers.ts` reconstructs blockers from error strings — a late failure instead of a predictable park. `src/db/repositories/extractor-profile-repo.ts` mutates a single active row per domain and `src/onboarding/profile-runner-client.ts:66` uses `updatedAt` as a surrogate version, so history is not immutable. This story adds the production-runner test matrix, the 3-sample (with waiver) hard-block gate, immutable activated versions with an active-version pointer, the `setup_required_profile` park contract via `src/server/routes/onboarding-routes.ts` + `src/onboarding/job-queue.ts`, and the `distributor_record` bypass — failing strictly on selector failure without auto-activation.

## Business Narrative
As an operator activating a domain profile, I want my draft proven against 3 confirmed real product pages through the same runner production uses, with a hard activation gate that blocks on any required-field failure and an immutable versioned activation that releases only the parked domain items, so that extraction never runs against an unproven profile, distributor items are never blocked, and every activation is auditable and reversible.

## Requirements

#### ADDED: Full-width Test Matrix bound to draft version and artifacts
Workspace shows a matrix with rows = 3 confirmed representative products (from `brand_url_index` via `sitemap-routes` inventory) and cols = per-field selectors + identity/variant checks, executed deterministically through the production static/rendered runner (`profile-runner-client` → extraction-worker). Each cell expands to extracted vs expected value + provenance + artifact id/hash + failure reason. Execution result is persisted per domain + draft version with retained artifact hashes; re-execution creates a new bound result, never mutates a prior one.

#### ADDED: Hard-block activation gate (3-sample, image rule preserved, waiver)
Activate mutation succeeds only when: required `title` succeeds on every confirmed sample, no `wrong_product`/`wrong_variant` result, no failing field declared required, and the existing two-sample + preview-attestation rule holds for images. A selector failing on 1 of 3 confirmed samples hard-blocks activation with a per-field expanded reason (expected vs actual, provenance, artifact, failure reason) and surfaces a deterministic `Revise` action. Domains with `<3` product URLs activate only with an audited waiver (reason + actor + artifact hash recorded in e06s02); otherwise the gate blocks. A stored passing run for the exact draft version is required — the gate never infers from a different version.

#### ADDED: Immutable activated versions with active-version pointer and rollback
Active profiles become immutable version rows plus a domain-level `active_version` pointer. Each version stores selectors, runtime/variant settings, confirmed sample IDs, source artifact hashes, validation summary, model/config provenance, approver, and activation reason. Activation inserts a new version and moves the pointer atomically inside one DB transaction. Rollback moves the pointer to a prior version atomically and triggers revalidation/re-release of affected parked work; the runner evidence for the rolled-back version is re-evaluated, not reused.

#### MODIFIED: Legacy mutable profile migration — no grandfathering
**Before:** `extractor-profile-repo` updates one row per domain in place; `updatedAt` surrogate versions are mutated directly.
**After:** Legacy rows are migrated to the versioned model; existing active profiles are **not** grandfathered — they are shown as `Active (legacy) · Degraded` until they re-pass the 3-sample gate, and extraction for their domains is blocked via the park contract. No data loss: prior selectors are preserved as the initial degraded version with provenance `legacy-migration`.

#### ADDED: Park at Discovery→Extraction as setup_required_profile with domain task
`official_page` items whose domain has no active version park at the Discovery→Extraction boundary as `setup_required_profile` (distinct from `failed`) and contribute to a single domain-level readiness task `"Build profile for example.com — unblocks N products"` (N = count of parked items for that domain). Activation deterministically releases parked items for that domain via the existing `onboarding-work` release path (`src/client/onboarding-work-api.ts:103-109` / server equivalent) inside the same activation transaction boundary. Parked items never auto-advance without an activation.

#### ADDED: Distributor-record bypass (profile-free extraction preserved)
Items with `source_type = distributor_record` bypass the entire gate — they are never parked as `setup_required_profile`, never appear in the domain task, and proceed to profile-free extraction/materialization without a domain profile. Determination is by onboarding item `source_type`, not by URL heuristics.

#### ADDED: Regression triggers but never auto-activates
Profile edits, sitemap drift above a threshold, or rendered-template drift enqueue a regression test against the active version's suite. Degraded health is surfaced (`Active · Degraded`), but no regression auto-activates a repair or moves the pointer — human re-activation through the gate is required.

## Acceptance Criteria (17.)

- **Given** a domain with 3 confirmed products and a draft at version `v5`, **when** Test Matrix is executed, **then** each of the 3 rows is evaluated through the production runner, per-cell results include extracted/expected + provenance + artifact hash, and the persisted result is bound to `v5` (re-execution after an edit creates a `v6`-bound result, `v5`'s result is unchanged).

- **Given** a draft where selector `title` fails on 1 of 3 confirmed samples, **when** the operator attempts Activate, **then** the mutation returns a gate error, the matrix cell for that field/sample expands to the failure reason with provenance and artifact, a `Revise` action is surfaced, and no active version is created and no parked items are released.

- **Given** a domain with 3 confirmed products where every required field passes on all 3 and the image two-sample + preview rule holds, **when** Activate is invoked with a passing `v5`-bound result, **then** an immutable version is inserted, the domain pointer moves to that version atomically, and parked `setup_required_profile` items for that domain are released deterministically (activation transaction reports released count).

- **Given** a domain with only 2 product URLs in `brand_url_index`, **when** no waiver exists, **then** Activate is blocked with `needs_waiver`; **when** an audited waiver (reason + actor + artifact hash) has been recorded, **then** Activate with a 2-sample passing matrix succeeds and the waiver provenance is stored on the new version.

- **Given** a legacy mutable `extractor_profiles` row, **after** migration, **when** no re-validation has occurred, **then** the workspace shows `Active (legacy) · Degraded`, official_page extraction for that domain remains parked, and the legacy selectors are preserved as a degraded version with `legacy-migration` provenance.

- **Given** an immutable version `v4` is active, **when** Rollback to `v3` is requested, **then** the pointer moves to `v3` atomically, `v3`'s persisted validation evidence is re-evaluated via the runner, and affected parked items are re-released only if `v3`'s evidence still satisfies the gate — otherwise the park remains.

- **Given** an onboarding item with `source_type = distributor_record` for a domain with no active profile, **when** it reaches the Discovery→Extraction boundary, **then** it is not parked, does not count toward the domain task, and proceeds to profile-free extraction.

- **Given** a regression is triggered by a profile edit or sitemap drift, **when** the regression run completes, **then** health may degrade to `Degraded` but no auto-activation occurs and the active pointer is unchanged.

## Verification Script

1. Run `bun run typecheck` — no type errors in versioning/park/runner code.
2. Run `bunx vitest run src/tests/unit/profile-test-matrix.test.ts src/tests/unit/profile-runner.test.ts` — matrix binds to exact draft version, cells include provenance/artifact, re-execution creates new bound result.
3. Run `bunx vitest run src/tests/unit/profile-activation-gate.test.ts` — failing 1-of-3 blocks activate with expanded reason + Revise; passing 3-of-3 with image rule activates atomically.
4. Run `bunx vitest run src/tests/unit/profile-waiver.test.ts src/tests/unit/profile-versioning.test.ts src/tests/unit/profile-rollback.test.ts` — `<3` without waiver blocks, with waiver passes; version immutability and atomic pointer move + legacy-degraded + rollback revalidation.
5. Run `bunx vitest run src/tests/unit/profile-parking.test.ts src/tests/unit/distributor-bypass.test.ts` — official_page without active version parks as `setup_required_profile` with domain task, distributor_record never parks.
6. Manual: add brand + guarded domain `example.com`, index sitemap, confirm 3, generate draft, run matrix (all green), activate — observe parked count released; repeat with 1 failing cell — activation blocked; repeat with 2-URL domain without/with waiver.

## Out of Scope
- Workspace shell/readiness rail/history chrome (e06s01), guided brand→domain→index→confirm UI + waiver capture (e06s02), LLM task-button generation and per-field governance (e06s03) — those stories own their UI; this story owns the matrix execution, gate, versioning, and park/release contracts.
- Sourcing/Discovery heuristics, pipeline board/Curation/Review/Promotion, external RBAC, `product_pages` schema changes, open-ended chatbot, and auto-activation on regression (all deferred/out per SCOPE_LATEST).

## Risks
- Runner parity drift between workspace validation and production extraction — mitigate by sharing `profile-runner-client` and retaining artifact hashes; tests assert same extraction contract.
- Immutable version migration cutting over mutable rows — mitigate by preserving legacy selectors as degraded version and blocking extraction until re-passed; add DB transaction tests.
- Parked-item release double-advance on concurrent activations — mitigate by moving pointer + releasing inside one atomic transaction keyed by domain.

## Traceability
- `story: e06s04`
- SCOPE: `specs/product/SCOPE_LATEST.yaml` in_scope e06s04 + constraints (3-sample, immutable versions, park contract, distributor bypass, no grandfather, never auto-activate).
- Planning context: `specs/planning-context.yaml` decisions (3 samples with waiver, no legacy grandfathering, hard-block on selector fail, distributor bypass).
- Reuses: `src/onboarding/profile-runner-client.ts`, `src/db/repositories/extractor-profile-repo.ts`, `src/onboarding/job-queue.ts:1631`, `src/onboarding/extraction/profile-blockers.ts`, `src/server/routes/onboarding-routes.ts:2636`, `src/client/onboarding-work-api.ts:103-109`, `brand_url_index` via `src/server/routes/sitemap-routes.ts`.

