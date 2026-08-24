# Review Stage UI Rebuild — The Final Human Gate Before Promotion

> Status: planned (planner output, no code)
> Epic: `specs/epics/e10-review-final-gate/`
> Evidence base: `/tmp/review-ui-research-brief.md` (three-agent research pass), repo recon of
> `src/client/components/onboarding/review/`, `src/server/routes/onboarding-routes.ts`,
> `src/onboarding/draft-promoter.ts`, `src/shared/schemas/onboarding.ts`.
> Design governance: `/impeccable` (Operate mode — this is task-completion app UI).

---

## 1. Problem statement

The Review stage is contractually the **last human gate** before an onboarding item becomes a
CMS product draft and reaches the live ShopSite site. Today it does not function as one:

1. **Most curated fields cannot be viewed or edited at review time.** `ReviewDraft`
   (`review-types.ts`) covers exactly 5 fields (curatedTitle, brandHint, curatedWeight,
   curatedDescription, searchKeywords). Price, quantity, images (pick/primary/reorder),
   dimensions, MPN, case pack/UOM, bullets, custom fields are read-only or invisible.
2. **No completeness gate on curated fields exists before approval.** The only mandatory
   checklist lives in `draft-promoter.ts` (~976–996) where failures surface as silent
   per-item promotion skips after the fact. Worse, the promoter's title chain
   `curatedTitle || extractionData.title || item.name` (draft-promoter.ts:629, 753)
   can promote a product whose curated title was never reviewed — a silent fallback.
3. **The reviewer has no record-level readiness signal.** There is no "what is still missing
   for this item to be promotable" indicator and no jump-to-field navigation from a failure
   to the field that must be fixed.
4. Approval ("Looks Good & Next") can succeed while the item would later fail promotion,
   converting a review-stage decision problem into a promotion-stage surprise.

**Goal:** a reviewer can view AND edit every curated field per product, see blocking errors
vs warnings, fix issues via jump-to-field navigation, and approve **only when** the promotion
mandatory checklist (Name, Price, Brand, Primary Image, ≥1 verified page assignment) passes.
No silent fallbacks promoting empty curated fields.

## 2. Architecture decision — in-place enhancement of the Rapid Review Workspace

**Decision: Option (a) — enhance the existing ReviewWorkspace in place**, behind a
`VITE_REVIEW_UI_V2` capability flag that toggles the new full-field editor + gating UI inside
the same workspace shell. Options (b) dedicated routed page and (c) editable grid are rejected.

Rationale (against brief evidence):

| Option | Verdict | Why |
|---|---|---|
| (a) Enhance workspace in place | **Chosen** | External evidence requires "queue-as-triage + form-per-record edit", which the existing queue + inspector already is structurally. Keeps the SSE layer (`subscribeBatchEvents`), keyboard nav (G = Looks Good & Next), decisions UI, fetch plumbing. Lowest blast radius; no deep-link/dual-surface drift risk. |
| (b) Dedicated routed page | Rejected | MEDIUM-HIGH cost; creates a second review surface that must be kept in sync with the workspace or retired; external evidence is agnostic drawer-vs-page so it buys nothing the inspector cannot provide. Deep-linking needs are met by the existing `?view=` precedent if ever required later. |
| (c) Editable grid | Rejected outright | Whole-row PUTs + whole-JSON `curation_data` last-write-wins would mass-invalidate durable review state and lose concurrent edits; W3C APG two-mode grid contract is high-risk for long-form description/image work. Explicitly out of scope forever. |

/impeccable rationale: this surface is pure **Operate** mode — scanability, consistency,
native expectations outrank expression. The redesign keeps the incumbent identity
(`rv-*` CSS system, panel decomposition) and replaces only what fails the job-to-be-done:
the incomplete edit surface and the absent readiness signal. No visual-world replacement.

**Legacy surfaces:** `pipeline-drawer/ReviewDrawerShell.tsx` + `CurationStagePanel.tsx` remain
diagnostics-only behind Pipeline Board (already the case). See §9 for retirement policy —
the V2 flag gates capabilities, not a parallel tree, so there is no second live surface to sync.

## 3. Field-by-field reviewable inventory & editability matrix

Legend — **Edit**: editable in review form; **RO**: read-only displayed; **Hidden**: not
surfaced; **Proposal**: decided via classification proposal accept/reject (unchanged).
Mutability column reflects server guards in `PUT /onboarding/items/:id` (onboarding-routes.ts:1846–1983).

