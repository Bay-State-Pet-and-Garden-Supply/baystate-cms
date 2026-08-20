# Refactor Plan — Unified Brand Hub for Extractor Profiles + Sitemaps & Brand URLs

<!-- story: e35s10 -->
<!-- References: docs/references/fowler.md — refactoring catalog / code-smell taxonomy; docs/references/kent-beck.md — Tidy First (structural before behavioral) -->

## Current Behavior (Hard Gate — before refactoring)

**What exists today:**

* Onboarding Settings renders four content tabs inside one component with display-none switching: General, Curation, Extractor Profiles, Sitemaps & Brand URLs, Distributors. Two of those tabs own the same domain-centric concept from opposite ends.
* **Extractor Profiles tab** owns the per-domain CSS-selector profile lifecycle (title, price, description, brand, images, custom selectors, variant strategy, runtime, shopify JSON flag, and `sitemapProductUrlPattern`). Creation is via a free-form domain text input that opens the Profile Builder workspace inline. Reads and writes go through an extractor-profile repository backed by the `extractor_profiles` table.
* **Sitemaps & Brand URLs tab** owns the persistent sitemap inventory. It lists one row per normalized domain from brand_url_index/sitemap telemetry via the sitemaps overview API, shows health status (healthy/stale/missing/error/blocked), URL counts (active/product), local hit rate and serper-calls-avoided metrics, filter bar, add-site modal (domain → optional fetch), per-row refresh/remove actions, and a slide-over domain drawer that paginates and searches indexed URLs. Writes go through sitemap/domain/brand-url-index repositories backed by `brand_url_index`, `brand_url_fts`, `sitemap_refresh_history`, and `brand_sites` (brand→domain mapping).
* The two tabs have duplicated domain entry points — Add Site in one place, Open Profile Builder in another — with no single place that answers "for brand X on domain Y, do I have indexed URLs, a healthy sitemap, and a profile that can actually extract?" The sitemap product URL pattern stored on the extractor profile is not visible alongside the indexed URL counts it filters.
* Identity is consistent at the storage layer (normalized domain: lowercase, strip www, strip scheme/path) but split in the UI layer with separate lists, separate search, and separate health signals.

## Why It Is Wrong (Hard Gate)

* **Fowler smells: Duplicated Concept, Split Responsibility, Shotgun Change.** Two views own one domain-centric entity without a shared read-model. Adding a brand correctly now requires touching two disconnected UIs; changing the URL-pattern filtering notion requires reasoning about extractor-profile semantics in one tab and sitemap-enumeration semantics in another.
* **Beck Tidy First violation:** Structural debt is forcing behavioral risk. Operators cannot assess brand readiness at a glance, so they fall back to cross-tab hunting, manual re-entry of the same normalized domain string, and ad-hoc guesses about whether extraction will succeed for a sitemap that already holds thousands of URLs but has no profile. Every new brand multiplies this cost.
* **Cognitive load over cohesion.** The extraction ladder (profile → page) and the discovery ladder (sitemap → brand_url_index → local lookup) share the same anchor — the brand domain / official site — yet the UI suggests they are unrelated capabilities.
* **No single "add brand" narrative.** The current affordances suggest sitemap inventory and selector engineering are independent workflows, so telemetry about one never informs the next step of the other (e.g., a freshly fetched sitemap that should prompt profile creation or re-validation).

## Invariant That Must Be Preserved (Hard Gate)

**Discovery-ladder determinism and zero-cost local retrieval must remain byte-for-byte unchanged.**

Concretely: a high-confidence UPC already indexed in `brand_url_index` for a domain must continue to satisfy Discovery locally and bypass a paid Serper call; sitemap reconciliation must continue to run inside a single transaction that inserts/updates/inactivates rows and keeps `brand_url_fts` in sync; last_seen / last_sitemap_refresh / active / lastmod / page_type bookkeeping, enrichment via `enrichUrlMetadata`, FTS5 ranking fallback, and `sitemap_refresh_history` telemetry must not regress. Extraction read semantics (profile selector resolution per domain, runtime static vs rendered, variant strategy, custom selector metadata) must also remain untouched at the repository level while this refactor composes them.

