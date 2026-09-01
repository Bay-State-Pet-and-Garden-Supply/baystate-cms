# Onboarding Hardening Plan

**Status:** proposed; implementation must not start until Gate 0 closes.  
**Scope:** P1-C, P1-A, P1-E, P1-D, P1-B, the P2 hash-stability question, migrations, observability, validation, and rollback.  
**Required delivery order:** **P1-C → P1-A → P1-E → P1-D → P1-B**. P2 is a characterization-first closeout after the P1 sequence unless Gate 0 finds an active safety defect.

## 1. Outcomes and binding invariants

1. A review queue of 500 products does not issue one detail request per product. Queue rows are a bounded, typed read model; full detail is loaded for the selected product and at most two adjacent products.
2. An official URL is auto-selected only when **official-domain authority and strict product identity proof both pass**. Domain, title similarity, product-looking markup, or a high aggregate score cannot substitute for identity. Ambiguity, contradictory GTINs, malformed evidence, or unavailable verification routes to `needs_input`.
3. Work-state reads have bounded query growth, cursor pagination, separate count/item contracts, and explicit health. Missing/corrupt projection inputs never become false zeroes or a safer category.
4. Review, approval, export-draft creation, and verified ShopSite push remain distinct states and actions. Approval/export mutations require a server-derived principal, role, exact-payload idempotency receipt, atomic state/audit writes, and replay-safe behavior.
5. The exact imported identity is retained separately from its operational normalized identity with deterministic transformation provenance. Legacy data is marked lossy; migration never fabricates the original spreadsheet fragments.
6. Identity hashes include only documented identity fields. Diagnostics, warning/reason order, timestamps, and run-local bookkeeping cannot stale an otherwise identical selection.
7. All DB access added here uses repositories. No direct SQL is added to route, client, or onboarding service modules.
8. Rollback is fail-closed: disable automatic selection or revert code; never restore the relaxed selector. Database migrations are additive and roll-forward only.

## 2. Repository evidence and option decisions

| Area | Current evidence | Decision and rationale |
|---|---|---|
| P1-C review fan-out | `ReviewWorkspace.tsx:75-76,160-203,263-321` loads up to 500 work-state rows and calls `getItemDetail` for every loaded ID in chunks of 24. `ReviewQueue.tsx:10-21,121-145` reads thumbnail/title/brand from the detail cache. | Add a consumer-owned `ReviewQueueRow` projection. Do **not** replace 500 requests with one unbounded 500-detail response: that preserves over-fetching and couples the queue to inspector internals. Protean's bounded projection guidance supports a consumer-specific row contract [R6]. |
| P1-A relaxed URL acceptance | `job-queue.ts:1435-1466` computes `verifiedStrong` but first accepts `officialDomainResult` at title/overlap `0.25` or `skuInPage`. `page-verifier.ts:125-129,327-393,398-427` derives strong proof from an aggregate score and weak combinations. | Select only `verifiedStrong.find(hasAuthority) ?? null`, then harden `hasStrongProof` into explicit proof classes. Official-domain authority remains necessary but never sufficient. GTIN is treated as a product identifier, consistent with GS1 and Google Merchant guidance [R1-R3]; precision-first banding avoids a single fuzzy threshold [R4-R5]. |
| P1-E work-state cost/health | `onboarding-work-state.ts:77-107` performs direct SQL and silently returns an empty variant map on any failure; `:176-187` calls `listSourcesByItem` per discovery item; `:275-323` performs per-item direct run/stage SQL and catches all failures; `:813-828` projects all rows before filtering and offset pagination. `BatchWorkspace.tsx:108-122` requests the combined endpoint merely to refresh counts. | Move all reads into bulk repositories, split counts/items APIs, use an opaque stable cursor, and return `projectionHealth`. A read model should be shaped and bounded for its consumer rather than exposing an aggregate that every client enriches [R6]. Do not materialize a new always-synchronized work-state table in this tranche; its write-fan-out and consistency burden exceed the measured problem until the baseline proves otherwise. |
| P1-D approval/export | Durable review guards already exist (`onboarding-review-repo.ts:72-145`), and approval+advance is transactional (`:147-290`). However, the route validates before the transaction and writes audit rows after it (`onboarding-work-routes.ts:188-324`), trusts optional client `reviewerId`, and has no durable idempotency key. UI tab logic groups `approved`, `ready_to_export`, `completed`, and `skipped` (`batch-workspace-logic.ts:43-91,192-209`), while `BatchWorkspace.tsx:409-434` co-renders approval and export actions. | Preserve the existing durable review table, but add a generalized operation receipt and server principal. Make approval/audit/stage mutation one transaction and render separate **Approval** and **Export** tabs. Deployment-gate precedents make the approval a bound, auditable prerequisite—not the deployment itself [R7-R8]. |
| P1-B imported names | `spreadsheet-parser.ts:204-213` trims both name parts and joins with `(name + part2).trim()`; `:227-232` normalizes before persistence. `onboarding-migration.sql:30-38`, `onboarding-item-repo.ts:24-65,195-215,271-344`, and `OnboardingItemSchema` have no raw identity. Frozen evidence consumes `spreadsheetIdentity.name` (`evidence-extraction.ts:38-57`; `cohort-curator.ts:482-489`). | Preserve mapped raw identity fragments and a separate normalized identity envelope. Keep `onboarding_items.name` as the operational normalized name for compatibility. Do not store the full raw row; store only bounded mapped identity fields. Legacy backfill is explicitly lossy. |
| P2 hash claim | `variant-resolution.ts:158-180` already hashes an identity-only object and excludes `reasonCodes`, `warnings`, `createdAt`, and `sourceContentHash`. `curation-cohort-repo.ts:127-157` already excludes `shadowPackagingOcrData` and `packagingOcrStageRunId` from extraction identity. | The reported “one-line reason-code fix” is not supported by the current tree. Characterize every producer/consumer before editing production hash code. If all paths are stable, close P2 with tests and documentation only; do not create a hash-version migration without a reproduced defect. |

