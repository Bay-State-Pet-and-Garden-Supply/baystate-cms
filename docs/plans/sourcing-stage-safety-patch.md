# Sourcing Stage Immediate Safety Patch — Implementation Plan

## Goal and safety invariants

- Preserve the six-stage domain order: **Sourcing → Discovery → Extraction → Curation → Review → Promotion**.
- Add one runtime capability, `sourcing.engineEnabled`, backed by `BAYSTATE_CMS_SOURCING_ENABLED`; default and invalid env values resolve to `false`, with test-only/future-settings in-memory override support.
- When the capability is disabled, no supported import or retry/reset path may leave an item at `sourcing/pending`.
- Moving a stranded item to Discovery must atomically persist `sourcing_decision_json.route = 'fallback_to_discovery'`, `origin = 'operator_override'`, empty accepted/provider IDs, and `decidedAt`, while clearing error/claim/retry state and setting `discovery/pending`.
- Preserve all historical `onboarding_evidence_attempts`; this patch neither creates nor deletes evidence rows.
- Sourcing never routes directly to Curation. `use_selected_bundle` and `bundle_to_curation` cease to be accepted transition contracts.
- The server/repository layer is authoritative. UI hiding is defense-in-depth, not the only gate.
- Preserve the dirty worktree; use one sequential writer, do not reset/stash/clean/stage/commit, and do not write a live database.

## Milestone 0 — Baseline and dependency order

- Before edits, record `git status --short`, `git diff --cached --name-only`, and diffs for every target already dirty; do not overwrite unrelated changes.
- Implement in this order:
  1. capability flag and shared request contracts;
  2. repository transition/reset invariants;
  3. import and route gates;
  4. client capability plumbing and UI suppression;
  5. documentation;
  6. focused tests, then full validation.
- No schema migration is required: `stage`, `stage_status`, and `sourcing_decision_json` already exist, and the fallback audit fits `SourcingDecisionSchema`.

## Milestone 1 — Add the default-off capability contract

### New file: `src/onboarding/flags.ts`

- Define `SourcingFlags { sourcingEngineEnabled: boolean }` and `DEFAULT_SOURCING_FLAGS = { sourcingEngineEnabled: false }`.
- Map `sourcingEngineEnabled` to `BAYSTATE_CMS_SOURCING_ENABLED`.
- Implement the established per-call env loader plus `getSourcingFlags()`, `overrideSourcingFlags(partial)`, and `resetSourcingFlagsOverride()`.
- Parse `true/1/yes` and `false/0/no`; missing, empty, or malformed values fail closed to `false`.
- Do not infer capability from provider credentials, historical evidence rows, or UI state.

### File: `src/shared/schemas/onboarding.ts`

- Add strict Zod request/response contracts for the repair action:
  - `FallbackSourcingItemsRequestSchema`: `{ itemIds: z.array(z.string().min(1)).min(1) }`.
  - response shape with deterministic counts and skipped IDs/reasons so a partial bulk result is visible, not silently reported as full success.
- Narrow `ResolveSourcingRequestSchema` to `fallback_to_discovery` only; remove `ResolveSourcingUseSelectedBundleSchema` and the `use_selected_bundle` union member.
- Keep `bundle_to_curation` in `SourcingRouteEnum` only as a legacy persisted-audit value: item hydration/cohort snapshots must continue parsing historical rows, but no request schema, repository transition, route, or UI may create or act on it. Remove it only in a later versioned data/schema migration after compatibility analysis.
- Behavioral contract: malformed/legacy bundle payloads fail with 400 and cannot mutate item, extraction data, accepted evidence IDs, or stage.

### New test: `src/tests/unit/sourcing-flags.test.ts`

- Assert default OFF, every accepted boolean spelling, malformed env fail-closed behavior, partial in-memory override, and override reset.

### Acceptance

- A fresh process with no env configuration reports Sourcing unavailable.
- No caller can enable Sourcing accidentally through an invalid env value.
- Shared schemas no longer authorize distributor bundle selection or direct Curation routing.

## Milestone 2 — Centralize safe import, fallback, and reset behavior in the repository

### File: `src/db/repositories/onboarding-item-repo.ts`