| # | Field | Stored in | Current | Target | Official-page | Distributor-record | Notes |
|---|---|---|---|---|---|---|---|
| 1 | curatedTitle | curation_data | Edit | Edit | ✔ | ✔ | Blocking gate field (effective Name). Show provenance (titleSource). |
| 2 | brandHint / Brand (ProductField16) | item.brand_hint (+ promoter resolveBrand) | Edit | Edit | ✔ | ✔ | Blocking gate field. Reuse `SearchableBrandSelector`. |
| 3 | price | item.price | RO display | **Edit** | ✔ | ✖ disabled, forced null | Server forces distributor price null at promotion; UI communicates constraint, never offers a dead field silently (visible "Distributor pricing set centrally" note). Blocking gate field. |
| 4 | quantity | extraction/item | Hidden | Edit (official) / RO (distributor) | ✔ | RO | |
| 5 | Primary image pick/order | extraction images | View+lightbox only | **Pick primary, reorder, hide** — see e10s04 (net-new server scope, flagged) | ✔ | Display-only until PI-6 rights verification | Distributor approved-images remain display-only. Blocking gate field. |
| 6 | curatedDescription (+sourceAttemptIds) | curation_data | Edit | Edit | ✔ | ✔ | Keep evidence citations visible (`EvidenceCitationList`). |
| 7 | searchKeywords | curation_data | Edit | Edit | ✔ | ✔ | |
| 8 | curatedWeight | curation_data (lbs-normalized) | Edit | Edit | ✔ | ✔ | Preserve `convertToLbs` server normalization; unit label in UI. |
| 9 | packagingOcrTitle | curation_data | Hidden | RO provenance chip | ✔ | ✔ | Feeds titleSource transparency. |
| 10 | titleSource / curationMethod | curation_data | Hidden | RO badge | ✔ | ✔ | Never editable by reviewer. |
| 11 | suggestedPages / verified page assignments | classification proposals | Proposal UI | Unchanged (proposal accept/reject + verified-page picker) | ✔ | ✔ | Blocking gate field: ≥1 VERIFIED page. |
| 12 | product type + attribute assignments | classification proposals | Proposal UI | Unchanged | ✔ | ✔ | Direct free-text product-type picker stays OUT of scope (invented taxonomy IDs violate governance #17). |
| 13 | correctedCategoryPage | curation_data | Existing | Unchanged | ✔ | ✔ | |
| 14 | bulletPoints, specs, custom fields (extraction_data) | extraction_data_json | Hidden | RO display (collapsible) | ✔ | RO (row immutable) | Generic PUT exists but editing raw extraction at review invites silent fallback drift; v1 keeps extraction read-only. |
| 15 | dimensions, MPN, case pack, UOM, ingredients, distributorCategory | extraction variantAttributes/etc. | Hidden | RO display (collapsible "Listing facts" group) | ✔ | ✔ | Reviewer visibility without write scope. |
| 16 | name (item.name), source_url, status | item columns | n/a | name/source_url stay non-editable here | — | — | Distributor rows: source_url/extraction_data writes are server-rejected (400); UI hides affordances rather than showing failing inputs. |
| 17 | reviewer notes / rejection reason | **new** (see §6 API) | none | Add (optional, non-blocking) | ✔ | ✔ | Deferred unless approved — flagged as minor net-new persistence. |

`.passthrough()` on `ExtractionDataSchema` means unknown keys can exist; the RO renderer must
tolerate unknown keys and never invent editors for them.

## 4. Validation & completeness gating design

### 4.1 Single source of truth: mirror the promoter checklist (fail-closed)

New shared module `src/classification/review-completeness.ts` exporting
`evaluateReviewCompleteness(itemContext): { ready: boolean; blockers: GateCode[]; warnings: WarningCode[] }`.
Gate codes mirror `draft-promoter.ts` ~976–996 exactly:

- `missing_name` — evaluated on the **effective promoted name**
  (`curationData.curatedTitle || extractionData.title || item.name`, same expression as
  promoter lines 629/753). This is the anti-silent-fallback mechanism: if the effective name
  would come from an unreviewed fallback source, that is a **warning**
  (`name_from_fallback_source`); if empty, a **blocker**. Empty curated fields can therefore
  never be promoted silently — either the reviewer sees the fallback explicitly or approval blocks.
- `missing_price` — `coreProduct.price` resolution path (item.price); always blocking for
  official_page; auto-satisfied-with-note for distributor_record (price forced null upstream).
- `missing_brand` — ProductField16 resolution (resolveBrand → brandHint), same chain as promoter.
- `missing_primary_image` — promoter media.primary resolution.
- `missing_pages` — ≥1 **verified** page assignment (unverified accepted proposals never count,
  matching promoter semantics).

Warnings (non-blocking): `name_from_fallback_source`, `description_empty`,
`keywords_empty`, `weight_missing`, `pending_proposals` (undecided proposals),
`unverified_accepted_pages`.

### 4.2 Client-side live evaluation

A pure derivation `review-readiness.ts` under `src/client/components/onboarding/review/`
computes the same blocker/warning sets from loaded detail for live UI (checklist panel, badges,
disabled approve). It imports the shared evaluator logic (or shares codes via
`src/shared/schemas/onboarding.ts` additions) so client and server cannot diverge. Client state
is advisory; the server gate is authoritative.

### 4.3 Server-side authoritative gate

- `POST /items/review-complete` (onboarding-routes.ts:1435–1560): add a Phase-1 check calling
  `evaluateReviewCompleteness`; any blocker produces a structured per-item failure
  `{ itemId, reason, blockers: GateCode[] }` in the existing all-or-nothing 400 response shape.
  No mutation occurs unless every item passes — existing fail-closed transactional pattern preserved.
- Promotion remains double-guarded: the promoter's own mandatory check stays (defense in depth);
  the durable-approval requirement (edits clear approval → re-review) already ensures edits race
  fail closed.

### 4.4 Save semantics (consequential-edit invalidation)

Explicit **Save** button with optional short debounce on blur — **no keystroke autosave**.
Every consequential save hits `PUT /items/:id`, which calls `markReviewInvalidated(itemId,
'consequential_edit')` and clears approval; keystroke autosave would thrash invalidation and
destroy the reviewed signal. After save: drop cached detail, eagerly reload, refresh queue
(existing `handleSaveEdit` flow extended). Dirty-state guard: navigating to another queue item
with unsaved changes prompts (WCAG 2.2 — no data loss on navigation).

### 4.5 Accessibility (WCAG 2.2)

- Errors identified in text, tied via `aria-invalid` + `aria-describedby`; never color alone
  (SC 1.4.1, 3.3.1, 3.3.3); suggestion text per G177.
- Jump-to-fix navigation moves focus to the first offending field (`shouldFocus` +
  `scrollIntoView`), not merely scrolling.
- Checklist panel is a labeled region with per-item status text ("Blocking — Price is empty").
- Keyboard parity preserved: existing shortcuts unchanged; Escape cancels edit with confirm
  when dirty.

## 5. Final confirmation step

Before "Looks Good & Next" (G) records durable review, when the V2 surface is enabled and any
field was edited this session, show a compact source-vs-curated confirmation: effective Name /
Price / Brand / Primary image / Pages side-by-side with their pre-edit values, plus warning list.
"No changes since load" short-circuits straight to approve (PostHog PR #68968 precedent) —
zero added friction on the dominant clean-pass path.

## 6. API changes needed

1. **Extend `POST /items/review-complete` responses** with structured blocker codes (§4.3).
   Backward-compatible additive shape.
2. **Image pick/approve at review time is NET-NEW SERVER SCOPE — FLAGGED.** Today there is no
   endpoint to set primary image / reorder / suppress candidate images on an onboarding item;
   images live in `extraction_data_json` written wholesale by generic PUT. A dedicated surface
   (e.g. `PUT /items/:id/media` writing a reviewed media selection) plus persistence decision
   is required before e10s04 can implement. **This story is blocked pending supervisor
   approval; everything else ships independently.**
3. Optional (deferred): reviewer notes persistence — flagged, not scheduled in v1.
4. **Not needed:** per-field PATCH / ETag optimistic concurrency. Two-operator contention is
   low (worker never claims review/promotion stages; single-operator reality) and schema work
   for version columns is disproportionate. Documented residual risk (§10).

## 7. Rollout / flag strategy

Follow the exact dual-capability precedent of `src/client/onboarding-feature-flags.ts`:

- New flag `reviewUiV2` reading `VITE_REVIEW_UI_V2` via the existing `envFlag` pattern,
  default **false** initially, computed once at module load.
- When false: current 5-field editor, no readiness checklist, no confirm step — zero behavior
  change (instant rollback path).
- When true: full-field form + mutability matrix + readiness gating UI + confirmation step.
  Server gate (e10s01) ships dark first — it hardens review-complete for both surfaces and is
  not user-visible until the client renders blocker codes.
- Staged enablement: dev → operator smoke batch → default-on in a subsequent release; flag
  removal only after a full cycle at default-on (matching Batch Workspace precedent).

## 8. Test plan (mapped to existing files)

| File | Asserts |
|---|---|
| `src/tests/unit/review-completeness-gate.test.ts` (**new**) | Evaluator: each gate code fires on its exact promoter-equivalent condition; effective-name fallback emits warning vs blocker; distributor price auto-satisfied; verified-vs-unverified pages; all-or-nothing review-complete 400 carries structured blockers; no mutation on partial failure. |
| `src/tests/unit/review-logic.test.ts` (extend) | Readiness derivation from detail payloads; editability matrix per source type; dirty-state detection. |
| `src/tests/unit/review-panel-gating.test.tsx` (extend) | Checklist panel renders blockers/warnings as text (a11y attributes present); approve disabled with blockers; jump-to-fix focuses field; confirm step appears iff edited; no-changes short-circuit. |
| `src/tests/unit/review-listing-form.test.tsx` (**new**) | Full-field form: edits price/quantity/keywords etc.; distributor rows disable price with explanatory note and send no price key; explicit-save PUT payload shape; weight unit handling; unknown extraction keys tolerated (passthrough). |
| `src/tests/unit/onboarding-review-state.test.ts` (extend, must not regress) | Consequential edits still call `markReviewInvalidated('consequential_edit')`; approved+edited items reopen for re-approval. |
| `src/tests/unit/onboarding-feature-flags.test.ts` (extend) | `VITE_REVIEW_UI_V2` parsing incl. kill-switch values ('false'/'0'/'no'), default-off. |
| `src/tests/unit/draft-promoter.test.ts`, `promotion-gate.test.ts`, `durable-approval-promote.test.ts` | Must pass unchanged — promoter checklist untouched (defense in depth intact). |
| `review-classification-panel.test.tsx` | Proposal accept/reject flows unchanged. |

Validation commands: `bun run test`, `bun run typecheck`, `bun run lint`.

## 9. Migration & retirement of legacy ReviewDrawerShell

- V1 (flag off): no changes anywhere; `ReviewDrawerShell` remains diagnostics-only behind
  Pipeline Board exactly as today (`pr10-drawer-render.test.tsx` keeps passing).
- Because the chosen architecture adds no second live review surface, there is **no sync
  burden**; `ReviewDrawerShell`/`CurationStagePanel` are formally declared frozen: bug-fix-only,
  no feature parity work ever.
- Retirement (post-default-on, separate small PR): delete `ReviewDrawerShell.tsx` +
  `CurationStagePanel.tsx` usage from `PipelineBoard.tsx` diagnostics view, keep the pipeline
  board itself; update/remove `pr10-drawer-render.test.tsx`. Gated on zero telemetry/manual
  reports of diagnostics-view use over one release cycle.

## 10. Residual risks

1. **Last-write-wins concurrency:** two operators editing the same item concurrently can lose
   edits (whole-JSON curation_data, no ETag). Accepted for v1 (low contention, worker never
   claims these stages); mitigations documented, not built.
2. **Client/server readiness divergence:** mitigated by sharing evaluator logic/codes, but the
   client snapshot can go stale between load and approve; the server gate is authoritative and
   will reject with codes the client then renders.
3. **Image pick story blocked** on net-new server scope decision (e10s04) — until then primary
   image remains whatever extraction produced, and `missing_primary_image` blockers may be
   unfixable from Review for affected items (honest blocker, surfaced, not hidden).
4. Effective-name fallback means an item with empty curatedTitle but rich extraction title is
   approvable with a warning — deliberate (matches real promotion behavior) but reviewers may
   approve on fallback data; mitigation is the loud warning + confirm step.
5. CONTEXT.md at repo root currently contains a scout handoff (denormalizer remap), not the
   domain model described in AGENTS.md; plan grounded on AGENTS.md pipeline documentation and
   code instead.

## 11. Epic breakdown & sequencing

See `specs/epics/e10-review-final-gate/` (epic.yaml + five story specs).

```
e10s01 server completeness gate ──► e10s02 full-field form ─┐
                               └──► e10s03 readiness UI ────┼──► e10s05 flag rollout + retirement
e10s04 image pick surface (BLOCKED on approval, independent)┘
```

Non-goals / boundaries (do NOT touch): promoter mandatory checklist and fallback chains;
`markReviewInvalidated` semantics; classification proposal accept/reject contracts;
distributor immutability guards (1871–1890); extraction_data editing; grid editing; new
canonical storage; git/workspace/sync paths; PI/Agent Lab surfaces; no staging or commits
outside sanctioned paths.