## 3. Gate 0 — required pre-implementation evidence

No writer starts until the following artifacts are reviewed and recorded in the implementation PR description (or an issue linked from it).

### G0.1 Dirty-state and safety capture

- Record `git status --short`, target-file hashes, and the changed/untracked manifest. Preserve unrelated work; do not stage, reset, restore, or commit it.
- Use one sequential writer. No network, paid crawl, model download, or live ShopSite call.
- Before any migration trial, copy the SQLite DB, run the existing backup verifier, and run migrations only against the verified copy or a synthetic temp DB. No live-DB repair/backfill is allowed outside the sanctioned migration path.

### G0.2 300–500-pair official-page identity benchmark

**New files:**
- `src/tests/fixtures/onboarding/official-page-identity-gold.jsonl`
- `scripts/benchmark-official-page-identity.ts`
- `src/tests/unit/official-page-identity-benchmark.test.ts`

Create 300–500 independently labeled item/page pairs, with at least 150 hard negatives and explicit strata for same-family variants, same-name/different-size products, listing/blog pages, duplicate/missing/invalid GTIN, JSON-LD `Product`/`ProductGroup`, Shopify matrices, SKU-only pages, canonical redirects, and official-domain false friends. Inputs are redacted local HTML/signal fixtures; acquisition is outside this plan and must not trigger new crawling.

The artifact records label provenance, expected normalized GTIN, page GTIN source paths, expected authority domain, identity label, and fixture content hash. Two reviewers adjudicate disagreements. The baseline report includes confusion matrices and Wilson 95% intervals by proof class, plus projected `needs_input` count/rate delta against the current selector.

**Activation floor:** any auto-eligible proof class has zero false-positive labels, point precision `1.0`, Wilson 95% lower bound `>= 0.95`, and no cross-variant false acceptance. Exact valid-GTIN cases have recall `>= 0.99`. Coverage/needs-input loss is reported but cannot relax the precision gate. If the floor is not met, that class remains manual.

### G0.3 Work-state query/p99 baseline

**New file:** `scripts/benchmark-onboarding-work-state.ts`.

Run 10 warmups + 100 measured reads over deterministic 50-, 500-, and 5,000-item synthetic batches and, if available, a **read-only verified DB copy**. Record p50/p95/p99, SQL statement count, rows examined/returned, response bytes, and peak process memory for counts, unfiltered page, `ready_for_review`, and sparse `needs_attention`. Query logs contain normalized statement IDs only—no values, URLs, names, credentials, or payload JSON.

### G0.4 Freeze the row/API contracts before P1-C

Approve this exact minimum `ReviewQueueRow` shape before coding:

- identity/display: `itemId`, `upc`, `displayTitle`, `brand`, `sourceType`, `imageUrl`;
- grouping/order: bounded family summary, durable `reviewState`, stable `sortKey`, `updatedAt`;
- queue-only safety: bounded `warningCodes`, `hasWarnings`, `reviewGateStatus: ready | blocked | unknown`;
- no descriptions, extraction blobs, OCR, proposals, variant matrices, source HTML, or full item objects.

Approve `ReviewQueuePage = {batchId, rows, nextCursor, counts, projectionHealth}`. Cursor is an opaque base64url encoding of versioned `(sortKey,itemId,filterHash)`, signed or hash-bound server-side; malformed or filter-mismatched cursors return `400`, never restart silently.

### G0.5 UI split boundary and P2 discrepancy

- Confirmed current sizes: `OfficialSiteResolutionWorkspace.tsx` **826 LOC**, `ReviewWorkspace.tsx` **1,505 LOC**, and `onboarding-work-state.ts` **874 LOC** (`wc -l`). P1-C may extract queue loading/cache hooks, but must not opportunistically rewrite the 826-line official-site workspace; P1-A changes only its reason/proof presentation if required.
- Trace every `identityMatrixHash` producer in `extraction-worker/routes/extract.ts`, `job-queue.ts`, the variant repository, and selection service. Add characterization tests proving diagnostic-only mutations are stable and identity mutations are not. Record whether the issue is already fixed. Production hash edits are forbidden without a failing fixture.

**Gate 0 acceptance:** all five artifacts exist; the benchmark labels and row contract are reviewed; baseline numbers are recorded; no implementation threshold is “TBD”; and P2 has a reproduced path or an explicit test-only closure.

