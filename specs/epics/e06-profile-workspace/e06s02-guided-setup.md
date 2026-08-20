# e06s02 — Guided brand → domain → index → confirm 3 products — sitemap inventory, candidate/confirmed distinction, and waiver

<!-- story: e06s02 -->
> Epic: e06 Brand Domain Profile Workspace + Guided Setup
> Status: planned | BCPs: 5 | Risk: P0 (critical — gating for activation, data provenance)
> Type: feat | Context: domain

## 1. Business narrative

New-brand setup is fragmented across brand, domain, and sitemap index concerns and a missing Domain Extractor Profile is only surfaced late in Extraction as a scattered `failed` item. Operators routinely advance Discovery→Extraction without knowing the domain has no healthy profile, and there is no single domain-task or candidate/confirmed distinction to guide representative-product selection. This story stitches the upstream into one guided flow surfaced inside the Profile Workspace and introduces a candidate/confirmed harness with an explicit waiver for sparse domains.

## 2. Actors

- **Operator (internal admin/power-user)** — adds/selects brand, assigns guarded official domain, triggers sitemap index refresh, confirms representative products, provides waiver attestation when required.
- **System (workspace + sitemap inventory)** — enforces guards, exposes `brand_url_index` inventory, persists confirmed suite and waiver provenance, computes readiness/freshness.

## 3. Preconditions

- `brand_url_index` repo and `sitemap-routes` inventory exist (tech-stack.md).
- Brand-site domain guards (brandUrlIndex / domain-config-service) exist and remain authoritative for official-domain assignment.
- Epic e06 workspace shell (e06s01) provides the full-page route `/settings/domains/:domain/profile` and its return-context mechanism (query state) — this story wires its upstream section into that shell rather than re-implementing routing.

## 4. Postconditions

- Workspace upstream section shows domain verification, index freshness, candidate vs confirmed products, the 3-product requirement, and waiver state.
- A persistent confirmed suite (3–10) per domain is stored with artifact provenance; waiver (when present) is auditable.
- Readiness rail reflects whether the upstream gate is satisfied for downstream build/test (e06s03/e06s04).

## 5. Solution and main flow

The guided flow is presented as the upstream panel/section of the domain-scoped Profile Workspace at `/settings/domains/:domain/profile`:

1. Operator adds or selects a brand, then assigns its **guarded official domain** (reuse existing brand-site guards; no new domain heuristic). Domain verification status is shown inline.
2. Workspace triggers or reflects **sitemap discovery/index** and surfaces product inventory from `brand_url_index` filtered to `page_type=product` via existing `sitemap-routes`. Freshness (last indexed at, product count) is shown.
3. Inventory is rendered with a **candidate vs confirmed** distinction: candidate = sitemap-only row, confirmed = operator-confirmed product (user explicitly confirms correct product page). Path-cluster/variant signals are shown where available.
4. Operator selects **3 representative confirmed products** covering templates/variants/edges when possible (suite persisted per domain, target 3–10). Workspace enforces a minimum of **3 confirmed** unless a waiver is present.
5. When sitemap product count <3, the panel requires an **explicit waiver** (reason text + actor) before the gate can be considered satisfied; waiver provenance is recorded. Activation gate in e06s04 reads this waiver decision.

All of (1)–(5) reuse existing inventory and guard modules; this story adds the workspace wiring, the confirmed-suite persistence/API, and the waiver record — not a new discovery heuristic.

## 6. Key constraints and alternative flows

- **Domain-scoped:** profiles and confirmed suites are per official domain; multiple brands may map to one domain and appear as associations in the workspace header (e06s01) — do not create brand-scoped duplicate state.
- **No product_pages confusion:** `product_pages` (SKU→Category Page) is never an inventory source for this flow; only `brand_url_index` is authoritative for candidate rows.
- **Waiver is the only way below 3:** domains with 0–2 product URLs cannot satisfy the upstream gate without an operator-waiver artifact (reason+actor+hash). Silent threshold lowering is prohibited.
- **Freshness is advisory, not authoritative for health:** sitemap freshness informs the operator but does not imply Profile Health; health is determined separately from confirmed same-domain product samples and extraction evidence (tracked in e06s04).
- **Alternative — no product URLs:** panel shows empty inventory, freshness indicator, and prompts Refresh index / waiver path; downstream Generate draft (e06s03) and activation (e06s04) remain blocked.
- **Alternative — waiver present:** gate permits 1–2 confirmed products; history records waiver-bound activation separately.
- **No Sourcing/Discovery redesign:** distributor fallback and global discovery heuristics stay as-is.

