# Multi-Distributor Sourcing V2 Recovery and HEAD Adaptation Plan

## Objective and verified baseline

Recover the byte-available Multi-Distributor Sourcing V2 work, then adapt it to the current six-stage, capability-gated architecture. This is a recovery/merge effort, not a clean-room redesign.

Verified on the planning baseline (`HEAD 6ff4880`):

- `stash@{1}` is `f6dfd66`; `git diff stash@{1}^ stash@{1}` contains the 13 tracked V2 modifications.
- stash parent `dc01ea6` contains all 15 untracked V2 files.
- recovered files target base `d1b9080`; none may be applied blindly to HEAD.
- the current dirty worktree contains the uncommitted Sourcing safety patch and unrelated concurrent work; the staged set was empty at plan creation.
- current SQLite has the 13-column `onboarding_evidence_attempts` table and no production writer.
- the operator-reported dev DB cohort is 148 `sourcing/pending` items and zero evidence rows. This plan does not mutate or repair that DB.

### Recovery provenance and safe extraction

Before implementation, record `git status --short`, `git diff --cached --name-only`, HEAD, target-file hashes, and both stash object IDs. Never run `git reset`, `git restore`, `git clean`, `git stash`, or a broad checkout/apply. Do not overwrite the current safety-patch versions of the Sourcing drawer files.

Use an ignored temporary recovery directory, not target paths:

```bash
mkdir -p .pi/recovery/sourcing-v2/untracked
for p in $(git ls-tree -r --name-only dc01ea6); do
  mkdir -p ".pi/recovery/sourcing-v2/untracked/$(dirname "$p")"
  git show "dc01ea6:$p" > ".pi/recovery/sourcing-v2/untracked/$p"
done
git diff stash@{1}^ stash@{1} > .pi/recovery/sourcing-v2/tracked.diff
```

Treat these artifacts as read-only source material. Merge behavior function-by-function into current files with one sequential writer. After every milestone, compare the current status against the baseline allowlist and stop on unexpected concurrent overlap.

## Non-negotiable invariants

- No Branding stage.
- Distributor lookup is UPC/GTIN-first. Imported brand and the optional brand-profile registry are advisory only; missing/stale profiles fall open to every enabled connection and never imply `not_stocked`.
- Sourcing may route only to adjacent Discovery. No new code may create or act on `bundle_to_curation`; the value remains parseable only for historical audit compatibility.
- Coherent current-generation evidence produces `evidence_to_discovery`; no evidence produces `fallback_to_discovery`; hard identity conflicts produce `needs_input_conflict` and remain in `sourcing/needs_input` until resolved.
- A Sourcing conflict item cannot be advanced through the generic advancement endpoint. Resolution must clear all open hard conflicts and complete the guarded Sourcing transition first.
- No fake source URL. Discovery still finds and verifies the official product page before Extraction.
- No structured-record fallback. It requires a separate ADR.
- `BAYSTATE_CMS_SOURCING_ENABLED` remains default OFF and fail-closed. Disabled import, repair, retry/reset, capabilities, and UI behavior from the safety patch remains unchanged.
- No raw credentials in `configuration_json`, source, logs, errors, or API responses. Connections store only `secret_ref`; secret resolution occurs server-side immediately before connector execution.
- Network work is bounded, cancellable, and outside import/database transactions. No network or paid crawl is run during recovery or validation.
- Evidence attempts are immutable and generation-scoped. A retry creates a new generation; stale generations remain audit-visible but cannot participate in reconciliation, acceptance, conflict completion, or routing.
- Distributor images are display-only in v1. They may not be copied to `extraction_data_json`, classification evidence, drafts, or promotion without PI-6 rights and identity verification.
- Database access remains repository-owned. Migrations are idempotent. No live DB write occurs without the sanctioned migration/activation path and a verified backup.
- No catalog/ShopSite write, Git catalog activation, staging, or commit is part of this work.

## Adaptation decision table

