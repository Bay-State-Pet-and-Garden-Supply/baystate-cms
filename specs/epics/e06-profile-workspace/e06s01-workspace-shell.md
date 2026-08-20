<!-- story: e06s01 -->

# e06s01 — Dedicated Profile Workspace shell — domain-scoped page at /settings/domains/:domain/profile with header, readiness rail, and navigation

## Story
- **ID:** e06s01
- **Epic:** e06 (Brand Domain Profile Workspace + Guided Setup)
- **Status:** planned
- **BCPs:** 5
- **Type:** feat
- **Risk:** P1
- **Context:** domain + frontend + onboarding pipeline coordination
- **Slice:** Workspace shell — no extraction/LLM logic, only navigation, header state, readiness derivation, and builder consolidation.

## Context
Branding onboarding is fragmented: brand, domain, sitemap index and extractor profile live in separate places. The current editor is an inline form inside the Sitemaps & Brand URLs / Extractor Profiles tables plus two divergent builder surfaces (`ProfileBuilder` inline/modal in `OnboardingSettings.tsx:837`/`Onboarding.tsx:831` and `ProfileBuilderWorkspace.tsx` overlay). Operators can queue `official_page` items with no profile and only learn late via `job-queue.ts:1631` late failure. This story creates the dedicated, domain-scoped workspace route ` /settings/domains/:domain/profile` as the single place that answers "for brand X on domain Y do I have everything to extract?" — with brand associations, profile version, freshness, and blocked-item count — and replaces the inline/modal editors.

Purpose: provide the navigable shell other e06 stories fill (guided setup, LLM build, test matrix + gate).
Callers: Onboarding batch flow, domain inventory, brand checklist, extraction blocker tasks, pipeline items (each links into the workspace).
Contracts: domain normalization (`lowercase + strip www + strip scheme/path`), `brand_url_index` as indexed-product source (not `product_pages`), `extractor_profiles` per-domain, parked `setup_required_profile` count.

## Narrative
As an **operator** (internal power-user), I want a **dedicated full page** per domain's extractor profile — at `/settings/domains/:domain/profile` — that shows brand associations, active version, sitemap/index freshness, and blocked-item count, with a **6-step readiness rail** and preserved return context, so that I stop hunting across tables/modals and can tell at a glance whether a domain is ready to extract without pasting URLs.

## Requirements

#### ADDED: Dedicated domain-scoped route /settings/domains/:domain/profile
Workspace is a full page, not drawer/modal/overlay. URL is domain-scoped; brands are associations rendered in breadcrumb/header (multiple brands may share one domain). Return context preserved via query state (e.g. `?return=...`). Inline table form and modal entry points are retired for this domain; they redirect or link into the workspace.

#### ADDED: Workspace header with domain, brand associations, active version, freshness, blocked count
Header derives server-side from `extractor_profiles` (active version + `updatedAt` surrogate until immutable versions in e06s04), `brand_url_index` freshness/count, and `setup_required_profile` parked-item count. Shows canonical domain, associated brands, active version label, sitemap/index freshness (last_sitemap_refresh), and "unblocks N products" blocked count.

#### ADDED: Hono GET /api/domains/:domain/profile-state and repo accessor
New read path `GET /api/domains/:domain/profile-state` returns the header/readiness state. Backed by a repo accessor that joins `extractor_profiles`, `brand_url_index` counts, and parked-item count with domain normalization applied once. No new writes.

#### ADDED: Navigation wiring from all four entry points
Domain inventory table, brand/domain checklist, extraction blocker task ("Build profile for example.com — unblocks N"), and pipeline item (official_page needing profile) each link to `/settings/domains/:domain/profile?return=...`. Deep links land without a second render.

#### ADDED: Left readiness rail with 6 steps and state machine
Steps: 1) Official domain verified, 2) Product URLs indexed, 3) 3 representative products confirmed, 4) Draft generated, 5) Required tests pass, 6) Human approval/activation. States: `Not configured · Draft · Needs testing · Ready for approval · Active · Degraded`. State derived server-side from profile presence/completeness, index freshness/count, confirmed-suite presence (e06s02), and version health (e06s04). Unknown steps render as not_configured, never as silent success.

#### ADDED: Evidence-rail placeholder + history shell and builder consolidation
History section lists immutable version shells (actor/model/config, diffs, activation/rollback events) — populated fully in e06s04 but shell renders empty state now. Single builder path: consolidate divergent `ProfileBuilderWorkspace` overlay vs `ProfileBuilder` modal/inline into one builder rendered inside the workspace; no drawer/modal regression.

#### ADDED: Legacy redirect / alias preservation
Historical `?settingsTab=profiles|sitemaps` values that previously landed on separate tabs map to the brand hub / workspace navigation so bookmarks keep working during rollout (shell respects alias before initializing).

## Acceptance Criteria (Gherkin — §17)

