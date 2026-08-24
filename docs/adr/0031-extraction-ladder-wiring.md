# ADR 0031: Wiring the Extraction Ladder into the Onboarding Page Extractor

**Status:** Accepted (2026-08-24)
**Supersedes:** none
**Related:** ADR 0030 (Agent Lab decommission — salvaged the deterministic extraction ladder as layers 1–4, production-unwired), ADR 0009 (browser tooling lives in the extraction worker)

## Context

ADR 0030 relocated the PI-11 extraction ladder (`src/onboarding/extraction-ladder/`) but left it with zero production consumers. Meanwhile the live extractor, `src/onboarding/page-extractor.ts`, already implements layered extraction (custom CSS profile → JSON-LD → meta → microdata → heuristics) over HTTP/Playwright, and carries a **dead** Shopify in-page `productJSON` path ("deprecated, variant logic removed") whose remaining plumbing — `RawExtraction.productJSON`, `mergeExtractionLayers` variant matching — was unreachable.

The ladder contributes two things page-extractor lacks:

1. **Platform payload parsing** — embedded `__NEXT_DATA__`, Nuxt hydration state, WooCommerce Store API JSON blocks, and (network) Shopify `/products/<handle>.js` — with maintained variant/GTIN handling.
2. **Deterministic identity classification** — `classifyPageIdentity` distinguishing retrieval success from correct-product extraction, with per-status reasons.

## Decision

**Enrichment, not replacement.** `extractViaHttpDetailed` now calls `applyLadderEnrichment` (`src/onboarding/extraction-ladder/enrich.ts`) after its own layer merge:

- Profile-Builder CSS profiles remain PRIMARY for domains with approved profiles; the ladder never overwrites a value any earlier layer produced.
- The ladder fills only EMPTY fields (`title`, `brand`, `description`, `price`) from structured/platform signals, recording provenance under new `ladder-*` keys.
- Platform gallery images are appended to `additionalImages` (deduped, capped at 16); plain og:image/JSON-LD image handling is untouched to avoid changing primary-image selection.
- `identityStatus` + `identityReasons` are attached additively to `ExtractionData` (new optional schema fields). They are diagnostics only — they gate nothing today.
- `extractProductData`'s `expected` accepts an optional `gtin`; the onboarding worker passes `item.upc`, enabling real exact-match identity when a platform payload affirmatively proves single-variant state.

**Dead code removed:** `RawExtraction.productJSON`, the always-null Layer 6 assignment, the Playwright-path `productJSON` variable, and all unreachable `matchedVariant` logic (variant-title enrichment, variant price override, variant featured-image selection).

**Shopify layer is opt-in.** Unlike the embedded parsers, Shopify's product `.js` endpoint requires one extra network request. Per the compatibility rule "no new network calls beyond what page-extractor already performs", `applyLadderEnrichment` parses embedded content only by default; the maintained Shopify fetch runs only when callers pass `allowShopifyProductJson: true` together with their own `fetchFn` transport (preserving whatever SSRF/policy posture the caller enforces). This replaces the dead in-page path with the ladder's maintained implementation without changing default traffic behavior.

## Compatibility guarantees

1. **Additive only** — no existing `ExtractionData` field is removed or overwritten by the ladder; new schema fields default to null/[] so persisted old records remain valid.
2. **Failure isolation** — each enrichment layer runs in its own try/catch; any failure degrades to "no enrichment" and can never fail extraction.
3. **No new network by default** — zero additional requests unless `allowShopifyProductJson` is explicitly enabled.
4. **Profile execution stays singular** — approved profiles continue to execute exclusively via the extraction worker (Crawlee/Camoufox, ADR 0009). We deliberately did NOT route profiles through the ladder's static-cheerio layer-4 seam: a second execution path with different rendering semantics would produce inconsistent results for the same profile. The seam remains available for future lightweight static validation probes.

## Consequences

- Platform-hosted catalogs (Next.js/Nuxt/WooCommerce storefronts) now get titles, brands, prices, descriptions, and variant-mapped galleries that heuristic parsing missed.
- Extraction results carry machine-readable identity diagnostics, unblocking future routing (e.g., flagging `parent_product_only` pages for variant-aware handling).
- The ladder module now has a production consumer; its test suite plus the new wiring tests guard both sides of the contract.