## 4. Delivery sequence and work items

Each milestone lands and validates before the next begins. The only dependency order is:

`Gate 0 → P1-C → P1-A → P1-E → P1-D → P1-B → P2/observability/docs closeout`.

### Milestone 1 — P1-C: bounded Rapid Review loading

**Files to modify**

- `src/client/components/onboarding/review/ReviewWorkspace.tsx`
- `src/client/components/onboarding/review/ReviewQueue.tsx`
- `src/client/components/onboarding/review/review-logic.ts`
- `src/client/components/onboarding/review/review-types.ts`
- `src/client/onboarding-work-api.ts`
- `src/server/routes/onboarding-work-routes.ts`
- `src/shared/schemas/onboarding-work-state.ts`

**Files to create**

- `src/shared/schemas/onboarding-review-queue.ts`
- `src/onboarding/onboarding-review-queue.ts`
- `src/client/components/onboarding/review/use-review-queue.ts`
- `src/client/components/onboarding/review/use-review-detail-cache.ts`
- `src/tests/unit/review-queue-schema.test.ts`
- `src/tests/unit/review-workspace-loading.test.tsx`

**Behavioral contract**

1. Add `GET /api/onboarding/batches/:id/review-queue?cursor=&limit=&...` with workspace ownership and Zod-validated output. During this milestone it may delegate to the existing batch projection, but it returns only `ReviewQueueRow` and a maximum page size of 100; P1-E replaces its internals without changing the contract.
2. Remove `ENRICH_CHUNK` and the effect that passes every item ID to `getItemDetail`. Row images, warning badges, grouping, filtering, and bulk-review safety come from the compact row.
3. Load full detail immediately for the selected row; prefetch only the next and previous review targets. Use an LRU cache capped at 5 details. Abort stale requests on batch/selection change, and generation-guard responses.
4. `reviewGateStatus = unknown` is blocking for bulk review; missing detail or queue health cannot be interpreted as eligible. The server review-completion gate remains final authority.
5. SSE refresh updates row pages/counts but does not overwrite a dirty inspector draft; invalidate only the affected row/detail after a successful mutation.

**Tests**

- `review-workspace-loading.test.tsx`: render a 500-row queue; assert no more than 3 initial `getItemDetail` calls, no call for unselected rows, LRU bound, stale-response rejection, adjacent prefetch, and dirty-draft preservation on SSE.
- `review-queue-schema.test.ts`: reject extraction blobs, oversized warning arrays, malformed cursors, and unknown enums; verify display fields and gate state.
- Extend `review-logic.test.ts`: warning filters and bulk selection use row summaries; `unknown` blocks.
- Extend `ReviewQueue` component tests: thumbnail/warning/title render before detail is available; keyboard navigation remains intact.

**Acceptance**

- A 500-item queue uses bounded row pages plus at most selected/adjacent detail calls; there is no code path equivalent to `items.map(getItemDetail)`.
- The queue remains useful when inspector detail fails, but review/bulk completion fails closed.
- Queue payload contains no inspector-only fields.

**Rollback:** revert the client to the prior workspace and leave the additive queue route unused. No DB change. Do not add a bulk-detail fallback.

### Milestone 2 — P1-A: strict official-page identity gate

**Files to modify**

- `src/onboarding/job-queue.ts`
- `src/onboarding/page-verifier.ts`
- `src/onboarding/sourcing/contracts.ts`
- `src/onboarding/variant-resolver.ts`
- `src/crawler/corpus-schema.ts` (compatibility re-export only if canonical GTIN helpers move)
- `src/onboarding/onboarding-telemetry.ts`
- `src/shared/schemas/onboarding-telemetry.ts`
- `src/tests/unit/brand-authority-gate.test.ts`
- `src/tests/unit/discovery-run-trace.test.ts`
- `src/tests/unit/sourcing-contracts.test.ts`
- `src/tests/unit/corpus-schema.test.ts`

**Files to create**

- `src/shared/gtin.ts`
- `src/tests/unit/page-verifier.test.ts`
- the Gate 0 benchmark files.

**Behavioral contract**

1. Replace relaxed-first selection with `verifiedStrong.find(v => hasAuthority(v.candidate)) ?? null`. Retain relaxed candidates only as bounded telemetry/review evidence; they cannot set `sourceUrl` or advance Discovery.
2. Replace the boolean’s implicit score semantics with a typed proof class: `exact_structured_gtin`, `exact_variant_gtin`, optional benchmark-qualified compound class, or `none`. `autoEligible` is a policy over proof class, not raw score.
3. Exact GTIN proof requires canonical 8/12/13/14-digit normalization, valid checksum for auto-selection, exact equality to the imported item identifier, a product-associated structured source path, and no contradictory product GTIN. A raw substring elsewhere in HTML remains diagnostic only.
4. Variant proof requires one unambiguous variant whose exact GTIN matches and whose receipt/matrix is current. Duplicate matches, stale hash, or name-only ranking are manual.
5. Authority remains ADR 0017 strict brand-domain mapping. Strong off-domain proof and weak official-domain proof both route to review.
6. `BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED=1` (or an equivalent existing central switch chosen in implementation) may kill auto-selection to review. There is no `relaxed` mode.