| # | Decision | Implementation contract and rationale |
|---|---|---|
| 1 | Routing | Add `evidence_to_discovery` to `SourcingRouteEnum`. Coherent evidence is accepted, audited with that route, and moved to `discovery/pending`; no evidence/all-not-stocked uses `fallback_to_discovery`; conflicts stay `sourcing/needs_input`. This preserves adjacent-only routing, the oracle prohibition, and cohort ownership. `evaluateItemReadiness()` already treats a non-null `sourcingDecision` as source-finalized; add a regression proving the new route survives the normal Discovery/Extraction path and does not strand cohort readiness. |
| 2 | Transition helper | Do **not** restore a generic third argument. Add dedicated `completeSourcingWithDecision(itemId, decision, targetStage: 'discovery' | 'sourcing')`. It performs a guarded/CAS-style update only from `stage='sourcing'` and validates route/target pairs: `evidence_to_discovery` or `fallback_to_discovery` → `discovery/pending`; `needs_input_conflict` → `sourcing/needs_input`. It rejects `curation`, non-Sourcing rows, route/target mismatch, and unresolved hard-conflict advancement. Keep two-argument `updateSourcingDecision` only for audit-only callers/tests and make it Sourcing-stage guarded. |
| 3 | Worker integration | Build the poll stage list per call: prepend `sourcing` only when `getSourcingFlags().sourcingEngineEnabled`; retain current curation cohort exclusivity. Add `processSourcing`. OFF means no Sourcing claims; ON + zero connections means audited automatic pass-through to Discovery. |
| 4 | Provider engine | Add a provider-neutral engine under `src/onboarding/sourcing/` with the closed connector enum `api | ftp_catalog | csv | legacy_adapter`. Port shapes/auth models—not Next.js/Supabase code—from BayState. Phase 1 production adapters: Phillips REST, then BCI REST. Phase 2: Orgill SFTP HD1, then PFX SFTP CSV after dependency/security approval. Exclude Central EDI. All lookups normalize catalog records and search exact normalized UPC/GTIN first. |
| 5 | Migration | Recover `distributor-v2-migration.sql` as new DDL, but run a new `distributor_v2_schema_version` gated block after the existing 13-column evidence-table creation. Use `PRAGMA table_info` guards for the recovered five additions—`distributor_connection_id`, `catalog_snapshot_id`, **`catalog_version`**, `observed_at`, `expires_at`—plus generation/run identity defined in ADR (`sourcing_generation_id`). Create the six other recovered tables with `IF NOT EXISTS` and the ADR-required generation table; backfill before writing the marker. No catch-and-continue marker after partial failure. |
| 6 | UI/API | Maintain one capability-gated `SourcingStagePanel`. OFF stays read-only + Continue. ON shows current generation, attempts, errors, display-only images, durable conflicts and their three resolution actions, Retry, and Continue only when the item is completed/eligible. Add a capability-gated `Distributors` tab to `OnboardingSettings`. Project raw attempt rows to one shared typed view; never expose `identityJson` as the client contract. |
| 7 | Conflict resolution | `resolveConflict` accepts `resolve_candidate | custom_value | dismiss`; candidate selection records acceptance. Inside one transaction it verifies item/workspace/current generation, resolves an open conflict once, and only when zero open hard conflicts remain and the decision is `needs_input_conflict` completes with `evidence_to_discovery` and moves to `discovery/pending`. Generic advance remains blocked before that. |
| 8 | Image rights | V1 excludes distributor images from pipeline evidence and copy. URLs can be shown read-only with provider/source/generation labels. Remove/guard the existing non-cohort `product-curator.ts` image backfill and do not restore the old resolve-sourcing image-copy path. A later ADR may integrate `verifyImageCandidate`/`computeCommerceApproved`. |
| 9 | Tests | Recover and adapt all six V2 suites to Bun DB conventions; preserve and extend the five safety-patch suites. Add provider-contract/engine/UI/settings tests. Register DB suites only in `test:db` and exclude Bun suites from Vitest to avoid duplicate/wrong-runtime collection. |
| 10 | ADR and activation | New `docs/adr/0014-multi-distributor-sourcing.md` is prerequisite to implementing adapters and mandatory before any environment turns the capability ON. It defines authority, contracts, secret refs, generations/writer, retry/cache semantics, rights, and rollout modes `shadow/manual/automatic`. The feature remains default OFF after delivery; enabling requires the rollout gates below, never model confidence. |

## Provider port matrix and phased scope

| Adapter | BayState reference | `connector_type` | Auth via `secret_ref` | Lookup model in this CMS | V1 status |
|---|---|---|---|---|---|
| Phillips | `apps/web/lib/b2b/adapters/phillips.ts` | `api` | one referenced `x-api-key`; non-secret base URL in configuration | bounded paged `/products`; normalize records, exact UPC/GTIN match; never treat an HTTP success with the wrong variant as `found` | **Phase 1 in**, first adapter |
| BCI / OrderCloud | `apps/web/lib/b2b/adapters/bci.ts`, `utils/oauth.ts` | `api` | referenced OAuth2 client id + client secret; token memory-only/redacted | client-credentials token, bounded `/me/products` pages, exact `xp.UPC`; price-schedule N+1 is not required for identity sourcing and stays off unless separately bounded | **Phase 1 in**, second adapter |
| Orgill | `apps/web/lib/b2b/adapters/orgill.ts`, `utils/fixed-width.ts`, `utils/sftp-client.ts` | `ftp_catalog` | referenced username/password or private-key material | download HD1 to an ignored quarantine/temp path, enforce size/time bounds, parse fixed width, create content-addressed snapshot, then local exact UPC search | **Phase 2**, after Phase 1 acceptance and SFTP dependency review |
| PFX | `apps/web/lib/b2b/adapters/pfx.ts`, `utils/csv-parser.ts`, `utils/sftp-client.ts` | `csv` | referenced SFTP username/password or key | bounded SFTP CSV snapshot, strict header/row validation, content hash, then local exact UPC search | **Phase 2**, after Orgill transport seam |
| Legacy | recovered migrated connections | `legacy_adapter` | existing secret reference if any | compatibility/read-only until a registered adapter exists; unknown adapter fails as `source_error`, never silently falls back | migration compatibility only |
| Central Pet EDI 832 | `apps/web/lib/b2b/adapters/central.ts` | n/a | n/a | reference is a stub and cannot prove a provider contract | **out** |

Phase 1 is the minimal vertical slice that may be approved for dev rollout. Phase 2 is a separately reviewable extension; do not add `ssh2-sftp-client` or lockfile changes until dependency/security approval. CSV remains a connector type for local/imported catalog snapshots even before PFX transport ships.

### Provider-neutral engine contract

Create `src/onboarding/sourcing/contracts.ts` and `src/onboarding/sourcing/engine.ts` with these behavioral contracts:

