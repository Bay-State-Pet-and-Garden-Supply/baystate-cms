You are reviewing the RESULTS of the first real production batch run through the new onboarding pipeline of **Baystate CMS** (a local Bun+Hono+SQLite CMS for ShopSite stores). Your review will be shared with the store owner/operator, so be concrete and prioritized.

## System context (epic #46 operating model — ADR 0016)

- The pipeline has stages: Sourcing → Discovery → Extraction → Curation → Review → Promotion.
- **Automation owns progression; humans own exceptions.** Sourcing is DEFAULT-ON in `automatic` mode; hard conflicts (brand/weight/packCount identity mismatches across distributor providers) ALWAYS route to `needs_input_conflict` for a human decision (never auto-resolved). No-evidence/provider-error outcomes fall back to discovery (audited).
- `distributor_record` materialization (Amendment B): qualified distributor records skip Discovery/Extraction entirely — merchandising-depth structured data, URL-null, profile-free, straight to the review boundary.
- Official-page sources REQUIRE an extractor profile (CSS selectors per domain, built via the visual Profile Builder) before extraction; without one, extraction fails with "No extractor profile for <domain>".
- A **family readiness barrier** holds curation until every member of a product family clears extraction (all 148 items belong to product-family cohorts; failed/stuck members hold their siblings).
- Operator-facing projections are server-owned; every telemetry metric carries an exact/approximation/not_available derivation marker.

## The data (3 files)

1. `01-batch-overview.md` — batch row, item distribution, server-owned work-state projection, source-type breakdown, family/cohort state, timing/staleness.
2. `02-failures-attention.md` — extraction failure taxonomy, sourcing hard-conflict detail (provider evidence attempt/error counts), review state, attention-ready signals, bug-or-expected verdicts.
3. `03-pipeline-health.md` — full telemetry table (with derivation markers), discovery outcomes, curation holds, review status, consistency checks, phase timing, health observations.

## What to deliver (post the COMPLETE review as ONE final message)

1. **Verdict on pipeline behavior**: does this batch behave consistently with the documented operating model, or is anything a genuine defect? Be specific about each suspect finding and assign severity (BLOCKER/HIGH/MEDIUM/LOW/WATCH):
   - `sourcing_decision_json.conflicts` is `[]` on all 49 `needs_input_conflict` routes while durable hard conflicts exist in `onboarding_evidence_conflicts` (82 hard + 241 soft, all open).
   - `onboarding_discovery_runs` has 0 rows and all 302 `onboarding_sources` rows have `discovery_run_id = NULL` (no persisted discovery trace records) despite candidates being written.
   - Provider evidence errors: 181/740 attempts errored (110 timeouts, 71 auth_failed; pet_food_experts 122/139 errored, phillips_storefront 57/148).
   - Family cohorts whose members ALL terminated in failure stay `status='waiting'` forever (state hygiene only).
2. **Prioritized operator action plan**: order the 4+ human actions (resolve 49 sourcing conflicts, build 7 extractor profiles, verify 17 official URLs, review/approve 66 distributor-record products) by impact/effort, with expected effect on work-state counts.
3. **Throughput assessment**: 146/148 items idle 2.5–3h, 0 reviewed/0 approved/0 exports; automation delivered 66 products to review in ~68 min. Is the bottleneck human throughput or pipeline design? What 2–3 product changes would most improve throughput (e.g., conflict normalization, batch review UX, profile pre-seeding)?
4. **Telemetry review**: are the metrics + derivation markers sound? Anything misleading or missing?
5. **Risks & next-batch recommendations**: what should change before/at the next import?

Keep it actionable and honest — flag uncertainty where the data cannot support a conclusion.
