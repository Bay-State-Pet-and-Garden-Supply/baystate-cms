<!-- story: e08s01 -->

# e08s01 — Vertical audit slice — Brand Strategy projection + minimal Brands grid

## Story

As an operator who audits brand strategy before the next spreadsheet import, I want to open **Settings → Brands** and see every brand's identity, sourcing tier, official domain, and readiness in one grid — including distributor-only brands and ambiguous matches — so that I stop hunting two tabs and know immediately what will happen at import.

## Context

Settings is split-brain: `SitemapHealthView` (domain-keyed) shows sitemap inventory but zero distributor routing; `DistributorConnectionsPanel` hides the only Advisory Brand Profile editor (aliases + `preferredDistributorIds` + `sourcingPolicy`) below connector creds. `BatchPreflightModal` already does unified Brand+Domain+Distributor setup per batch, but there is no persistent brand-level audit surface. This tracer-bullet delivers the **projection + minimal grid** without yet moving the editor — it proves the join is correct and surfaces distributor-only / unmatched rows. Depends on: e07 not required for minimal grid; governed readiness enrichment waits for e07s04 (handled in e08s02).

Depends on: SCOPE_LATEST `in_scope` e08s01, planning-context aggregation-only constraint. Provides: `BrandStrategy` endpoint and minimal `BrandStrategyView` skeleton consumed by e08s02.

## Business Narrative

Operator imports a spreadsheet with 30 products spanning 6 brands. Before clicking Import, they open Settings → Brands. The grid shows: Fromm — Preferred tier Phillips + Fallback Bradley, `frommfamily.com (142 URLs, fresh)` + governed readiness `Active`; Butcher's — `No official site configured` + `Profile bypass eligible when distributor evidence qualifies`; Three Dog — `⚠ Ambiguous: matches "three dog" and "threedog"`; plus one unmatched distributor-only row. No Distributors tab was opened. The operator now knows which brands are distributor-only and which need profile work, without re-typing Preflight.

## Requirements

### ADDED: GET /api/onboarding/brands/strategy view-model — aggregation projection

- New service `src/onboarding/brand-hub/view-model.ts` (or `brand-strategy-service.ts`) exposes `listBrandStrategies(): BrandStrategy[]` where each `BrandStrategy` = `{ brandKey: string, normalizedBrand: string, aliases: string[], preferredDistributorIds: string[], sourcingPolicy: 'advisory'|'preferred_then_fallback'|'preferred_only', fallbackTier: string[], officialDomains: Array<{ domain: string, sitemap: { totalUrls, freshCount, lastRefreshAt, freshness: 'fresh'|'stale'|'missing'} }>, extractorReadiness: 'active'|'degraded'|'draft'|'needs_testing'|'not_configured'|'profile_bypass_eligible', ambiguous: Array<{ candidateBrand, reason }>, unmatched: boolean }`.
- Join is **exact normalized-brand authority**: `brand_name` lower+trim (`brand-site-repo` contract) exactly equals `brand_advisory_profiles.brand` lower+trim (`distributor-repo` runtime uses case-insensitive, but authority is exact). Aliases are advisory metadata only — runtime sourcing does NOT consult `aliases_json`; they are shown but not used for matching.
- Non-authoritative diagnostics: if `normalizeBrand(a)` with conservative comparison (lower+trim, collapse whitespace, strip punctuation) matches multiple advisory rows or a brand_sites row without exact advisory match, surface as `ambiguous` / `possible_match` diagnostic with reason — never silently join. Unmatched distributor-only brands (advisory without brand_sites) and domains without advisory both appear as explicit rows.
- No migration. Reads `brand_sites`, `brand_advisory_profiles` (or `brand_advisory_profiles` via `distributor-repo`), `extractor_profiles` / `domain-profile-state-repo`, `brand_url_index` via `sitemap-inventory-service`. Writes delegate to existing repos.
- Globally presented but persisted under **server-derived singleton workspace ID**: route derives workspace via `getServerSingletonWorkspace()` (single row, ordered by `created_at`, fail-closed if >1 legacy rows exist — return 409 with diagnostic). Never union historical workspaces, never accept client workspace input. `aliases_json` remains advisory.

### ADDED: Brands tab minimal grid — BrandStrategyView skeleton