## 7. Edge cases

- Sitemap returns zero product rows or transient fetch failure — show stale count + last-success timestamp, allow retry.
- Duplicate/conflicting brand→domain mappings — rely on existing domain guards; workspace surfaces the conflict rather than silently overwriting.
- Candidate rows later reclassified as non-product page_type — confirmed suite entries that lose candidacy become stale but remain in history with a warning.

## 8. NFRs

- No new external dependencies; adds only a lightweight confirmed-suite + waiver table/repo and a workspace panel.
- Server state derivation remains deterministic; no model confidence influences readiness.

## 9. Dependencies

- e06s01 workspace shell (route + header/readiness rail shell)
- `brand_url_index` repo, `sitemap-routes`, domain verification guards
- Downstream consumers: e06s03 (Generate draft needs confirmed samples), e06s04 (Test Matrix + activation gate reads confirmed suite and waiver)

## 10. Assumptions

- Sitemap inventory filtering (`page_type=product`) is heuristics-derived but stored canonically in `brand_url_index`; candidate/confirmed split is the mitigation for imperfect product typing.
- Operators confirm correct product identity (not system inference); confirmed samples are the trust boundary.

## 11. Glossary

- **Candidate** — sitemap-only `brand_url_index` product row.
- **Confirmed** — operator-confirmed product page used as a Profile Validation Sample for health and matrix execution.
- **Waiver** — explicit operator attestation allowing activation with <3 product URLs.

## 12. Requirements

#### ADDED: Guarded brand → official domain wiring surfaced in workspace
Before: Brand/domain assignment lived outside the workspace and domain guards were not surfaced in the profile flow.
After: Workspace upstream panel surfaces brand→guarded official domain assignment (reuse existing guards), domain verification status, and preserves return context via query state.

#### ADDED: Sitemap inventory from brand_url_index with candidate/confirmed distinction
Candidate rows sourced from `brand_url_index` via `sitemap-routes` inventory (filtered `page_type=product`); confirmed rows are operator-persisted per domain. Panel shows candidate vs confirmed, path-cluster/variant signals, product count, and index freshness (last indexed at).

#### ADDED: Persistent 3-representative-product confirmation (3–10 suite)
Workspace persists a per-domain confirmed suite of 3–10 representative products (selected from candidates) covering templates/variants/edges where possible; requires an explicit minimum of 3 confirmed unless a waiver is present. Repo + API enforce persistence and auditability.

#### ADDED: Explicit waiver for <3 product URLs with audit provenance
When sitemap product count <3, workspace requires an operator waiver (reason text + actor + artifact/hash timestamp) before the upstream gate can be satisfied; waiver is recorded immutably and is readable by the activation gate (e06s04), which permits activation with 1–2 confirmed products only when a waiver is present.

## 13. Design notes

Reuse, never duplicate: `brand_url_index-repo`, `sitemap-routes`, domain verification modules, and the e06s01 workspace shell. The confirmed-suite and waiver persistence should be a small domain-scoped table (or extension of existing profile/domain tables) with a repo accessor analogous to existing domain-state accessors — avoid a parallel inventory system.

## 14. Data model

- `brand_url_index` (existing) — source of truth for candidate inventory.
- New: `domain_confirmed_suite` (domain → ordered set of confirmed `brand_url_index` ids/URLs + selection metadata + actor/timestamp) and `domain_profile_waiver` (domain → reason + actor + created_at + artifact hash) — exact table names deferred to implementation but must be per-domain, auditable, and immutable once recorded.

