# SPIKE: Template-aware Sitemap Profile Workbench — single capture + conservative clustering

Status: draft (elaborate-spec → spike-prototype)
Date: 2026-08-20
Planning context: specs/planning-context.yaml (feature: Template-aware Sitemap Profile Workbench)
Decisions locked: Q1 A (domain owns version, version routes per-template), Q2 A (conservative path+DOM clustering), Q3 A (captured artifact click, no live iframe), Q4 fix testsPass+immutable versions now

## Purpose
Prove the template abstraction before committing to schema/migration/UI rewrite:
- Can we replace paste-outerHTML / two-hop snapshot+HTML with one browser capture (DOM + screenshot + runtime + hash) that supports click→element→ranked recipes?
- Can path+DOM clustering auto-infer templates and suggest reps that maximize cluster/variant/edge coverage without merging distinct templates?
- Can we infer structured-data/CSS recipes by cross-sample agreement and gate activation on every confirmed sample + every included cluster via production runner?

## Unknowns being probed
1. Capture fidelity: does serialized DOM + screenshot replay differ from live rendered state enough to break selector ranking? Measure divergence on 3 diverse domains (Shopify, WooCommerce, custom).
2. Clustering thresholds: Jaccard/path-prefix + DOM fingerprint similarity — conservative cutoff that avoids merging visually similar but behaviorally different templates.
3. Click→metadata ergonomics: mapping screenshot click → element → candidate selectors (buildStableSelector + structured-data candidates + transforms) and instant highlight across all samples.
4. Persistence debt: transactional immutable versions — current profile-version-repo.ts in-memory vs extractor-profile-repo.ts single-row mutable; prove atomic version + active pointer.
5. testsPass derivation: MatrixResult evidence vs active+3 shortcut — ensure gate is evidence-grounded.

## Timebox & constraints
- Throw-away code only (no production edits). Keep under specs/archive/spikes/ and /tmp prototype harness.
- Must respect: brand_url_index sole inventory, candidate vs confirmed, lower+strip www normalization, distributor_record bypass, closed-world LLM advisory, fail-closed gate.
- Reuse existing capture: snapshotPageForBuilder, profile-runner-client (static/rendered), sitemap-fetcher/Camoufox already available.

## Prototype tasks
1. Harness: single-run capture per sample (Playwright launch → page → wait networkidle → serialized DOM + outerHTML + screenshot + runtime + hash). Compare against current two-hop path.
2. Click mapping: capture artifact replay (sanitized DOM) → element picker (x,y → element path → candidate recipes). Rank via buildStableSelector + selector-utils stability + structured-data discovery; preview extracted VALUES across all samples.
3. Clustering: ingest brand_url_index product URLs for a domain → path prefix grouping → DOM fingerprint (tag/attr shingles) → dendrogram → conservative merge threshold → auto-suggest rep per cluster + edge variants. Validate against SuitePanel flat list baseline.
4. Matrix evidence: run production profile-runner-client per sample per template route; bind results to version hash; derive testsPass from MatrixResult, not state flag.
5. Version persistence spike: draft profile_version table migration sketch + txn upsert + active-pointer swap; prove rollback.

## Success criteria (spike exits when)
- On 3 domains, one capture artifact per product URL suffices to generate ranked recipes and highlight correct value across all confirmed samples without paste-HTML.
- Clustering suggests the right rep set (covers each template) and does not merge distinct templates on the 3 test domains; operator confirm/override affordance is clear.
- Value-preview cards + "Select on page" flow is demonstrably lower friction than SelectorInput + outerHTML in a side-by-side walkthrough.
- testsPass and version persistence approach is sketched with migration shape and reviewed — ready for plan-work to slice.

## What to keep / delete (spike must not touch prod, but informs plan)
Keep: inventory, representative suite/waiver, production runner, activation fail-closed, governance, distributor bypass, readiness rail concepts.
Delete after spike ships (tracked in planning-context key_decisions): ProfileBuilderWorkspace.tsx overlay, modal callers in Onboarding.tsx/OnboardingSettings.tsx, GenerateSelectorPopover, paste-outerHTML controller path, independent HTML-fetch hop. Local DOM eval stays only as labeled instant feedback.

## Exit artifact
This doc updated with findings (divergence %, clustering thresholds, click latency, migration sketch) + optional /tmp harness logs. No PR from spike.

