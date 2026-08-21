<!-- story: e08s03 -->

# e08s03 — Parity-gated cleanup — Distributors infra-only and tab routing

## Story

As an operator who has verified the Brands Hub editor works, I want the Distributors tab to show only connection infrastructure (and the Brands tab to be the single place for brand routing) so that configuration is no longer split-brain and the tab names match their responsibilities.

## Context

e08s01 delivered the audit grid, e08s02 moved the write path into the Brands Hub and fixed the round-trip. The old Advisory Brand Profiles form still exists in `DistributorConnectionsPanel` (intentionally, for parity). This parity-gated cleanup removes it only after prove-create/edit/delete works from the Hub, and finalizes `OnboardingSettings` tabRegistry copy/routing so Brands = Strategy Hub, Sitemaps = raw inventory, Distributors = Connection Infrastructure. Single-store singleton workspace enforcement is finalized here.

Depends on: e08s02 (parity proven). Provides: split-brain resolved, tab responsibilities crisp.

## Business Narrative

Operator has edited three brands in the Brands Hub and confirmed `GET /api/onboarding/brands/strategy` reflects all changes. They open Settings → Distributors and now see only Distributor Connections (API keys, scraper health, enable/disable) with a note: *Brand routing moved to Settings → Brands*. The Brands tab header reads *Brands & Sourcing Strategy Hub* and the Sitemaps tab still shows raw domain inventory. No re-typing from Preflight is needed in v1 beyond the Hub.

## Requirements

### REMOVED: Advisory Brand Profiles form from DistributorConnectionsPanel — parity-gated

**Before:** `src/client/components/onboarding-settings/DistributorConnectionsPanel.tsx` renders the advisory form (brand, aliases, preferredDistributorIds) at the bottom below connector CRUD.
**After:** (removed) — form deleted, leaving only Distributor Connections (list, create, health, enable/disable, secretConfigured). Removal is gated: only after `e08s02` tests prove Brands Hub create/edit/delete round-trips sourcingPolicy. The panel's empty-state copy points to *Settings → Brands* for brand routing.

### MODIFIED: OnboardingSettings tabRegistry — Brands = Strategy Hub, Distributors = Connection Infrastructure

**Before:** `OnboardingSettings.tsx` renders `SitemapHealthView` for both `sitemaps` and `brands` tabs (brands header *Domain Sitemap & Profile Hub*), and `DistributorConnectionsPanel` includes advisory form.
**After:** `primaryOnboardingSettingsTabs()` returns `brands` label *Brands & Sourcing Strategy Hub* (or *Brands*), `sitemaps` label *Sitemaps & Brand URL Index* (raw inventory), `distributors` label *Distributors — Connections* with subtitle *Connection infrastructure for Sourcing (ADR 0014)*. `OnboardingSettings.tsx` renders `BrandStrategyView` for `brands`, `SitemapHealthView` for `sitemaps`, and infra-only `DistributorConnectionsPanel` for `distributors`. Domain normalization stays single-point (lower+strip www+strip scheme/path at repo boundary).

### ADDED: Single-store singleton workspace finalization — fail-closed diagnostic

- Import the singleton helper from e08s01 (`src/db/repositories/workspace-singleton.ts`) into remaining distributor paths that still derived workspace ad-hoc. Any legacy code path that would union multiple workspace rows now returns the singleton or fail-closed 409 with listing of ids. Client never sends workspace. No migration — existing `workspace_id` columns remain but are singleton-partitioned.

## Acceptance Criteria (Gherkin — §17)

```gherkin
Feature: Distributors infra-only and tab routing

  Scenario: Advisory form removed only after parity
    Given e08s02 tests prove Brands Hub create/edit/delete with sourcingPolicy round-trip
    When Settings → Distributors is opened
    Then DistributorConnectionsPanel shows only Distributor Connections (no advisory form)
    And panel copy reads "Brand routing moved to Settings → Brands"
    And no advisory API is called from this panel

  Scenario: Tab labels match responsibilities
    When OnboardingSettings tab bar renders
    Then tabs are [General, Brands & Sourcing Strategy Hub, Sitemaps & Brand URL Index, Distributors, …]
    And Brands tab renders BrandStrategyView (grid with tiers) while Sitemaps tab renders SitemapHealthView raw inventory

  Scenario: Singleton workspace fail-closed
    Given DB has two legacy workspaces
    When any distributor or brand-strategy route is called
    Then response is 409 multiple_workspaces with diagnostic, not unioned rows
```

## Solution (§5) — Steps

### Story e08s03: Parity-gated cleanup — Implementation Steps

1. Delete Advisory Brand Profiles section from `DistributorConnectionsPanel.tsx` (keep connector CRUD, health, enable, secretConfigured); update empty-state copy to point to Brands; ensure no advisory fetch remains in panel → verify: `bunx vitest run src/tests/unit/distributor-connections-panel.test.tsx`
2. Update `src/client/components/onboarding-settings/tabRegistry.ts` labels/subtitles for `brands` / `sitemaps` / `distributors` and `OnboardingSettings.tsx` to render `BrandStrategyView` vs `SitemapHealthView` per tab; verify domain normalization single-point still respected → verify: `bun run typecheck && bunx vitest run src/tests/unit/tab-registry.test.ts src/tests/unit/onboarding-settings.test.tsx`
3. Import and enforce `workspace-singleton` in any remaining distributor/brand-site paths that still called `findWorkspace()`; add branch for fail-closed 409 coverage → verify: `bunx vitest run src/tests/unit/workspace-singleton.test.ts src/tests/unit/distributor-repo.test.ts`

## Verification Script (Step-by-Step)

1. `bun run typecheck` passes.
2. `bunx vitest run src/tests/unit/distributor-connections-panel.test.tsx` — advisory form absent, only connections, pointer copy present.
3. Open `Settings → Brands` — grid with tiers, sitemap, readiness; open `Settings → Distributors` — only connections; open `Settings → Sitemaps` — raw inventory. Tab labels match spec.
4. `bunx vitest run src/tests/unit/tab-registry.test.ts src/tests/unit/onboarding-settings.test.tsx` — tab routing copy correct.

## Out of Scope (§18)

- New Sourcing policies, strict-sequential priority, per-brand retailer edits, BatchPreflight persistence, canonical brands migration.
- Further Sourcing/Discovery heuristic changes.
- Workspace RBAC reintroduction.

## Constraints (§6)

- Parity-gated: removal only after e08s02 prove; keep 409 diagnostic for multi-workspace legacy.
- No new migration; aggregation-only; tier labels Preferred/Fallback; global retailer banner once.
- Reuse existing repos and inventory services.

## Risks

- Operators who bookmarked Distributors advisory form deep link may not find it — tab copy must direct them to Brands clearly.
- Singleton enforcement may surface legacy multi-workspace 409 for first time — needs actionable diagnostic.

## Traceability

- SCOPE: e08s03 — Parity-gated cleanup
- planning-context key_decisions: strip Distributors to infra-only, singleton global, tab routing finalization
- files: src/client/components/onboarding-settings/DistributorConnectionsPanel.tsx, src/client/components/OnboardingSettings.tsx, src/client/components/onboarding-settings/tabRegistry.ts, src/db/repositories/workspace-singleton.ts