- Extend `OnboardingItemRow` with the existing sourced columns used by `mapRowToItem` (`source_type`, accepted-attempt columns, `sourcing_decision_json`) and parse them without new `any` casts.
- Change `insertItems` to accept an explicit options object or required caller-selected `defaultStage`; ordinary callers must pass the effective entry stage. Do not let a hidden repository default strand items. Preserve explicit `item.stage` for fixtures/internal state construction.
- Add one transaction-backed repository operation, e.g. `fallbackPendingSourcingItemsToDiscovery(itemIds)`, which:
  - deduplicates IDs;
  - mutates only rows currently `stage='sourcing' AND stage_status='pending'` (the audited stranded cohort);
  - writes one fresh `fallback_to_discovery` operator-override decision per moved row;
  - sets `stage='discovery'`, `stage_status='pending'`, `retry_count=0`, `error_message=NULL`, `claimed_by=NULL`, `claimed_at=NULL`, and `updated_at`;
  - preserves source URL, extraction/curation payloads, accepted-attempt fields, and every evidence-attempt row;
  - returns moved count plus explicit missing/ineligible IDs; no route-level SQL.
- Add/reset through one capability-aware repository/service seam, e.g. `resetItemsForRetry(itemIds, { sourcingEngineEnabled })`:
  - disabled + current stage `sourcing`: atomically apply the same audited fallback instead of resetting in place;
  - otherwise retain existing `resetItemsToPending` semantics, including failing active classification runs;
  - return per-item results so routes can disclose skips.
- Remove the `advanceItemsToNextStage` special case for `bundle_to_curation`; every completed Sourcing item can advance only to adjacent Discovery.
- Make `updateSourcingDecision` incapable of selecting `curation` from Sourcing; preferably replace its arbitrary `nextStage?: PipelineStage` with the dedicated fallback operation. No generic helper may recreate the bypass.

### Tests: `src/tests/unit/onboarding-repos.test.ts`

- Update default-entry expectations to Discovery under the disabled flag/caller policy.
- Assert an explicit Sourcing fixture remains possible for historical/repair tests.
- Assert disabled reset of `sourcing/pending` produces `discovery/pending` plus the complete auditable fallback decision and clears error/claim/retry fields.
- Assert reset cannot leave `sourcing/pending`, including duplicate/missing IDs and mixed-stage input.
- Assert ordinary Discovery/Extraction/Curation reset semantics remain unchanged.
- Assert fallback preserves evidence rows and unrelated payload fields.
- Assert completed Sourcing advances only to Discovery even when a legacy persisted decision says `bundle_to_curation`.

### Update: `src/tests/unit/sourcing-stage-order.test.ts`

- Replace “mandatory inert Sourcing” assertions with capability-aware entry assertions.
- Keep a focused worker regression proving disabled imports are in `discovery/pending` and therefore claimable by the existing Discovery leg; do not add a Sourcing worker case.

### Update: `src/tests/unit/sourcing-resolution.test.ts`

- Delete positive bundle-to-Curation expectations.
- Assert only fallback is schema-valid and repository-valid.
- Assert legacy bundle requests/decisions never produce Curation transitions.

### Acceptance

- Repository callers cannot create an implicit `sourcing/pending` item while Sourcing is disabled.
- Reset is safe independently of the UI and HTTP route.
- Bulk fallback is one SQLite transaction and leaves durable decision audit data.
- No Sourcing transition targets Curation.

## Milestone 3 — Gate all import and mutation routes

### File: `src/server/routes/onboarding-routes.ts`

- In `POST /api/onboarding/batches`, read `getSourcingFlags()` once and pass `sourcing` only when enabled, otherwise `discovery`, for every inserted spreadsheet item. Keep external work outside the import transaction.
- Ensure other creation callers follow the same policy: pass the effective stage from their service boundary rather than relying on a mutable global default.
- Add `GET /api/onboarding/capabilities` returning the effective `{ sourcing: { engineEnabled } }` contract for the board.
- Add `POST /api/onboarding/items/fallback-sourcing-to-discovery`:
  - validate with `FallbackSourcingItemsRequestSchema`;
  - require an active workspace;
  - verify every requested item belongs to a batch owned by that workspace before mutation;
  - call the repository bulk operation; never issue route-level UPDATE SQL;
  - return moved/skipped details; 400 for malformed input, 404 for wholly unknown/foreign input, and a truthful partial result for mixed eligibility.
