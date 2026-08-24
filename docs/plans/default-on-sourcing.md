# Default-On Distributor Sourcing and Discovery-Skip Implementation Plan

> **Status update (2026-08): SUPERSEDED by ADR-0030 (Agent Lab decommission) — content below references the deleted `src/product-intelligence/**` Agent Lab surface and is preserved as a historical record only.**

## Objective and verified planning baseline

Implement the product-owner directive: **“Default on. We always want to check our distributors first, and skip Discovery if we find the product on our distributors.”**

The governing design is `.pi/subagents/artifacts/717cb3a5_planner_0_output.md`. This plan operationalizes that ruling without reopening it:

- missing `BAYSTATE_CMS_SOURCING_ENABLED` means enabled;
- a qualified distributor record skips Discovery by routing **Sourcing → Extraction**, never Sourcing → Curation;
- one qualified provider is sufficient, while every enabled provider is still queried within the bounded generation;
- distributor-record Extraction is deterministic, identity-only, URL-less, profile-free, and provenance-bound;
- no result bypasses the mandatory human Review stage;
- default-on activation remains blocked until all nine findings below are fixed and the measured provider gates pass.

Verified planning baseline:

- `docs/adr/0014-multi-distributor-sourcing.md`, `CONTEXT.md`, and `AGENTS.md` still describe default-OFF, mandatory Discovery, and adjacent-only Sourcing; Amendment A must supersede those clauses before code changes proceed.
- The target plan did not exist before this planning pass.
- The worktree is heavily dirty/untracked, including Sourcing, cohort, Product Intelligence, and unrelated Store Manager work; implementation must patch current files in place with one sequential writer.
- No `/tmp/*.md` scout report was present at planning time; the prior planner ruling is the authoritative audit artifact.
- This plan performs no live provider request, paid crawl, model call, live-DB write, staging, or commit.

## Non-negotiable invariants

- **Default-on is not default-open.** Missing flag enables; explicit `false|0|no`, empty/whitespace, or malformed values disable. An invalid mode also disables the effective capability.
- **Upgrade isolation.** Existing installations pin `BAYSTATE_CMS_SOURCING_ENABLED=false` before deployment. All pre-amendment items receive entry-policy version `0`; only explicitly inserted post-amendment version-`1` items may be automatically observed or claimed.
- **The 148 stranded rows are never claimed, looked up, backfilled, or repaired automatically.** They retain the audited **Continue to Official Site Discovery** path.
- **No Curation bypass.** `distributor_record_to_extraction` targets `extraction/pending`. `bundle_to_curation` stays parse-only historical audit and is rejected by every writer, route, transition, and UI action.
- **No fake URL.** Distributor-routed items and extractions retain `source_url = NULL`. A real distributor URL stays on its immutable evidence attempt only.
- **Qualification is deterministic.** Confidence never grants acceptance. Exact normalized UPC/GTIN, current-generation ownership, schema validity, a nonblank product name, complete projection provenance, and no unresolved hard identity conflict are mandatory.
- **Variant safety fails closed.** Flavor, formula, and every connector-declared variant axis are hard identity fields. An unclassified/unknown variant-bearing attribute makes a record insufficient for Discovery skipping.
- **Distributor Extraction is identity-only.** No descriptions, bullets, claims, price, inventory, images, arbitrary provider fields, network fetch, extractor profile, DOM parse, OCR, or model call enters `distributor_record_v1` materialization.
- **Generation and workspace authority are rechecked at every write boundary.** Stale, cross-item, cross-workspace, unaccepted, malformed, or open-conflict evidence cannot route, materialize, freeze, classify, or promote.
- **Images remain outside commerce.** Raw distributor image URLs are evidence-detail only. PI-6 verification is the sole path to a commerce-approved distributor image.
- **Review remains mandatory.** Sourcing and Extraction may automate deterministic work; no item is approved, promoted, published, or written to ShopSite/catalog without the existing Review/Promotion gates.
- **Database access remains repository-owned.** Upgrade migrations are versioned, transactional, PRAGMA-guarded, idempotent, row-preserving, and run against a live database only after a verified backup and writer shutdown.
- **Repository hygiene.** Preserve all pre-existing dirt; no reset, restore, clean, stash, broad checkout, staging, or commit. The sanctioned scoped classification-catalog commit path is not used because this work changes no canonical catalog configuration.

## Governing decisions

1. **Default ON; retain the kill switch.**
   - Missing `BAYSTATE_CMS_SOURCING_ENABLED` enables Sourcing.
   - `false|0|no` disables it; empty, whitespace, and malformed values disable fail-closed.
   - Existing installations pin `false` through migration and rollout.
   - A durable entry-policy version excludes the 148 legacy `sourcing/pending` rows from worker claims and observation.

2. **Qualified evidence routes to Extraction, never Curation.**
   - The target is `extraction/pending` with item/extraction `source_type='distributor_record'`.
   - `official_page` keeps the current URL/profile/page path.
   - `distributor_record` uses deterministic structured materialization so extraction provenance, hashes, readiness, and frozen evidence remain intact.

3. **One qualified provider is enough.**
   - Every enabled provider is queried within the bounded generation.
   - Qualification requires exact normalized UPC/GTIN equality, a current-generation schema-valid found attempt, at least one nonblank product name, no unresolved hard conflict, and a complete deterministic v1 projection.
   - When multiple records share an identity-critical field, all values must agree unless an operator resolution explicitly supplies/omits that field.

4. **No fake URL.**
   - `onboarding_items.source_url`, `ExtractionData.sourceUrl`, and `onboarding_extractions.source_url` remain null for distributor records.
   - Real distributor URLs remain `EvidenceAttempt.evidenceUrl`, displayed as evidence only.
   - Discovery is used when there is no usable identifier, no stock, insufficient evidence, provider-only failure, materialization failure followed by operator fallback, or an explicit operator request for the official path.

5. **Conflict/error handling remains fail-closed.**
   - Hard identity conflicts remain `sourcing/needs_input`.
   - Errors with no qualified found record use `degraded_fallback_to_discovery`.
   - A qualified record plus other `not_stocked`/`source_error` outcomes still routes to distributor Extraction with warnings.
   - Flavor, formula, and connector-declared variant axes are hard; unknown variant-bearing attributes are insufficient.
   - Final conflict resolution reruns qualification: qualified → Extraction; otherwise → Discovery. `dismiss` omits the disputed field and never chooses a provider silently.

6. **Distributor-record Extraction v1 is identity-only and profile-free.**
   - Allowed: exact UPC/GTIN, distributor SKU, MPN, product name, noncanonical brand evidence, weight, whitelisted size/count/pack-count/flavor/formula values, connector-declared normalized variant axes, and provider/attempt/generation/catalog/observation provenance.
   - Excluded: description, bullets, claims, price, inventory, images, and arbitrary provider fields.
   - Persist `extraction_method='distributor_record_v1'`, null URL, source type, accepted attempt IDs, generation ID, and deterministic evidence hash.
   - Revalidate current generation and conflicts immediately before atomic materialization. Deterministic integrity failure leaves `extraction/failed` and exposes an audited official-Discovery fallback; it never fabricates data.

7. **Use a new route and route-specific schemas.**
   - Add `distributor_record_to_extraction`.
   - Keep `evidence_to_discovery` for accepted-but-insufficient evidence or an explicit official-site path.
   - Keep `bundle_to_curation` parseable only for historical audit.
   - The distributor route requires nonempty accepted attempts/providers, `sourceType='distributor_record'`, the exact current generation, and a canonical evidence hash.