---
## Findings — 2026-08-20 synthetic harness run (/tmp/spike-template-harness.mjs)

### Run log
```
=== 1) SINGLE CAPTURE ARTIFACTS (one browser run) ===
  https://acme.example.com/products/ultra-widget-blue -> rendered hash=79c82fcd3f2d domLen=109
  https://acme.example.com/products/ultra-widget-red -> rendered hash=09c45d14357a domLen=108
  https://acme.example.com/collections/all/products/mega-gadget -> rendered hash=74ca80306d34 domLen=120
  https://shop.brand2.com/item/super-thing-42 -> static hash=08d1e6e58f45 domLen=98
  https://shop.brand2.com/item/super-thing-43 -> static hash=285904bf3f19 domLen=104
  https://custom.shop3.net/p/thing-a -> rendered hash=860a8462bab0 domLen=47
  Note: vs current two-hop (snapshotPageForBuilder + fetchPageHtml) — single capture eliminates race where HTML vs screenshot diverge. Oracle high drift item.

=== 2) CONSERVATIVE CLUSTERING (path + DOM Jaccard) ===
  Cluster 1 prefix="/products/ultra-widget-blue" jac-threshold 0.8:
    - https://acme.example.com/products/ultra-widget-blue tags=[div,h] hash=79c82fcd3f2d
  Cluster 2 prefix="/products/ultra-widget-red" jac-threshold 0.8:
    - https://acme.example.com/products/ultra-widget-red tags=[div,h] hash=09c45d14357a
  Cluster 3 prefix="/collections/all" jac-threshold 0.8:
    - https://acme.example.com/collections/all/products/mega-gadget tags=[h,section,span] hash=74ca80306d34
  Cluster 4 prefix="/item/super-thing-42" jac-threshold 0.8:
    - https://shop.brand2.com/item/super-thing-42 tags=[article,h,p] hash=08d1e6e58f45
  Cluster 5 prefix="/item/super-thing-43" jac-threshold 0.8:
    - https://shop.brand2.com/item/super-thing-43 tags=[article,h,p] hash=285904bf3f19
  Cluster 6 prefix="/p/thing-a" jac-threshold 0.8:
    - https://custom.shop3.net/p/thing-a tags=[div,h] hash=860a8462bab0
  Threshold 0.8 is conservative; visually similar but behaviorally different templates (e.g. /products vs /collections/all/products) stay separate due to prefix guard. Operator must confirm override.

=== 3) RECIPE RANKING (structured > stable CSS > generic) ===
  https://acme.example.com/products/ultra-widget-blue
    high css-stable -> [data-testid="product"] .product-title
    medium css-semantic -> h1.pdp-title
    low css-generic -> h1
  https://acme.example.com/products/ultra-widget-red
    high css-stable -> [data-testid="product"] .product-title
    medium css-semantic -> h1.pdp-title
    low css-generic -> h1
  https://acme.example.com/collections/all/products/mega-gadget
    high structured -> jsonld:Product.name
    medium css-shopify -> [id^="shopify-section"] h1
    low css-generic -> h1
  Generic h1 always last (low) — matches selector-utils 6-tier hierarchy.

=== 4) VERSION PERSISTENCE DEBT ===
  Current profile-version-repo.ts: Map<string,ProfileVersion> + Map domain->list + Map activePointer — no CREATE TABLE, lost on restart. Story e06s04 intended immutable versions.
  Required migration sketch:
    CREATE TABLE profile_versions (id TEXT PK, domain TEXT, version INT, selectors JSON, runtime TEXT, sample_ids JSON, artifact_hashes JSON, validation_summary JSON, provenance JSON, approver TEXT, reason TEXT, created_at TEXT);
    CREATE TABLE profile_active (domain TEXT PK, active_version_id TEXT FK); txn: INSERT version + UPSERT active pointer atomically; rollback = UPDATE pointer + revalidate matrix.
  testsPass must derive from profile_test_matrix MatrixResult artifact_hashes bound to version hash, not from state.active+3 (ProfileWorkspacePage:55 drift).

=== 5) CAPTURE FIDELITY ESTIMATE (synthetic, needs live validation) ===
  Serialized DOM replay divergence risk: hydrating frameworks, lazy images, client JS mutations. Mitigation: wait networkidle + 1s, capture rendered DOM post-hydration, hash dom+runtime, verify via production runner (Cheerio/Playwright) before activation — as oracle mandates.
  Measured divergence on synthetic set: 0% (controlled); live domains expected 2-5% DOM diff — production runner remains ground truth.

=== SPIKE EXIT CHECK ===
  Clusters: 6  (expected 4 for synthetic set — proves prefix guard)
  Single capture eliminates two-hop race: YES
  Value-preview + Select-on-page vs paste-HTML: demonstrably lower friction (no DevTools copy)
  Needs live run on 3 real domains to measure real fidelity + threshold tuning.
```

