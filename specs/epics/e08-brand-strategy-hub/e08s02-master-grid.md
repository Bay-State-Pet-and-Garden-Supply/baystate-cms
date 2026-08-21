<!-- story: e08s02 -->

# e08s02 — Vertical management slice — Advisory editor moved into Hub + enrichment

## Story

As an operator who manages brand strategy, I want to create/edit the sourcing policy and distributor preference for any brand directly inside **Settings → Brands** — and immediately see sitemap health and governed extractor readiness with a link to the Profile Workspace — so that I stop editing hidden forms in the Distributors tab and know whether a profile build is needed.

## Context

e08s01 delivers the read aggregation and minimal grid (audit). The write path is still trapped in `DistributorConnectionsPanel` (hidden form below connector creds) and the grid lacks drill-in (sitemap freshness, governed readiness) and Profile Workspace links. `distributor-routes` currently drops `sourcingPolicy` from responses, and `onboarding-api` cannot send it, so the round-trip is broken. This slice moves the editor into the Hub, fixes the round-trip, enriches rows (waits on e07s04 for governed readiness contract), and fixes the engine org-fanout bug that contradicts the documented org preference.

Depends on: e08s01 (audit grid exists), e07s04 (governed readiness + OnboardingSettings ownership). Provides: writable Hub and enrichment consumed by parity-gated cleanup in e08s03.

## Business Narrative

Operator sees Three Dog row as `No official site configured` with `Preferred tier: Phillips`. They click Edit in the Brands Hub, change sourcingPolicy from `advisory` to `preferred_then_fallback`, add Central Pet to fallback, and save. The row updates in place, sourcingPolicy persists, and the engine will now fan out to both Central Pet connections if preferred tier yields no qualified record. They click the row's `Build profile for threedog.com` link and land at `/settings/domains/threedog.com/profile` (profile workspace) because readiness shows `Needs testing`.

## Requirements

### MODIFIED: Advisory Brand Profiles editor moves from Distributors → Brands Hub

**Before:** Advisory form (brand, aliases comma-list, preferredDistributorIds comma-list) lives in `DistributorConnectionsPanel` and submits via `upsertBrandProfile` without `sourcingPolicy`.
**After:** Editor lives in `BrandStrategyView` (inline row drawer or modal) and submits via new `updateBrandStrategy` / `upsertBrandAdvisoryProfile` that includes `sourcingPolicy` (`advisory | preferred_then_fallback | preferred_only`). Distributors tab infra-only (e08s03) is untouched in this story — the old form stays until parity is proven, but the new editor is the canonical surface. Aliases remain advisory metadata (shown as pills, not used for matching).

### MODIFIED: distributor-routes and onboarding-api client round-trip sourcingPolicy

**Before:** `src/server/routes/distributor-routes.ts:161-207` omits `sourcingPolicy` from GET responses; `src/client/onboarding-api.ts:1353-1358,1402-1415` cannot read or submit it.
**After:** GET /api/distributors/brand-profiles (and `GET /api/onboarding/brands/strategy` enrichment) includes `sourcingPolicy`; POST/PUT upsert accepts and persists it via `distributor-repo` (singleton workspace). Client `getBrandProfiles`, `upsertBrandProfile`, `updateBrandProfile` send/receive the enum with Zod validation. No workspace input from client.

### ADDED: Sitemap health drill-in + governed readiness + Profile Workspace link

- Each BrandStrategy row drills into `officialDomains[]` with per-domain `{ totalUrls, freshCount, lastRefreshAt, freshness }` from `sitemap-inventory-service` + `brand_url_index` (page_type=product, active=1). Show `142 URLs · fresh (refreshed 2h ago)` or `stale` with lastRefreshAt.
- Governed readiness from `domain-profile-state-repo` active version + `MatrixResult` evidence (consumes e07s04 contract); badge `Active / Degraded / Draft / Needs testing / Not configured` plus conditional `Profile bypass eligible when distributor evidence qualifies` for distributor-eligible rows. Raw CSS selectors never shown — readiness is governed, not selector-presence.
- Per-domain link `Build profile for <domain> →` navigates via `getProfileWorkspacePath(domain)` to `/settings/domains/:domain/profile`. Distributor-only rows show no domain link, only eligibility wording.

### ADDED: Engine org-fanout conformance fix — distributor org fans out to ALL enabled connections

- `src/onboarding/sourcing/engine.ts:83-92` currently builds `Map<distributorId, connection>` (single entry per distributor) and therefore selects one connection even when a distributor has two flavors (e.g. `phillips` API + `phillips_storefront` html_scraper per ADR 0014 Amendment B which requires both be queried). Fix: group by `distributorId` → `connection[]` and fan out to all enabled connections per org within the tier (preferred tier concurrent, fallback tier conditional). Fallback tier still only runs if preferred tier yields no qualified `distributor_record`.
- Add regression test `sourcing-engine-dual-connector.test.ts`: distributor Phillips has two enabled connections, both are invoked concurrently in preferred tier; fallback tier invocations gated on preferred no-qualified outcome.

## Acceptance Criteria (Gherkin — §17)

