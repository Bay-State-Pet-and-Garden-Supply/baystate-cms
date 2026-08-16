# Pipeline Health & Quality Report — Batch NEWFORNICK081226

- Batch: `2df53d50-fe8f-4d90-847a-cfdfc2cc6311` (name `NEWFORNICK081226`, file `NEWFORNICK081226.xlsx`)
- Created: 2026-08-16T02:58:45Z, status `active`, 148 items, single batch in the whole DB
- Analysis time: ~2026-08-16T06:43Z (≈3.7h after import)
- Source types: 80 `official_page` (expected from spreadsheet/brand hints), 68 `distributor_record`

---

## 1. TELEMETRY (GET /api/onboarding/metrics — global scope)

| Metric | Value | Derivation |
|---|---|---|
| automationCompletionRate | 0.4459 (66/148, minus skipped) | exact |
| attentionVolume | 80 items | exact |
| attentionRateByReason | source_conflict 49 (61.3%), verify_official_url 17 (21.3%), extractor_profile_required 14 (17.5%) | exact |
| attentionResolutionTime | n/a | not_available (no durable needs_input entry timestamp; requires future event capture) |
| productsCompletedFromDistributorOnly | 1.0 (66/66 automation-finished items) | exact |
| productsRequiringOfficialSite | 0 (breakdown: distributor_record 66/share 1.0, official_page 0) | exact |
| extractorProfileBlockRate | 0.175 (14/80 attention) | exact |
| extractorProfileDomainUnblockCount | 0 operations | exact |
| familiesWaitingCount | 2 items | exact |
| familyWaitDurationHours | 1.068h mean across 55 ready cohorts (ready≈final updated_at) | approximation |
| cohortCurationSuccessRate | n/a | not_available (no terminal cohort run yet) |
| productsReadyForReview | 66 | exact |
| reviewThroughputProductsPerMinute | 0 (0 reviewed over ~220 min; floor, not measured rate) | approximation |
| reviewEditRate | 0 (invalidated/reviewed) | approximation |
| bulkApprovalSuccessRate | 0 | approximation |
| exportSuccessRate | 0 (0/14 change sets pushed workspace-wide; in-flight not failures) | exact |

Note: all derivation markers are honestly labeled; the three `not_available`/`approximation` values are correctly documented in their notes.

## 2. DISCOVERY OUTCOMES (17 discovery/completed items)

- All 17 have **0 selected/verified sources** (`source_url` empty) despite 2–10 candidate URLs each (15 of 17 have exactly 10 candidates) → all sit in `verify_official_url` attention awaiting human selection.
- Candidate quality is weak: top confidence for a sample item was **0.6875** (shop.dogkrazy.com), with candidates dominated by **retailer/distributor domains** (shop.dogkrazy.com, theproperpet.com, shop.barkandluv.com, pacificpet.net, burlopet.com, net32.com, zeiglersdist.com, pood.bluepetfood.eu) — no obvious official brand page ranked highly. This is why the engine could not auto-verify.
- **Observability gap:** `onboarding_discovery_runs` is **empty for the entire DB (0 rows)** and all 302 `onboarding_sources` rows for this batch have `discovery_run_id = NULL` — no persisted run/trace records for discovery despite candidates being written. Evidence-chain traceability for discovery appears not implemented on this path.
- Candidate methods: serper_upc (275 rows), serper_name (27), sitemap_name (20 — includes the 7 selected rows elsewhere).

## 3. CURATION (2 curation/pending items)

- Held by the **family readiness barrier** (legacy barrier, not cohort-curation v2 — no terminal cohort runs):
  - PET ARMOR EXTEND FLEA/TICK COLLAR DOG SM (`073091052180`) — cohort `3c98842a…` waiting: "Waiting for 1 family member to finish Extraction"; blocker: PET ARMOR LG still `sourcing/needs_input`.
  - NYLABONE POWER CHEWLIMITED CHKN XS (`018214856511`) — cohort `fe572233…` waiting: "Waiting for 2 family members to finish Extraction"; blockers: NYLABONE MD + XL still `sourcing/needs_input`.
- Both updated by the worker's hold logic at 06:42:56Z (last poll). These are correct barrier holds — their siblings must clear sourcing+extraction first.

## 4. REVIEW (66 review/pending items)

- **`onboarding_review_state` has ZERO rows for this batch** → 0 reviewed, 0 approved, 0 invalidations. All 66 items await human review (queue is untouched).
- All 66 are `distributor_record` source type (Amendment-B merchandising materializations — URL-null, no profile/fetch needed).
- Arrival window: 03:28:58Z → 04:06:14Z; longest item has waited ~2.6h with zero review activity.