- New component `src/client/components/brand-strategy/BrandStrategyView.tsx` (or `src/client/components/onboarding-settings/BrandStrategyView.tsx`) rendered in `OnboardingSettings.tsx` under `settingsTab === 'brands'`. Replaces raw domain-only `SitemapHealthView` list for that tab; `Sitemaps` tab keeps raw `SitemapHealthView` inventory.
- Columns: **Brand Identity** (`brandKey` + alias pills), **Sourcing tier** (`Preferred tier: Phillips, Bradley` / `Fallback tier: Central Pet` or `All Enabled` when advisory `sourcingPolicy === 'advisory'` and no preferred), **Official Domain & Sitemap** (`frommfamily.com (142) fresh` or `No official site configured`), **Extraction Readiness** (`Active / Degraded / Draft / Needs testing / Not configured` + conditional `Profile bypass eligible when distributor evidence qualifies` for distributor-only / eligible rows).
- Tier pills use **Preferred tier / Fallback tier** labels, never sequential `[1]->[2]` numbering (runtime is tiered-concurrent: preferred tier concurrent, fallback conditional). `All Enabled` maps to no preferred list.
- Empty states: distributor-only rows show `No official site configured`; ambiguous rows show `⚠ Ambiguous` badge with diagnostic reason; unmatched rows are not hidden.

### ADDED: Global retailer denylist banner — read-only

- `src/onboarding/discovery/retailer-domain-list.ts` is global code policy. In `BrandStrategyView`, render **once** as a page-level banner: `Global retailer denylist active — discovery will not persist provisional domains on these hosts`, with count of denylisted hosts. Never per-row, never editable. No per-brand override.

### MODIFIED: Single-store global contract — no client workspace input

**Before:** `distributor-routes` derive workspace from request or first row unordered (`findWorkspace()`), and `brand_advisory_profiles` are keyed by `workspace_id`.
**After:** `GET /api/onboarding/brands/strategy` and advisory reads use server singleton workspace; if >1 legacy workspace rows exist, fail closed with diagnostic (not union). Client never sends `workspaceId`. Existing `workspace_id` columns remain but are treated as singleton-partitioned, not legacy read-only ignored.

## Acceptance Criteria (Gherkin — §17)

```gherkin
Feature: Minimal Brands audit grid

  Scenario: Audit shows tier, domain, and distributor-only
    Given brand "Fromm" has advisory { preferredDistributorIds: ["phillips","bradley"], sourcingPolicy: "preferred_then_fallback" } and brand_sites { domain: "frommfamily.com" } with sitemap 142 fresh
    And brand "Butcher's" has advisory without brand_sites
    When GET /api/onboarding/brands/strategy is called
    Then response contains Fromm row with sourcingTier "Preferred tier: phillips, bradley / Fallback: central_pet" and domain "frommfamily.com (142 fresh)" and readiness derived from domain-profile-state
    And response contains Butcher's row with domain "No official site configured" and extractorReadiness "profile_bypass_eligible"
    And opening Settings → Brands shows both rows without opening Distributors

  Scenario: Ambiguous / unmatched surfaced, not silently joined
    Given brand_sites has "three dog" and advisory has "threedog" (whitespace difference)
    When GET /api/onboarding/brands/strategy is called
    Then result contains an ambiguous diagnostic for "three dog" listing candidate "threedog" with reason "whitespace-normalized match"
    And no silent merge occurs — both normalized keys appear as distinct rows or one row with explicit ambiguous badge

  Scenario: Retailer banner once, not per-row
    When BrandStrategyView renders
    Then a single global banner states retailer denylist active
    And no row contains a per-brand retailer authority control

  Scenario: Singleton workspace fail-closed
    Given distributor db has two legacy workspace rows
    When GET /api/onboarding/brands/strategy is called
    Then response is 409 with code "multiple_workspaces" and diagnostic listing workspace ids
```

## Solution (§5) — Steps

### Story e08s01: Vertical audit slice — Implementation Steps

