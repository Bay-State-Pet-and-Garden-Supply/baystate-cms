# Batch NEWFORNICK081226 — Failures & Attention Analysis
**Batch:** 2df53d50-fe8f-4d90-847a-cfdfc2cc6311 · 148 items · status=active · created 2026-08-16T02:58:45Z
**Analysis window:** ~3.75h post-creation (snapshot 06:43Z) · **DB:** storage/catalog/.shopsite-cms/app.db (read-only)

## 0. Batch state at a glance (all 148 items accounted for)
| stage/status | count | source_type | meaning |
|---|---|---|---|
| review/pending | 66 | distributor_record | automation-finished, awaiting operator review |
| sourcing/needs_input | 49 | official_page | hard conflicts — operator must decide |
| discovery/completed | 17 | official_page | URL found — operator must verify (verify_official_url attention) |
| extraction/failed | 14 | official_page | missing extractor profile |
| curation/pending | 2 | distributor_record | family barrier hold (siblings stuck in sourcing) |

**Totals reconcile:** 66+49+17+14+2 = 148. No stuck/unknown states. No failed item lacks an error message.

---

## 1. EXTRACTION FAILURES (14/14 = 100% one signature)
Every failure is: `No extractor profile for <domain> — profile required`, `retry_count=0` (no auto-retry — correct, since the fix is a human action).

| domain | items | items in batch needing that profile |
|---|---|---|
| frommfamily.com | 4 | 4 |
| farmtopaw.ca | 3 | 3 |
| primalpetfoods.com | 3 | 3 |
| mypetshoponyonge.ca | 1 | 1 |
| shop.allpetsconsidered.com | 1 | 1 |
| torontopets.ca | 1 | 1 |
| woofmeownh.com | 1 | 1 |

**Error taxonomy:** missing-profile 14/14 (0 HTTP/parse/timeout failures). **Extractor profiles on file:** 17 profiles exist (chewy.com, petco.com, stellaandchewys.com, instinctpetfood.com, etc. — all pre-existing test/earlier work) but **NONE** covers any of the 7 domains above. Profile Builder is the prescribed unblock.

## 2. SOURCING NEEDS_INPUT (49/49 = hard conflicts, all manual)
- Decision payload: `route=needs_input_conflict`, `origin=automatic_policy`, `schemaVersion=2`, `sourcing_entry_policy_version=1` on all 148 items. Sourcing is enabled in **automatic** mode; hard conflicts are always routed to the operator.
- **323 conflict rows** for the batch (all `open`, none resolved): 241 soft + **82 hard**.
- **Every one of the 49 items has ≥1 HARD conflict.** Hard fields: `weight` (43), `brand` (31), `packCount` (8). Soft fields: images (49), distributorSku (49), name (48), description (43), category (37), casePack (9), unitOfMeasure (3), ingredients (3).
- Evidence attempts: 740 total across providers — found 183 (bradley 82, central_pet 38, phillips_storefront 36, pet_food_experts 20, orgill 7); not_stocked 376; **source_error 181** (timeout 110, auth_failed 71). pet_food_experts alone: 122 errors/148 attempts; phillips_storefront 57 errors/148.
- Classification of WHY each waits: 49/49 = **hard conflict** (durable, open). Zero manual-mode holds, zero no-evidence fallbacks at needs_input (those would have been `fallback_to_discovery`).

## 3. REVIEW STATE
- `onboarding_review_state` for this batch: **0 rows**. Nothing reviewed, nothing approved, nothing invalidated. The 66 distributor_record items sit in the review drawer untouched.
- Telemetry agrees: `reviewThroughputProductsPerMinute=0`, `bulkApprovalSuccessRate=0`, `reviewEditRate=0`.