**Observability**

Add bounded proof-class counters and reason breakdowns: considered, auto-selected, authority-denied, identity-denied, ambiguous, contradictory-GTIN, invalid-GTIN, and routed-to-input. Report old-policy vs strict-policy `needs_input` delta from the offline benchmark and post-activation actual delta by batch. Do not label by URL, GTIN, item ID, or brand.

**Tests**

- `page-verifier.test.ts`: exact JSON-LD/Shopify GTIN positive; formatted equality; invalid checksum; GTIN in review text only; conflicting GTIN; duplicate variants; listing/blog; title+brand+schema without qualified proof; abort/fetch failure.
- `brand-authority-gate.test.ts`: relaxed official candidate no longer auto-selects; mapped official + strict proof succeeds; off-domain strict proof fails authority; ambiguous strict evidence fails closed.
- `discovery-run-trace.test.ts`: outcome/reason telemetry and item transition are deterministic.
- Benchmark test enforces the precision/Wilson floor and compares projected needs-input delta.
- Run extractor-profile golden products through local fixtures to prove selected strict URLs still reach the same trusted profile extraction outputs; zero network.

**Acceptance**

- No selection path can bypass both `hasStrongProof` and `passesAuthorityGate`.
- The labeled activation floor passes. A failed floor leaves auto-selection disabled for that proof class.
- Existing exact-GTIN golden products preserve selected URL and extraction result; weak combinations now park visibly.

**Rollback:** arm the auto-select kill-to-review switch or revert. Never restore `officialDomainResult` as an auto-select branch.

### Milestone 3 — P1-E: bounded, healthy work-state read model

**Files to modify**

- `src/onboarding/onboarding-work-state.ts`
- `src/server/routes/onboarding-work-routes.ts`
- `src/server/routes/onboarding-routes.ts`
- `src/client/onboarding-work-api.ts`
- `src/client/components/onboarding/BatchWorkspace.tsx`
- `src/client/components/onboarding/review/use-review-queue.ts`
- `src/shared/schemas/onboarding-work-state.ts`
- `src/db/repositories/onboarding-source-repo.ts`
- `src/db/repositories/onboarding-variant-resolution-repo.ts`
- `src/db/repositories/classification-run-repo.ts`
- `src/db/repositories/classification-cohort-run-repo.ts`
- `src/tests/unit/onboarding-work-state.test.ts`
- `src/tests/unit/onboarding-telemetry.test.ts`

**Files to create**

- `src/db/repositories/onboarding-work-state-repo.ts`
- `src/tests/unit/onboarding-work-state-query-plan.test.ts`
- `src/tests/unit/onboarding-work-routes.test.ts`
- the Gate 0 benchmark script.

**Behavioral contract**

1. Add separate workspace-scoped APIs:
   - `GET /api/onboarding/batches/:id/work-state/counts` → `{batchId,counts,projectionHealth}`;
   - `GET /api/onboarding/batches/:id/work-state/items?cursor&limit&filters...` → `{batchId,items,nextCursor,projectionHealth}`.
2. Remove client offset pagination. Stable order is `(row_number,id)` unless a consumer contract defines another stable key. A cursor is filter-bound; mutation between pages may update rows, but no unchanged row is duplicated or skipped.
3. The items service scans bounded raw chunks and bulk-loads context for those IDs. A sparse filter may return fewer than `limit`; every response caps scanned rows and returns a continuation rather than scanning an unbounded batch in one request. Counts may scan the batch once but use a constant number of set-based repository queries.
4. Add bulk repository methods for source counts, active variant summaries, current cohort/run states, stage results, review rows, and workspace-scoped change-set status. Remove `getDb()` and dynamic `require()` from `onboarding-work-state.ts`.
5. Parse errors are explicit. A corrupt variant/curation context marks the affected item `needs_attention` with new reason/action `projection_unavailable`/`retry_projection` (or an equivalently reviewed enum), and `projectionHealth.status = degraded`. A failed category-critical bulk query returns `503` plus bounded health detail; it must not return empty data/zero counts. Optional display-field loss may return 200/degraded with null display data.
6. Migrate the legacy `/work-state` route to a temporary compatibility adapter over the new service, mark it deprecated, move all first-party clients in this milestone, then remove the adapter after one release. There is one canonical projector.

**Projection health contract**

`{status: healthy | degraded, version, computedAt, issues:[{source,code,affectedCount}]}`. `issues` is bounded and contains no exception text or record values. Clients show “counts unavailable/projection degraded,” never cached-looking zeroes. Approval/export selection is disabled when the relevant queue is degraded.

**Performance/observability**

- Structured local metrics: endpoint, projection version, duration, statement count, rows scanned/returned, payload bytes, health status, and cursor-page number. No query values.
- Acceptance on the 500-item fixture: counts and an item page have statement counts independent of batch size; full traversal is `O(pages)`, not `O(items)`; p99 is `<= 250 ms` and at least 50% below recorded baseline on the same machine/fixture; peak memory and payload bytes do not regress.
- 5,000-item sparse filtering is bounded per response and does not block the event loop with one full item projection.

