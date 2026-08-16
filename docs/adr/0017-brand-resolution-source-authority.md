# ADR 0017 — Brand Resolution and Source Authority for Official Domain Discovery

- **Status:** Accepted
- **Relates to:** ADR 0007 (item-centric onboarding pipeline), ADR 0014 + Amendments A/B (multi-distributor sourcing), ADR 0016 (onboarding operating model), `docs/runbooks/sourcing-engine-rollout.md`
- **Implementation surface:** `src/onboarding/source-discovery.ts`, `src/onboarding/job-queue.ts`, `src/onboarding/domain-utils.ts`, `src/onboarding/discovery/retailer-domain-list.ts`, `src/onboarding/brand-inferrer.ts`, `src/db/repositories/brand-site-repo.ts`, `src/server/routes/onboarding-routes.ts`, `src/client/components/onboarding/attention/OfficialSiteResolutionWorkspace.tsx`

## Context

Products of the same brand resolve to inconsistent domains in Official Domain Discovery, and the resolved domain determines which extraction profile (if any) is required. Live evidence from the pipeline board:

- FROMM products → `frommfamily.com` (correct official brand domain).
- PRIMAL products → `primalpetfoods.com` (correct official brand domain).
- BUTCHER'S products → `farmtopaw.ca`, `mypetshoponyonge.ca`, `shop.allpetsconsidered.com`, `torontopets.ca`, `woofmeownh.com` — five different Canadian pet **retailer** domains for seven products of one brand, each requiring its own extractor profile, and each recorded with `source_type = official_page` even though none is an official brand page.

Root causes, verified in code:

1. **Discovery is unguided whenever the brand is unknown or unmapped.** `discoverSources(upc, name, brandHint)` only scopes searches (`site:` queries, sitemap pass, +0.35 brand-domain score) when `brandHint` maps to rows in `brand_sites`. When `brandHint` is absent (spreadsheet has no brand column value) or unmapped, discovery is pure Serper ranking, and each product of a brand independently lands on whatever retailer page ranks top — the same-brand scatter. The `noDomainMapped` halt only fires when a brand IS assigned but unmapped; a missing brand skips the halt entirely.
2. **Brand inference is run-local.** `inferBrandFromSearchResults` produces `{ brand, confidence, inferredDomain }`, and the worker persists the inferred *brand* to the item, but the inferred *domain* is deliberately never persisted ("no brand mapping was persisted") — so one product's successful inference never guides the next product of the same brand.
3. **The ranker rewards pet-sounding retailer domains.** `scoreResult` adds +0.05 for `/pet|animal|dog|cat|paw|woof|bark|feed|farm|supply|agway/` in the domain, so `farmtopaw.ca` is *boosted* for sounding pet-like. The retailer demotion list (`KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS`) contains 11 domains and none of the observed Canadian retailers; demotion is −0.2 and can be outvoted by accumulated positive signals.
4. **Auto-accept has no authority check.** The auto-selection policy gates on page-verification identity evidence (UPC, Shopify variant, JSON-LD/title) but does not require the accepted candidate's domain to be an official mapped brand domain. A verified retailer page can therefore auto-accept as an `official_page` source.
5. **`assign_brand` / `assign_domain` are declared but unimplemented.** They appear in `DiscoveryCardSummarySchema.availableActions` but have no server route, so the operator cannot correct brand/domain assignments from the attention UI.