## 5. FAMILY / COHORT HEALTH

- 159 cohort rows for the batch: **ready 55 (66 member-rows), waiting 72 (82 member-rows), superseded 32 (49 member-rows)**. Member counts overlap across superseded vs live groupings (197 member-rows > 148 items) because superseded rows are stale re-groupings — expected by design.
- Grouping kind: `deterministic_grouping` / `product-family-v1` (membership_reason_json).
- Family sizes observed: 2–4 members (e.g., BUTCHERS PUP 1LB ×4, NYLABONE CHEWLIMITED XS ×3, most ×2).
- Only 2 families are actively waiting (the 2 curation items above); the rest of the waiting member-rows are items whose siblings are in needs_input/extraction attention.

## 6. CONSISTENCY CHECKS

- **Reconciliation: 66 + 49 + 17 + 14 + 2 = 148 = total_items ✓**
- All stage/status combos are inside the documented operating model: sourcing/needs_input, discovery/completed, extraction/failed, curation/pending, review/pending. **No anomalies in combos.**
- Internal cross-checks: attentionVolume 80 = 49+17+14 ✓; productsReadyForReview 66 = review items ✓; familiesWaitingCount 2 = curation-held items ✓.
- **Anomaly candidates:**
  1. `sourcing_decision_json` for the 49 needs_input items has `"conflicts": []` (empty) yet route = `needs_input_conflict` and warnings describe the hard identity conflicts — the hard conflicts live only in `onboarding_evidence_conflicts` (82 hard/open + 241 soft/open) and the decision's `warnings` array. Schema inconsistency worth surfacing (decision JSON should reference its conflicts).
  2. `onboarding_discovery_runs` empty + `discovery_run_id` NULL on all 302 sources (traceability gap, see §2).
  3. 14 `change_sets` exist workspace-wide while export rate reads 0/14 — batch has nothing approved, so 0 batch exports is correct; the 14 change sets predate the batch (field-audit/catalog work) and are "in-flight, not failures" per the metric note.

## 7. PACE (all items created at import, 02:58:45Z)

| Phase | Completed by | Window from import |
|---|---|---|
| Import | 02:58:45 | 0 |
| Sourcing (148 generations `completed`) | first decision 03:00:30; last sourcing update 03:27:40 | ~29 min |
| Discovery (17) | 03:35:50 | ~37 min |
| Extraction (14 blocked) | 03:37:57 | ~39 min |
| Review arrivals (66) | 03:28:58 → 04:06:14 | ~37 min window |
| Curation (2 held) | still pending (06:42:56 last hold poll) | blocked |
| Human review | none yet | 0 reviewed |

Pipeline moved 66 items to review in ~68 minutes from import, fully automated (distributor-record path). The remaining 82 items are in attention states with no human action taken yet.

## 8. TOP-5 HEALTH OBSERVATIONS

1. **Largest block = sourcing conflicts (49 items, 61% of attention):** all routed `needs_input_conflict` (automatic policy) on hard identity-field conflicts across providers bradley/central_pet/pet_food_experts — e.g., brand "WHOLESOMES" vs "Wholesomes" vs "WholesomesFlavor", weight "3 lb" vs "3.0000 lb". 82 hard + 241 soft conflicts open. These are normalization/labeling differences between distributors, not data corruption; an operator resolve pass or normalization improvement would unblock nearly a third of the batch.
2. **Discovery confidence is low for all 17 (2nd block, 21%):** candidates are retailer pages at ≤0.6875 confidence with no selected source; discovery also leaves **no trace records** (runs table empty, run_id NULL) — flag to engineering.
3. **Extractor profiles are the clean, expected block (14 items, 18%):** "No extractor profile for {domain}" for 7 domains (frommfamily.com ×4, primalpetfoods.com ×3, farmtopaw.ca ×3, and 4 single-domain items). 17 profiles exist but cover none of these domains — building profiles for the 7 domains would release these deterministically.
4. **No human activity yet:** 0 reviewed / 0 approved / 0 exports. The automation delivered 66 ready-for-review products; the operator queue is untouched (~2.6h). Review throughput is a floor of 0 products/min.
5. **Telemetry is honest and internally consistent** — all exact metrics cross-check (80 = 49+17+14; 66 = ready-for-review; 2 = families waiting), and the 3 non-exact metrics carry correct derivation markers + explanatory notes. Nothing looks wrong or missing in values; the only gaps are the two flagged structural ones (discovery trace records, decision-json conflict reference).