**Tests**

- Query-count assertions for 50/500/5,000 rows; fail if statement count grows with item count.
- Cursor traversal has no duplicate/gap for unchanged rows; cursor/filter mismatch is 400; caps are enforced.
- Repository failure returns 503/degraded, not false zeros. Malformed per-item JSON yields affected-item `needs_attention` and bounded health issue.
- Existing mapping-table cases remain byte-equivalent when health is healthy.
- `BatchWorkspace` count refresh calls only `/counts`; every feature view uses `/items` or its typed consumer projection.

**Acceptance**

- No source N+1, no service-level direct SQL, no silent catch-to-empty, and no offset API in first-party clients.
- Performance and health gates pass at 500 and 5,000 items.

**Rollback:** deploy the previous application against the additive/no-schema-change milestone or temporarily route the compatibility adapter to the canonical new projector. If health is degraded, disable affected actions; never fall back to silent projection.

### Milestone 4 — P1-D: separate and replay-safe approval/export gates

**Files to modify**

- `src/server/app.ts`
- `src/server/routes/onboarding-work-routes.ts`
- `src/server/routes/onboarding-routes.ts` (`/promote` export-draft preparation only)
- `src/db/onboarding-migration.sql`
- `src/db/migrations.ts`
- `src/db/repositories/onboarding-review-repo.ts`
- `src/db/repositories/audit-log-repo.ts`
- `src/onboarding/draft-promoter.ts`
- `src/shared/schemas/onboarding-work-state.ts`
- `src/shared/schemas/onboarding.ts` (export request/response contract if that remains its owner)
- `src/client/onboarding-work-api.ts`
- `src/client/onboarding-api.ts`
- `src/client/components/onboarding/batch-workspace-logic.ts`
- `src/client/components/onboarding/BatchWorkspace.tsx`
- `src/client/components/onboarding/WorkStateTabs.tsx`
- `src/client/components/onboarding/approved/ApprovedView.tsx`
- `src/client/components/onboarding/approved/ReadyToExportView.tsx`
- `src/tests/unit/onboarding-review-state.test.ts`
- `src/tests/unit/onboarding-approval-gates.test.ts`
- `src/tests/unit/durable-approval-promote.test.ts`
- `src/tests/unit/approved-logic.test.ts`

**Files to create**

- `src/db/repositories/onboarding-operation-receipt-repo.ts`
- `src/server/authenticated-principal.ts`
- `src/tests/unit/onboarding-operation-receipt-migration.test.ts`
- `src/tests/unit/onboarding-operation-idempotency.test.ts`
- `src/tests/unit/onboarding-approval-export-ui.test.tsx`

**Migration/receipt contract**

Add `onboarding_operation_receipts` with `id`, workspace/batch IDs, `operation` (`approve` or `create_export_drafts`), client `idempotency_key`, canonical `request_hash`, server `actor_id`, `actor_role`, status (`started|completed|failed`), bounded `response_json`, timestamps, and unique `(workspace_id,batch_id,operation,idempotency_key)`. Index batch/operation/status. A same-key/same-hash retry returns the completed receipt with `replayed=true`; same key/different hash is `409`; an interrupted `started` row fails closed for reconciliation and never re-executes blindly.

**Behavioral contract**

1. Remove `reviewerId` from client input. `app.ts` authenticates the bearer token and supplies a server principal. Approval requires `catalog_approver`; export-draft creation requires `catalog_exporter`. Principal/role configuration is server-side; missing principal or role is 401/403 and performs zero writes. No route trusts an actor/role header or request body.
2. Approval transaction owns: receipt claim, eligibility revalidation, durable approval, review→promotion transition, per-item audit, batch audit, and completed response receipt. Emit SSE only after commit. Any thrown audit/receipt failure rolls back state.
3. Export-draft transaction/service claims its own receipt and verifies current durable approval immediately before draft/change-set mutation. Approval never invokes it. Existing Change Set Review remains the only surface for actual ShopSite export/push.
4. Split tabs into **Approval** (reviewed, awaiting explicit approval) and **Export** (approved, export drafts, verified completions). `skipped` gets a passive/history surface, not an approval/export count. Buttons say “Approve…” and “Create ShopSite drafts…”; only a pushed change set says “Exported.”
5. Disable repeat buttons while in flight, but treat the DB receipt—not UI state—as the double-send authority.

**Tests**

- Two concurrent identical approval requests: one mutation/audit set, identical replay response, one completed receipt.
- Same key with altered IDs/order semantics: canonical order-equivalent payload replays; changed set conflicts 409.
- Crash/fault injection at receipt, approval, stage, audit, and completion boundaries: no approval without matching stage/audit/receipt; no draft without approval.
- Missing/wrong role and client actor spoofing execute zero writes.
- Approval never creates a change set or invokes ShopSite; export preparation never auto-approves; a double-send creates one change set/draft set.
- Consequential edit invalidates approval and causes later export receipt attempt to fail closed.
- UI test proves Approval and Export are separate tabs/actions and degraded projection disables both.

**Acceptance**