If this invariant is violated, paid search costs spike silently, staged telemetry drifts from reality, and "local hit rate" metrics lie — the exact observability this refactor intends to make clearer.

---

## Problem Statement

From the developer's perspective: I own two Onboarding Settings tabs that both reason about brand official-site URLs but present them as separate worlds. As an operator I must add a domain in Sitemaps, wait for a fetch, then separately remember to open Profile Builder and re-type the same domain to build selectors, then go back to Sitemaps to verify the URL pattern field that actually lives on the profile. There is no unified brand row that tells me at a glance "purina.com — healthy sitemap with 14k product URLs, mapped to brand Purina, profile missing/incomplete/ready, variant strategy set, last refreshed 3d ago." Adding cross-links between the tabs would help locally but would preserve the split lists, split search/filter state, and the duplicated domain-entry ceremony. I want one Brand Hub inside Onboarding Settings that is domain-keyed, composes extractor profiles and sitemap/brand-URL inventory together around brands, and centralizes the "add/refresh/profile" loop without breaking either ladder's deterministic behavior.

## Solution

From the developer's perspective: Replace the two tabs `Extractor Profiles` and `Sitemaps & Brand URLs` with a single `Brands` (a.k.a. Brand Hub) tab inside the existing Onboarding Settings surface (the smallest viable move per the interview: thin view-model, domain-keyed, unified Add Brand flow, row action navigates to Profile Builder, pattern editable in both hub and builder, legacy tab deep-links redirect, additive schema affordances allowed, hub tests added). Introduce a thin, read-only Brand Hub view-model/service that joins per-domain signals already available from existing repositories — extractor profile presence and completeness, sitemap health/status and refresh timing, brand_url_index counts, brand_sites associations, and telemetry aggregates — without moving ownership of writes away from the original repositories. Keep individual writes where they live today (profile upserts stay in the extractor-profile repo; sitemap reconciliation stays in brand_url_index/sitemap repos) and expose pattern edits through the hub as a delegated call to the same profile upsert path so last-write-wins semantics remain explicit. Provide one Unified Add Brand interaction that normalizes the domain once, optionally fetches/indexes the sitemap immediately, and surfaces a CTA to build or edit the profile. Collapse the two filter/search experiences into one domain/brand search with health and profile-status facets. Keep Distributors, General, and Curation untouched. Make the change structurally first (introduce the view-model, then rewire the tab shell to compose it), behaviorally second (unified add, inline pattern edit, redirect), each slice guarded by typecheck and existing sitemap/profile suites.

## Commits

A plan of tiny, Fowler-style refactoring steps. Each commit leaves the codebase green and independently landable; net behavior change is deferred to the final wiring commits per Beck's Tidy First.