```gherkin
Feature: Dedicated Profile Workspace shell

Scenario: Operator opens workspace from domain inventory
  Given a domain example.com registered in brand_url_index with 42 product URLs
  When operator clicks the domain row's "Open profile" action
  Then browser navigates to /settings/domains/example.com/profile
  And header shows domain "example.com", associated brands, active version (or "Not configured"), index freshness, and blocked-item count
  And readiness rail shows Step 1 verified and Step 2 indexed
  And return query param preserves caller return path

Scenario: Workspace replaces inline form and modal
  Given operator previously reached profile editing via OnboardingSettings inline form or Onboarding modal
  When they follow any profile edit entry point
  Then no inline form or modal builder is rendered
  And the dedicated page is the sole editor surface

Scenario: Header state is server-derived and normalized
  Given requests for WWW.EXAMPLE.COM and https://www.example.com/path
  When GET /api/domains/:domain/profile-state is called with either variant
  Then both resolve to normalized domain example.com and return identical header state

Scenario: Readiness reflects Degraded when active profile needs re-validation (no grandfather)
  Given a legacy mutable active profile existing before this increment
  When profile-state is fetched before re-validation via 3-sample gate
  Then readiness rail renders Degraded / Needs testing (not silent Active)

Scenario: Query return context preserved
  Given operator entered workspace from pipeline item with return=/onboarding?batch=42
  When they use workspace "Back" or close
  Then navigation returns to the caller path stored in query state without nesting modals
```

## Solution (§5) — Steps
### Story e06s01: Workspace shell — Implementation Steps

**type:** feat
**risk:** P1
**context:** domain + Hono route + React shell
**Context:** Creates the domain-scoped full page and server-derived header/readiness contracts that e06s02–e06s04 fill. No LLM or activation-gate logic in this slice.

## Steps

1. Create route /settings/domains/:domain/profile with domain normalization helper and return-context via query state; retire inline table form in OnboardingSettings and modal in Onboarding for this path → verify: bun run typecheck && bunx vitest run src/tests/unit/profile-workspace-route.test.ts src/tests/unit/domain-profile-state.test.ts 2>&1 | tail -n 30
2. Implement Hono GET /api/domains/:domain/profile-state + repo accessor joining extractor_profiles, brand_url_index counts/freshness, and setup_required_profile parked count; ensure normalization applied once → verify: bun run typecheck && bunx vitest run src/tests/unit/domain-profile-state.test.ts 2>&1 | tail -n 30
3. Implement left readiness rail (6 steps) with state machine Not configured → Draft → Needs testing → Ready for approval → Active → Degraded derived server-side; wire header deriving brand associations, active version, freshness, blocked count → verify: bun run typecheck && bunx vitest run src/tests/unit/profile-readiness.test.ts src/tests/unit/profile-workspace-header.test.ts 2>&1 | tail -n 30
4. Add evidence-rail placeholder + history section shell (empty-state + version shell) and consolidate builders — single builder inside workspace, remove ProfileBuilderWorkspace overlay divergence, no drawer/modal regression → verify: bun run typecheck && bunx vitest run src/tests/unit/profile-workspace.test.ts 2>&1 | tail -n 30
5. Wire four entry points (domain inventory, brand checklist, blocker task, pipeline item) to link to /settings/domains/:domain/profile?return=... and handle legacy settingsTab alias redirect before state init → verify: bun run typecheck && bunx vitest run src/tests/unit/profile-workspace.test.ts src/tests/unit/profile-workspace-route.test.ts 2>&1 | tail -n 30

## Verification Script (Step-by-Step)

1. `bun run typecheck` — workspace route and API types green.
2. `bunx vitest run src/tests/unit/profile-workspace-route.test.ts src/tests/unit/domain-profile-state.test.ts` — normalized domain resolves identically for www/scheme/path variants; GET returns header state.
3. `bunx vitest run src/tests/unit/profile-readiness.test.ts src/tests/unit/profile-workspace-header.test.ts` — readiness rail renders all 6 steps with correct states and blocked count.
4. `bunx vitest run src/tests/unit/profile-workspace.test.ts` — single builder renders inside workspace, no inline form/modal regression, evidence rail + history shell present.
5. Manual: add brand Acme + domain acme.com → index → click domain inventory → lands at /settings/domains/acme.com/profile → Back returns to caller via query state; legacy ?settingsTab=profiles redirects.

## Out of Scope (§18)
- Guided confirm-3 flow and candidate/confirmed distinction (e06s02)
- LLM task buttons and per-field governance (e06s03)
- Test matrix, activation gate, immutable versions, park/release (e06s04)
- Sourcing/Discovery heuristic redesign; full pipeline board/Curation/Review/Promotion overhaul; external merchant RBAC; product_pages changes; open-ended chatbot

## Constraints (§6)
- Reuse, never duplicate: brand_url_index/sitemap inventory, extractor_profiles, onboarding-work parked-item path, PI boundary not needed in shell.
- Domain normalization canonical: lowercase, strip leading www., strip scheme/path before all reads.
- Runtime: Bun 1.3.5, TS 5.9, Hono 4, React 19/Vite 6, SQLite bun:sqlite; keep `bun run typecheck && bunx vitest run && bun run test:db` green; CI skips lint (advisory).
- Never hardcode credentials; no raw SQL outside repos; preserve unknown ShopSite fields; redact logs via multipart-upload.

## Risks
- Divergent builders re-introduced — mitigate with single render path test and route redirect guard.
- Domain normalization drift between client/router/repo — mitigate with shared helper and cross-variant unit test.
- Premature gate logic creep — keep e06s01 to shell + header derivation only; gate/version tests belong to e06s04.

## Traceability
- story: e06s01
- SCOPE: specs/product/SCOPE_LATEST.yaml in_scope e06s01
- epic: specs/epics/e06-profile-workspace/epic.yaml
