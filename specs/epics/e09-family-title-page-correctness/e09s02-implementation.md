# e09s02 — Implementation: Pure Validators + Review/Promotion Gates

> Implements Phase B of `docs/plans/family-title-category-page-requirements-plan.md` §13 (adjudicated 2026-08-22). One sequential writer; contracts per `e09s01-requirements.md` (T1-T10 titles, P1-P12 pages). No schema migration (per Plan migration boundary); no write-once table semantics altered.

## B1 — Pure family title contract

**New files:**

- `src/classification/family-title-consistency.ts` (`FAMILY_TITLE_CONSISTENCY_VERSION = 'v2'`) — `validateFamilyTitleSet(input)` over `TitleFrozenFacts` / `TitleValidationInput` → `TitleValidationResult`. Enforces shared skeleton (T2), canonical shared terms/position (T3), variant fidelity incl. always-visible Soft/Hard/Classic/Hypo (T4), sibling-leakage rejection (T5), invention-blocking with ambiguous-variant findings (T6), all-or-nothing set validity (T7).
- `src/classification/title-lint.ts` (`TITLE_LINT_VERSION = 'v1'`) — `lintCandidateTitle` / `lintTitleSet` with `DEFAULT_BRAND_CASE_MAP`; deterministic brand rendering/casing lint feeding the consistency verdict (T3).

**Wiring points:** `src/onboarding/cohort-name-coordinator.ts`, `src/onboarding/cohort-curator.ts`, `src/onboarding/product-curator.ts`. Invalid candidate or fallback sets produce **zero durable `curated_title` rows** (T7); rule/prompt versions participate in authority hash so new revisions invalidate reuse safely (T8). `product-family-v1` grouping untouched (T1/T10).

## B2 — Pure Category Page correctness contract

**New file:** `src/classification/category-page-correctness.ts` (`CATEGORY_PAGE_CORRECTNESS_VERSION = 'v1'`) — `validateCategoryPageAssignment(input)` → `PageCorrectnessResult`.

Enforces: verified frozen catalog only (P1), stable-ID identity fail-closed (P2), required primary w/ evidenced dual-species co-primary only (P3), member-owned evidence + Execution Product Type context (P4), species/food-treat-toy/form semantic compatibility (P5), child-over-Shop-All specificity (P6), brand Pages optional-secondary-only (P7), confidence never authoritative (P8), per-member outcome `assigned | needs_input | blocked` without cross-member leakage (P9).

Ambiguity resolves to `needs_input`, never a guessed Page. No retrieval/embeddings/reranking or new taxonomy introduced (scope lock §14).

## B3 — Review and promotion gates

**Modified:**

- `src/classification/review-completion-gate.ts` — Review cannot complete without a valid `familyTitleValidation` record (schema-parsed; missing/malformed blocks with title-specific reason, T9) and an accepted current Category Page when the page gate snapshot enables the target (P10). Abstention/stale/foreign/unverified primaries refuse completion.
- `src/classification/promotion-gate.ts` — new `assertPagesCurrentForImport` (P11 defense-in-depth): recomputes accepted `category_page` proposal currentness against the CURRENT verified Page identities of the active import before any product draft / `product_pages` / `ProductOnPages` write; stale/deleted/foreign-import identity returns a blocking result (`stale_page_assignment`). Never mutates historical rows.
- Legacy/rollback path shares the same validator authority or abstains (P12) — name-only hard-coded fallbacks are no longer acceptance authority.

**Migration boundary:** none required — diagnostics ride existing curation/output JSON (`FamilyTitleValidationRecordSchema`).

## Test coverage

- `src/tests/unit/title-lint.test.ts` (18), `family-title-consistency.test.ts` (17), `category-page-correctness.test.ts` (25), `promotion-gate.test.ts` (47, incl. stale-import refusal), plus integration via `cohort-name-coordinator.test.ts` (60).