- `SourcingLookupRequest`: `{ itemId, generationId, upc, gtin?, registerName, brandHint?, connection, signal, deadlineAt }`; require a normalized 8–14-digit UPC/GTIN (reuse/extract the project’s shared barcode normalizer rather than inventing connector-specific rules) and never issue a brand-only lookup.
- `DistributorCatalogRecord`: the ported shape (`distributorUpc`, `upc/gtin`, name, description, brand, MPN, weight, attributes, image URLs, catalog version/observed time). Commerce price/inventory may be retained in raw catalog metadata only when authority policy permits, but they are not v1 Sourcing acceptance inputs.
- `DistributorConnector.lookupByGtin(request)`: returns exactly one of `found`, `not_stocked`, or `source_error`; no throw crosses the engine boundary. A `found` result must contain an exact normalized identifier match and a variant-consistent record.
- `runSourcingGeneration`: resolves enabled connections for the workspace, applies advisory brand ordering without filtering, composes cancellation/deadline signals, calls each connector with a per-provider cap, validates every result, and persists one attempt per invoked connection through the writer. Unknown connector type, missing/redacted secret, malformed config/response, timeout, cancellation, or transport failure is a durable `source_error` with a stable non-secret code.
- No raw response or credential is persisted. `rawSnapshot` from the old shape is not part of the writer contract. Store normalized identity, matched fields, source URL when real, provider/connection/snapshot/version, timestamps/expiry, and bounded redacted warnings/errors.
- Cache reuse is generation-aware and requires the same connection, exact identifier, unexpired catalog snapshot/attempt, and compatible catalog version. Cache reuse still creates or explicitly links a current-generation attempt; a stale generation can never be accepted directly.

## Migration ordering and live-data safety

1. **Code/test DB only:** recover/adapt SQL and repository code; run migrations solely against in-memory/temp databases.
2. Existing core/schema migrations create `app_meta`, workspace/batch/item tables, and the current 13-column `onboarding_evidence_attempts` table.
3. Load `src/db/distributor-v2-migration.sql` under the absent `distributor_v2_schema_version` gate.
4. In one migration transaction:
   - `CREATE TABLE IF NOT EXISTS` for `distributors`, `distributor_connections`, `distributor_catalog_snapshots`, `onboarding_evidence_conflicts`, `onboarding_evidence_conflict_candidates`, and `onboarding_item_evidence_acceptances`;
   - PRAGMA-check and add evidence columns `distributor_connection_id`, `catalog_snapshot_id`, **`catalog_version`**, `observed_at`, `expires_at`, and `sourcing_generation_id` (or the exact ADR-approved generation key); add matching indexes;
   - create the ADR-approved generation table/metadata if a normalized run table is selected; the minimum contract is a durable generation ID with item, status, timestamps, and supersession identity—not `retry_count` reuse;
   - backfill `observed_at = created_at`; create deterministic legacy distributor/connection rows per provider and workspace; bind historical attempts only where the item→batch→workspace and normalized provider match is unique;
   - leave ambiguous historical connection/generation bindings NULL and audit-visible; remove the recovered unsafe “first connection in the database” fallback;
   - migrate legacy accepted IDs deliberately into the acceptance table if valid and same-item/same-UPC, otherwise leave them unaccepted and report counts;
   - create all indexes; run `foreign_key_check`; only then write `distributor_v2_schema_version`.
5. A failure rolls back and leaves the marker absent. Re-running is idempotent. Test both fresh schema and an exact pre-V2 13-column fixture, including the scout’s missing-`catalog_version` regression.
6. **Any later dev/live activation:** stop application writers, checkpoint WAL, create a timestamped SQLite backup with the existing verified backup mechanism, reopen/verify the backup (`integrity_check`, expected tables/counts), preserve free-space evidence, then run normal startup migration. Abort rather than bypass backup verification.
7. Do not run a repair script against `storage/catalog/.shopsite-cms/app.db`. The 148 legacy pending rows continue through the existing Continue-to-Discovery operator action. Engine-ON entry applies to new imports only.

## Milestones in dependency order

### Milestone 0 — Freeze recovery evidence and protect concurrent work

**Files/artifacts**

- Read: `.pi-subagents/artifacts/sourcing-v2-scout-brief.md`, both oracle artifacts, `docs/plans/sourcing-stage-safety-patch.md`, `CONTEXT.md`, `docs/adr/0007-item-centric-onboarding-pipeline.md`, `src/onboarding/flags.ts`.
- New ignored artifacts only: `.pi/recovery/sourcing-v2/tracked.diff`, `.pi/recovery/sourcing-v2/untracked/**`, baseline status/hash manifest.

**Work**

- Verify the 13 tracked and 15 untracked inventories and byte hashes.
- Classify every target as current dirty safety-patch, clean recovery target, or unrelated concurrent target.
- Establish one sequential writer and a per-milestone allowlist. Never overwrite `SourcingStagePanel.tsx` or safety routes from recovered bytes.
- Coordinate with store-manager/other sessions by avoiding their files and rechecking status before each write; pause on overlap rather than stashing anyone’s work.

**Acceptance**

- Recovery inputs are locally readable without modifying target files.
- Staged set remains empty; no stash/reset/clean command ran.
- An exact baseline lets review distinguish pre-existing dirt from recovery changes.

### Milestone 1 — Ratify the Sourcing ADR and shared contracts

**New**

- `docs/adr/0014-multi-distributor-sourcing.md`
- `src/onboarding/sourcing/contracts.ts`

**Adapt**

- `src/shared/schemas/distributor.ts` — recover, then close `connectorType` to `api | ftp_catalog | csv | legacy_adapter`; keep secret-key rejection recursive/case-insensitive and reject credential-bearing values/URLs, not only six top-level keys; add connection create/update and brand-advisory profile schemas.
- `src/shared/schemas/distributor-evidence.ts` — restore lookup input/result and insert/writer contracts; add connection/snapshot/catalog/generation/observed/expiry fields; validate normalized identity and forbid authoritative raw snapshots.
- `src/shared/schemas/onboarding.ts` — add `evidence_to_discovery`; keep legacy `bundle_to_curation` parse-only; add typed conflict/current-generation/item-detail views. Do not re-add `use_selected_bundle`.
- `CONTEXT.md`, `AGENTS.md`, `docs/adr/0007-item-centric-onboarding-pipeline.md` — update “engine not implemented” wording only when the vertical slice exists; preserve default-OFF and adjacent-only rules.