```
1. Extract the hard-gate invariant as executable coverage for the discovery ladder → verify: bun run test:db -t "sitemap"
   - Add or promote one focused suite that locks the current reconcile-then-lookup contract (high-confidence UPC present → serper bypass, reconcile keeps FTS in sync, enrichment idempotent). This is the living specification of the preserved invariant before any structural move.

2. Introduce a read-only Brand Hub overview type that composes per-domain signals → verify: bun run typecheck
   - Define the hub row shape (domain, normalized key, profile presence/completeness, sitemap health/status, URL counts, local hit rate, last refreshed, brand associations, attention reasons, sitemap product pattern) as a pure type with no runtime behavior yet.

3. Add a thin Brand Hub view-model that joins existing repository reads without new writes → verify: bun run typecheck && bun run test
   - Build a service that reads from the existing profile, sitemap, brand-URL, and brand-site sources and returns overview rows keyed by normalized domain; zero mutations, zero new tables, covered by a new unit test with stubbed repos.

4. Add a hub-focused unit test for the join logic (healthy domain with profile vs missing profile vs multi-brand edge) → verify: bun run test -t "brand hub"
   - Verifies domain normalization, FTS-aware count wiring, and profile completeness derivation without touching the UI.

5. Add a brand-hub route/view contract to the shared onboarding schemas → verify: bun run typecheck
   - Expose the hub overview response shape alongside the existing sitemaps overview shape so client and server share one branded type, keeping the legacy sitemaps contract intact.

6. Add a server-side hub overview handler that delegates to the new view-model → verify: bun run test:db -t "sitemap"
   - Wire a handler that returns the same domain inventory the sitemaps overview already returns but enriched with profile presence; legacy /sitemaps overview stays available as an alias to avoid breaking existing clients.

7. Verify legacy sitemap API stays green in parallel with the new hub handler → verify: bun run test:db -t "sitemap-routes"
   - No UI change yet; proves the handler can be called alongside the current routes before the tab shell is touched.

8. Extract the tab shell routing registry from the onboarding settings component → verify: bun run typecheck
   - Pull the tab-id-to-panel mapping into a declarative registry so that adding or retiring a tab is a one-line change rather than a multi-site edit.

9. Render the new "Brands" tab as a parallel, feature-flagged composition of existing panels → verify: bun run typecheck && bun run test
   - Mount a Brands tab that composes the existing sitemap health view and profile builder surface together (stacked composition) without removing the legacy tabs yet, so visual diff is reviewable under a flag.

10. Unify domain normalization through a single shared helper for the hub and both creation flows → verify: bun run test -t "normalize"
    - Replace inline lowercase/strip-www normalizations in the two creation paths with the shared canonical helper so Add Site and Open Profile Builder no longer diverge on edge inputs like www. prefixes or trailing slashes.

11. Replace the duplicated domain creation entries with a single unified Add Brand flow → verify: bun run typecheck && bun run test:db -t "brand"
    - One entry point: normalize once, persist brand_sites mapping when a brand name is supplied, optionally fetch and reconcile the sitemap in the same transaction; creation of the profile remains deferred to the builder (no implicit empty profile row).

12. Make sitemap product URL pattern editable from the hub row and delegate to the existing profile upsert → verify: bun run test:db -t "extractor"
    - Hub inline edit calls the same extractor-profile upsert path as the builder uses, with explicit preserved-merge semantics: explicit null clears, omitted fields preserve, string replaces. Covers the interview decision that pattern is editable in both places with last-write-wins.

13. Change row interaction to navigate to the profile builder instead of expanding inline → verify: bun run typecheck
    - Domain row CTA becomes Inspect / Edit Profile that routes to the existing profile builder workspace with the normalized domain prefilled; no duplicate inline builder state is introduced.

14. Collapse legacy search/filter state into a single domain/brand search with health and profile-status facets → verify: bun run typecheck && bun run test
    - One input filters on domain and brand associations; status and needs-attention filters continue to apply uniformly to the hub list.

15. Retire the legacy tab entries and redirect historical deep-links to the unified hub → verify: bun run typecheck && bun run test
    - Remove the separate Extractor Profiles and Sitemaps entries from the tab bar; map incoming settingsTab values of profiles and sitemaps to brands before state initializes so bookmarks and ?view=onboarding&settingsTab= profiles|sitemaps continue to land on the hub.

16. Remove the feature flag and make Brands the sole brand-URL/profile surface → verify: bun run typecheck && bun run test
    - Delete the temporary flag and dead branches left from the parallel-tab phase; no behavioral change in this commit, purely removing conditionality.

17. Add additive schema affordance only if it measurably helps the hub query (index only) → verify: bun run test:db
    - If the hub overview join shows a query-plan regression, add a narrow covering index on the domain key used by the overview and keep all existing tables/columns unchanged; skip entirely if the current indexes already satisfy the hub reads.

18. Add hub-level characterization tests that guard the new tab shell and unified add flow → verify: bun run test
    - One integration test for the hub overview endpoint returning domain rows with profile enrichment and one component smoke test for the tab shell redirect and unified add modal; existing sitemap/profile suites remain the hard gate.

19. Run the full preflight and validate specs YAML → verify: bun run typecheck && bun run test && bun run test:db && bash scripts/validate-specs-yaml.sh
    - Final green gate before branch landing; proves both ladders unchanged, the unified panel composes, and the redirect/spec contract holds.
```

## Decision Document

Alternatives considered and choices made:

- ** alternatives to a full merge — kept separate with cross-links vs full merge vs data-layer-only merge vs new top-level Brand Hub**
  - Considered cross-linking the two existing tabs without merging lists: lowest risk but preserves split search state, duplicated add ceremony, and the inability to see profile + sitemap health at one glance. Rejected as curing the symptom rather than the concept split.
  - Considered a data-only merge that normalizes the schema behind the scenes while leaving two tabs intact: moves the invariant without improving the operator narrative.
  - Considered a new top-level Brand Hub outside Onboarding Settings: attractive long-term surface but out-of-proportion to the current pain and requires navigation/IA work that belongs to a later epic.
  - Chosen path: replace the two tabs with one `Brands` tab inside Onboarding Settings that composes the existing panels, backed by a thin view-model. This is the minimal structural change that gives one domain-keyed list and one add flow while leaving escape hatches small.

- **UI-only merge vs thin view-model vs full aggregate entity — choose thin view-model**
  - Chosen thin view-model: a read-only join over extant repos that produces a Brand Hub overview row. Ownership of writes stays with extractor-profile and sitemap repos; the hub delegates. This avoids a big-bang repository merger while still giving the hub a single type to render and test.

- **Identity key for the hub — domain-keyed**
  - Domain (normalized: lowercase, strip www/scheme/path) is the natural join key because both profiles and indexed URLs are keyed there; brand associations are rendered as badges per row and every row that has no brand reads as Unassigned. A brand-keyed pivot would obscure multi-brand and unassigned domains.

- **Scope of the unified hub — Profiles plus Sitemaps only**
  - Includes extractor profiles and sitemap/brand-URL inventory and the brand_sites association visible per domain; excludes taxonomy, curation, store settings, distributor connections, and product-intelligence concerns for v1.

- **Modules that will be touched or introduced**
  - Touched: the onboarding settings tab shell and the sitemap/brand-URL and extractor-profile repository consumers. Extractor-profile write semantics stay delegated to the profile repo (explicit null vs omitted vs string merge). Sitemap reconciliation and FTS sync stay untouched in the brand-URL repo.
  - Introduced: a brand-hub view-model/service that joins profile presence/completeness, sitemap health/status, URL counts, local hit rate, last refreshed, brand associations, attention reasons, and the sitemap product URL pattern for overview rendering. No new write repository in v1.

- **Interfaces that will change**
  - Shared onboarding schema gains a Brand Hub overview response type that mirrors the existing sitemaps overview shape with profile enrichment. Server gains a hub overview handler. Onboarding Settings gains a `brands` tab id and deprecates `profiles` and `sitemaps` as primary tab ids (they become aliases/redirects). Client hub state gains unified filter facets that cover health and profile status.

- **Technical clarifications from the interview**
  - Legacy deep-links `profiles` and `sitemaps` redirect to `brands` on load before local state initializes so bookmarks and external links land without a secondary render. The add flow is unified into one domain-normalized entry that optionally fetches the sitemap immediately; an empty extractor profile is not fabricated until the operator opens the builder. The sitemap product URL pattern is owned by the extractor-profile record and editable from both surfaces — builder and hub row delegate to the same upsert with last-write-wins. Row detail navigates to the existing profile builder with the domain prefilled rather than expanding inline.

- **Architectural decisions**
  - Tidy First: structural introduction of the view-model before behavioral rewiring of the add and tab shell. No split-brain writes: the hub never writes `brand_url_index` or `extractor_profiles` except by delegating to the canonical repos, preserving the transactional reconcile and the profile merge semantics. Normalized domain is resolved through one canonical helper rather than ad-hoc inline transforms in two places.

- **Schema changes, API contracts, specific interactions**
  - No behavioral schema migration required for v1. If the hub query regresses, a narrow covering index on the domain key is the only additive schema affordance permitted. API contract: `GET /sitemaps` (legacy) and the new hub overview endpoint return compatible domain-inventory payloads; the legacy route remains as an alias so existing drawer and overview fetches stay green. Interaction contract for pattern edits: HTTP validation rejects absent normalized domain and trims before upsert; enrichment and refresh lifecycle keep its fail-closed handling (invalid or corrupt responses surface as status rather than throwing through the reconcile transaction).

