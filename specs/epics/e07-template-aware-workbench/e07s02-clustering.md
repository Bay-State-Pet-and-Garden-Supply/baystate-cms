<!-- story: e07s02 -->

# e07s02 — Conservative template clustering + representative suggestion — path+DOM verifier-filtered auto-suggest with operator override

## Story

As an operator indexing a brand's sitemap, I want the workspace to auto-group product pages into templates and suggest representatives covering each template so that confirming 3+ reps actually proves extraction across the domain, not just one template.

## Context

Sitemaps yield 100s-1000s of product URLs (brand_url_index, page_type=product). Today the operator picks 3 arbitrarily from a flat list; path-cluster/variant signals promised in e06s02 never shipped. Live spike showed earthanimal.com 3/3 cleanly clusters to /products while acmepet.com spam must be filtered before suggestion. Depends on e07s01's evidence contract; provides cluster coverage input for matrix in e07s03-s04.

## Business Narrative

After discovery, the SuitePanel shows Found (e.g., 6562) and Confirmed with freshness. The panel now also shows conservative clusters (e.g., /products (3) with tag shingle preview) and a Suggested reps row (one per cluster plus an edge variant). The operator confirms or overrides (merge/split cluster, swap a rep) — the choice persists and the waiver path remains when <3 verified URLs exist. The suggestion never includes a 404/spam URL.

## Requirements

### ADDED: Template-aware clustering

- Cluster on (templateAwarePrefix + DOM fingerprint). templateAwarePrefix strips slug/ID: /products/:slug → /products, /product/:id → /product, /p/:x → /p, /collections/all/products → /collections/all/products (kept distinct from /products). DOM fingerprint = tag+class shingle Jaccard, threshold 0.8 conservative + same-prefix guard; cross-prefix never merges even if Jaccard high.
- Source corpus is brand_url_index product URLs where page_type=product and active=1; candidate set is read via sitemap-inventory-service. Clustering runs server-side and returns { prefix, count, fingerprint, suggestedUrl, variantIds }.

### ADDED: Verifier filter before suggestion

- Before clustering suggests reps, each candidate URL is filtered by page-verifier / sitemap-health (reachable, not parked, not 404) and optionally a lightweight static fetch HEAD check. Hosts like acmepet.com that return identical length / spam h1 are excluded (length dedupe + h1 entropy check). Filtered items are not counted in Suggested reps but remain in Found.

### ADDED: Auto-suggest covering each cluster/variant/edge

- One suggested rep per cluster + one extra suggestion when a cluster contains variant options (e.g., size/color param or /collections grouping). Suggestion maximizes coverage: at least one per cluster, up to 10, prioritizing most recent last_sitemap_refresh_at and most distinct DOM. Suggestion is advisory — suite remains operator-confirmed.

### ADDED: Operator confirm/override persistence

- Confirming a suggestion writes to domain_representative_suite (existing table) with confirmed_by + added_at. Override actions (merge two clusters into one suggested rep, split a cluster, replace suggestedUrl) are persisted as a small cluster-overrides table { domain, clusterKey, action, actor, at } so reruns respect the override.
- Waiver when <3 verified URLs after filtering: reason >=8 chars + actor + hash persisted as domain_profile_waiver (existing), still gates activation.

## Acceptance Criteria

```gherkin
Feature: Cluster-aware representative suggestion

  Scenario: Clusters group templates
    Given domain "example.com" has 5 URLs: 3 at /products/* with similar DOM and 2 at /product/* with similar DOM
    When clustering is run
    Then 2 clusters are returned (/products with 3, /product with 2)
    And suggested reps contain one from each cluster

  Scenario: Spam is filtered
    Given candidate "acmepet.com/products/x" returns static length 75799 for two URLs with spam h1
    When suggestion is run
    Then that URL is excluded from Suggested reps
    And reason is verifier-filtered (not counted toward <3 waiver threshold as valid)

  Scenario: Operator override persists
    Given /products and /collections/all/products were suggested as separate clusters
    When operator merges them into one rep and confirms
    Then rerunning clustering still shows the merged override (not 2 suggestions)
    And domain_representative_suite reflects the merged choice
```

## Solution — Steps

1. Add server helper src/onboarding/template-clustering.ts implementing templateAwarePrefix + fingerprint + Jaccard + verifier filter.
2. Extend GET /api/domains/:domain/representative-suite to return { clusters, suggested, filtered } alongside existing suite.
3. Add small migration for cluster_overrides table.
4. Update SuitePanel to render clusters, Suggested reps row, confirm/override actions, and filtered count explanation.
5. Unit tests for prefix stripping, Jaccard threshold, spam filter.

## Verification Script

1. `bunx vitest run src/tests/unit/template-clustering.test.ts` — prefix, Jaccard, merge guard, spam dedupe.
2. `bunx vitest run src/tests/unit/sitemap-inventory-service.test.ts src/tests/unit/page-verifier.test.ts`
3. `bun run typecheck && bunx vitest run src/tests/unit/profile-workspace.test.ts` — suggestion renders and persists.

## Out of Scope

- Capture/recipe ranking — e07s03.
- Workspace consolidation / deletions — e07s04.
- External indexing or Sourcing changes.

## Traceability

- SCOPE: e07s02 — Conservative template clustering + representative suggestion
- spike: earthanimal /products clustering + acmepet spam filtered
- files: src/onboarding/template-clustering.ts, src/onboarding/sitemap-inventory-service.ts, src/db/repositories/brand-url-index-repo.ts, src/onboarding/page-verifier.ts, src/client/components/profile-workspace/SuitePanel.tsx
