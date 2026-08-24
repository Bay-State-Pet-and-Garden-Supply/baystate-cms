# e10s01 — Server review-completeness gate

## Goal
Make `POST /api/onboarding/items/review-complete` enforce the promotion mandatory checklist
(Name, Price, Brand, Primary Image, ≥1 verified page) BEFORE durable review is recorded, using
the exact same field-resolution logic as `src/onboarding/draft-promoter.ts` (~976–996, title
chain 629/753). Fail closed, all-or-nothing.

## Files
- **New:** `src/classification/review-completeness.ts` — pure evaluator
  `evaluateReviewCompleteness(ctx) -> { ready, blockers: GateCode[], warnings: WarningCode[] }`.
  Resolution helpers extracted from / mirroring draft-promoter logic WITHOUT modifying the
  promoter itself (defense in depth preserved).
- **New shared codes:** blocker/warning code union exported via `src/shared/schemas/onboarding.ts`
  additions (client consumes identical codes).
- **Edit:** `src/server/routes/onboarding-routes.ts` (`/items/review-complete`, ~1435–1560) — add
  Phase-1 completeness check per item; failures join the existing per-item `failures[]` shape as
  `{ itemId, reason, blockers }`; zero mutation unless all pass.
- **Edit:** `GET` item detail projection — include computed `{ blockers, warnings, ready }` so the
  client renders live status from authoritative logic.

## Behavioral contract (fail-closed invariants)
1. Blocker `missing_name`: effective name (`curatedData.curatedTitle || extractionData.title ||
   item.name`) empty → block. Non-empty but sourced from fallback → WARNING
   `name_from_fallback_source` (never a silent fallback: reviewer sees it or blocks).
2. `missing_price`: item price resolution empty → block for official_page; distributor_record
   items auto-satisfied with note (server forces null upstream — not reviewer-fixable).
3. `missing_brand`: ProductField16 resolution (resolveBrand → brandHint) empty → block.
4. `missing_primary_image`: promoter media.primary equivalent empty → block.
5. `missing_pages`: zero VERIFIED page assignments → block (unverified accepted never count).
6. Warnings (non-blocking): description_empty, keywords_empty, weight_missing,
   pending_proposals, unverified_accepted_pages.
7. Evaluator is pure/deterministic; no DB writes; workspace-ownership guards unchanged;
   existing gates (stage==='review', run decision completeness, legacy pages gate) unchanged.

## Tests
- New `src/tests/unit/review-completeness-gate.test.ts`: every code's trigger condition;
  effective-name warning-vs-blocker boundary; distributor price path; verified-pages-only rule;
  review-complete 400 carries structured blockers and mutates nothing (assert DB state before/
  after); legacy no-run items still gated by category-page requirement.
- Regression (must stay green unchanged): `draft-promoter.test.ts`, `promotion-gate.test.ts`,
  `durable-approval-promote.test.ts`, `onboarding-approval-gates.test.ts`.

## Acceptance criteria
- An item missing any mandatory field cannot reach approved state via review-complete; response
  names the exact fields.
- No silent-fallback promotion path remains reachable through approval without an explicit
  warning surfaced to the client.

## Residual risk
Client readiness snapshot may be stale vs server evaluation; server is authoritative and its
codes are rendered on rejection.