8. **Review is required, but measured rollout gates are also required.**
   - Per connector: all offline fixture/security tests pass; at least 100 labeled observations, including at least 30 known-found and 20 negative/wrong-variant cases; zero false found/wrong-product/wrong-variant acceptances; zero credential leaks; zero unverified distributor-image flow; correct conflict/fallback routing for every sampled failure; source-error rate ≤10%; p95 item completion ≤60 seconds.
   - Canary one workspace/provider for at least seven days and 100 real items before broader activation.

9. **Operational controls exceed a boolean flip.**
   - Implement `observe | manual | automatic` through `BAYSTATE_CMS_SOURCING_MODE`; the boolean remains the outer kill gate.
   - Missing mode defaults to `automatic`; invalid mode disables effective Sourcing.
   - New connections default disabled and require a separate operator enable action after health/fixture checks.
   - `/api/onboarding/capabilities` reports effective state, mode, and a non-secret configuration reason.
   - The runbook covers the upgrade pin, verified backup, legacy exclusion, provider gates, rollback/restart, and quarantine. Rollback never deletes evidence or rewrites reviewed history.

10. **Ratify ADR 0014 Amendment A first.**
    - The dated amendment must explicitly supersede default-OFF, adjacent-only-to-Discovery, and mandatory-Discovery clauses before implementation proceeds.

## Normative routing table

| Condition | Route/audit | Target |
|---|---|---|
| Kill switch OFF or invalid configuration; new import | no Sourcing decision | `discovery/pending` |
| Legacy entry-policy-v0 item; operator continues | `fallback_to_discovery` | `discovery/pending` |
| No usable UPC/GTIN or no enabled connection | `fallback_to_discovery` | `discovery/pending` |
| All providers return `not_stocked` | `fallback_to_discovery` | `discovery/pending` |
| Provider errors and no qualified record | `degraded_fallback_to_discovery` | `discovery/pending` |
| Accepted evidence exists but misses the v1 completeness floor | `evidence_to_discovery` | `discovery/pending` |
| One or more qualified records, no hard conflict | `distributor_record_to_extraction` | `extraction/pending` |
| Qualified record plus another error/not-stocked outcome | `distributor_record_to_extraction` with warnings | `extraction/pending` |
| Any hard identity/variant conflict | `needs_input_conflict` | `sourcing/needs_input` |
| Final operator resolution yields a qualified projection | `distributor_record_to_extraction` | `extraction/pending` |
| Final resolution leaves no qualified projection | `evidence_to_discovery` or `fallback_to_discovery` | `discovery/pending` |
| Explicit bounded retry | `retry_provider_errors` | `sourcing/pending` |
| Structured materialization integrity failure | extraction failure audit; no fabricated decision | `extraction/failed` |
| Operator chooses official path from distributor Extraction | `evidence_to_discovery` operator override | `discovery/pending` |

### Mode and entry-policy matrix

| Effective state | Import stage | Lookup behavior | Mutation authority |
|---|---|---|---|
| kill switch OFF / malformed flag / invalid mode | `discovery/pending` | none | no Sourcing decision, generation, attempt, acceptance, or conflict |
| `observe` | `discovery/pending` | `observeSourcingForDiscoveryItem` runs once for entry-policy-v1 items before ordinary Discovery, using fixture/live provider policy as configured | may append a generation and immutable attempts only; must not change item stage/status/source, decision, acceptances, conflicts, extraction, or Discovery outcome |
| `manual` | `sourcing/pending` | worker queries all enabled providers and computes qualification | item stops at `sourcing/needs_input`; only an explicit operator action or final conflict-resolution action selects Extraction vs Discovery |
| `automatic` (default) | `sourcing/pending` | worker queries all enabled providers and computes qualification | deterministic route table applies; conflicts remain manual |

`CURRENT_SOURCING_ENTRY_POLICY_VERSION = 1` is written explicitly by spreadsheet and reviewed Agent Lab create-import paths. Repository callers that omit a version receive `0` fail-closed. Stage-Sourcing claims require the exact current version. Observe-mode selection also requires version `1`. No migration infers eligibility from timestamps, stage, UPC, or existing evidence.

## Route-specific decision contract

`src/shared/schemas/onboarding.ts` must separate historical reads from creatable decisions:

- `LegacySourcingDecisionSchema`: parse-only compatibility for rows without a schema version and for historical `bundle_to_curation`; never accepted by a mutation helper.
- `SourcingDecisionV2Schema`: strict `schemaVersion: 2` discriminated union by `route`.
- `SourcingDecisionSchema`: read union (`V2 | legacy`) used for hydration.
- `CreatableSourcingDecisionSchema`: V2-only input used by repositories, services, routes, and workers.

| V2 route | Accepted attempts | Provider IDs | Generation | Evidence hash/source type | Allowed target |
|---|---:|---:|---:|---|---|
| `distributor_record_to_extraction` | ≥1, unique | ≥1, unique | required/current | 64-char canonical SHA-256; `distributor_record` | `extraction/pending` |
| `evidence_to_discovery` | ≥1, unique | ≥1 | required/current | no materialization hash; `official_page` | `discovery/pending` |
| `fallback_to_discovery` | exactly 0 | may be empty | optional only for no-generation fallback | no hash; `official_page` | `discovery/pending` |
| `degraded_fallback_to_discovery` | exactly 0 | error providers retained | required when attempts exist | no hash; `official_page` | `discovery/pending` |
| `needs_input_conflict` | exactly 0 | ≥1 | required/current | no hash; at least one persisted hard conflict | `sourcing/needs_input` |
| `retry_provider_errors` | exactly 0 | error providers retained | required/current | no hash | `sourcing/pending` |
| `bundle_to_curation` | historical shape only | historical | historical | historical | none; reject |

`completeSourcingWithDecision()` must parse `CreatableSourcingDecisionSchema`, enforce the matrix in one transaction, recheck item/workspace/entry-policy/current-generation/open-conflict state, and update `source_type` atomically with the stage transition. It must never accept a caller-provided target that disagrees with the route.

## Deterministic distributor projection and hash contract

Create one pure authority in `src/onboarding/sourcing/distributor-record-projection.ts` and reuse it in reconciliation, automatic/manual routing, final conflict resolution, and materialization.

- `buildDistributorRecordProjection(input)` returns either `{ qualified: true, projection, acceptedAttemptIds, providerIds, evidenceHash, warnings }` or `{ qualified: false, reasonCodes, acceptedAttemptIds, providerIds, warnings }`.
- Parse each `identityJson` with the strict evidence schema; require exact normalized attempt lookup, record UPC/GTIN, and item identifier equality.
- Require attempt item, workspace connection, current generation, outcome, observation provenance, and nonblank name.
- Normalize safe field names and values once. Sort providers, attempts, keys, and multi-values before hashing; volatile timestamps other than provider observation provenance do not participate.
- Built-in hard fields include UPC, GTIN, MPN, weight, size, count, pack count, brand, flavor, and formula. Valid connector-declared axes join that set for the generation.
- A connector must declare which raw fields are variant-bearing and map them to bounded normalized axis names. An undeclared/unmappable variant-bearing field yields `unknown_variant_axis` and makes the projection insufficient; it is never treated as copy.
- Operator conflict resolutions are explicit projection inputs. `resolve_candidate` uses that candidate; `custom_value` uses the reviewed value; `dismiss` removes the field. Remaining evidence must independently satisfy qualification.
- Projection v1 contains only allowed identity fields plus per-field attempt/provider provenance. It contains no description, bullet, price, inventory, image, arbitrary raw field, secret, or confidence authority.
- `evidenceHash = hashCanonicalJson({ version: 'distributor-record-projection-v1', ...projection })`. The decision, extraction row, extraction payload, and frozen cohort projection must carry the same value.