1. Add `src/onboarding/brand-hub/brand-strategy-service.ts` (or extend `view-model.ts`) — join `listBrandSites()` + `listBrandAdvisoryProfiles()` (singleton workspace) + `listExtractorStates()` via `domain-profile-state-repo` + `brand_url_index` via `sitemap-inventory-service`; implement exact normalized authority + possible_match diagnostics; expose `BrandStrategy` Zod schema in `src/shared/schemas/brand-strategy.ts` → verify: `bun run typecheck && bunx vitest run src/tests/unit/brand-strategy-view-model.test.ts`
2. Add Hono route `GET /api/onboarding/brands/strategy` in `src/server/routes/onboarding-routes.ts` (or `brand-strategy-routes.ts`) with singleton workspace guard and 409 multiple_workspaces handling; wire service; add zod response validation → verify: `bunx vitest run src/tests/unit/brand-strategy-routes.test.ts`
3. Create minimal `BrandStrategyView.tsx` with columns (Brand Identity, Sourcing tier Preferred/Fallback, Official Domain & Sitemap, Extraction Readiness with profile-bypass-eligible wording) plus empty states and ambiguous badges; render from `OnboardingSettings.tsx` brands tab (keep Sitemaps tab as raw `SitemapHealthView`) → verify: `bunx vitest run src/tests/unit/brand-strategy-view.test.tsx`
4. Add global retailer banner (read-only) reading `retailer-domain-list.ts` count → verify: `bunx vitest run src/tests/unit/brand-strategy-view.test.tsx` — banner-once assertion
5. Add singleton workspace helper `src/db/repositories/workspace-singleton.ts` (`getServerSingletonWorkspace`) and replace ad-hoc `findWorkspace()` in strategy path; add branch coverage for multi-workspace fail-closed → verify: `bunx vitest run src/tests/unit/workspace-singleton.test.ts`

## Verification Script (Step-by-Step)

1. `bun run typecheck` passes.
2. Seed two brands in test DB: `fromm` with advisory + brand_sites domain, `butchers` advisory-only; `bunx vitest run src/tests/unit/brand-strategy-view-model.test.ts` — asserts tier pills, distributor-only row, ambiguous diagnostics.
3. `bunx vitest run src/tests/unit/brand-strategy-routes.test.ts` — GET returns BrandStrategy[] with normalized keys, sourcingPolicy preserved, multiple_workspaces 409 when seeded.
4. `bun run dev`, open `Settings → Brands` — grid shows Fromm + Butcher's rows, global retailer banner once, no Distributors nav required.
5. `bunx vitest run src/tests/unit/brand-strategy-view.test.tsx` — asserts column presence, tier label not sequential, profile-bypass wording.

## Out of Scope (§18)

- Moving Advisory editor into Brands Hub (e08s02) — this slice is read-only audit.
- SourcingPolicy round-trip write fix and engine org-fanout fix (e08s02).
- Governed readiness drill-in details and Profile Workspace deep links beyond badge (e08s02).
- Distributors tab cleanup and parity-gated removal (e08s03).
- New canonical brands table, per-brand retailer edits, strict-sequential priority, BatchPreflight persistence.

## Constraints (§6)

- Aggregation-only, exact normalized-brand authority, never silently join; no migration.
- Singleton workspace persisted, never union legacy rows; fail-closed on >1.
- Preferred/Fallback tier labels, not sequential numbers; All Enabled maps to no preferred.
- Profile bypass is conditional runtime eligibility, not permanent brand property.
- Retailer denylist global read-only, banner once.

## Risks

- Conservative exact match may still surface many ambiguous rows for noisy brand strings — diagnostics reduce confusion but don't canonicalize; follow-up alias cleanup is operator-driven.
- Singleton guard may surface 409 in legacy installs with multiple workspaces — diagnostic must list ids and actionable next step (consolidate workspaces).
- Joining four sources (sites, advisory, extractor state, sitemap) risks stale reads if sitemap-inventory-service freshness lags — show lastRefreshAt.

## Traceability

- SCOPE: e08s01 — Vertical audit slice
- planning-context key_decisions: aggregation, tiered org-rank, singleton global, governed readiness, minimal slice
- ADRs: 0014 (tiered, org vs connection), 0017 (brand → domain | distributor_record | retailer_page)
- files: src/onboarding/brand-hub/view-model.ts, src/server/routes/onboarding-routes.ts, src/client/components/brand-strategy/BrandStrategyView.tsx, src/client/components/OnboardingSettings.tsx, src/db/repositories/workspace-singleton.ts, src/onboarding/discovery/retailer-domain-list.ts