**ADR decisions required before code proceeds**

- distributor evidence is supporting identity/Discovery evidence, never canonical merchandising authority;
- exact UPC/GTIN precedence and variant mismatch behavior;
- connector registration and auth/secret-ref resolution;
- immutable generation lifecycle, cache/expiry, reset supersession, retry/error outcomes;
- single evidence writer and normalized acceptance/conflict authority;
- manual advancement semantics versus the dedicated automatic Sourcing-completion transition (the worker completes Sourcing and lands in Discovery; it never skips a stage);
- display-only image policy and PI-6 follow-up;
- rollout modes: `shadow` (observations only), `manual` (new imports enter Sourcing; operator completes/retries), `automatic` (worker may complete coherent/no-evidence items to Discovery), with the global env flag still the outer kill gate.

**Tests**

- Update `src/tests/unit/sourcing-resolution.test.ts`: new route parses; bundle request remains invalid; route/target matrix is closed.
- New `src/tests/unit/sourcing-contracts.test.ts`: invalid GTIN, connector, secret-shaped configuration, malformed found result, and raw snapshot fail closed.
- Preserve `src/tests/unit/sourcing-flags.test.ts` unchanged except capability metadata additions if needed.

**Acceptance**

- No implementation ambiguity remains around generations, manual/automatic mode, route targets, secrets, or images.
- A type cannot express Sourcing→Curation or a brand-only provider lookup.

### Milestone 2 — Recover and harden the V2 schema/repositories

**Recover from `dc01ea6`, then adapt**

- `src/db/distributor-v2-migration.sql`
- `src/db/repositories/distributor-repo.ts`
- `src/db/repositories/onboarding-acceptance-repo.ts`
- `src/db/repositories/onboarding-conflict-repo.ts`

**Adapt current tracked files**

- `src/db/migrations.ts` — add the gated migration in the ordering above; no broad recovered hunk application.
- `src/db/repositories/onboarding-evidence-repo.ts` — restore one `insertEvidenceAttempt`; map new fields; add current-generation queries and strict same-item/same-UPC/same-generation acceptance reads; expiry-aware cache helpers.
- `src/db/repositories/onboarding-item-repo.ts` — hydrate acceptances from the relational authority after the marker; add guarded `completeSourcingWithDecision`; block generic advancement of `needs_input` or unresolved-conflict items; extend ON-mode retry to supersede/start a generation while leaving OFF-mode fallback intact.

**Function-level contracts**

- `insertEvidenceAttempt(input)` validates connection/workspace/item/generation ownership and appends exactly once (use a deterministic idempotency key or unique generation+connection attempt key from the ADR). It never updates prior attempts.
- `recordAcceptances` validates every attempt before insertion and performs `ON CONFLICT DO NOTHING`; post-migration normalized rows are authoritative even when empty.
- `reconcile` and acceptance readers select only the current generation.
- `insertConflictWithCandidates` is idempotent per generation/field/value set so worker retry cannot duplicate open conflicts.
- `resolveConflict` uses status/current-generation guards and rejects foreign/cross-item candidates, already-resolved races, and stale generations.
- `createConnection`/update functions validate schemas before SQL, scope by active workspace, never return resolved secrets, and support enabled/config/policy updates needed by Settings.
- Brand-profile registry is workspace settings only: optional brand/alias → ordered distributor IDs, advisory and fall-open. Store no credentials in it.

**Recover/adapt tests**

- `src/tests/unit/distributor-v2.test.ts`
- `src/tests/unit/acceptance-migration.test.ts`
- `src/tests/unit/conflict-resolution.test.ts`
- Update `src/tests/unit/db-migration.test.ts` with fresh/pre-V2/idempotent/rollback cases.
- Update `src/tests/unit/onboarding-repos.test.ts` and `src/tests/unit/sourcing-stage-order.test.ts` for guarded completion and unresolved-conflict block.

**Assertions**

- all seven logical V2 tables/contracts exist after migration; all new evidence columns, including `catalog_version` and generation ID, exist on upgrade;
- second migration run changes nothing; a forced mid-migration error leaves no version marker;
- no historical attempt binds to an arbitrary workspace connection;
- normalized empty acceptances never resurrect legacy JSON;
- duplicate acceptance/writer/conflict operations are idempotent;
- cross-workspace/stale-generation candidates cannot be accepted or resolved;
- no transition helper can target Curation.

**Acceptance**

- The DB layer is independently safe before any provider or worker code can use it.
- Existing 13-column databases upgrade without data deletion and with an explicit ambiguity policy.

### Milestone 3 — Build the provider-neutral engine and Phase 1 REST connectors

**New**

- `src/onboarding/sourcing/engine.ts`
- `src/onboarding/sourcing/connector-registry.ts`
- `src/onboarding/sourcing/secret-resolver.ts`
- `src/onboarding/sourcing/connectors/phillips.ts`
- `src/onboarding/sourcing/connectors/bci.ts`
- `src/onboarding/sourcing/oauth-client.ts`
- `src/tests/unit/sourcing-engine.test.ts`
- `src/tests/unit/sourcing-phillips-connector.test.ts`
- `src/tests/unit/sourcing-bci-connector.test.ts`
- Fixture copies adapted from BayState under `src/tests/fixtures/sourcing/` (sanitized and credential-free).