## Nine fix-required blockers

Line references are the governing ruling’s references, supplemented with the verified current ranges where the ruling named only a file.

| # | Severity | Finding | Required fix contract |
|---:|---|---|---|
| 1 | **BLOCKER** | `src/onboarding/draft-promoter.ts:354-379` reads attempts by `item_id = ? OR lookup_upc = ?` and downloads raw images. | Remove UPC-wide/raw-attempt image ingestion. Any provenance lookup must join exact item → batch workspace, current generation, relational acceptance, and connection workspace. Even accepted raw URLs remain non-commerce; only an existing PI-6 `commerceApproved` asset association may reach the downloader. Add zero-fetch tests for unaccepted, stale, cross-workspace, same-UPC, and accepted-but-unverified distributor images. |
| 2 | **BLOCKER** | `src/onboarding/job-queue.ts:73-77`; `src/db/repositories/onboarding-item-repo.ts:314-350` claim every `sourcing/pending` row when enabled. | Add `sourcing_entry_policy_version`, backfill existing rows to `0`, write `1` only from post-amendment import call sites, filter Sourcing claim/observe queries to exact version `1`, and keep version-0 UI on Continue-to-Discovery. Test a 148-row fixture with zero claims/lookups. |
| 3 | **BLOCKER** | `src/onboarding/job-queue.ts:966-995` fails without URL and always requires a profile. | Dispatch Extraction on persisted source type before URL/profile validation. Keep current profile path for `official_page`; call deterministic materializer for `distributor_record`, with no fetch/profile/OCR/model dependency. |
| 4 | **BLOCKER** | `src/db/onboarding-migration.sql:25-45,66-74` does not persist item source type and makes extraction URL non-null. | Update fresh DDL and add a versioned upgrade: item source type + entry marker; nullable extraction URL; extraction source type/method/generation/accepted-attempt/hash provenance. Rebuild the SQLite extraction table transactionally, preserve rows/counts/indexes, run `foreign_key_check`, and write the marker last. |
| 5 | **HIGH** | `src/classification/stages/evidence-extraction.ts:60-76,209-229`; `src/shared/schemas/cohorts.ts:132-190` assume official-page extraction. | Add the `distributor_record` classification evidence source and DB CHECK, map source-aware reliability/metadata, prohibit official-page labeling, and introduce execution-evidence-v2 with source type, extraction binding, generation, attempts, and hash. Keep V1 parse-only compatibility. |
| 6 | **HIGH** | `src/onboarding/cohort-curator.ts:1844-1876` hardcodes `official_page` and drops accepted-attempt provenance. | Build frozen items only from V2 projection provenance; retain source type, sorted accepted IDs, generation, and evidence hash. Never read post-freeze live values or rewrite V1 snapshots. |
| 7 | **HIGH** | `src/onboarding/sourcing/contracts.ts:268-278`; `src/onboarding/sourcing-reconciler.ts:18-49` omit flavor/formula from hard identity authority. | Add flavor/formula and connector-declared normalized axes; make reconciliation pure; persist every hard conflict explicitly; make unknown variant-bearing axes insufficient rather than soft. |
| 8 | **HIGH** | `src/shared/schemas/distributor.ts:169,183` defaults new connections enabled. | Default create/domain schemas and UI to disabled; server creation must ignore/reject an attempted create-as-enabled shortcut. Enable only through a separate workspace-scoped update after operator health checks. Existing states are not silently rewritten. |
| 9 | **MEDIUM** | `src/shared/schemas/onboarding.ts:245-294` uses one broad `SourcingDecisionSchema`. | Introduce the V2 discriminated union and V2-only writer schema above; retain a separate historical parser. Validate decisions at every repository/API boundary and test every invalid route/attempt/generation/hash/target combination. |

**Release block:** default-on and Discovery skipping remain unactionable until all four BLOCKER, all four HIGH, and the one MEDIUM finding are fixed, distributor provenance survives cohort Curation, and provider observation gates pass.

## ADR 0014 Amendment A deliverable

Append a dated section titled **“Amendment A — Default-On Sourcing and Distributor-Record Extraction”** to `docs/adr/0014-multi-distributor-sourcing.md`. Ratify it before implementation work after the documentation change. It must normatively cover all 17 points:

1. Product-owner directive and exact default-OFF/adjacent-only/mandatory-Discovery clauses superseded.
2. Missing flag enables; explicit false is the kill switch; malformed configuration disables fail-closed.
3. Durable entry-policy version excludes existing stranded rows and keeps them operator-controlled.
4. `distributor_record_to_extraction` is the only automatic Discovery-skipping route.
5. Direct Sourcing → Curation and actionable `bundle_to_curation` remain prohibited.
6. Single-provider qualification floor and multi-provider conflict rules.
7. Exact route/target matrix and route-specific schema invariants.
8. Item/extraction source type, null URL, generation, accepted-attempt, and evidence-hash provenance.
9. Source-dispatched Extraction and no-profile/no-fetch contract.
10. V1 identity allowlist and explicit exclusion of copy, commerce data, and images.
11. Dedicated `distributor_record` classification evidence label; never `official_product_page`.
12. Versioned frozen cohort projection with source type and distributor provenance.
13. PI-6 as the sole distributor-image commerce path.
14. Provider error, conflict, resolution, retry, and supersession semantics.
15. Observe/manual/automatic modes, quantitative gates, canary sequence, and rollback.
16. Versioned backup-verified migrations and backward parsing of historical routes/projections.
17. Acceptance tests for flags, legacy isolation, routing, materialization, cohort freeze, promotion/images, migrations, and kill-switch behavior.

## Milestones in dependency order

### Milestone 0 — Freeze the dirty baseline and implementation allowlist

**Files**

- No project file changes.
- Read-only authorities: `.pi/subagents/artifacts/717cb3a5_planner_0_output.md`, this plan, `docs/plans/sourcing-v2-recovery-plan.md`, `docs/adr/0014-multi-distributor-sourcing.md`, `CONTEXT.md`, and the files in the blocker table.

**Work**

- Record `HEAD`, full `git status --short`, staged paths, and hashes for every milestone target before the first writer.
- Partition target paths from unrelated dirty Store Manager/Product Intelligence/catalog work; stop on overlap rather than stashing or replacing it.
- Assign one sequential writer and a per-milestone allowlist. Recheck status/hash before and after each milestone.
- Confirm implementation/test databases are temporary/in-memory. Do not inspect or mutate `storage/catalog/.shopsite-cms/app.db` during implementation.

**Tests**

- None; this is a provenance/hygiene gate.

**Verification commands**

```bash
git rev-parse HEAD
git status --short
git diff --cached --name-only
find /tmp -maxdepth 1 -type f -name '*.md' -print | sort
```

**Acceptance**

- Outer and nested staged sets are empty.
- Every planned target has a baseline hash/status classification.
- No reset/restore/clean/stash command, network call, DB mutation, stage, or commit occurred.

### Milestone A — Ratify Amendment A; establish flags, entry policy, decisions, and qualification

**Adapt**

- `docs/adr/0014-multi-distributor-sourcing.md`
- `src/onboarding/flags.ts`
- `src/onboarding/sourcing/contracts.ts`
- `src/onboarding/sourcing-reconciler.ts`
- `src/shared/schemas/onboarding.ts`
- `src/shared/schemas/distributor.ts`
- `src/shared/schemas/distributor-evidence.ts`
- `src/shared/schemas/classification.ts`

