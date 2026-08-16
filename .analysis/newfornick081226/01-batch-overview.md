# Batch Analysis: NEWFORNICK081226

Batch id: `2df53d50-fe8f-4d90-847a-cfdfc2cc6311` · Workspace id: `5d0e7adf-9e7f-4e23-a59e-267cfd775d0b`
Analyzed (UTC): 2026-08-16T06:39 (read-only; server live on :3030)

---

## 1. Batch row (onboarding_batches, all scalar fields)

| field | value |
|---|---|
| id | 2df53d50-fe8f-4d90-847a-cfdfc2cc6311 |
| workspace_id | 5d0e7adf-9e7f-4e23-a59e-267cfd775d0b |
| name | NEWFORNICK081226 |
| file_name | NEWFORNICK081226.xlsx |
| status | **active** |
| total_items | 148 |
| completed_items | 0 (DB column) |
| failed_items | 0 (DB column) |
| column_mapping_json | `{"name":"DESCRIPTION1","nameMergeWith":"DESCRIPTION2","upc":"SKU_NO","price":"LIST_PRICE","quantity":"QUANTITY_ON_HAND"}` |
| created_at | 2026-08-16T02:58:45.769Z |
| updated_at | 2026-08-16T02:58:45.769Z |

API `/api/onboarding/batches/:id` (server-derived, newer than DB columns): `completedItems: 0`, **`failedItems: 14`** (derived from items at extraction/failed), `skippedItems: 0`, status `active`.

## 2. Item distribution (this batch, 148 items)

### stage × stage_status
| stage | stage_status | count |
|---|---|---|
| review | pending | 66 |
| sourcing | needs_input | 49 |
| discovery | completed | 17 |
| extraction | failed | 14 |
| curation | pending | 2 |
| **total** | | **148** |

### status column
All 148 items still carry `status = imported` — per-item pipeline progress lives in stage/stage_status, not the legacy status column.

### source_type breakdown
| source_type | count |
|---|---|
| official_page | 80 |
| distributor_record | 68 |

### duplicate / existing-SKU
- `is_duplicate = 0` for all 148 items.
- `existing_sku` empty for all 148 (no catalog matches found).

### retry / policy / claim
- retry_count: 0 for all 148 (no retries attempted).
- sourcing_entry_policy_version: 1 for all 148.
- claimed_by: empty for all 148 (nothing currently claimed by a worker).

## 3. Work-state projection (server-owned, GET /api/onboarding/batches/:id)

| category | count |
|---|---|
| processing | 0 |
| needs_attention | **80** |
| waiting_on_family | 2 |
| ready_for_review | **66** |
| approved | 0 |
| ready_to_export | 0 |
| completed | 0 |
| skipped | 0 |
| **total** | **148** |

Sanity check (exact numeric identity): `needs_attention 80 = sourcing/needs_input 49 + discovery/completed 17 + extraction/failed 14`; `waiting_on_family 2 = curation/pending 2`; `ready_for_review 66 = review/pending 66`. So **discovery/completed and extraction/failed both project to needs_attention** (operator must confirm/repair before automation can continue). Zero items are approved/exported/completed — nothing has left the pipeline yet.

## 4. Source-type × stage detail

| source_type | stage | count | meaning |
|---|---|---|---|
| distributor_record | review | 66 | merchandising-depth materialization (URL-null, profile-free) — straight to review |
| distributor_record | curation | 2 | held behind family readiness barrier |
| official_page | sourcing | 49 | needs_input (conflicts/fallbacks/manual) |
| official_page | discovery | 17 | URLs discovered, awaiting operator go-ahead to extract |
| official_page | extraction | 14 | extraction failed |

- **80 official_page** items all went through Sourcing → Discovery → Extraction; none reached curation yet.
- **68 distributor_record** items (46%) skipped Discovery/Extraction entirely and are at the review boundary (66) or held in curation (2).

## 5. Families / cohorts (curation_cohorts × curation_cohort_members)

- **All 148 items** are members of product-family cohorts (grouping_version `product-family-v1`).
- Non-superseded cohort status: **55 ready**, **72 waiting**, 1+ superseded (regrouping churn during the run — ~32 superseded cohorts show the family grouping was recomputed repeatedly as members moved/failed; this is normal run-time churn, not a defect).
- Waiting blocked reasons:
  - "Member failed in Extraction (SKU: …)" — 10 cohorts name specific failed SKUs (e.g. Butcher's Pup 6279874810xx, Fromm 0727051134xx, Churu 8951350009xx).
  - "Waiting for 1 family member to finish Extraction" — 58 cohorts.
  - "Waiting for 2 family members to finish Extraction" — 4 cohorts.
- The 2 curation/pending held items (both `distributor_record`):
  - PET ARMOR EXTEND FLEA/TICK COLLAR DOG SM (upc 073091052180) — held by a waiting family (1 member in extraction).
  - NYLABONE POWER CHEWLIMITED CHKN XS (upc 018214856511) — held by a waiting family (2 members in extraction).
  - Both show `claimed_by = ''` but `updated_at` refreshing every ~2s (06:39:30) — the worker is actively re-holding them (claim → release → re-claim churn, silent by design after the last refinement).

## 6. Timing

- created_at: all items 2026-08-16T02:58:45.769Z (single bulk import).
- updated_at: min 03:01:03.391Z → max 06:39:02.270Z.
- Analysis time: 06:39:04Z. Per-stage staleness:

| stage | last updated | idle since | verdict |
|---|---|---|---|
| sourcing/needs_input (49) | 03:27:40 | **~3h 11m** | stalled — waiting on human (needs_input) |
| discovery/completed (17) | 03:35:50 | ~3h 04m | stalled — waiting on operator to confirm/advance |
| extraction/failed (14) | 03:37:57 | ~3h 01m | stalled — failures need remediation |
| review/pending (66) | 04:06:14 | ~2h 33m | stalled — waiting on review approval |
| curation/pending (2) | 06:39:30 | — (active) | actively held; not stuck |

**146 of 148 items have been static in their current stage for 2.5–3+ hours.** The only live activity is the worker's 2-second poll re-holding the 2 barrier members.

## 7. Top-5 observations (what the store owner should know right now)

1. **Nothing has been promoted/exported yet** — approved=0, ready_to_export=0, completed=0. The batch is fully loaded but has not produced a single store-ready product.
2. **80 of 148 items (54%) need the operator's attention** — 49 sourcing conflicts/manual holds, 17 discovered URLs awaiting go-ahead, 14 extraction failures. All official_page items are blocked behind human decisions.
3. **14 extraction failures are compounding through the family barrier**: the failed items (concentrated in Butcher's Pup frozen foods, Fromm, Churu, Better Bone, Lazy Dog, Wellness, Three Dog Bakery) hold 72 waiting families (58 waiting on 1 member, 4 on 2, 10 naming failed SKUs) — the failures stall *successful* siblings, not just the failed products.
4. **The 66 review/pending items (45%) are ready now** — all distributor_record materializations sitting since ~03:28–04:06. The fastest path to first output is to review/approve these; they need no scraping and no URL.
5. **Batch is otherwise healthy**: 0 duplicates, 0 existing-SKU collisions, policy version 1 everywhere, no retry churn, no stuck *worker* (the 2 held items are being re-held correctly). The bottleneck is human throughput (attention queue + review), not automation.

---

*Read-only analysis; no repo or DB writes performed. DB: storage/catalog/.shopsite-cms/app.db (sqlite3 -readonly). API: GET-only on :3030.*