## 4. ATTENTION-READY SIGNALS (80 of 148 items = 54% need human judgment NOW)
Telemetry `attentionVolume=80`, exact derivation:
| attentionReason | items | human action |
|---|---|---|
| source_conflict | 49 | resolve hard conflicts (Use distributor record / Continue to Discovery) |
| verify_official_url | 17 | verify discovered official pages |
| extractor_profile_required | 14 | build profiles / release domains |

Plus: 66 ready-for-review (operator review+approve), 2 curation/pending held by family barrier (families whose siblings are the 49 sourcing items). **Blocked-on-automation: 0.** `extractorProfileDomainUnblockCount=0` (no domain release yet performed).

## 5. BUG-OR-EXPECTED
| outcome | verdict | reasoning |
|---|---|---|
| 14 missing-profile extraction failures | **EXPECTED** | ADR-required behavior: official_page sources need an extractor profile; human builds via Profile Builder; no auto-retry is correct |
| 49 needs_input hard conflicts | **EXPECTED** | Durable hard-conflict resolution; conflicts always manual even in automatic mode; conflicts materialize in onboarding_evidence_conflicts (241 soft + 82 hard, all open) |
| Family barrier holds (2 curation/pending + cohort churn) | **EXPECTED & WORKING** | Supersede chains recorded `Member failed in Extraction (SKU: …)` progressively; familyWaitDuration 1.07h mean; barrier held families until extraction finished/failed |
| 17 verify_official_url | **EXPECTED** | Humans own URL verification per operating model |
| Provider source_error 181/740 (timeout/auth) | **EXPECTED-operational, worth watching** | Live distributor scraping; pet_food_experts 122 errors and phillips_storefront 57 errors starve evidence — may inflate conflicts for UPCs only those providers stock |
| 0 stuck items; 0 empty error messages; distributor_record items URL-null (68 = 66+2, verified) | **EXPECTED** | Amendment B materialization; pipeline quiesced into human-wait states |

## 6. FINDINGS
### Top-5 actionable (store owner)
1. **Resolve 49 sourcing hard conflicts** (weight 43 / brand 31 / packCount 8) in the sourcing workspace — biggest single block; also unblocks the 2 family-held curation items.
2. **Build extractor profiles for 7 domains** (frommfamily.com, farmtopaw.ca, primalpetfoods.com, mypetshoponyonge.ca, shop.allpetsconsidered.com, torontopets.ca, woofmeownh.com) via Profile Builder → unblocks 14 extraction failures + families.
3. **Verify 17 official URLs** surfaced as verify_official_url attention.
4. **Review + approve the 66 distributor-record products** (nothing reviewed yet after ~3.75h; review throughput 0).
5. **Watch pet_food_experts / phillips_storefront connector reliability** (timeout 110, auth_failed 71 across 181 errored attempts) before trusting their evidence coverage.

### Top-3 suspect-defect findings
1. **`sourcing_decision_json.conflicts` is always `[]` even on `needs_input_conflict` routes** (job-queue.ts automatic-path). The payload looks contradictory (route says conflict, array says none); the truth lives only in `onboarding_evidence_conflicts`. Audit/observability nit — misleads anyone reading the decision JSON directly. Severity: LOW.
2. **Family cohorts whose members ALL reach terminal failure stay `status='waiting'` indefinitely** (e.g., cohort c00f8bb4 "butchers pup frzn sausage" with 4 failed members, blocked_reason records the failures, never supersedes to a terminal state). No items are actually blocked (no curation member exists in those families), so this is state hygiene only. Severity: LOW/cosmetic.
3. **High provider error rates (181/740 attempts = 24% errored)** — pet_food_experts 122/139 errored (timeout-dominated). Not a pipeline bug, but evidence starvation can silently widen conflict/qualification outcomes. Severity: WATCH (data-quality, not correctness).

### Residual risks
- Snapshot is ~3.75h after start; conflict resolution and review actions by the operator will change all 49/66/2 numbers.
- Family-wait telemetry is `approximation` (cohort updated_at) — directionally correct.
- No CI in this repo; all conclusions are from direct read-only DB/API inspection.