- Change `POST /api/onboarding/items/reset` to call the capability-aware reset seam. When disabled, Sourcing rows are audited-fallbacked; poll the worker only after successful transitions.
- Apply the same invariant to `POST /api/onboarding/items/:id/retry`; remove its direct SQL path so it cannot recreate `sourcing/pending`.
- Audit/deprecate any batch retry route or stale client call (`/batches/:id/bulk-retry`): either route it through the same seam or remove the unsupported client surface; no alternate retry endpoint may bypass the gate.
- In `POST /api/onboarding/items/:id/resolve-sourcing`:
  - require the item to be in Sourcing and workspace-owned;
  - reject `use_selected_bundle`/all bundle payloads;
  - allow only `fallback_to_discovery`, implemented through the dedicated atomic operation;
  - do not read evidence to construct extraction data and do not call `updateItemExtractionData`.
- Keep `POST /items/advance` defense-in-depth through the repository’s adjacent-only transition rule.

### File: `src/product-intelligence/onboarding-import.ts`

- In create mode, read/pass the same effective entry stage (`discovery` while disabled) to `insertItems`; augment mode must not change an existing item’s stage.
- Preserve the existing atomic import record/evidence merge contract.

### New test: `src/tests/unit/sourcing-safety-routes.test.ts`

- Use the existing Hono + temporary SQLite harness.
- Assert spreadsheet `POST /batches` creates `discovery/pending` with `sourcingDecision=null` when the flag is OFF.
- Assert the same import can enter Sourcing only under an explicit ON override (capability behavior only; no worker implementation).
- Assert create-mode Agent Lab imports use Discovery while OFF; augment mode preserves stage.
- Seed multiple `sourcing/pending` rows and assert the bulk endpoint moves all eligible rows, writes distinct valid fallback decisions, and reports ineligible/missing IDs.
- Assert wrong-workspace IDs fail closed without cross-workspace mutation.
- Assert `/items/reset` and `/:id/retry` cannot leave a Sourcing item pending while OFF.
- Assert `resolve-sourcing` accepts fallback, rejects selected-bundle payloads, and never writes Curation/extraction state.
- Assert `items/advance` cannot use a legacy `bundle_to_curation` row to skip Discovery.

### Update: `src/tests/unit/onboarding-duplicate-skip.test.ts`

- Add the stage assertion to the existing real spreadsheet-import route test: the surviving new item is `discovery/pending` under default flags.

### Update: `src/tests/unit/product-intelligence-import.test.ts`

- Add create-mode stage assertions under OFF and ON overrides; reset overrides in test teardown.

### Acceptance

- Every production item-creation path is covered.
- Every production retry/reset path is covered.
- Route authorization/ownership prevents a repair request from touching another workspace.
- The unsupported direct-to-Curation path returns an error and has zero database effects.

## Milestone 4 — Capability-aware UI and explicit bulk repair affordance

### File: `src/client/onboarding-api.ts`

- Add typed `getOnboardingCapabilities()` and `fallbackSourcingItemsToDiscovery(itemIds)` functions.
- Replace `ItemDetailResponse.evidenceAttempts?: any[]` with the existing `DistributorEvidenceAttemptView[]` (or a narrowly typed historical-attempt view).
- Type the fallback response so partial/skipped outcomes must be handled.

### File: `src/client/components/Onboarding.tsx`

- Load onboarding capabilities before rendering `PipelineBoard`; fail closed (`engineEnabled=false`) on fetch failure and surface the fetch error/non-operational state rather than exposing engine actions.
- Pass a required `sourcingEngineEnabled` prop to `PipelineBoard`.
- Remove or reroute stale legacy retry helpers that bypass the board API; no hidden list view may offer an unsafe Sourcing retry.

### File: `src/client/components/PipelineBoard.tsx`

- Add required prop `sourcingEngineEnabled: boolean`.
- When disabled and the selected set contains eligible `sourcing/pending` rows, show a distinct bulk **Continue to Discovery** action. It calls the dedicated fallback API, confirms the item count, refreshes staged data, clears selection, and reports partial skips/errors.
- Do not label this action “Advance” or “Reset”; it is the auditable repair operation.
- Exclude Sourcing items from generic bulk Reset while disabled. If a stale Sourcing row reaches a single-item reset handler, call the safe fallback API or suppress reset entirely.
- Keep the Sourcing column visible so historical/stranded rows and six-stage reality remain observable; do not hide the stage itself.
- Pass capability state into `SourcingStagePanel` and `ReviewDrawerShell`.
- Do not include Sourcing in `isAutomatedStage` while the engine is absent.