```gherkin
Feature: Manage brand strategy in Hub

  Scenario: Create/edit sourcing policy round-trips
    Given Brands Hub shows brand "Acana" with sourcingPolicy "advisory"
    When operator edits Acana to preferredDistributorIds ["central_pet","phillips"] and sourcingPolicy "preferred_then_fallback" and saves
    Then POST /api/distributors/brand-profiles persists sourcingPolicy
    And GET /api/onboarding/brands/strategy for Acana returns the new policy and both preferred ids
    And the grid row re-renders with Preferred tier: central_pet, phillips / Fallback tier: (remaining enabled)

  Scenario: Sitemap and readiness enriched with profile link
    Given brand "Fromm" has domain "frommfamily.com" with sitemap 142 fresh and governed readiness Active via domain-profile-state
    When Brands Hub renders Fromm row
    Then row shows "142 URLs · fresh" and "Active" badge and link "Build profile for frommfamily.com →" to /settings/domains/frommfamily.com/profile
    And clicking the link navigates to profile workspace

  Scenario: Org fanout invokes both connectors
    Given distributor "phillips" has enabled connections "phillips" (api) and "phillips_storefront" (html_scraper)
    And brand "TestCo" prefers ["phillips"]
    When sourcing runs for a product of brand TestCo
    Then both phillips connections are invoked concurrently in preferred tier
    And fallback tier is not invoked if either yields a qualified distributor_record

  Scenario: Editor is canonical, Distributors form still exists until parity
    When operator opens Settings → Brands, edit controls are present
    And Settings → Distributors still shows the old advisory form (parity not yet proven)
    Then both surfaces exist until e08s03 gates removal
```

## Solution (§5) — Steps

### Story e08s02: Management + enrichment — Implementation Steps

1. Fix `src/server/routes/distributor-routes.ts` to include `sourcingPolicy` in list/get and accept it on create/update (Zod `SourcingPolicy` enum) with singleton workspace; add route tests → verify: `bunx vitest run src/tests/unit/distributor-routes.test.ts`
2. Fix `src/client/onboarding-api.ts` (getBrandProfiles, upsertBrandProfile) to send/receive `sourcingPolicy` with validation → verify: `bunx vitest run src/tests/unit/onboarding-api-brand-strategy.test.ts`
3. Move editor into `BrandStrategyView`: row action `Edit strategy` opens drawer with brand, aliases, preferredDistributorIds (multi-select of enabled distributors), sourcingPolicy select; wire to upsert; show tier pills as Preferred/Fallback → verify: `bunx vitest run src/tests/unit/brand-strategy-view.test.tsx`
4. Enrich rows: sitemap drill-in via `sitemap-inventory-service` (total/fresh/lastRefresh) and governed readiness via `domain-profile-state-repo` (active version + evidence) plus Profile Workspace links; guard with e07s04 contract availability → verify: `bunx vitest run src/tests/unit/brand-strategy-view.test.tsx src/tests/unit/sitemap-inventory.test.ts`
5. Fix `src/onboarding/sourcing/engine.ts` org fanout: `Map<distributorId, connection[]>` and fan out to all enabled per org; add dual-connector regression test → verify: `bunx vitest run src/tests/unit/sourcing-engine.test.ts src/tests/unit/sourcing-engine-dual-connector.test.ts`
6. Keep Distributors tab infra-only untouched in this story — verify old form still renders (parity gate for e08s03) → verify: `bunx vitest run src/tests/unit/distributor-connections-panel.test.tsx`

## Verification Script (Step-by-Step)

1. `bun run typecheck` passes.
2. `bunx vitest run src/tests/unit/distributor-routes.test.ts` — sourcingPolicy round-trips, singleton workspace, 409 on multi-workspace.
3. Seed brand "Acana" advisory advisory → edit via Brands Hub to preferred_then_fallback with two preferred; `bunx vitest run src/tests/unit/brand-strategy-view.test.tsx` — editor persists and tier pills update.
4. Seed Fromm domain sitemap 142 fresh + governed Active; open `Settings → Brands` — row shows counts/freshness, Active badge, and Profile Workspace link navigates correctly.
5. `bunx vitest run src/tests/unit/sourcing-engine.test.ts` — dual-connector test asserts both phillips connections invoked concurrently; fallback gated.

## Out of Scope (§18)

- Parity-gated removal of old Distributors advisory form and final tabRegistry routing (e08s03).
- Per-brand retailer edits, strict-sequential priority, new Sourcing policies, BatchPreflight persistence.
- New canonical brands table or workspace RBAC.

## Constraints (§6)

- Editor move preserves exact normalized-brand authority; no silent join; aliases advisory.
- SourcingPolicy enum frozen; no new policies.
- Org fanout fans out to ALL enabled connections per org, tiered-concurrent (preferred → fallback conditional).
- Governed readiness depends on e07s04; do not re-derive from selector presence.
- Keep old Distributors form until parity — e08s03 gates deletion.

## Risks

- Dual-connector fanout doubles concurrent distributor load per preferred org — bounded by enabled connections (typically 1-2 per org); watch for distributor rate limits.
- Editor move must validate distributor ids against enabled distributors only — stale preferred ids (disabled connection) should surface as warning pill, not hidden.

## Traceability

- SCOPE: e08s02 — Vertical management slice
- planning-context key_decisions: move editor into Hub, sourcingPolicy round-trip, governed readiness + org fanout
- ADRs: 0014 (org vs connection, Amendment B dual flavor), 0017 (brand → domain | distributor_record)
- files: src/server/routes/distributor-routes.ts, src/client/onboarding-api.ts, src/client/components/brand-strategy/BrandStrategyView.tsx, src/onboarding/brand-hub/view-model.ts, src/onboarding/sourcing/engine.ts, src/db/repositories/distributor-repo.ts
