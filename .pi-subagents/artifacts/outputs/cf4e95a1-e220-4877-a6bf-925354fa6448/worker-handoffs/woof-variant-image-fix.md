# Woof Variant Image Fix — Worker Handoff

## Summary

Fixed the Woof variant image extraction bug in `src/onboarding/page-extractor.ts`. The issue was that Shopify product JSON parsing always grabbed the bare `window.productJSON` (which lacks per-variant `featured_image`) and the variant matcher only fired on URL `?variant=...` parameters, so all Lavender Pupsicle sizes got the default Green image.

The fix has two parts:

1. **Richer product JSON selection** — `extractProductJsonFromHtml` now collects all candidate Shopify product objects in the page (including `mntn_product_data = { ... }` and `window.<x>Bundles.push({ ... })`) and picks the one whose variants carry `featured_image` / `featured_media` / `image` data. The bare `window.productJSON` is only used as a fallback.

2. **Expected-name variant inference** — when the URL doesn't carry `?variant=...`, `mergeExtractionLayers` (now accepting an optional `expected` context) calls a new `inferVariantFromExpectedName` helper that scores each variant against the expected catalog name. Scoring uses size-alias expansion (`SM`→`small sm`, `XL`→`x large extra large ...`) plus exact `option1`/`option2` matching. A clear winner is required (top score strictly greater than runner-up, above a minimum threshold) so ambiguous names fall through to the default JSON-LD image instead of guessing.

`extractProductData` now passes `expected` into `extractViaHttpDetailed` and the Playwright merge path, so both HTTP and Playwright extractions benefit from variant inference.

## Changed Files

| File | Change |
|------|--------|
| `src/onboarding/page-extractor.ts` | Refactored `extractProductJsonFromHtml` to collect multiple candidate objects; added `collectProductJsonCandidates`, `findObjectEnd`, `inferVariantFromExpectedName`, `expandExpectedNameTokens`, `getExpectedSizeAliasForms`, `scoreVariant`, `variantDescriptor`, `normalizeToken`, `tokenSet`, `SIZE_ALIASES`. Added optional `expected` parameter to `extractViaHttp`, `extractViaHttpDetailed`, and `mergeExtractionLayers`. Updated `extractProductData` to pass `expected` into both HTTP and Playwright merge calls. |
| `src/tests/unit/page-extractor-variant-inference.test.ts` | New test file with 6 vitest cases covering: Lavender/Small, Lavender/Large, Lavender/X-Large, Forest Green/Small, ambiguous name fallback, and the rich-vs-bare product JSON preference. |

## Validation

| Command | Result |
|---------|--------|
| `bun run typecheck` | **0 errors** |
| `bunx vitest run` | **140 pass, 0 fail** (134 pre-existing + 6 new) |
| `bun run test` (vitest + bun test) | **All green** (vitest 140, bun test 126) |
| `bunx vitest run src/tests/unit/page-extractor-variant-inference.test.ts` | **6/6 pass** |
| `bunx vitest run src/tests/unit/page-extractor-images.test.ts` | **3/3 pass** (pre-existing recommendation srcset test still green) |

### End-to-end verification against the real Woof URL

```
WOOF PUPSICLE LAVENDER SM        => "Pupsicle - Lavender / Small"      (Lavender image, width=1200, prov: shopify-variant)
WOOF PUPSICLE LAVENDER LG        => "Pupsicle - Lavender / Large"      (Lavender image, width=1200, prov: shopify-variant)
WOOF PUPSICLE LAVENDER XL        => "Pupsicle - Lavender / X-Large"    (Lavender image, width=1200, prov: shopify-variant)
WOOF PUPSICLE FOREST GREEN SMALL => "Pupsicle - Forest Green / Small"  (Green image,     width=1200, prov: shopify-variant)
WOOF PUPSICLE                    => "Pupsicle"                         (JSON-LD fallback, no variant inferred)
```

## Design Notes

- **Brace-balanced parsing with `vm.runInNewContext`** is preserved as the safe evaluation path. `findObjectEnd` walks the opening `{` and returns the matching `}` index while correctly handling strings, escapes, and template literals.
- **Candidate selection is quality-scored** by how many variants carry image data plus the variant count. The bare `window.productJSON` gets a small boost only when its variants also carry image data, so we never lose good data to a slightly-better bare object.
- **Variant inference is conservative** — it only fires when (a) the top score is strictly greater than the runner-up, (b) the top score clears a minimum threshold of 10 (at least one distinguishing token matched), and (c) distinguishing tokens exist (i.e. the expected name actually carries color/size info). A name like "WOOF PUPSICLE" with no differentiating tokens falls through to the JSON-LD fallback.
- **The `expected` context is plumbed through both HTTP and Playwright paths** — `extractViaHttpDetailed` accepts it as an optional 3rd parameter, and the Playwright branch passes `expected` directly to `mergeExtractionLayers`.
- **Size alias expansion** covers `SM/Small`, `LG/Large`, `XL/X-Large/Extra Large`, `MD/Medium`, `XS/X-Small/Extra Small`, and their `xsmall`/`xlarge`/`xtra` variants. The full normalized forms are used for exact option2 matching while individual pieces contribute to token-set overlap.
- **Brand tokens are excluded** from the scoring set so "WOOF" in the expected name doesn't inflate scores for variants that all say "WOOF" in their vendor/title.

## Residual Risks

- **Variant scoring relies on `option1`/`option2`/`option3` naming.** Products that use a single `option` (no per-axis breakdown) or non-standard field names will not be disambiguated by the scorer. Mitigation: the inference falls back to default JSON-LD image for those products, which is the same behavior as before this fix.
- **The new collector parses up to 800 KB of HTML per candidate site** (`findObjectEnd` has a `maxChars` cap). For extremely large inline scripts this is safe but could be tuned lower if needed.
- **No UI or profile-management features were added** — this worker is scoped to the extractor fix. Profile management, review, and promotion tooling remain a separate effort.
- **The "ambiguous name falls back" case** currently falls back to the JSON-LD `og:image` (the default Green thumbnail for Pupsicle). That's the same image all sizes were getting before, so it's no regression, but it does mean ambiguous catalog names will still produce the same image across SKUs. Resolving that would require either discovering variant-specific URLs (e.g. `?variant=...`) at the source-discovery stage or threading the expected context earlier in the pipeline.

## No Staged Files

`git status --short | grep '^[A-Z]'` returns nothing related to this work. Changes are working-tree only.