### File: `src/client/components/pipeline-drawer/SourcingStagePanel.tsx`

- Add required `sourcingEngineEnabled` and a focused `onContinueToDiscovery` callback.
- Remove “automatic sourcing decision” copy unconditionally.
- When disabled:
  - render a concise “Sourcing engine unavailable/disabled” explanation;
  - retain read-only historical evidence/conflict visibility;
  - render only **Continue to Discovery**;
  - hide checkboxes, selection state, click-to-select behavior, **Use Selected Bundle & Continue**, and **Re-run Sourcing**.
- When enabled, do not restore bundle-to-Curation selection in this patch; that route is prohibited until the structured-record fallback ADR exists. The only supported resolution remains fallback to Discovery.

### File: `src/client/components/pipeline-drawer/ReviewDrawerShell.tsx`

- Add a prop controlling whether the generic Reset button is allowed for the current item; suppress it for Sourcing when the engine is disabled.
- Keep generic early-stage keyboard/advance behavior excluding Sourcing; the dedicated fallback button remains the only disabled-mode Sourcing transition.

### New test: `src/tests/unit/sourcing-stage-panel.test.tsx`

- Use `renderToStaticMarkup` (existing no-jsdom pattern).
- Disabled assertions: engine-unavailable copy and Continue action present; automatic-decision copy, Re-run, selected-bundle button, and evidence checkboxes absent.
- Enabled assertions: unsupported bundle-to-Curation action remains absent; historical evidence remains inspectable.
- Add a small pure UI predicate/helper if necessary and test that generic bulk/single Reset eligibility excludes disabled Sourcing while Continue eligibility includes only `sourcing/pending`.

### Acceptance

- A user can repair all selected stranded rows from the board.
- No disabled-mode UI advertises work the backend cannot perform.
- No UI exposes distributor-to-Curation routing.
- Historical evidence remains visible and untouched.

## Milestone 5 — Reconcile authoritative documentation

### File: `CONTEXT.md`

- Add **Sourcing** as the first of six declared Pipeline Stages and define it as a capability-gated pre-Discovery evidence stage.
- State that while the engine is disabled, imports enter Discovery and historical `sourcing/pending` rows use audited fallback.
- Correct the board relationship to six columns; describe automated stages accurately (Discovery, Extraction, Curation; Sourcing is automated only when its future engine capability is enabled).
- Update linear advancement to include Sourcing while explicitly prohibiting Sourcing → Curation.
- State distributor evidence is supporting third-party evidence, never a fake official URL; structured-record fallback is deferred.

### File: `AGENTS.md`

- Change “five key stages” to six and add the gated Sourcing entry before Discovery.
- Document `BAYSTATE_CMS_SOURCING_ENABLED` as default OFF, imports-to-Discovery behavior while OFF, and the no-engine/no-writer boundary.
- Correct the worker description if touched: it processes Discovery/Extraction/Curation today; it does not process Sourcing.

### File: `docs/adr/0007-item-centric-onboarding-pipeline.md`

- Amend the declared order to six stages.
- Record that Sourcing is present in the state model but capability-gated; disabled installations enter Discovery and use an audited fallback for stranded Sourcing rows.
- Reaffirm manual stage advancement and adjacent-only routing; explicitly prohibit direct Sourcing → Curation.
- Add a note that a dedicated Sourcing authority/provider/retry ADR is required before enabling the engine.

### Explicit follow-up, not part of this patch

- Do **not** create or accept a new Sourcing ADR here. A later ADR must define provider authority, evidence generations/writer, retry semantics, worker ownership, rights/provenance, and structured-record fallback before the capability defaults ON.

### Acceptance

- No governing onboarding text still calls the current state model five-stage.
- Documentation distinguishes declared Sourcing from an implemented Sourcing engine.
- Documentation contains no fake-URL or distributor-to-Curation guidance.

## Milestone 6 — Validation and review

### Focused commands

```bash
bunx vitest run src/tests/unit/sourcing-flags.test.ts src/tests/unit/sourcing-stage-panel.test.ts
bun test src/tests/unit/onboarding-repos.test.ts src/tests/unit/sourcing-stage-order.test.ts src/tests/unit/sourcing-resolution.test.ts src/tests/unit/sourcing-safety-routes.test.ts src/tests/unit/onboarding-duplicate-skip.test.ts src/tests/unit/product-intelligence-import.test.ts
```