**New**

- `src/onboarding/sourcing/entry-policy.ts`
- `src/onboarding/sourcing/distributor-record-projection.ts`
- `src/tests/unit/sourcing-entry-policy.test.ts`
- `src/tests/unit/sourcing-distributor-projection.test.ts`

**Function-level work**

1. Append and ratify Amendment A before code proceeds.
2. In `flags.ts`:
   - extend `SourcingFlags` with `mode: 'observe' | 'manual' | 'automatic' | null`, effective enabled state, and a stable non-secret reason code;
   - make `DEFAULT_SOURCING_FLAGS.sourcingEngineEnabled = true` and default mode `automatic` only when env keys are absent;
   - distinguish absent from empty/whitespace; empty/malformed flag or invalid mode yields effective disabled;
   - preserve per-call env loading and test override, without allowing an override to manufacture a valid mode accidentally.
3. In `entry-policy.ts`, export version `1`, `deriveSourcingEntryStage(flags)`, `isCurrentSourcingEntryPolicy(version)`, and mode predicates used by imports/worker/UI.
4. Replace broad Sourcing decision writing with V2 route-specific schemas while keeping a read-only legacy parser. Make arrays unique/bounded, timestamps valid, hashes canonical, and unknown keys rejected.
5. Add `distributor_record_to_extraction` to `SourcingRouteEnum`; keep `bundle_to_curation` parse-only.
6. Default new distributor connections to disabled in schema. Require a separate update to enable; preserve recursive credential rejection.
7. Extend normalized evidence with variant-axis declarations and strict observation provenance. Add `flavor`/`formula` and validated connector-declared axes to hard identity evaluation.
8. Make `reconcileDistributorEvidence()` pure: return conflict candidates/warnings/qualification inputs, but perform no DB writes. Observe mode must be able to evaluate without creating authoritative conflicts.
9. Implement the canonical projection/hash contract and reason codes (`missing_name`, `identifier_mismatch`, `stale_generation`, `unknown_variant_axis`, `open_hard_conflict`, `incomplete_provenance`, etc.).
10. Treat `distributor_record` as a third-party classification source in policy schema; it is never claim/composition authority unless a future canonical config explicitly permits it.

**Tests**

- Update `src/tests/unit/sourcing-flags.test.ts`: absent=true/automatic; explicit false spellings; empty/whitespace/malformed disabled; each valid mode; invalid mode disabled; override/reset and reason codes.
- Update `src/tests/unit/sourcing-contracts.test.ts`: V2 route matrix, legacy parse-only behavior, hash format, unique accepted IDs/providers, variant-axis validation, no secret/raw snapshot.
- Update `src/tests/unit/sourcing-reconciler.test.ts`: flavor/formula/custom axes are hard; unknown variant axis is insufficient; pure reconciliation writes nothing; confidence never resolves a conflict.
- New projection suite: single provider; agreeing providers; found+error; missing name; stale/malformed/cross-item attempts; deterministic ordering/hash; dismiss/custom/candidate resolutions; excluded fields.
- Update `src/tests/unit/distributor-settings-panel.test.tsx` expectations for disabled-by-default creation only after the UI change in Milestone C.

**Verification commands**

```bash
bunx vitest run \
  src/tests/unit/sourcing-flags.test.ts \
  src/tests/unit/sourcing-contracts.test.ts \
  src/tests/unit/sourcing-entry-policy.test.ts \
  src/tests/unit/sourcing-distributor-projection.test.ts
bun test src/tests/unit/sourcing-reconciler.test.ts
bun run typecheck
git diff --check
```

**Acceptance**

- Amendment A is ratified and complete before runtime code is eligible to merge.
- Missing flag/default mode behavior and every fail-closed configuration case are unambiguous.
- No creatable type can express Sourcing → Curation or distributor Extraction without generation/attempt/provider/hash provenance.
- Projection qualification is pure, deterministic, identity-only, and order-insensitive.

### Milestone B — Add the eligibility/source/provenance migration and repository contracts

**Adapt fresh schema**

- `src/db/onboarding-migration.sql`
- `src/db/distributor-v2-migration.sql`
- `src/db/classification-migration.sql`

**Adapt versioned upgrade path and repositories**

- `src/db/migrations.ts`
- `src/db/repositories/onboarding-item-repo.ts`
- `src/db/repositories/onboarding-extraction-repo.ts`
- `src/db/repositories/onboarding-evidence-repo.ts`
- `src/db/repositories/onboarding-acceptance-repo.ts`
- `src/db/repositories/onboarding-conflict-repo.ts`
- `src/db/repositories/distributor-repo.ts`
- `src/db/repositories/curation-cohort-repo.ts`
- `src/server/routes/onboarding-routes.ts` (spreadsheet import only in this milestone)
- `src/product-intelligence/onboarding-import.ts` (create-import entry policy only)

**Schema/migration contract**

1. Fresh `onboarding_items` adds:
   - `source_type TEXT NOT NULL DEFAULT 'official_page'` constrained to the source enum;
   - `sourcing_entry_policy_version INTEGER NOT NULL DEFAULT 0`.
2. Fresh and upgraded `onboarding_extractions` supports:
   - nullable `source_url`;
   - `source_type` and existing `extraction_method`;
   - nullable `sourcing_generation_id`;
   - canonical sorted `accepted_evidence_attempt_ids_json`;
   - nullable `evidence_hash`.
3. Add `duration_ms` to evidence attempts for measured p95/source-error gates.
4. Add `distributor_record` to the fresh and upgraded `classification_evidence.source` CHECK.
5. Change only **new** distributor connection defaults to disabled. Do not silently rewrite existing operator-controlled connection states.
6. Use a new explicit migration marker (for example `default_on_sourcing_schema_version=1`) after the existing V2 marker. Existing items are backfilled to policy `0`; no timestamp/stage heuristic may set `1`.
7. Rebuild `onboarding_extractions` inside one transaction when PRAGMA reports a non-null URL or missing provenance columns:
   - snapshot row count and primary keys;
   - create the complete replacement table;
   - copy every old row as `official_page` with null distributor provenance;
   - compare counts/IDs, swap, recreate indexes, and run `foreign_key_check`;
   - write the marker last. Any failure rolls back and leaves the marker absent.
8. Rebuild `classification_evidence` with the new CHECK using the same row-count/ID/FK discipline. Do not delete “pre-existing orphan” data in this migration; fail and require the separately sanctioned integrity workflow rather than combining repair with schema evolution.

**Repository contracts**

- `insertItems(batchId, items, entryStage, sourcingEntryPolicyVersion=0)` writes the version explicitly and hydrates it. Production spreadsheet and reviewed Agent Lab create-import callers pass version `1`; omitted version remains `0` fail-closed.
- `claimItemsForProcessing('sourcing', ...)` requires exact current entry-policy version in the atomic subquery and outer CAS. Other stages remain unchanged.
- `insertExtraction` becomes a discriminated input:
  - `official_page` requires a real URL and the current extraction method contract;
  - `distributor_record` requires null URL, method `distributor_record_v1`, current generation, nonempty accepted IDs, and hash.
- Replace URL-only latest-source helpers with `getLatestExtractionBindingsByItemIds()`, returning URL, source type, method, generation, accepted IDs, and hash.
- Evidence/acceptance/conflict reads gain exact item/workspace/current-generation helpers; no helper falls back to lookup UPC.
- Acceptance replacement/finalization is generation-scoped and validates every attempt before write.
- `createConnection()` persists disabled unless a later explicit update enables it.
- `computeExtractionHash()` includes item source type and sorted distributor provenance in addition to extraction payload, decision, URL, and PI result hashes.

