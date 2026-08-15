# Distributor Scrapers Migration Plan

**Status**: ratified via product-owner grill session (2026-08-15). Decisions recorded in ADR 0014 **Amendment B**; terms in `CONTEXT.md` (`Distributor Scraper`, updated Sourcing entry). This plan is the implementation handoff.

## Goal

Re-implement the six BayStateApp distributor scrapers as TypeScript connectors in the CMS sourcing engine. Uploaded products are scanned against distributors first; a qualified hit skips Discovery **and** provides merchandising-depth data (not just identity) so Curation has enough to work with.

## Ratified decisions (do not re-litigate)

1. **Architecture**: in-process TS connectors implementing the existing `DistributorConnector.lookupByGtin` contract. No Python sidecar.
2. **Scope**: all five — `orgill`, `pet_food_experts`, `phillips_storefront`, `bradley`, `central_pet`. Phillips/BCI REST `api` connectors stay registered; enablement per-connection (ops). **Amazon is excluded** — it is a retailer/marketplace, not a distributor; sourcing remains distributor-scoped.
3. **Data depth**: merchandising-depth materialization (description, features, category, dimensions, case_pack, unit_of_measure, ingredients, image URLs display-only). **Price/inventory excluded. URL stays null.**
4. **Connector type**: new closed-set member `html_scraper` (CHECK-constraint migration + shared Zod schema + client types + registry keyed `(connectorType, distributorId)`).
5. **Auth**: crawlee `SessionPool`, cookies memory-only (`persistCookiesPerSession: false`), `LoginAutomationConfig` constants, JSON credentials in `api_keys`; one re-login then durable `source_error`; redacted logging.
6. **Engine map**: Playwright for login/JS (orgill, phillips_storefront, PFX, central_pet); Cheerio for static extraction (orgill, phillips_storefront, PFX, bradley + browser fallback). `retryOnBlocked`, rate limits, origin allowlists, deadlines/AbortSignal. No proxies v1.
7. **Selectors**: typed code constants with fallback chains. No runtime config surface.
8. **Tests**: offline fixture HTML snapshots + recovered TEST_SKUs + ground-truth field expectations; env-gated live smoke script (no credentials in CI).
9. **Rollout**: land all five **disabled**; tiers: (1) bradley, central_pet → (2) orgill, pet_food_experts, phillips_storefront; each tier observe → manual → automatic per `docs/runbooks/sourcing-engine-rollout.md`.
10. **Superseded**: Orgill/PFX SFTP deferral, Central Pet EDI 832 exclusion (as primary transports). `ftp_catalog`/`csv` types remain for future catalog distributors.

## Migration sources (BayState repo)

- Live Python adapters: `apps/scraper/scrapers/approved_sources/adapters/{orgill,phillips,bradley,pet_food_experts,central_pet}.py` — field logic, search URL templates, selectors, auth configs (`auth.py`: `ORGILL_LOGIN`, `PHILLIPS_LOGIN`, `PFE_LOGIN`), anti-bot (`anti_bot.py`).
- Deleted legacy YAML archive (selector fallbacks + workflows): git commit `5619f6a4^`, path `apps/scraper/legacy-scraper-archive/configs/*.yaml` + `agents/scraper-config-builder/references/`.
- Test SKUs: `tests/live/test_all_adapters_live.py` / `run_adapter_test.py` — orgill `755625321923`, bradley `001135`, central_pet `38777520`, phillips `072705115310`, PFX `33011808`.
- Old catalog metadata: `apps/web/lib/approved-sources/distributor-catalog.ts` (domains, asset domains, allowedFields per distributor).

## Implementation outline

- **M1 Connector type + schema**: `html_scraper` in `SOURCING_CONNECTOR_TYPES`, migration (PRAGMA-guarded CHECK), `shared/schemas/distributor.ts`, `client/onboarding-api.ts`, registry mapping + `FixedConnectorRegistry` tests.
- **M2 Scraper core**: shared crawlee runner module (session pool, deadline/signal plumbing, origin allowlists, response caps, retry/backoff), `LoginAutomationConfig` types + recovered constants, JSON credential parsing in `secret-resolver.ts` (typed shape for `html_scraper`).
- **M3 Connectors tier 1** (bradley, central_pet): Cheerio/Playwright extraction, field maps per old adapters, fixture snapshots + unit tests.
- **M4 Connectors tier 2** (orgill, pet_food_experts, phillips_storefront): login flows, session handling, fixture snapshots (incl. auth-failure fixtures) + unit tests.
- **M5 Materializer Amendment B**: expand `buildDistributorExtractionData` merchandising fields (extraction_method v2 marker, provenance per field), keep conflict scope identity-only; update projection/materializer tests.
- **M6 Live smoke tooling**: `scripts/sourcing-live-smoke.ts` (port of `run_adapter_test.py`), env-gated.
- **M7 Rollout**: connection rows for all five (disabled), tiered enablement per runbook gates, observe-mode verification with TEST_SKUs.

## Engineering notes

- **Provider IDs**: `phillips` (REST) vs `phillips_storefront`; `bci` (REST) vs `bradley` — evidence provenance must disambiguate; reconciler merges both when enabled.
- **Crawlee storage**: reuse the extraction-worker pattern (`preload/crawlee-storage.mjs`, per-run dirs, purge-on-start); sessions must NOT persist cookies to disk.
- **Conflicts**: merchandising fields merge with per-field provenance and never trigger hard conflicts; identity-critical set unchanged.
- **Amazon**: out of scope (retailer/marketplace, not a distributor) — no connector, no evidence tier, no anti-bot machinery.
- **Fixture provenance**: every fixture HTML snapshot records source URL + capture date; ground truth = old adapters' expected extracted fields for the TEST_SKUs.

## Residual risks

- Distributor site markup drift (mitigated: fixture tests + live smoke + code-reviewed selector changes).
- ASP.NET/SFCC login fragility (mitigated: success/failure indicators, one re-login, observe-mode verification).
- Rate limits/lockouts on auth-gated sites during batch imports (mitigated: session reuse, rate limiting, per-connector budgets).

## Implementation status (2026-08-15)

All milestones M1–M7 are **implemented and reviewed** per the implementation plan
(`docs/plans/distributor-scrapers-implementation-plan.md`): the `html_scraper`
connector type + independent `distributor_html_scraper_schema_version`
migration, the five Crawlee-based connectors (bradley, central_pet, orgill,
pet_food_experts, phillips_storefront) with provenance-stamped offline
fixtures, the memory-only session/auth core, the v2 merchandising-depth
projection/materializer with v1 compatibility, cohort/classification/
curation/promotion consumers, the env-gated live smoke tool, the 14-test
offline acceptance chain, and the documented disabled-row checklist. M8
(tiered operator activation) is an operator-run rollout and is NOT an
implementation-time action. Remaining known baseline: five pre-existing
cohort-freeze OCR-authority test failures (verified failing at HEAD before
this work; out of scope).