**Adapt**

- `package.json`/`bun.lock`: no Phase 1 dependency is expected; change only if implementation proves one is necessary and review approves it.

**Function-level work**

- Port `B2BProduct` field shapes and response fixtures, not classes or Supabase sync code.
- Phillips: inject `fetch`, enforce HTTPS/config allowlist, timeout/body/page caps, `x-api-key` from resolved secret, response schema validation, exact identifier match.
- BCI: implement bounded OAuth client-credentials token retrieval/cache with redacted errors; bounded product pagination; omit price-schedule N+1 from v1 identity lookup unless a separate bounded need is approved.
- Engine: deterministic connection ordering, brand advisory reordering only, bounded concurrency, `AbortSignal` composition, per-provider results, and one durable attempt for every invoked connector.
- Do not issue real network requests in tests; use injected fake transports and fixtures. Assert credentials never appear in logs/errors/persisted rows.

**Deferred Phase 2 (separate review after Phase 1)**

- New: `src/onboarding/sourcing/connectors/orgill.ts`, `pfx.ts`, `sftp-client.ts`, fixed-width/CSV parsers and tests.
- Adapt `package.json`, `bun.lock` only after approving `ssh2-sftp-client` (or a safer existing transport). Enforce host/port/path allowlists, host-key verification, max bytes, timeouts, ignored quarantine paths, content hashing, atomic snapshot activation, and cleanup.

**Acceptance**

- Two distinct live-capable connector implementations satisfy the same contract with mocked transport.
- Missing/masked credentials, timeout, bad JSON, wrong UPC/variant, page-cap exhaustion, and unknown connector all persist bounded `source_error`/`not_stocked` outcomes rather than throwing or inventing evidence.

### Milestone 4 — Recover reconciliation and integrate the flag-gated worker

**Recover/adapt**

- `src/onboarding/sourcing-reconciler.ts` from `dc01ea6`.
- `src/onboarding/job-queue.ts` from the tracked stash behavior, merged into current cohort-aware code.
- `src/onboarding/flags.ts` — preserve current default-OFF parser; add ADR-approved rollout mode only if needed, defaulting to the least permissive mode.

**Function-level work**

- Export/test `IDENTITY_CRITICAL_FIELDS`: `upc`, `gtin`, `manufacturerPartNumber`, `weight`, `size`, `count`, `packCount`, `brand`; exact identifier/pack/variant disagreement is hard. Brand remains advisory as a lookup key but contradictory returned brand evidence remains reviewable identity conflict.
- Reconcile only validated `found` attempts in the current generation. Confidence never overrides a hard conflict. Soft copy disagreements retain provenance and do not block Discovery.
- Build `AUTO_STAGES` dynamically: when OFF, exact current `curation/extraction/discovery` behavior; when ON, Sourcing is included without changing active cohort Curation ownership.
- `processSourcing(item)` starts/loads the current generation, runs enabled connections, persists attempts, reconciles, then:
  - zero enabled connections → automatic `fallback_to_discovery` and guarded move to `discovery/pending`;
  - all current attempts `not_stocked` (and no errors/found) → `fallback_to_discovery`;
  - provider errors with no found evidence → follow ADR retry budget; while retryable remain Sourcing, after exhaustion use the approved degraded/no-evidence audit outcome but still only Discovery—not Curation;
  - hard conflict → persist durable conflicts, decision `needs_input_conflict`, `sourcing/needs_input`, no accepted attempts;
  - coherent found evidence → record current-generation acceptances, decision `evidence_to_discovery`, guarded move to `discovery/pending`;
  - emit one truthful SSE status event per terminal/review outcome (remove recovered duplicate emit).
- ON-mode Retry/reset supersedes the old generation and schedules a clean generation. OFF-mode continues the safety patch’s audited fallback.
- Do not restore `src/onboarding/product-curator.ts` distributor image backfill, `src/classification/stages/evidence-extraction.ts` broad high-reliability block, or direct distributor-copy consumption yet. Discovery may consume a narrowly typed identity/name/brand evidence projection; images and commerce copy remain excluded. Any later Curation consumption must freeze attempt provenance for active cohort mode first.

**Recover/adapt tests**

- `src/tests/unit/sourcing-reconciler.test.ts`
- `src/tests/unit/sourcing-pass-through.test.ts`
- Extend `src/tests/unit/sourcing-stage-order.test.ts`, `sourcing-flags.test.ts`, `curation-cohort-service.test.ts`.

**Assertions**

- OFF worker never calls `claimItemsForProcessing('sourcing')` or a connector.
- ON zero-connection and all-not-stocked pass through to Discovery with the correct distinct route and no fake URL.
- coherent evidence yields `evidence_to_discovery`, relational acceptances, and Discovery—not Curation;
- hard conflict remains `sourcing/needs_input`; generic advance skips it;
- retry uses a new generation and ignores all stale attempts/conflicts;
- `evaluateItemReadiness` recognizes the sourcing decision after the item proceeds through Discovery/Extraction, while active cohort Curation remains exclusively cohort-claimed.

**Acceptance**

- Import → claim → lookup → writer → reconcile → guarded Discovery routing works end-to-end under ON and is unreachable under OFF.

### Milestone 5 — Secure routes, conflict completion, and Settings integration

**Recover/adapt**