- Every successful operation has one durable completed receipt and atomic audit lineage bound to server actor/role/request hash.
- Network double-click/retry cannot duplicate approval or draft creation.
- No UI/API text conflates approved, drafts created, and verified exported.

**Rollback:** database table remains inert. Revert application code only after confirming no `started` receipts; reconcile started receipts read-only and either mark failed via a sanctioned repair after backup or retain blocked. Never delete receipts or clear approval to force a retry.

### Milestone 5 — P1-B: lossless imported identity and versioned normalization

**Files to modify**

- `src/onboarding/spreadsheet-parser.ts`
- `src/shared/schemas/onboarding.ts`
- `src/shared/schemas/cohorts.ts`
- `src/db/onboarding-migration.sql`
- `src/db/migrations.ts`
- `src/db/repositories/onboarding-item-repo.ts`
- `src/onboarding/cohort-curator.ts`
- `src/classification/stages/evidence-extraction.ts`
- `src/onboarding/cohort-title-hash.ts`
- `src/onboarding/cohort-page-hash.ts`
- `src/tests/unit/spreadsheet-parser.test.ts`
- `src/tests/unit/onboarding-repos.test.ts`
- `src/tests/unit/cohort-freeze.test.ts`
- `src/tests/unit/evidence-extraction.test.ts`
- `src/tests/unit/cohort-title-hash.test.ts`
- `src/tests/unit/cohort-page-hash.test.ts`

**Files to create**

- `src/onboarding/imported-identity.ts`
- `src/tests/unit/onboarding-imported-identity-migration.test.ts`

**Migration/schema contract**

Add nullable `raw_identity_json`, `normalized_identity_json`, `identity_normalizer_version`, and `identity_provenance_hash` to `onboarding_items`. Fresh-schema SQL and marker-gated upgrade must converge. Envelopes are Zod-validated, size-bounded, canonical JSON:

- raw v1: exact mapped `upc`, name fragments `{column,value,boundary}`, brand/department hints, row number, and column-mapping hash;
- normalized v1: operational name/hints and ordered transformations `{code,beforeHash,afterHash,version}`;
- provenance: source (`spreadsheet` or `legacy_operational_backfill`), `lossy`, parser version, and hash of canonical raw+normalized envelopes.

Never store the full row or unmapped columns. Backfill existing items as `legacy_operational_backfill`, `lossy=true`, with the existing operational fields in both envelopes; it must not claim original fragments, rerun normalization, alter `name`, or mutate completed frozen snapshots.

**Behavioral contract**

1. Capture raw cell values before trim/normalization. Join split fields with a versioned boundary rule: preserve explicit boundary whitespace as one space; when neither cell contains boundary whitespace, concatenate fragments (preserving `LAV`+`ENDER` and `ANTL`+`ER SM` behavior). Record the decision. Never silently guess an extra separator.
2. Run the existing conservative normalization into the normalized envelope; `onboarding_items.name` remains its operational output. Transformations are deterministic/idempotent and never overwrite raw identity.
3. Add execution-evidence projection v3 carrying the imported identity/provenance hash while retaining V1/V2 parsers. New freezes use v3; old snapshots remain byte-readable. Evidence metadata distinguishes exact imported text from normalized operational text.
4. Migration activation requires the worker paused and zero `freezing|running` cohort runs. If active runs exist, stop before backfill/activation. Future freezes bind v3 via the existing canonical projection hash; do not rewrite historical run hashes or extraction hashes in place.
5. UI exposure, if added later, labels raw vs normalized clearly; this milestone does not add editing of raw identity.

**Tests**

- Spreadsheet regressions: hard split words, explicit spaces, empty part, Unicode, leading zeros in string UPCs, glued size+brand, brand-last, idempotence, and bounded envelopes.
- Repository round-trip and corrupt-envelope fail-closed behavior.
- Fresh and upgrade migration; deterministic lossy backfill; rerun idempotence; active cohort-run refusal; old code tolerates additive columns.
- Freeze v3 includes raw/normalized provenance; changing raw identity/provenance changes the v3 snapshot hash; transformation ordering is canonical; diagnostics/timestamps do not.
- Historical V1/V2 fixture parses and hashes unchanged. Frozen evidence uses normalized operational name for curation while preserving raw provenance metadata.

**Acceptance**

- Every new import can reconstruct exact mapped name fragments and explain every normalization step.
- Legacy rows are truthful about lossiness; no fabricated raw identity.
- Existing operational titles remain unchanged on migration, and historical frozen snapshots are immutable/readable.

**Rollback:** stop new imports, revert app code, retain nullable columns/envelopes, and do not down-migrate. Existing `name` keeps old code functional. Restore a verified backup only for a proven migration corruption, never as routine code rollback.

### Milestone 6 — P2 hash stability, observability, and documentation closeout

**Files to modify only if a failing characterization identifies them**

- `src/shared/schemas/variant-resolution.ts`
- `src/db/repositories/curation-cohort-repo.ts`
- the actual producer found in `src/extraction-worker/routes/extract.ts` or `src/onboarding/job-queue.ts`

**Tests to create/extend**