The extractor-profile architecture (ADR 0008) makes the cost of this visible: one profile per domain, so scattered domains multiply profile-building work ("build profile for `farmtopaw.ca` — unblocks 1 product" instead of one profile unblocking a brand's whole line). But the scatter is a symptom, not the disease: **discovery is making an authority decision ("this page is the official source") without a resolved brand identity and source policy.**

## Decision

**Discovery does not decide what is official. Brand Resolution decides what source strategies are legitimate for a product; discovery only finds candidates inside that boundary.**

The invariant is *one brand → one deterministic source strategy*, not literally one domain:

- `brand → official_domain → official_page` (FROMM, PRIMAL);
- `brand → distributor_record` (preferred for brands with no legitimate official product site — ADR 0014 path, profile-free, null URL);
- `brand → approved_retailer` (retailer pages are a valid fallback but are typed `retailer_page`, never `official_page`).

Specific commitments, implemented in phases:

### Commitments

1. **Brand guidance becomes a discovery invariant, not a hint.** A product enters official discovery with a resolved brand where possible: spreadsheet brand column when present, otherwise LLM/heuristic inference with a confidence threshold (existing `MIN_BRAND_INFERENCE_CONFIDENCE` machinery). A high-confidence inferred domain is persisted to `brand_sites` as a provisional mapping so the next product of the same brand is guided; the mapping remains operator-editable/removable in Settings → Domain Configuration (existing `upsertDomainConfig` full-replacement semantics).
2. **No auto-accept without authority match.** The auto-selection policy requires the accepted candidate's domain to be an official mapped brand domain (`isOfficialDomainMatch` against `getOfficialDomainsForBrand`, strict exact-or-subdomain — `domain-utils.ts`). A candidate that fails authority must go to manual review even when page-verification identity evidence is strong. When the brand is unknown or unmapped, official candidates are never auto-accepted; review decides.
3. **The ranker stops rewarding retailer-sounding domains.** The pet-word domain bonus is removed. `KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS` is treated as a living denylist: observed retailer/distributor domains from live batches are added on discovery (this ADR's first seed: `farmtopaw.ca`, `torontopets.ca`, `mypetshoponyonge.ca`, `woofmeownh.com`, `shop.allpetsconsidered.com`). Demotion is a ranking bias only — retailer candidates are never discarded, because a retailer page can still be a useful reviewed fallback.
4. **`assign_brand` and `assign_domain` are implemented as first-class attention actions.** `assign_brand` sets the item's brand hint; `assign_domain` upserts the brand→domain mapping and re-runs discovery. Both follow the existing discovery-card action pattern (`accept_candidate`, `search_again`, `verify_url`) and surface in `OfficialSiteResolutionWorkspace`.
5. **Source taxonomy records the truth (Phase 3/deferred).** `official_page` is reserved for confirmed official brand pages. Phase 1 only prevents *unauthorized* `official_page` auto-selection — a retailer page is never auto-selected as the official source (commitment 2); operator-verified retailer sources keep today's `official_page` typing until the dedicated `retailer_page` `SourceType` and the migration/reclassification of historical mislabeled rows land in Phase 3 (rollout phases below). Nothing is deleted.

### Non-goals (deferred)

- A dedicated `BRAND_RESOLUTION` pipeline stage before Discovery (Phase 2 — the schema/UI model of `brand_status` and `source_policy`).
- Dynamic retailer detection signals (multi-brand catalogs, cart UI, retailer schema.org markup) beyond the denylist.
- Canonical brand identity (aliases like "Primal" vs "Primal Pet Foods") — brand comparison stays conservative (`normalization/brand.ts`), aliasing is operator-resolved.

## Consequences

- Same-brand products converge on one guided domain: search credits are spent scoped (`site:`), sitemap matching activates, and one extractor profile unblocks the brand's whole line through the existing domain-release sweep (`domain-release.ts`).
- Auto-accept becomes stricter; some previously auto-accepted items now surface for manual review. This is intentional — review decides authority, automation decides ranking.
- BUTCHER'S-style brands route toward `distributor_record` (no profile, no URL) or reviewed `retailer_page` sources instead of fake `official_page` records.
- The first seed of the retailer denylist is batch-specific; the list grows by discovery, mirroring the existing "conservative demotion, never discard" policy.

### Known limitations (Phase 1)

Provisional brand→domain mappings are authority-bearing on later discovery runs (they guide `site:` scoping and satisfy the auto-accept authority gate) until a dedicated provisional flag lands in Phase 2/3. Phase 1 mitigates this two ways: the retailer/distributor denylist guard (a known retailer domain is never persisted provisionally — commitment 3) and the atomic first-mapping-wins insert (`insertBrandSiteIfAbsent`) that prevents concurrent provisional mappings from scattering a brand across domains.

## Rollout phases

1. **Phase 1 (safety rails, in progress):** ranking fixes (commitment 3), authority gate on auto-accept (commitment 2), provisional persistence of high-confidence inferred domains (commitment 1), `assign_brand`/`assign_domain` actions (commitment 4). No schema migration; no behavior change for mapped brands that are working (FROMM, PRIMAL).
2. **Phase 2:** dedicated brand-resolution attention surface with `brand_status`/`source_policy` on the item; migration of existing items (inferred brand + mapped domain → auto-resolved; everything else → needs review).
3. **Phase 3:** full `retailer_page`/`distributor_page` source taxonomy and reclassification of historical `official_page` rows that are retailer pages.
4. **Phase 4:** automation — brand clustering suggestions, domain suggestions from review outcomes, market-aware policies (regional domains like `frommfamily.ca`). LLM suggestions never override source authority.