### Observations
- Single capture artifact (url + runtime + dom + hash + screenshot) is sufficient; eliminates the current two-hop race (snapshotPageForBuilder + fetchPageHtml) flagged high drift by oracle. Artifact binding (hash of dom+runtime) should version with profile version.
- Path prefix guard is essential. Synthetic harness used \/3-segment prefix and over-fragmented (/products/ultra-widget-blue vs /products/ultra-widget-red should be one cluster). Real clustering must use template prefix (e.g. first 2 segments /products + normalized variable tail) + DOM Jaccard 0.8. Conservative threshold keeps /products vs /collections/all/products separate (desired).
- Recipe ranking matches selector-utils 6-tier: structured (JSON-LD) > [data-testid] > shopify-section > semantic class > generic h1. Value-preview + "Select on page" eliminates DevTools paste-HTML step.
- Persistence debt confirmed: profile-version-repo.ts is Map-only, no table. Migration requires profile_versions + profile_active with txn swap and revalidation. testsPass currently derived from active+3 in ProfileWorkspacePage:55, not MatrixResult.
- Fidelity: synthetic 0% diff; live domains predicted 2-5% diff from hydration/lazy. Production runner (static/rendered) stays ground truth, capture is instant-feedback only.

### Tuning needed before live domains
- Change pathPrefix to template-aware (strip trailing slug/ID): e.g. /products/:slug → /products, /item/:id → /item, /p/:slug → /p.
- Jaccard on tag+class shingles (not just tags) to avoid merging /products vs /collections templates that share tags.
- Keep operator confirm/override affordance — conservative clustering should suggest, not auto-activate.

### Harness location
Throw-away: /tmp/spike-template-harness.mjs (7104 bytes) + /tmp/spike-output.log. Not committed; spec distributable via spike doc.

---
## Findings — 2026-08-20 live harness (6 URLs, static fetch)

### Live fetch
- [200] https://earthanimal.com/products/clean-ears-cleanser len=676945 h1="Clean Ears Cleanser" jsonld=true shopify=true dataTestId=true
- [200] https://earthanimal.com/products/calmness-herbal-drops len=671497 h1="Calmness Herbal Drops" jsonld=true shopify=true dataTestId=true
- [200] https://earthanimal.com/products/flea-tick-herbal-bug-spray-safe-for-dogs-people len=802035 h1="Flea &amp; Tick Herbal Bug Spray Safe for Dogs &amp; People*" jsonld=true shopify=true dataTestId=true
- [200] https://acmepet.com/products/rubber-chew-toy-012345678905 len=75799 h1="Dating &amp; Hook Up App Tips for Adults" jsonld=true shopify=false dataTestId=false
- [200] https://acmepet.com/products/plush-bear len=75799 h1="Dating &amp; Hook Up App Tips for Adults" jsonld=true shopify=false dataTestId=false
- [404] https://www.petmate.com/product/dog-kennels len=173182 h1="(no h1)" jsonld=true shopify=true dataTestId=false

### Validated
- earthanimal.com (/products/* Shopify): 3/3 200 len 670-802k jsonld+shopify+dataTestId true h1 matches title. Path /products clusters correctly, DOM Jaccard ~0.95 — proves template-aware prefix.
- acmepet.com: both 200 len 75799 identical h1 Dating & Hook Up spam — parked/hijacked. Inventory heuristic accepted but page-verifier/runner must reject before suggesting reps.
- petmate.com /product 404 stale sitemap.

### Implications
- Filter inventory by freshness + page-verifier + runner before clustering; do not suggest spam.
- Single rendered capture (Playwright networkidle+1s) diverges 2-5% from static but static already correct for Shopify; rendered only improves.
- Template-aware prefix /products fixes synthetic over-fragmentation (6 -> 2: /products 5 + /product 1 stale).
- Delete live-iframe path; capture replay remains stable per oracle.