- `src/tests/unit/variant-resolution-schema.test.ts`
- `src/tests/unit/onboarding-variant-resolution-repo.test.ts`
- `src/tests/unit/curation-cohort-repo.test.ts`
- `src/tests/integration/onboarding-betterbone-variant-flow.test.ts`

Assert invariance under reason-code/warning/diagnostic order, `createdAt`, source-content hash, availability/price/image changes if documented non-identity, OCR stage-run IDs, and shadow OCR. Assert change under parser version, canonical parent, platform, variant key, normalized identifiers/options, deep link, selected source/type, accepted evidence IDs, and actual extraction evidence. Any intentional hash-domain change requires a versioned hash, migration impact analysis, stale-receipt behavior, and no in-place rewriting of historical receipts.

**Likely acceptance:** tests confirm current `computeIdentityMatrixHash` and `computeExtractionHash` are already stable; production diff is zero and the stale claim is superseded in documentation.

Update `src/onboarding/onboarding-telemetry.ts` and its schema/tests so the final dashboard reports:

- strict proof-class selection and needs-input delta;
- review queue row/detail requests, payload and load latency;
- work-state p95/p99, statements, scanned rows, projection degradation;
- approval/export attempt, success, reject, replay, conflict, and interrupted-receipt counts;
- import normalization code counts and lossy legacy row counts.

Use bounded enums only. Timing metrics must state derivation and sample window; unavailable values remain `not_available`, never zero.

Add supersession banners (documentation edits only; do not delete history):

- `docs/plans/onboarding-ui-clarity-and-observability.md`: mark implemented portions vs this plan; this plan owns read-model performance/health. Explicitly state one-click semantic-conflict mutation remains out of scope unless separately designed.
- `docs/plans/issue-variant-page-resolution.md`: mark it historical/partially implemented and point hash assertions to the characterization tests.
- `docs/plans/agent-lab-training-interface-spec.md`: mark decommissioned by ADR 0030; never use it to reintroduce Agent Lab.
- `docs/plans/domain-extractor-profile-worker-plan.md`: state that deterministic worker/profile governance remains valid, while runtime LLM extraction and agent orchestration remain prohibited by ADR 0030/0033.

## 5. Migration deployment and rollback runbook

1. **Preflight:** one writer; capture dirty tree; pause onboarding worker; confirm zero item/cohort claims; verify disk space; create timestamped DB backup; run `scripts/verify-sqlite-backup.ts` (existing verifier path/CLI as implemented) against it; record schema markers and row counts.
2. **Rehearsal:** migrate a copy twice; compare `PRAGMA integrity_check`, `foreign_key_check`, schema markers, row counts, approval states, stage counts, operation receipts, identity provenance hashes, and representative frozen snapshot hashes.
3. **Deploy code in milestone order.** P1-D and P1-B each carry their own marker-gated additive migration. Marker writes are last inside the transaction. A partial failure leaves the marker old and the idempotent migration retryable.
4. **Canary:** one synthetic/local batch, then one fully reviewed real batch with no network side effects. Observe strict-selection needs-input delta, query p99/health, review detail count, receipt replay, and normalization counts.
5. **Activation:** resume one worker only after health is green. No automatic profile activation, DB repair, ShopSite push, or catalog commit is part of this plan.
6. **Rollback:** stop worker/actions first. Prefer code revert or strict auto-select kill. Additive schema remains. Do not use `git reset/restore`, drop columns/tables, delete receipts, rewrite frozen hashes, or mutate approval state. Restore the verified backup only if migration corrupted data and only after preserving the failed DB for diagnosis.

## 6. Validation commands

Run targeted suites after each milestone, then the full local gate. Commands are network-free and must use temp DBs/verified copies.

```bash
# Baselines / offline benchmarks (after Gate 0 scripts exist)
bun run scripts/benchmark-official-page-identity.ts --fixture src/tests/fixtures/onboarding/official-page-identity-gold.jsonl --json /tmp/onboarding-identity-baseline.json
bun run scripts/benchmark-onboarding-work-state.ts --sizes 50,500,5000 --warmup 10 --iterations 100 --json /tmp/onboarding-work-state-baseline.json

# P1-C
bunx vitest run src/tests/unit/review-queue-schema.test.ts src/tests/unit/review-workspace-loading.test.tsx src/tests/unit/review-logic.test.ts

# P1-A
bun test src/tests/unit/page-verifier.test.ts src/tests/unit/brand-authority-gate.test.ts src/tests/unit/discovery-run-trace.test.ts src/tests/unit/sourcing-contracts.test.ts src/tests/unit/corpus-schema.test.ts src/tests/unit/official-page-identity-benchmark.test.ts

# P1-E
bun test src/tests/unit/onboarding-work-state.test.ts src/tests/unit/onboarding-work-state-query-plan.test.ts src/tests/unit/onboarding-work-routes.test.ts src/tests/unit/onboarding-telemetry.test.ts

# P1-D
bun test src/tests/unit/onboarding-review-state.test.ts src/tests/unit/onboarding-approval-gates.test.ts src/tests/unit/durable-approval-promote.test.ts src/tests/unit/onboarding-operation-receipt-migration.test.ts src/tests/unit/onboarding-operation-idempotency.test.ts
bunx vitest run src/tests/unit/approved-logic.test.ts src/tests/unit/onboarding-approval-export-ui.test.tsx

# P1-B + P2
bun test src/tests/unit/spreadsheet-parser.test.ts src/tests/unit/onboarding-repos.test.ts src/tests/unit/onboarding-imported-identity-migration.test.ts src/tests/unit/cohort-freeze.test.ts src/tests/unit/evidence-extraction.test.ts src/tests/unit/cohort-title-hash.test.ts src/tests/unit/cohort-page-hash.test.ts src/tests/unit/variant-resolution-schema.test.ts src/tests/unit/onboarding-variant-resolution-repo.test.ts src/tests/unit/curation-cohort-repo.test.ts src/tests/integration/onboarding-betterbone-variant-flow.test.ts

# Repository gates
bun run typecheck
bun run lint
bun run test

git status --short
```

