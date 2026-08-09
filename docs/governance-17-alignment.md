# #17 Governance Alignment — AI Curation/Classification Quality

Tracking issue #17 coordinates remediation of the adversarial audit of the
production modular curation/classification pipeline. This document maps every
tracked item to its delivering work and status, with emphasis on the items
delivered by the Product Intelligence program (issues #19–#29).

Scope note: #17 intentionally links focused implementation tickets rather
than one rewrite. Items live in two workstreams — the **Product Intelligence
program** (this repo's `feat/pi-1-product-intelligence-execution-boundary`
branch) and the **classification subsystem** (issue-17 remediation passes
committed on `main` as `issue17-passN` commits). The two workstreams are
complementary: each delivers its own provenance/telemetry; neither
substitutes for the other.

## P0 — restore safety and make capabilities explicit

| # | Item | Status | Delivered by |
|---|------|--------|--------------|
| #4 | Fail-fast configuration readiness validation for curation targets | ✅ CLOSED | classification workstream |
| #5 | Primary Product Type gating explicit for fields and Category Pages | ✅ CLOSED | classification workstream |
| #6 | Review gates fail-closed; AI promotion fallback removed | ✅ CLOSED | classification workstream — accepted-only promotion semantics (live accepted decision required; `acceptedProposals.length ? accepted : nonRejected` fallback deleted) landed in `d3e0423` (pass 2, items B+K); promotion is accepted-only in both the SQL-proposal path and the true-legacy embedded path |
| #8 | Brand evidence, source provenance, OCR fallback defects | ✅ CLOSED | classification workstream |
| #9 | Execute from immutable snapshots; enforce model/data policies | ✅ CLOSED | classification workstream — pass 1 (item A) `0af96d5`/`b1eba02` + security rounds `23356c7`/`50578f8`/`1461af3`: `src/classification/model-policy-gateway.ts` (protected calls run from the frozen policy; endpoint locality checked as well as declared locality; no implicit policy → no model call; denied-before-transport); pass 4 (item E) `33cea8c`/`a836f80`/`cb4ae5d`/`ad90656`/`e891b7e`/`e6f802d`: `classification_model_calls` audited provenance (call row inserted before transport; terminal row before output), frozen local-VLM route with loopback verification, sanitized run-detail endpoint. The PI analog — immutable policy snapshots + centralized enforcement — is **PI-5** (`src/product-intelligence/policy/policy-gateway.ts`, `verifyPolicySnapshot`, `bcd0bbc`); both are delivered, each scoped to its own subsystem |
| #10 | Replace self-reported confidence bulk acceptance with calibrated policy | ✅ CLOSED | classification workstream — calibration tiers remain **evaluation-only**; production ML features remain disabled in the active config |

## P1 — classification semantics and durable architecture

| # | Item | Status | Delivered by |
|---|------|--------|--------------|
| #7 | Target-aware evidence grounding, conflicts, applicability | ✅ CLOSED | classification workstream — pass 5 (items H+I) `69d2c32`/`f6ef1a6`/`2b5a8d5`/`cab0e29`: `evidence-targeting.ts`, relation-typed `classification_proposal_evidence` with role-union validation, contradiction detection surfaced in `classification_proposal_decision_evidence`, applicability conditions carry exact canonical IDs |
| #11 | Stable Category Page IDs and configurable assignment scope | ✅ CLOSED | classification workstream — page identity: active verified Page import `96d018cb` (211 `exported_guid` records, source hash `20d94f68…`) with strict identity bijection (`c85c821`…`c912b60`, pass 3 item D1); **D2 activation** (2026-08-09): reviewed preview (`e23224ba…` staged; evidence `3b276fed…` unchanged), user-approved activation → active bundle `b5ca076f…` in nested commit `024c6412` (only `store/classification/**`), `store-pages.enabled:true` with `optionSource: live_store`; runtime authority loads with zero blockers and readiness reports Category Pages runnable; page assignments are verified-ID-only (never display names) via `assignment-projection.ts` |
| #12 | Preserve proposal revisions; evidence-backed corrections | ✅ CLOSED | classification workstream — decision revision migration + reviewed-facts carry forward (`decision-revision-migration.ts`, `reviewed-facts.ts`, `proposal-review-service.ts`), pass 5 (item I) citations rendered in both review UIs (`cab0e29`) |
| #13 | Persist model-call provenance; run inspection/replay | ✅ **DELIVERED (both workstreams)** | **Classification-side** (pass 4, item E): `classification_model_calls` audited wrapper (started-before-transport, terminal-before-output, call-ID linkage verified in-transaction), sanitized run-detail endpoint — committed `33cea8c`…`e6f802d`. **PI-side**: **PI-2** (durable steps/tool calls/events with request+response hashes, `product_intelligence_steps`/`tool_calls`/`events`), **PI-5** (policy decision audit table, prompt hashes, `config_snapshot_id`), **PI-10** (`c8e9f29`: full run inspector projection, three replay modes — deterministic reconstruction / same-configuration rerun / comparison rerun — every replay a new run linked via `origin_run_id` + `replay_depth`, originals immutable). Each workstream delivers its own provenance for its own runs; neither substitutes for the other |
| #14 | Golden-set quality evaluation and production telemetry | ✅ **DELIVERED (both workstreams)** | **Classification-side** (pass 7, item F): `classification-metrics` schema + read-only repo + pure aggregation (`0433047`), versioned quality report endpoint + weekly-report qualitySummary with honest n/a coverage (never fabricated zeros), route-identity groups, per-proposal latest-live-decision selection (`3dc206a`/`8da49b6`); golden-set benchmark harness exists but remains **evaluation-only** (Gold qualification gate: ≥200 holdout, ≥20/class, ≥0.80 coverage, zero safety violations, positive CI lower bound; `insufficient_sample` is the honest state). **PI-side**: **PI-9** (`2021905`/`204dc4e`: versioned golden dataset reusing the #14 benchmark tables — frozen content-addressed datasets, deterministic train/test/holdout splits; 9-outcome metrics taxonomy; evaluation runner + `pi_evaluation_runs` audit rows; extraction benchmark with retrieval-vs-extraction scoring; staged rollout gates over measured metrics; kill switch) |
| #15 | Unify ProductField serialization; explicit built-in output policy | ✅ CLOSED | classification/ShopSite workstream — serialization unification (M5); **item J** (pass 8, `668a693`): `src/shopsite/built-in-output-policy.ts` — immutable `SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1` enumerates every supported built-in field (Name, FileName, Price, SaleAmount, ProductDescription, MinimumQuantity, ProductType, Weight, Graphic, SearchKeywords, MoreInfoImage1–20) with omission/default/encoding/cardinality rules; `product-denormalizer.ts` consumes it byte-compatibly; the DTD-level policy is **adapter-owned**, not workspace-configurable (ADR-0011); custom `ProductField*` values stay on classification mapping/serialization; draft-promoter Name/Price/new-date ProductField1 is documented draft input behavior, not XML output policy |
| #16 | Repair classification referential integrity; prevent orphaned run data | ✅ CLOSED | classification workstream — pass 6 (item C1) audit/backup/repair tooling (`2979de8`…`4c0ed69`) with adversarial-grade backup verifier (VACUUM INTO single artifact, sidecar refusal, immutable open, collision-resistant identity, quarantine cleanup, content-attested publish); **C2 live repair executed 2026-08-09** against the verified backup (`/tmp/issue17-c2-backup`): 637 stage results, 2003 evidence, 191 proposals, 42 proposal decisions, 180 onboarding sources, 50 onboarding extractions, 1 profile revision, 22 dangling embedded proposals removed in ONE transaction; **post-audit clean** (0 FK violations, `PRAGMA integrity_check = ok`, operational rows untouched — 268 terminal runs, 465 proposals, 211 verified pages, 33,631 product_pages) |

## P2 — continuous quality program

The P2 gate (adjudicated dataset expansion, drift monitoring, versioned
recalibration) is operationalized by the PI program: **PI-9's** rollout gates
advance only on measured aggregate metrics with minimum sample sizes, the
golden dataset is versioned (`pi-golden-v1`) and frozen per version, and
**PI-10's** budgets/retention cap blast radius. The classification
workstream's `confidence-calibrator.ts` + benchmark harness extend the same
pattern — evaluation-only; production ML remains disabled in the active
config (`mlFeatures.*` all `disabled` in bundle `b5ca076f…`).

## Controlled-value identity (item G)

Item G (pass 8, `668a693`; fix `26165d4`) made controlled-value string
identity explicit and canonical: a controlled value ID is exactly its stored
canonical string (NFC-normalized, trimmed); label equals ID by documented v2
policy (ADR-0012). `src/classification/controlled-value-identity.ts` centralizes
comparison keys, canonical validation (rejecting empty/control-character
values, non-NFC/non-trimmed values, exact duplicates, normalized/case-fold
collision pairs, and aliases whose `mapsTo` is not an exact allowed ID),
alias→exact-ID resolution, and `{value: id, label: id}` options. Proposals,
decisions, reviewed facts, applicability conditions, serialization
validation, and conflict detection carry the exact canonical ID; callers no
longer do ad hoc case-insensitive canonicalization.

## Program record

All PI-delivered items are committed on
`feat/pi-1-product-intelligence-execution-boundary`:

- PI-5 `bcd0bbc` — policy gateway, immutable snapshots, decision audit
- PI-9 `2021905` + `204dc4e` — golden-set evaluation, telemetry, rollout gates
- PI-10 `c8e9f29` — model-call provenance consumption, run inspection/replay
- PI-11 `d7bad48` + layers 5–8 — deterministic extraction ladder, browser
  capture, interaction, managed fallback, narrow LLM extraction

Classification-side issue-17 remediation is committed on `main` as
`issue17-passN` commits (pass 1 items A → pass 10 item D2), with the two
operational gates executed against the live store DB on 2026-08-09:

- **C2** — integrity repair (verified backup, one transaction, clean post-audit)
- **D2** — user-approved config-store activation: active bundle `b5ca076f…`,
  nested catalog commit `024c6412` (only `store/classification/**`), evidence
  hash `3b276fed…` unchanged, `store-pages` enabled against the same 211-page
  verified import

GitHub issue #17's checkboxes are updated by the issue owner; per project
constraint, this repository commits no issue writes.