**Tests**

- Extend `src/tests/unit/db-migration.test.ts`: fresh schema, exact pre-amendment upgrade, nullable URL rebuild, classification source CHECK, row/ID preservation, idempotent second run, forced rollback/no marker, and FK checks.
- Extend `src/tests/unit/distributor-v2.test.ts`: disabled fresh defaults and duration/provenance columns.
- Extend `src/tests/unit/onboarding-repos.test.ts`: marker hydration; omitted=0; explicit=1; 148 version-0 Sourcing rows unclaimable; version-1 row claimable; workspace isolation; non-Sourcing claims unchanged.
- Extend `src/tests/unit/acceptance-migration.test.ts`: current-generation acceptance replacement and stale/cross-workspace rejection.
- Extend `src/tests/unit/product-intelligence-import.test.ts`: create imports use derived entry stage and marker; augment mode never changes the existing marker/stage.
- Preserve exact historical route/projection rows without rewriting them.

**Verification commands**

```bash
bun test \
  src/tests/unit/db-migration.test.ts \
  src/tests/unit/distributor-v2.test.ts \
  src/tests/unit/onboarding-repos.test.ts \
  src/tests/unit/acceptance-migration.test.ts \
  src/tests/unit/product-intelligence-import.test.ts
bun run typecheck
git diff --check
```

**Acceptance**

- A fresh DB and a pre-amendment DB converge on the same schema.
- Re-running migration is a no-op; an injected failure preserves the old table and leaves the marker absent.
- All pre-existing items, including a 148-row fixture, are policy `0` and cannot be claimed or observed.
- Distributor extraction provenance is representable without a URL; official extraction still fails closed without one.
- No live DB is migrated during implementation.

### Milestone C — Implement mode-aware routing, conflict completion, capabilities, and operator controls

**Adapt**

- `src/onboarding/job-queue.ts`
- `src/db/repositories/onboarding-item-repo.ts`
- `src/db/repositories/onboarding-conflict-repo.ts`
- `src/db/repositories/onboarding-acceptance-repo.ts`
- `src/db/repositories/onboarding-evidence-repo.ts`
- `src/server/routes/onboarding-routes.ts`
- `src/server/routes/distributor-routes.ts`
- `src/client/onboarding-api.ts`
- `src/client/components/PipelineBoard.tsx`
- `src/client/components/pipeline-drawer/SourcingStagePanel.tsx`
- `src/client/components/onboarding-settings/DistributorConnectionsPanel.tsx`

**New**

- `src/onboarding/sourcing/observation.ts`
- `src/tests/unit/sourcing-observe-mode.test.ts`

**Function-level work**

1. `buildAutoStages()` includes Sourcing only for valid manual/automatic mode; OFF/invalid/observe never claims Sourcing.
2. `processDiscovery()` invokes the bounded observation helper only for mode=`observe`, marker-v1, not-yet-observed imports. Observation appends a generation/attempts with measured duration, never calls conflict/acceptance/decision/transition writers, and never turns an observation failure into a Discovery failure.
3. Refactor `processSourcing()` around one evaluated generation outcome:
   - no identifier/no connection/all not-stocked → fallback;
   - only errors → degraded fallback;
   - accepted but incomplete → evidence-to-Discovery;
   - qualified found plus optional errors/not-stocked → distributor-to-Extraction with warnings;
   - hard conflict → persist current-generation conflicts and `sourcing/needs_input`;
   - manual mode leaves every non-conflict outcome `needs_input` with a server-derived qualification view until the operator chooses the route;
   - automatic mode applies the route table.
4. Query all enabled connections once per generation; never stop after the first found record. Bound the whole item to 60 seconds and persist per-attempt duration.
5. Extend `completeSourcingWithDecision()` to target `'extraction'`; update item source type and null URL atomically; require marker-v1 for automatic distributor routing; preserve legacy operator fallback for marker-v0 rows.
6. Final conflict resolution recomputes the canonical projection in the transaction after applying candidate/custom/dismiss semantics. Qualified → Extraction; accepted-but-insufficient → Discovery. Never reuse the previous blanket `evidence_to_discovery` final step.
7. Extend `/onboarding/items/:id/resolve-sourcing` with a strict manual `use_distributor_record` action. The server recomputes qualification and ignores client-supplied IDs/hash/providers. Existing fallback action remains, deriving evidence-vs-no-evidence audit route server-side.
8. Capabilities return `{ engineEnabled, mode, configurationReason, entryPolicyVersion }`. Do not expose secret references or connection details.
9. Legacy marker-v0 items show Continue-to-Discovery even when the engine is globally ON; no Retry/use-distributor action appears.
10. Create connection UI/API always starts disabled. Enabling is a separate explicit PATCH with confirmation that fixture/credential/health checks completed.
11. Kill switch behavior:
    - new imports enter Discovery;
    - no new Sourcing claims/observations occur;
    - Sourcing retry uses audited fallback;
    - in-flight/history is not rewritten or deleted;
    - UI exposes operator quarantine/Continue for pending items.

**Tests**

- Extend `src/tests/unit/sourcing-stage-order.test.ts`: mode-specific stage lists; marker-v0 never claimed; marker-v1 manual/automatic claimed; observe stays Discovery.
- Extend `src/tests/unit/sourcing-pass-through.test.ts`: new route to Extraction; found+error warnings; incomplete found to Discovery; no identifier/no connection/all-not-stocked/error matrix; one terminal event.
- Extend `src/tests/unit/conflict-resolution.test.ts`: final candidate/custom/dismiss reruns projection; qualified → Extraction; insufficient → Discovery; stale/current-generation and cross-item races.
- Extend `src/tests/unit/sourcing-resolution.test.ts` and `src/tests/unit/sourcing-safety-routes.test.ts`: strict actions, server-derived hash/IDs, workspace ownership, legacy v0 behavior, kill-switch rejection, no Curation target.
- Extend `src/tests/unit/distributor-routes.test.ts`: create-disabled, separate enable, ownership, secret redaction.
- Extend `src/tests/unit/sourcing-stage-panel.test.tsx` and `src/tests/unit/distributor-settings-panel.test.tsx`: modes, legacy Continue, manual confirmation, default-disabled connection.
- New observe suite asserts zero item/decision/acceptance/conflict/extraction mutation on found, conflict, error, timeout, and repeat polling.

**Verification commands**

```bash
bun test \
  src/tests/unit/sourcing-stage-order.test.ts \
  src/tests/unit/sourcing-pass-through.test.ts \
  src/tests/unit/conflict-resolution.test.ts \
  src/tests/unit/sourcing-resolution.test.ts \
  src/tests/unit/sourcing-safety-routes.test.ts \
  src/tests/unit/distributor-routes.test.ts \
  src/tests/unit/sourcing-observe-mode.test.ts
bunx vitest run \
  src/tests/unit/sourcing-stage-panel.test.tsx \
  src/tests/unit/distributor-settings-panel.test.tsx
bun run typecheck
git diff --check
```

**Acceptance**

- Automatic qualified evidence reaches `extraction/pending`; no route/helper can reach Curation.
- Manual and observe modes have materially distinct, tested mutation boundaries.
- A found+error generation still uses the qualified record and retains the error warning.
- Final conflict resolution follows the same qualification authority as automatic routing.
- Capabilities and connection creation are truthful, fail-closed, workspace-scoped, and non-secret.