- `src/server/routes/distributor-routes.ts` from `dc01ea6`, rewritten for current authorization and capability conventions.
- `src/server/app.ts` — mount exactly once under `/api`.
- `src/server/routes/onboarding-routes.ts` — typed item-detail projection; conflict routes; ON retry behavior; preserve OFF fallback and workspace checks.
- `src/client/onboarding-api.ts` — typed distributor/connection/conflict/current-generation calls and views.
- `src/client/components/OnboardingSettings.tsx` — add capability-gated `Distributors` tab.
- New `src/client/components/onboarding-settings/DistributorConnectionsPanel.tsx`.
- New `src/tests/unit/distributor-routes.test.ts` and `src/tests/unit/distributor-settings-panel.test.tsx`.
- Extend `src/tests/unit/sourcing-safety-routes.test.ts`.

**Route contract**

- Prefer active-workspace-derived endpoints (`/onboarding/settings/distributors`, `/connections`) over accepting arbitrary `workspaceId` query/body values. Every read/mutation validates active workspace ownership; cross-workspace resources return 404.
- Capability OFF: Settings distributor surface is hidden/read-only per capability contract and engine mutations/retry fail closed; existing Continue/fallback endpoints remain available.
- Connection APIs return distributor, connector type, non-secret config, authority policy, enabled/health state, and a boolean `secretConfigured`; never return `secret_ref` contents or resolved credentials.
- Create/update validates the connector-specific non-secret config and an opaque secret reference. Secret material is provisioned through the existing local secret store/env outside this payload; no raw credential form posts into `configuration_json`.
- Conflict list/resolve verifies route item ID equals conflict item ID, workspace ownership, current generation, open status, and capability. Candidate selection validates candidate ownership and records acceptance.
- Last-hard-conflict resolution transaction writes `evidence_to_discovery` and moves to Discovery. Resolving one of multiple hard conflicts leaves `sourcing/needs_input`. `dismiss` is explicit audit; it may clear a hard conflict only under the ADR’s operator-override policy and never silently.
- Item detail maps `EvidenceAttempt` to `DistributorEvidenceAttemptView` plus generation/conflict data; parse `identityJson` server-side with `ProductIdentityEvidenceSchema`. Raw DB JSON is never the frontend type.

**Acceptance**

- Routes are workspace-isolated and capability-gated; raw secret material cannot enter or leave the connection contract.
- The Settings surface can configure enablement, non-secret connector config, authority policy, and advisory brand profiles without becoming a Brand authority.
- Conflict resolution cannot advance a stale/wrong item and never targets Curation.

### Milestone 6 — Merge the single capability-gated Sourcing drawer

**Recover/adapt, never overwrite**

- `src/client/components/pipeline-drawer/SourcingStagePanel.tsx` — extend the current safety-patch component, using the recovered V2 file only as behavioral reference.
- `src/client/components/pipeline-drawer/SourcingIdentitySummary.tsx` — retain current version and update truthful stage numbering/copy only.
- `src/client/components/PipelineBoard.tsx`
- `src/client/components/pipeline-drawer/ReviewDrawerShell.tsx` only if the existing Reset visibility seam needs an ON-mode Retry action.
- `src/tests/unit/sourcing-stage-panel.test.tsx` — preserve disabled assertions and add enabled-mode cases.

**Behavior**

- OFF is byte/behavior compatible with the safety patch: read-only historical attempts, no auto/retry/bundle controls, Continue to Official Site Discovery.
- ON shows current generation and superseded-history disclosure; attempt outcome, provider, exact matched IDs, normalized identity/title/description, warnings/errors, observed/expiry/catalog version; image URLs/thumbnails are marked “display only—not approved for catalog use.”
- Durable hard conflicts render candidates and `Use candidate`, `Custom value`, `Dismiss` actions. There are no evidence checkboxes or “Use selected bundle.”
- `Continue to Discovery` is disabled while open hard conflicts exist or status is `needs_input`; it is available only after the guarded decision/transition contract permits it. Retry is available only ON and creates a new generation.
- Refresh item detail and board after every mutation; show partial/race failures rather than optimistic advancement.

**Acceptance**

- One component truthfully represents both capability modes.
- No UI path copies images, selects arbitrary bundles, bypasses conflicts, or routes to Curation.

### Milestone 7 — End-to-end recovery tests and runner registration

**Recover/adapt all six V2 files**

- `src/tests/unit/distributor-v2.test.ts`
- `src/tests/unit/sourcing-reconciler.test.ts`
- `src/tests/unit/acceptance-migration.test.ts`
- `src/tests/unit/conflict-resolution.test.ts`
- `src/tests/unit/sourcing-pass-through.test.ts`
- `src/tests/unit/sourcing-resolution.test.ts` (one shared recovered/safety suite; merge both contracts—do not create a duplicate)

**Preserve/extend the five safety-patch test files**

- `src/tests/unit/sourcing-flags.test.ts`
- `src/tests/unit/sourcing-resolution.test.ts` (same file listed above)
- `src/tests/unit/sourcing-safety-routes.test.ts`
- `src/tests/unit/sourcing-stage-order.test.ts`
- `src/tests/unit/sourcing-stage-panel.test.tsx`

**Runner files**

- `package.json` — add DB/provider-route suites to the existing `test:db` Bun invocation(s); do not duplicate paths.
- `vitest.config.ts` — exclude every Bun/SQLite suite; leave pure/render tests under Vitest where compatible.

**Required end-to-end assertions**