Acceptance evidence records command, exit status, duration, changed-file manifest, and baseline/after JSON. Do not claim a command passed unless it was run.

## 7. Explicit non-goals and boundaries

- Do not restore `src/product-intelligence/**`, Agent Lab UI/routes/tables, specialist runtimes, policy/budget/event subsystems, or Product Intelligence imports. ADR 0030 remains binding.
- Do not implement ADR 0033 Assistants, model calls, autonomous loops, runtime LLM extraction, discovery adjudication, or a new intelligence/orchestration layer. ADR 0033 is proposed and cannot authorize implementation.
- Do not change the six pipeline stages, cohort barrier/frozen semantics, taxonomy, classification authority, variant-selection UI architecture, profile activation governance, image rights decisions, or Promotion safety gates except for the narrow contracts above.
- Do not rewrite `OfficialSiteResolutionWorkspace.tsx` as part of queue loading. Do not create a generic frontend entity cache.
- Do not perform new crawls/network calls to build benchmark data. Do not use paid services.
- Do not write a live DB except marker-gated migrations and explicitly sanctioned receipt/approval/import paths after backup verification. No ad hoc SQL repair.
- Do not push to ShopSite, activate catalog configuration, or stage/commit outer-repository changes. The sanctioned scoped catalog commit path is not needed here.

## 8. Overall acceptance criteria

- Gate 0 is complete and reproducible.
- Delivery order is exactly P1-C, P1-A, P1-E, P1-D, P1-B; each milestone passes before the next starts.
- 500-item review load and 5,000-item read-model tests meet request/query/p99/health gates.
- Strict auto-selection meets the labeled precision gate and all non-qualified evidence routes visibly to input.
- Projection failures are visible and fail closed; no silent empty map/false zero remains.
- Approval/export roles, atomic audits, durable receipts, double-send/replay, and UI separation tests pass.
- New imports preserve raw and normalized identity; legacy lossiness is explicit; frozen history is not rewritten.
- P2 closes with a reproduced fix or test-proven no-op, not an assumed edit.
- Typecheck, lint, targeted suites, and full tests pass; dirty worktree remains preserved and unstaged.

## 9. Residual risks

1. The 300–500-pair set may underrepresent future storefront markup; proof classes remain kill-to-review and require continued labeled monitoring.
2. Precision-first gating will increase `needs_input`; operator capacity is observable but not solved by weakening identity.
3. Cursor pages over a mutating batch provide stable traversal for unchanged rows, not a transaction-wide snapshot. A future persisted projection is warranted only if measured churn makes this unacceptable.
4. A single API token plus configured principal is role enforcement but not multi-user identity. Multi-user auth/RBAC is a separate product/security project; until then audit identifies the configured local principal.
5. Additive receipt/identity migrations cannot be down-migrated safely. Operational rollback is code-only unless verified corruption requires backup restoration.
6. Legacy raw names are irrecoverable; the migration can only label them lossy.
7. Splitting large UI/service modules reduces the touched paths but does not by itself solve all existing maintainability debt.

## 10. References

- **[R1] GS1, Verified by GS1:** https://www.gs1us.org/industries-and-insights/by-topic/verified-by-gs1
- **[R2] Google Merchant Center, GTIN specification:** https://support.google.com/merchants/answer/6324461
- **[R3] Google Merchant Center, structured-data/JSON-LD mapping:** https://support.google.com/merchants/answer/6386198?hl=en-GB&ref_topic=6386199
- **[R4] Claro, banded confidence thresholds for auto-merge:** https://getclaro.ai/resources/playbooks/confidence-thresholds-auto-merge/
- **[R5] Claro, why a single fuzzy-match threshold breaks:** https://getclaro.ai/resources/guides/why-fuzzy-match-scripts-break/
- **[R6] Protean, projection granularity:** https://docs.proteanhq.com/patterns/projection-granularity/
- **[R7] GitLab, deployment approvals:** https://docs.gitlab.com/ci/environments/deployment_approvals/
- **[R8] openwop RFC 0051, approval deployment gate primitive:** https://github.com/openwop/openwop/blob/main/RFCS/0051-approval-deployment-gate-primitive.md
- Repository authorities: `CONTEXT.md`; ADR 0007, 0013, 0014, 0016, 0017, 0030, and proposed 0033.