## Testing Decisions

- **What makes a good test for this refactor:** Behavioral seam tests that assert externally observable outcomes — a reconciled sitemap remains locally retrievable by UPC without a network call, a pattern edit issued from the hub is visible when the same domain is opened in the builder, a legacy deep-link lands on the Brands hub, and a unify-add call with fetchNow actually produces active product URLs — without asserting internal composition (whether the hub composes two panels or one join query) or private component state.

- **Which modules will be tested:**
  - The new hub view-model join (domain normalization, profile presence/completeness derivation, multi-brand and unassigned badge wiring, counts/rate passthrough).
  - The sitemap reconciliation and brand-URL lookup seam as the characterization baseline that must stay green before and after.
  - The extractor-profile pattern delegation seam (hub inline edit reaches the same upsert semantics as the builder).
  - The hub overview endpoint and the Onboarding Settings tab shell redirect for legacy settingsTab values.

- **Prior art in this codebase:**
  - Database-backed route and repository suites under `src/tests/unit/` for sitemaps (cache repo, health evaluator, matcher, fetcher, routes including `sitemap-routes`, `source-discovery-sitemap-priority` that asserts zero-cost local hit), and for profiles (`extractor-profiles`, `profile-builder-mapping`, `profile-builder-reducer`, `page-extractor` image/variant tests) — these are the characterization layers to lean on rather than rebuilding bespoke harnesses.
  - Brand-URL index repo tests already assert reconcile/FTS sync/enrichment; brand-site repo tests assert brand→domain mapping, including first-mapping-wins semantics. The hub view-model mirrors this pattern at the joined level.

- **Coverage plan given the current state:**
  - Existing sitemap and profile suites provide meaningful coverage of each ladder in isolation but none yet asserts the unified hub view. The plan therefore keeps those suites as the hard pre-flight gate and adds one focused hub unit suite plus one hub endpoint integration test and one tab-shell smoke test — enough to prove the composition and the redirect without requiring full component-by-component coverage before landing.

## Out of Scope

- Distributor connections and distributor-record sourcing behavior (separate onboarding stage with its own tables, connectors, and ADR-bounded behavior).
- Curation, taxonomy, and product-type / category-page classification — the hub surfaces applicability only insofar as a profile exists; it does not enroll taxonomy reads.
- General store settings (API keys except Serper-key discovery that already feeds sourcing) and product-intelligence Agent Lab concerns (flags, PolicyGateway, executor routing).
- Top-level navigation or a new top-level route outside Onboarding Settings; the hub stays under `?view=onboarding&settingsTab=brands` for v1.
- Moving the canonical ownership of `sitemap_product_url_pattern` away from extractor profiles or merging `brand_url_index` and `extractor_profiles` into a single table — the thin view-model composes rather than re-homes data.
- Extraction worker internals (Crawlee/Playwright/preload) and VLM/packaging OCR concerns.
- Bulk brand import or bulk sitemap refresh orchestration beyond per-domain refresh already offered.
- Design-system or theming overhaul beyond adopting existing hub/tab styling already used in the General Store tokens.

## Further Notes

- **Fowler lens:** The dominant smell to erase is Duplicated Concept / Split Responsibility applied to the brand domain entity; the prescribed refactoring family is Extract Concept → Compose Panels → Move Method to thin view-model, each step tiny and reversible.
- **Beck lens:** Keep structural moves (extract helper, introduce read-model, centralize tab registry) strictly separate from behavioral changes (unify add, edit pattern from hub, redirect legacy tabs) so every intermediate commit stays green.
- **Rollback is one flag and one line:** Until the final retire step, switching back to two tabs is a registry entry plus alias removal; the hub handler can remain as an unused endpoint since it writes nothing.
- **Deferred to a follow-up if operators ask:** Brand-keyed pivot or toggle inside the same hub, bulk actions driven from the unified list, and a post-extraction verification seam that re-scores a profile from live validation samples — each is a behavioral layer that belongs on top of this structural foundation rather than interleaved with it.

## Verify

- `bun run typecheck`
- `bun run test`
- `bun run test:db`
- `bash scripts/validate-specs-yaml.sh`