### Milestone D — Add source-dispatched distributor-record Extraction

**New**

- `src/onboarding/sourcing/distributor-record-materializer.ts`
- `src/tests/unit/distributor-record-materializer.test.ts`
- `src/tests/unit/distributor-record-extraction-panel.test.tsx`

**Adapt**

- `src/onboarding/job-queue.ts`
- `src/db/repositories/onboarding-extraction-repo.ts`
- `src/db/repositories/onboarding-item-repo.ts`
- `src/shared/schemas/onboarding.ts`
- `src/server/routes/onboarding-routes.ts`
- `src/client/onboarding-api.ts`
- `src/client/components/PipelineBoard.tsx`
- `src/client/components/pipeline-drawer/ExtractionStagePanel.tsx`

**Function-level work**

1. Branch `processExtraction()` on persisted item source type before URL/profile checks.
2. Preserve the official branch byte-for-byte except for the discriminated repository input: real URL → domain/profile → current page extraction.
3. `materializeDistributorRecordExtraction(itemId, workspaceId)` executes inside a repository transaction and rechecks:
   - item is workspace-owned and `extraction/in_progress`;
   - current V2 decision is `distributor_record_to_extraction`;
   - decision generation is exactly current and not superseded;
   - relational accepted IDs exactly match the decision/projection contribution set;
   - every accepted attempt is schema-valid, found, exact-identifier, same item/workspace/generation, and connection-owned;
   - no current open hard conflict exists;
   - recomputed canonical projection/hash equals the decision hash.
4. Materialize `ExtractionData` with title, noncanonical brand, weight, exact identifiers, distributor SKU/MPN, whitelisted variants, and a dedicated distributor-record provenance object. Keep description/bullets/price/images empty, URL null, confidence non-authoritative, and OCR fields null/disabled without invoking OCR.
5. Insert one `onboarding_extractions` row with method/source/generation/IDs/hash, update item `extraction_data_json`, and mark Extraction completed atomically. A retry with the same generation/hash is idempotent and cannot create divergent rows.
6. Do not import or call `extractProductData`, profile lookup, fetch, DOM tooling, OCR, VLM, LLM, or image processing from the distributor branch. Test injection/spy seams prove zero calls.
7. Deterministic integrity failure uses a stable error code, marks `extraction/failed`, and performs no partial insert/update. It is not blindly retried because unchanged evidence cannot heal an integrity error.
8. Add an operator **Continue with Official Site Discovery** action for distributor-source Extraction (pending/failed/completed before Curation): in one guarded transaction set source type back to official, keep URL null, clear the active item extraction payload, move to `discovery/pending`, and record the operator override. Preserve generations, attempts, conflicts, acceptances, and prior extraction audit rows. Later-stage items must first use the existing reviewed send-back flow; no post-Review history rewrite is introduced.
9. Extraction UI labels distributor materialization accurately, hides URL edit/profile actions, shows accepted provider/attempt/generation/hash provenance, and exposes the guarded fallback. It never displays distributor copy/images as extracted commerce data.

**Tests**

- New materializer suite: one provider; multiple agreeing providers; found+error; null URL; no profile; deterministic hash/order; allowed field mapping; excluded description/price/inventory/image/arbitrary fields; stale generation; foreign connection; changed acceptance; open conflict; hash mismatch; transaction rollback; idempotent retry; zero external calls.
- Extend `src/tests/unit/sourcing-pass-through.test.ts`: route is followed by distributor Extraction completion with fixture connectors, not Discovery.
- Extend `src/tests/unit/extraction-remedies.test.ts`: distributor integrity failure remains failed and explicit fallback returns to Discovery atomically; official profile remedies are unchanged.
- New panel suite: distributor source has no URL/profile control and exposes only provenance/fallback; official source UI remains unchanged.

**Verification commands**

```bash
bun test \
  src/tests/unit/distributor-record-materializer.test.ts \
  src/tests/unit/sourcing-pass-through.test.ts \
  src/tests/unit/extraction-remedies.test.ts
bunx vitest run src/tests/unit/distributor-record-extraction-panel.test.tsx
bun run typecheck
git diff --check
```

**Acceptance**

- A qualified fixture record completes Extraction with a null URL and no profile/network/model/image call.
- The row, item payload, decision, and canonical projection carry identical generation/attempt/hash provenance.
- Any authority mismatch fails closed with zero partial materialization.
- The official fallback is explicit, atomic, audited, and preserves immutable sourcing evidence.

### Milestone E — Preserve provenance through cohorts/classification and close the promotion image leak

**Adapt schemas and migration-backed source handling**

- `src/shared/schemas/cohorts.ts`
- `src/shared/schemas/classification.ts`
- `src/classification/types.ts`
- `src/classification/product-evidence-extractor.ts`
- `src/classification/stages/evidence-extraction.ts`

**Adapt cohort production/consumers**

- `src/onboarding/curation-cohort-service.ts`
- `src/onboarding/cohort-curator.ts`
- `src/onboarding/product-curator.ts`
- `src/onboarding/cohort-title-hash.ts`
- `src/onboarding/cohort-title-coordinator.ts`
- `src/onboarding/cohort-page-hash.ts`
- `src/onboarding/cohort-page-coordinator.ts`
- `src/classification/cohort-product-type-resolver.ts`
- `src/db/repositories/curation-cohort-repo.ts`

**Adapt promotion boundary**

- `src/onboarding/draft-promoter.ts`
- `src/db/repositories/onboarding-evidence-repo.ts`

**Function-level work**

1. Add `execution-evidence-v2` rather than mutating V1 semantics. V2 member provenance contains:
   - item source type and nullable source URL;
   - extraction source type, URL, and method;
   - current sourcing generation ID;
   - sorted accepted attempt/provider IDs;
   - distributor evidence hash;
   - V2 sourcing decision and existing extraction/OCR/PI evidence.
2. Keep `ExecutionEvidenceProjectionV1Schema` parse-only for historical snapshots. Add a central parser/adapter; historical V1 safely normalizes to official-page provenance because distributor-record routing did not exist when V1 snapshots were written. Never rewrite persisted V1 bytes.
3. Replace URL-only readiness with exact source-binding comparison:
   - official source requires matching real item/extraction URL;
   - distributor source requires both URLs null and matching source type/method/generation/IDs/hash;
   - a missing/malformed binding blocks readiness rather than passing.
4. Tighten `isSourceFinalized()`: an arbitrary non-null historical sourcing decision is not enough. A distributor item is finalized only after a valid distributor extraction binding; official path requires the normal Discovery URL completion.
5. `buildExecutionEvidenceProjection()` writes V2 and hashes all provenance. `buildFrozenItem()`/`frozenItemFromProjection()` restore source type and accepted provenance from the frozen member, never hardcode official-page or read live post-freeze values.
6. Update title/page/product-type input hashes and coordinators so source-kind/provenance drift changes their input identity. Shared downstream functions accept the versioned projection union without weakening V2 checks.
7. Classification evidence mapping:
   - distributor identity fields use `source='distributor_record'`, null classification URL, and metadata containing sorted attempt/provider IDs, generation, evidence hash, and per-field provenance;
   - never label distributor evidence `official_product_page`;
   - emit no distributor description/bullets/images/claims/composition;
   - central provenance formatting in `product-evidence-extractor.ts` must not fall through to `official_product_page` metadata for the new source;
   - existing evidence-policy logic treats the new source as third-party and preserves claim/composition prohibitions.