1. Flag OFF import enters Discovery and performs zero Sourcing claims/network/writes.
2. Flag ON new import enters Sourcing; zero connections passes to Discovery.
3. Phillips/BCI fixture lookup writes a current-generation attempt; coherent exact product yields `evidence_to_discovery` and relational acceptance.
4. Exact UPC but wrong size/pack/variant produces a hard conflict, not a found coherent bundle.
5. Two hard conflicts: first resolution remains `needs_input`; last resolution atomically writes `evidence_to_discovery` and moves to Discovery.
6. Reset/retry creates a new generation; old attempts/conflicts remain visible but never affect the new decision.
7. Missing brand profile queries all enabled providers; stale profile cannot generate `not_stocked`.
8. Missing/redacted credential, provider timeout/error, unknown connector, malformed response, and cancellation produce bounded durable errors with no secret leakage.
9. Migration fresh/13-column/idempotent/rollback/catalog-version cases pass.
10. Legacy `bundle_to_curation` is readable for audit but no schema, route, helper, worker, UI, or generic advance can create/use it.
11. Distributor image URLs stay out of extraction, classification evidence, draft, and promotion payloads.
12. Discovery receives real identity evidence without a fake URL; official URL remains required before Extraction.
13. Current curation cohort readiness/ownership tests stay green.

**Acceptance**

- The recovered six suites are not merely restored: each reflects HEAD’s flag, routing, generation, rights, ownership, and runner contracts.

### Milestone 8 — Rollout, operator handling, and documentation close-out

**Adapt**

- `docs/adr/0014-multi-distributor-sourcing.md` status/implementation notes.
- `CONTEXT.md`, `AGENTS.md`, `docs/adr/0007-item-centric-onboarding-pipeline.md`.
- New `docs/runbooks/sourcing-engine-rollout.md`.

**Rollout sequence**

1. **Flag OFF after merge:** run migrations only through the sanctioned startup path after backup verification; capability endpoint remains false; disabled import/Continue/reset behavior unchanged.
2. **Dev connector configuration:** add secret references and disabled connections; use Settings health/fixture checks. Do not contact a provider during CI or migration.
3. **Shadow observations:** with the outer flag still controlled in dev and ADR `shadow` mode, run sampled new-item lookups and persist/inspect observations without changing item stage/decision/acceptance. Measure retrieval, exact-product/variant correctness, conflict/error rates, latency, and secret/redaction violations. Self-reported confidence is not an activation metric.
4. **Manual dev ON:** enable for a fresh test batch only; operator reviews every result/conflict and explicitly continues. Existing 148 stranded rows remain on the safety-patch Continue-to-Discovery flow; do not requeue or backfill them.
5. **Automatic dev ON:** permit deterministic coherent/no-evidence completion to Discovery only after shadow/manual thresholds defined in ADR are met and all provider-specific tests pass. Keep hard conflicts manual.
6. **Real new imports:** enable one workspace/provider cohort at a time with monitoring and a documented kill action (`BAYSTATE_CMS_SOURCING_ENABLED=false` + restart). OFF must immediately return new imports to Discovery and make Sourcing retries use audited fallback; historical evidence remains readable.
7. **Phase 2 adapters:** Orgill then PFX only after separate transport/dependency/security approval and fixture/manual acceptance.

**Operator contract for existing rows**

- No repair script and no automatic migration of the 148 `sourcing/pending` rows.
- Operators use the existing bulk/single **Continue to Official Site Discovery** action while OFF.
- Engine ON applies to new imports. Retrofitting historical items requires a separately reviewed, backup-verified operator action and is not in this plan.

**Acceptance**

- Documentation no longer says the engine is absent once implemented, but still states default OFF, provider/rights limits, and no Sourcing→Curation.
- Rollback is an outer flag change, not data deletion or Git/catalog mutation.

## Validation commands

Run only after concurrent writers are quiescent enough to give a stable tree. Tests use in-memory/temp databases and injected transports; no command below contacts live providers or the dev DB.

```bash
# Recovery provenance / hygiene
git diff --check
git diff --cached --name-only
git status --short

# Pure contracts and UI
bunx vitest run \
  src/tests/unit/sourcing-flags.test.ts \
  src/tests/unit/sourcing-contracts.test.ts \
  src/tests/unit/sourcing-stage-panel.test.tsx \
  src/tests/unit/distributor-settings-panel.test.tsx

# DB/worker/route suites (Bun)
bun test \
  src/tests/unit/distributor-v2.test.ts \
  src/tests/unit/acceptance-migration.test.ts \
  src/tests/unit/conflict-resolution.test.ts \
  src/tests/unit/sourcing-reconciler.test.ts \
  src/tests/unit/sourcing-pass-through.test.ts \
  src/tests/unit/sourcing-resolution.test.ts \
  src/tests/unit/sourcing-safety-routes.test.ts \
  src/tests/unit/sourcing-stage-order.test.ts \
  src/tests/unit/sourcing-engine.test.ts \
  src/tests/unit/sourcing-phillips-connector.test.ts \
  src/tests/unit/sourcing-bci-connector.test.ts \
  src/tests/unit/distributor-routes.test.ts \
  src/tests/unit/db-migration.test.ts \
  src/tests/unit/curation-cohort-service.test.ts

# Project gates
bun run typecheck
bun run test
bun run lint

# Final hygiene (must remain empty for staged paths)
git diff --check
git diff --cached --name-only
git status --short
```

If project-wide lint/test reveals pre-existing or concurrent failures, capture before/after evidence and do not hide them with exclusions. Recovery-owned focused tests, typecheck, and lint on touched files must be green before review.

## Exact recovery/implementation file inventory

### Recover as new, then adapt

- `src/db/distributor-v2-migration.sql`
- `src/db/repositories/distributor-repo.ts`
- `src/db/repositories/onboarding-acceptance-repo.ts`
- `src/db/repositories/onboarding-conflict-repo.ts`
- `src/onboarding/sourcing-reconciler.ts`
- `src/server/routes/distributor-routes.ts`
- `src/shared/schemas/distributor.ts`
- six recovered tests listed in Milestone 7