- If a new DB-backed test is excluded from Vitest, register it in `package.json` `test:db`; update `vitest.config.ts` only when needed to prevent duplicate/wrong-runtime collection.

### Required project validation

```bash
bun run typecheck
bun run test
bun run lint
```

### Manual/API checks

- With env unset/OFF, import a small spreadsheet and verify every item appears in Discovery, not Sourcing.
- Seed/inspect historical `sourcing/pending` rows; select them in the Sourcing column, run **Continue to Discovery**, and verify stage/status plus `fallback_to_discovery` decision JSON.
- Verify Reset/Retry on a stale Sourcing row cannot leave it pending in Sourcing.
- POST a legacy selected-bundle payload and confirm 400 with no item/extraction mutation.
- Confirm the Sourcing drawer shows historical evidence but no automatic, rerun, checkbox, or bundle controls.
- Re-run with the flag ON only to confirm capability reporting/import entry behavior; do not expect or test a Sourcing worker.
- End with `git status --short` and `git diff --cached --name-only`; the latter must be empty. Review the diff allowlist and preserve pre-existing unrelated dirt.

## Exact file inventory

### New files

- `src/onboarding/flags.ts`
- `src/tests/unit/sourcing-flags.test.ts`
- `src/tests/unit/sourcing-safety-routes.test.ts`
- `src/tests/unit/sourcing-stage-panel.test.tsx`

### Files to modify

- `src/shared/schemas/onboarding.ts`
- `src/db/repositories/onboarding-item-repo.ts`
- `src/server/routes/onboarding-routes.ts`
- `src/product-intelligence/onboarding-import.ts`
- `src/client/onboarding-api.ts`
- `src/client/components/Onboarding.tsx`
- `src/client/components/PipelineBoard.tsx`
- `src/client/components/pipeline-drawer/SourcingStagePanel.tsx`
- `src/client/components/pipeline-drawer/ReviewDrawerShell.tsx`
- `src/tests/unit/onboarding-repos.test.ts`
- `src/tests/unit/sourcing-stage-order.test.ts`
- `src/tests/unit/sourcing-resolution.test.ts`
- `src/tests/unit/onboarding-duplicate-skip.test.ts`
- `src/tests/unit/product-intelligence-import.test.ts`
- `CONTEXT.md`
- `AGENTS.md`
- `docs/adr/0007-item-centric-onboarding-pipeline.md`
- `package.json` and `vitest.config.ts` only if required to register/run the new DB-backed suites correctly

## Non-goals and boundaries

- No distributor/provider lookup implementation, provider registry changes, credentials, network calls, paid crawls, or model calls.
- No `onboarding_evidence_attempts` writer, generation/run model, evidence migration, or historical evidence deletion.
- No Sourcing worker leg and no change to `AUTO_STAGES`.
- No Branding stage or other new Pipeline Stage/Stage Status.
- No fake source URLs and no relaxation of Discovery’s confirmed-URL requirement before Extraction.
- No distributor extraction mapper, image import, rights flow, or direct Sourcing/Distributor → Curation path.
- No structured-record fallback ADR or implementation.
- No live database repair script/write; repair occurs only through the sanctioned endpoint after normal application backup practices.
- No unrelated refactors of the large Pipeline Board, onboarding authorization model, classification/cohort internals, or ShopSite/catalog state.

## Residual risks

- Flag ON exposes the declared Sourcing entry stage but does not make it operational; it must remain OFF in production until the later vertical slice and ADR land.
- Previously persisted legacy `bundle_to_curation` decisions may remain readable for audit. Transition code must ignore them; deleting/re-writing historical audit data is out of scope.
- In-memory flags are process-local and not a durable settings system; this matches existing flag conventions but requires coordinated process configuration.
- Concurrent operators may submit fallback twice; the repository predicate must make the second call an explicit ineligible/no-op result, never a second transition.
- Existing onboarding routes have uneven workspace ownership checks. This patch must fully guard the new repair and modified resolve paths, but broad route-authorization remediation is a separate effort.
- Discovery can still pause for missing brand/domain or fail-closed extraction profiles; those are supported review states, not inert Sourcing stranding.
- Historical non-`pending` Sourcing rows (`failed`, `completed`, `in_progress`, `skipped`) are not part of the audited bulk cohort. UI must explain/report them rather than silently mutate them; expanding repair eligibility requires a separate decision.