8. Promotion image fix:
   - delete the `item_id OR lookup_upc` query and never append raw `identity.images` to `downloadAndProcessImages()`;
   - if a provenance helper is retained for an existing PI-6 asset association, it must join exact item, batch workspace, current generation, relational acceptance, and workspace connection;
   - raw distributor attempt URLs—including accepted/current ones—contribute zero commerce downloads without a durable PI-6 `commerceApproved` asset; official extracted images and the existing verified PI import gate remain separate.
9. Promotion rechecks distributor extraction generation/hash/accepted provenance in `computePromotionGate()` so a stale or tampered materialization cannot draft even after Review.

**Tests**

- Extend `src/tests/unit/curation-cohort-service.test.ts`: null-URL distributor readiness; mismatched source type/generation/IDs/hash blocks; arbitrary historical decision no longer finalizes source.
- Extend `src/tests/unit/cohort-freeze.test.ts`: V2 schema/hash; frozen distributor provenance retained; post-freeze live mutation invisible; historical V1 remains parseable/read-only.
- Extend `src/tests/unit/cohort-title-hash.test.ts`, `src/tests/unit/cohort-page-hash.test.ts`, `src/tests/unit/cohort-worker.test.ts`, and `src/tests/unit/cohort-product-type-resolver.test.ts`: V2 input and source-provenance drift.
- Extend `src/tests/unit/evidence-extraction.test.ts`: distributor source label/metadata, null URL, identity-only fields, no official label, no claim/composition/image/copy elevation.
- Extend `src/tests/unit/classification-pipeline.test.ts`: distributor evidence passes through reviewable classification without bypassing safety policy.
- Extend `src/tests/unit/draft-promoter.test.ts`: unaccepted, stale-generation, foreign-workspace, same-UPC, and accepted-but-not-PI6 distributor images cause zero download; official and PI-6-approved behavior remains; stale/tampered extraction provenance blocks drafting.
- Update projection factories in PR6–PR13/cohort suites only as required to exercise V1 compatibility and current V2 writes; do not bulk-rewrite historical fixtures to hide compatibility failures.

**Verification commands**

```bash
bun test \
  src/tests/unit/curation-cohort-service.test.ts \
  src/tests/unit/cohort-freeze.test.ts \
  src/tests/unit/cohort-title-hash.test.ts \
  src/tests/unit/cohort-page-hash.test.ts \
  src/tests/unit/cohort-worker.test.ts \
  src/tests/unit/cohort-product-type-resolver.test.ts \
  src/tests/unit/evidence-extraction.test.ts \
  src/tests/unit/classification-pipeline.test.ts \
  src/tests/unit/draft-promoter.test.ts
bun run typecheck
git diff --check
```

**Acceptance**

- Frozen distributor evidence can be reproduced from persisted V2 bytes without a live item/evidence read.
- Every classification record truthfully says `distributor_record`; none is elevated to official-page evidence.
- Source/generation/attempt/hash drift blocks readiness, classification execution, or promotion.
- No raw distributor evidence URL reaches the image downloader; PI-6 remains the sole commerce path.

### Milestone F — Complete acceptance coverage, runner registration, docs, and controlled rollout

**New**

- `src/tests/unit/sourcing-default-on-e2e.test.ts`

**Adapt tests/fixtures and runners**

- `src/tests/fixtures/sourcing/**` (sanitized, credential-free, offline only)
- `src/tests/unit/sourcing-recovery-acceptance.test.ts`
- All focused suites named in Milestones A–E
- `package.json`
- `vitest.config.ts`

**Adapt operational/domain documentation**

- `docs/runbooks/sourcing-engine-rollout.md`
- `CONTEXT.md`
- `AGENTS.md`

**Work**

1. Add one fixture-connector end-to-end suite covering import → eligibility → generation → all-provider lookup → qualification/conflict → route → distributor materialization → cohort V2 freeze → distributor-labeled classification → mandatory Review gate → promotion provenance gate.
2. Required E2E cases:
   - absent flag/automatic/default-on new import;
   - explicit false and malformed configuration;
   - observe mutation isolation;
   - manual explicit route;
   - automatic single-provider qualified route;
   - two agreeing providers;
   - flavor/formula/custom-axis conflict;
   - unknown variant axis and no-name insufficiency;
   - found+timeout route with warning;
   - all-not-stocked/provider-only errors;
   - 148 marker-v0 rows with zero connector calls;
   - retry supersession/stale generation;
   - materialization hash/current-generation failure;
   - V2 cohort freeze/classification source;
   - raw image non-flow;
   - kill switch/quarantine behavior;
   - no route/action reaches Curation or bypasses Review.
3. Register every Bun/SQLite suite once under `test:db`; keep it excluded from Vitest. Keep pure schema/projection/render suites under Vitest. Do not duplicate collection.
4. Update the runbook with the exact rollout/rollback sequence below, read-only observation queries/export template, stable reason codes, and incident quarantine checklist.
5. Update `CONTEXT.md` and `AGENTS.md` only after implementation exists: default-on/fail-closed semantics, route to Extraction, identity-only materializer, modes, marker-v0 legacy behavior, V2 provenance, PI-6 image boundary, and mandatory Review.
6. Run no provider/network/model request in CI. Fixture connectors and injected transports are the only test transports.

**Verification commands (run only after implementation; they were not run while writing this plan)**

```bash
# Focused pure suites
bunx vitest run \
  src/tests/unit/sourcing-flags.test.ts \
  src/tests/unit/sourcing-contracts.test.ts \
  src/tests/unit/sourcing-entry-policy.test.ts \
  src/tests/unit/sourcing-distributor-projection.test.ts \
  src/tests/unit/sourcing-stage-panel.test.tsx \
  src/tests/unit/distributor-settings-panel.test.tsx \
  src/tests/unit/distributor-record-extraction-panel.test.tsx

# Focused DB/worker/cohort/promotion suites
bun test \
  src/tests/unit/db-migration.test.ts \
  src/tests/unit/onboarding-repos.test.ts \
  src/tests/unit/sourcing-stage-order.test.ts \
  src/tests/unit/sourcing-pass-through.test.ts \
  src/tests/unit/sourcing-observe-mode.test.ts \
  src/tests/unit/conflict-resolution.test.ts \
  src/tests/unit/distributor-record-materializer.test.ts \
  src/tests/unit/curation-cohort-service.test.ts \
  src/tests/unit/cohort-freeze.test.ts \
  src/tests/unit/evidence-extraction.test.ts \
  src/tests/unit/draft-promoter.test.ts \
  src/tests/unit/sourcing-default-on-e2e.test.ts

# Canonical project gates
bun run typecheck
bun run build
bun run test
bun run lint

# Hygiene
git diff --check
git diff --cached --name-only
git status --short
```

If a project-wide command exposes unrelated pre-existing/concurrent failures, record before/after evidence and report them separately. Do not add exclusions, loosen assertions, or edit unrelated files to manufacture green output.

**Acceptance**

- Focused and canonical suites cover every governing route, mode, migration, provenance, image, kill-switch, and review invariant.
- No DB-backed suite is collected by Vitest or omitted from `test:db`.
- Domain/runbook text no longer claims default-OFF/mandatory Discovery after Amendment A.
- Outer and nested staged sets remain empty; no canonical catalog file or live DB changed.

## Rollout and rollback sequence