## 15. API

- `GET /api/domains/:domain/profile-state` (from e06s01) includes upstream fields: verification, freshness, productCounts, candidates/confirmed arrays, waiver.
- New or extended: `POST /api/domains/:domain/confirmed-suite` (set suite), `POST /api/domains/:domain/waiver` (create waiver); both workspace-ownership scoped (404 cross-workspace where applicable).

## 16. Security

Existing workspace-ownership model; no new RBAC. Waiver actor is the authenticated operator; audit record is required.

## 17. Acceptance criteria (Gherkin)

```gherkin
Feature: e06s02 guided upstream — brand → domain → index → confirm 3

  Scenario: Upstream panel surfaces verification, freshness, and candidate vs confirmed
    Given an official domain "example.com" with a brand association
    And brand_url_index has product rows for "example.com" indexed within the last hour
    When the operator opens /settings/domains/example.com/profile
    Then the upstream panel shows domain verification status and index freshness
    And product rows are split into candidate (sitemap-only) and confirmed (operator-confirmed) sets
    And sitemap-routes inventory is the source (not product_pages)

  Scenario: Requires 3 representative confirmed products
    Given 10 candidate product URLs for "example.com"
    When the operator confirms 2 products
    Then the workspace indicates upstream not ready (needs 3 confirmed)
    When the operator confirms a third representative product
    Then the upstream gate is satisfied and the confirmed suite is persisted per domain
    And the suite covers templates/variants/edges where distinguishable

  Scenario: Waiver required for sparse sitemaps
    Given sitemap product count is 2 for "tiny.example"
    When the operator attempts to satisfy the upstream gate with 2 confirmed products and no waiver
    Then activation remains blocked
    When the operator submits a waiver with reason text and actor
    Then the waiver is recorded with artifact hash and timestamp
    And the upstream gate is satisfied with 2 confirmed products

  Scenario: Waiver is the only way below threshold
    Given sitemap product count is 1
    When a prior implementation attempts to activate with 1 confirmed product and no waiver
    Then the gate rejects the activation (no silent threshold lowering)

  Scenario: Cross-workspace isolation preserved
    Given a confirmed-suite or waiver request for a domain in another workspace
    Then the server responds 404
```

## 18. Out of scope

- Sourcing/Discovery heuristic redesign and crawler tuning
- Full pipeline board / Curation / Review / Promotion overhaul
- External merchant roles / new RBAC
- Changes to product_pages (ShopSite Category Page assignments)
- Open-ended chatbot UX or direct LLM save/activate paths
- New sitemap discovery engine; this story only wires and surfaces existing inventory

## 19. Risks

- Treating every sitemap row as a product could pollute confirmed suites — mitigated by candidate/confirmed distinction and operator confirmation requirement.
- Variant signals may not surface path clusters correctly — fall back to simple path-prefix grouping and document the limitation in the panel.

## 20. Verification

Verification script (step-by-step):

1. Run `bun run typecheck` — workspace wiring and new repo compile.
2. Run `bunx vitest run src/tests/unit/brand-url-index.test.ts src/tests/unit/sitemap-inventory.test.ts` — inventory sourcing intact, candidate/confirmed split surfaced.
3. Run `bunx vitest run src/tests/unit/representative-suite.test.ts` — 3-product requirement, 3–10 persistence per domain, per-workspace isolation.
4. Run `bunx vitest run src/tests/unit/profile-waiver.test.ts` — waiver required when <3 URLs, provenance (reason+actor+hash) recorded, gate permits 1–2 only with waiver.
5. Open `/settings/domains/:domain/profile` for a domain with 10 candidates — observe upstream panel states (freshness, candidate/confirmed, gate).
6. For a domain with 2 products, submit waiver with reason — observe activation unblocked; without waiver, observe hard block.

## Traceability

- story: e06s02
- SCOPE: in_scope e06s02, constraints (brand_url_index source, 3 confirmed minimum, waiver with reason+actor)
- planning-context: "Indexed products = brand_url_index", "Representative suite = 3 confirmed", explicit waiver decisions