### Existing current files to adapt (merge, never replace)

- `src/db/migrations.ts`
- `src/db/repositories/onboarding-evidence-repo.ts`
- `src/db/repositories/onboarding-item-repo.ts`
- `src/onboarding/job-queue.ts`
- `src/onboarding/flags.ts`
- `src/server/routes/onboarding-routes.ts`
- `src/server/app.ts`
- `src/shared/schemas/distributor-evidence.ts`
- `src/shared/schemas/onboarding.ts`
- `src/client/onboarding-api.ts`
- `src/client/components/OnboardingSettings.tsx`
- `src/client/components/PipelineBoard.tsx`
- `src/client/components/pipeline-drawer/SourcingStagePanel.tsx`
- `src/client/components/pipeline-drawer/SourcingIdentitySummary.tsx`
- `src/client/components/pipeline-drawer/ReviewDrawerShell.tsx` only if required by the retry-control seam
- `src/onboarding/product-curator.ts` only to remove/guard unverified distributor image backfill; do not restore other stash hunks
- `package.json`, `vitest.config.ts`
- safety and cohort tests named above
- `AGENTS.md`, `CONTEXT.md`, `docs/adr/0007-item-centric-onboarding-pipeline.md`

### New implementation files

- `docs/adr/0014-multi-distributor-sourcing.md`
- `docs/runbooks/sourcing-engine-rollout.md`
- `src/onboarding/sourcing/contracts.ts`
- `src/onboarding/sourcing/engine.ts`
- `src/onboarding/sourcing/connector-registry.ts`
- `src/onboarding/sourcing/secret-resolver.ts`
- `src/onboarding/sourcing/oauth-client.ts`
- `src/onboarding/sourcing/connectors/phillips.ts`
- `src/onboarding/sourcing/connectors/bci.ts`
- `src/client/components/onboarding-settings/DistributorConnectionsPanel.tsx`
- contract/engine/connector/route/settings tests and sanitized fixtures named above

### Explicitly do not restore in v1

- recovered `use_selected_bundle` UI/request behavior;
- recovered `bundle_to_curation` worker/route behavior;
- recovered generic three-argument `updateSourcingDecision`;
- recovered broad distributor emission in `src/classification/stages/evidence-extraction.ts` until frozen provenance/reliability policy is separately approved;
- recovered distributor-copy/image behavior in `src/onboarding/product-curator.ts`;
- Central EDI adapter or BayState Supabase sync/factory code.

## Scope boundaries

- No new Pipeline Stage or Stage Status.
- No canonical Brand mutation, automatic brand assignment, or brand-required lookup.
- No structured-record Extraction fallback and no relaxation of Discovery’s verified-source requirement.
- No distributor image download/import/approval, no commerce price/inventory write, no product draft or ShopSite/catalog mutation.
- No live provider call, paid crawl, model call, or live DB write during implementation/tests.
- No historical-item bulk reprocessing or repair script.
- No redesign of cohort Curation, Product Intelligence, extraction profiles, Store Manager, or general auth middleware.
- No broad dependency upgrade. Phase 2 SFTP dependency is separately approved.
- No staging/commit. In particular, this work does not use the sanctioned scoped classification-catalog commit path because it changes no canonical catalog files.

## Final review and acceptance criteria

A reviewer must confirm:

- recovery provenance accounts for all 28 stash paths and no recovered hunk was blindly applied;
- the safety patch’s OFF behavior and five existing tests remain intact;
- every coherent/no-evidence/conflict transition obeys the route table and no Curation bypass exists;
- current-generation, workspace, exact-identifier, conflict, and secret boundaries fail closed;
- migration is upgrade-safe, includes `catalog_version`, has no arbitrary-connection backfill, and writes its marker only after success;
- Phase 1 has two provider implementations behind one tested contract with injected transport;
- images are display-only and the unverified curator backfill is gone/guarded;
- all six recovered test suites are adapted and registered under the correct runner;
- typecheck, focused tests, full tests, lint, `git diff --check`, final status, and empty staged set are evidenced before approval.

## Residual risks

- The stash implementation never contained a live provider engine; connector behavior is necessarily a contract port from another stack and requires real-provider dev validation before use.
- Phillips/BCI API schemas, pagination, scopes, and rate limits may differ from the reference fixtures; wrong-variant detection and bounded failure must remain conservative.
- SFTP adds dependency, host-key, file-size, quarantine, and operational risks; keeping Orgill/PFX in Phase 2 limits initial blast radius.
- The exact generation schema was absent from recovered V2. The ADR must settle it before migration coding; using `retry_count` alone would mix evidence and is unacceptable.
- Existing legacy attempts may lack an unambiguous workspace connection/generation. They remain historical/read-only rather than being guessed into authority.
- `curation-cohort-service.ts` currently treats any non-null Sourcing decision as source-finalized, including legacy routes. This plan adds regression coverage for `evidence_to_discovery`; tightening legacy-route semantics may require a separate compatibility migration.
- Removing the current non-cohort distributor image backfill can change legacy draft behavior, but retaining it violates PI-6. Review should treat fail-closed image exclusion as the required security correction.
- The current worktree is concurrently edited. Even a correct plan can be implemented incorrectly if writers stash/reset or overwrite safety/store-manager changes; sequential allowlists and repeated status checks are mandatory.
- Full repository tests/lint may expose unrelated concurrent failures. They must be reported distinctly, never suppressed.
- Default-OFF prevents automatic impact but not operator misconfiguration. Rollout requires measured shadow/manual evidence, a tested kill switch, and explicit workspace/provider enablement.