1. **Pre-upgrade pin (mandatory for every existing installation).** Set `BAYSTATE_CMS_SOURCING_ENABLED=false`, restart, and verify capabilities report disabled with reason `explicit_false`. Inventory enabled connections; do not rely on the new missing-flag default during upgrade.
2. **Quiesce and verify backup.** Stop API/workers, checkpoint WAL through the existing approved procedure, verify free space, then use the existing SQLite backup verifier against the exact DB path. Example operator form (replace paths; do not run during implementation):
   ```bash
   bun run classification:integrity backup --db <absolute-app.db> --backup <absolute-timestamped-backup.db>
   ```
   Require a passing manifest/hash, `integrity_check`, protected-table counts/digests, source identity, and no WAL/SHM sidecar on the backup. Abort on any failure or source drift.
3. **Migrate while pinned OFF.** Start only the sanctioned migration path, verify `default_on_sourcing_schema_version`, columns, row counts, `foreign_key_check`, policy-0 legacy count, and disabled capability. Roll back from the verified backup rather than editing rows if migration fails.
4. **Configure disabled connections.** Create provider connections disabled, provision secret references server-side, run offline fixture/security tests, then perform the documented controlled health check. Enabling is a separate operator action.
5. **Observe one workspace/provider.** Set flag true and mode `observe`; existing/new items continue through official Discovery. Collect at least 100 labeled observations per connector (≥30 found; ≥20 negative/wrong-variant), error rate, duration p95, conflict/fallback accuracy, credential/image incidents. No item decision/source/acceptance changes are allowed.
6. **Gate to manual.** Require all quantitative decision-8 thresholds. Set mode `manual` for fresh policy-v1 imports only; review every qualification/conflict and explicitly select Extraction or Discovery. Legacy policy-0 rows remain Continue-to-Discovery.
7. **Automatic canary.** After manual evidence passes, set mode `automatic` for one workspace/provider for at least seven days and 100 real items. Review every item at the normal Review stage and compare route/materialization against labels.
8. **Broaden provider by provider.** Repeat gates independently. A passing connector never vouches for another connector or variant-axis map.
9. **Kill/incident action.** Set `BAYSTATE_CMS_SOURCING_ENABLED=false` and restart. Abort in-flight calls; do not delete evidence or rewrite completed/reviewed history. New imports go to Discovery. Inventory `sourcing/pending|in_progress|needs_input`, `extraction/pending|failed` distributor items, and reviewed distributor items; quarantine/Continue explicitly. Preserve attempts, generations, conflicts, decisions, extraction rows, and incident measurements.
10. **Rollback code/schema only from verified evidence.** Code rollback keeps the kill switch false. Schema/data rollback uses the verified backup and documented downtime; never ad hoc SQL, never a repair script over the 148 rows, and never evidence deletion.

## Explicit non-goals and boundaries

- No new Pipeline Stage, stage status, or Brand authority.
- No Sourcing → Curation route, actionable historical bundle route, or automatic Review/Promotion.
- No description, bullets, marketing claims, price, inventory, image, arbitrary field, or canonical Brand assignment from distributor materialization.
- No fake distributor/source URL and no relaxation of official-page profile rules for `official_page` extraction.
- No PI-6 redesign; this work only closes raw distributor image flow and honors existing commerce approval.
- No new connector/provider, Phase-2 SFTP dependency, broad dependency upgrade, live provider call, paid crawl, model download, or model request.
- No historical-item backfill, live-DB repair, or automatic reprocessing of the 148 rows.
- No rewrite of persisted V1 cohort snapshots or historical `bundle_to_curation` decisions.
- No redesign of cohort grouping, taxonomy/config authority, Product Intelligence, extraction profiles, Store Manager, general auth, or ShopSite publication.
- No canonical catalog mutation, nested classification commit, outer staging, or commit.

## Final implementation acceptance criteria

A reviewer must attest all of the following before default-on activation:

- Amendment A contains all 17 normative points and is ratified first.
- All nine blocker-table rows have focused regression evidence.
- Missing/false/malformed flag and observe/manual/automatic mode behavior match the matrix.
- A 148-row legacy fixture produces zero claims, observations, and connector calls, while post-amendment items remain eligible.
- Single-provider qualified and found+error cases route to `extraction/pending`; incomplete/conflict/error cases follow the normative table.
- No helper/schema/API/UI can create or act on Sourcing → Curation.
- Distributor materialization is URL-null, identity-only, deterministic, hash-bound, current-generation/workspace-owned, and zero-fetch/profile/OCR/model/image.
- V2 frozen evidence retains source/generation/attempt/hash provenance; V1 remains readable without mutation.
- Classification emits `distributor_record`, never `official_product_page`, and third-party claim/composition restrictions remain effective.
- Raw distributor attempt images produce zero downloads; only PI-6 commerce-approved assets can cross that boundary.
- Mandatory Review remains in the path and promotion revalidates provenance.
- Fresh/upgrade/idempotent/rollback migrations pass against temporary DBs; a verified backup exists before any real migration.
- Per-provider quantitative gates and the seven-day/100-item canary pass on measured outcomes, never model confidence.
- Full typecheck/build/test/lint and diff hygiene pass or unrelated baseline failures are separately evidenced.
- No network/paid/model/live-DB/catalog mutation occurred during implementation tests; no staged files or unauthorized commits exist.

## Residual risks

- **Incorrect exact-UPC distributor data:** a provider can publish the wrong product or variant under an exact identifier; single-provider routing cannot eliminate this. Mitigation is strict variant-axis handling, mandatory Review, zero-false-acceptance gates, and immediate kill/quarantine.
- **Sparse drafts:** skipping official Discovery means v1 drafts may lack descriptions, claims, and commerce-approved images. This is intentional; the system must show missing content rather than infer or import unsafe copy/assets.
- **Migration/projection compatibility:** nullable extraction URLs, table rebuilds, the new classification source CHECK, and execution-evidence-v2 affect old databases and many cohort consumers. Verified backups, V1 parse-only support, row/hash checks, and temporary-DB upgrade fixtures reduce but do not eliminate rollout risk.
- **Default-on traffic:** an installation that fails to pin false and already has enabled connections can contact providers after upgrade. Disabled connection creation, explicit upgrade pin, truthful capabilities, and startup checklists are mandatory controls.
- **Connector metadata quality:** connector-declared variant axes can be incomplete or wrong. Unknown axes fail to Discovery; each connector must independently meet labeled negative/wrong-variant gates.
- **Observation-label quality:** the thresholds depend on correct human labels and representative negatives. Preserve the labeled artifact and reviewer provenance; do not promote on raw retrieval rate alone.
- **Concurrency:** generation supersession, conflict resolution, materialization, and operator fallback can race. Exact-generation CAS and transactional revalidation are required, but crash/restart scenarios still need canary observation.
- **Dirty worktree drift:** concurrent edits can invalidate line references or silently overwrite safety fixes. One sequential writer, target hashes, and per-milestone status comparison remain mandatory.

## Dependency-ordered milestone summary

1. **M0 — Baseline/allowlist:** freeze dirty-tree provenance; no project writes.
2. **MA — Amendment/contracts:** ratify Amendment A, then establish default-on flags/modes, entry policy, route-specific decisions, variant safety, and deterministic projection.
3. **MB — Migration/repositories:** persist eligibility/source/provenance safely and isolate all legacy rows.
4. **MC — Routing/controls:** implement observe/manual/automatic behavior, new Extraction route, conflict completion, capabilities, and disabled-first connections.
5. **MD — Source-dispatched Extraction:** materialize identity-only distributor records with atomic hash/current-generation validation and official fallback.
6. **ME — Cohort/classification/promotion:** freeze V2 provenance, label distributor evidence truthfully, and close raw image flow.
7. **MF — Acceptance/rollout:** register complete offline coverage, update domain/runbook text, run canonical gates, and execute measured provider-by-provider rollout.
