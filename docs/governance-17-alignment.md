# #17 Governance Alignment — AI Curation/Classification Quality

Tracking issue #17 coordinates remediation of the adversarial audit of the
production modular curation/classification pipeline. This document maps every
tracked item to its delivering work and status, with emphasis on the items
delivered by the Product Intelligence program (issues #19–#29).

Scope note: #17 intentionally links focused implementation tickets rather
than one rewrite. Items live in two workstreams — the **Product Intelligence
program** (this repo's `feat/pi-1-product-intelligence-execution-boundary`
branch) and the **classification subsystem** (the working tree's extensive
uncommitted classification work, committed separately by its owner).

## P0 — restore safety and make capabilities explicit

| # | Item | Status | Delivered by |
|---|------|--------|--------------|
| #4 | Fail-fast configuration readiness validation for curation targets | ✅ CLOSED | classification workstream |
| #5 | Primary Product Type gating explicit for fields and Category Pages | ✅ CLOSED | classification workstream |
| #6 | Review gates fail-closed; AI promotion fallback removed | ✅ CLOSED | classification workstream |
| #8 | Brand evidence, source provenance, OCR fallback defects | ✅ CLOSED | classification workstream |
| #9 | Execute from immutable snapshots; enforce model/data policies | 🔵 OPEN | classification workstream (`runtime-snapshot.ts`, `integrity-audit.ts`, `feature-policy.ts` in the working tree). The PI analog — immutable policy snapshots + centralized enforcement — is delivered by **PI-5** (`src/product-intelligence/policy/policy-gateway.ts`, `verifyPolicySnapshot`, `bcd0bbc`) |
| #10 | Replace self-reported confidence bulk acceptance with calibrated policy | ✅ CLOSED | classification workstream |

## P1 — classification semantics and durable architecture

| # | Item | Status | Delivered by |
|---|------|--------|--------------|
| #7 | Target-aware evidence grounding, conflicts, applicability | 🔵 OPEN | classification workstream (`curation-target-processor.ts`, `proposal-safety.ts` in the working tree) |
| #11 | Stable Category Page IDs and configurable assignment scope | 🔵 OPEN | classification workstream (`src/shared/stable-id.ts`, page-identity work in the working tree) |
| #12 | Preserve proposal revisions; evidence-backed corrections | 🔵 OPEN | classification workstream (`decision-revision-migration.ts`, `reviewed-facts.ts`, `proposal-review-service.ts` in the working tree) |
| #13 | Persist model-call provenance; run inspection/replay | ✅ **DELIVERED by PI** | **PI-2** (durable steps/tool calls/events with request+response hashes, `product_intelligence_steps`/`tool_calls`/`events`), **PI-5** (policy decision audit table, prompt hashes, `config_snapshot_id`), **PI-10** (`c8e9f29`: full run inspector projection, three replay modes — deterministic reconstruction / same-configuration rerun / comparison rerun — every replay a new run linked via `origin_run_id` + `replay_depth`, originals immutable) |
| #14 | Golden-set quality evaluation and production telemetry | ✅ **DELIVERED by PI** | **PI-9** (`2021905`/`204dc4e`: versioned golden dataset reusing the #14 benchmark tables — frozen content-addressed datasets, deterministic train/test/holdout splits; 9-outcome metrics taxonomy; evaluation runner + `pi_evaluation_runs` audit rows; extraction benchmark with retrieval-vs-extraction scoring; staged rollout gates over measured metrics; kill switch) |
| #15 | Unify ProductField serialization; explicit built-in output policy | ✅ CLOSED | classification/ShopSite workstream |
| #16 | Repair classification referential integrity; prevent orphaned run data | ✅ CLOSED | classification workstream |

## P2 — continuous quality program

The P2 gate (adjudicated dataset expansion, drift monitoring, versioned
recalibration) is operationalized by the PI program: **PI-9's** rollout gates
advance only on measured aggregate metrics with minimum sample sizes, the
golden dataset is versioned (`pi-golden-v1`) and frozen per version, and
**PI-10's** budgets/retention cap blast radius. The classification
workstream's `confidence-calibrator.ts` + benchmark harness extend the same
pattern.

## Program record

All PI-delivered items are committed on
`feat/pi-1-product-intelligence-execution-boundary`:

- PI-5 `bcd0bbc` — policy gateway, immutable snapshots, decision audit
- PI-9 `2021905` + `204dc4e` — golden-set evaluation, telemetry, rollout gates
- PI-10 `c8e9f29` — model-call provenance consumption, run inspection/replay
- PI-11 `d7bad48` + layers 5–8 — deterministic extraction ladder, browser
  capture, interaction, managed fallback, narrow LLM extraction

GitHub issue #17's checkboxes are updated by the issue owner; per project
constraint, this repository commits no issue writes.
