# Task for planner

## Plan: Expand proposal generator with variant/facet discovery and broader image candidate patterns

Read these files fully:
- `src/onboarding/profile-generator.ts` — the LLM-based CSS selector proposal generator (buildSelectorCandidates, generateExtractorProfile, buildLlmPrompt)
- `src/extraction-worker/routes/extract.ts` — the trusted deterministic extractor (fails closed, no LLM, runs approved profiles)
- `src/onboarding/page-extractor.ts` — lines 1320-1600 showing existing variant inference from Shopify productJSON
- `src/shared/schemas/extraction-worker.ts` — ExtractRequest, ExtractResponse, ProfileProposalDraft schemas
- `CONTEXT.md` — the glossary sections on Source-Page Variant, Variant Selection Strategy, Domain Extractor Profile, Profile Builder

## Problem

The proposal generator at `src/onboarding/profile-generator.ts`:
1. **Image candidate discovery** (line ~578-580) only scans three patterns:
   `img[itemprop="image"], [class*="product-image"] img, [class*="gallery"] img`
   This misses many real Shopify theme patterns.
2. **Variant/facet/option selectors** — zero discovery. No dropdowns, swatches, option buttons, size selectors are scanned.
3. **The LLM prompt** only asks for 5 fields (title, price, description, brand, images) — no variant strategy output.
4. **GeneratedSelectorProfile** only has those 5 fields — no variantSelectionStrategy field.

## Required changes

### 1. Expand image candidate discovery in buildSelectorCandidates

Add more patterns that real Shopify/ecommerce sites use:
```typescript
// Additional image candidates
$('img[data-media-gallery], [data-product-media], [data-gallery-role]').each(...)
$('[class*="product__media"] img, [class*="pdp-gallery"] img, [class*="swiper-wrapper"] img').each(...)
$('img[data-zoom], img[data-zoom-image], [data-gallery-wrapper] img').each(...)
$('[class*="pdp-carousel"] img, [class*="product-carousel"] img, [class*="media-gallery"] img').each(...)
$('[data-slider] img, [role="tabpanel"] img').each(...)
```

Prefer elements that have product-related class/id/tag names and skip tiny thumbnails (width < 50px or height < 50px). Deduplicate by absolute URL.

### 2. Add variant/facet option discovery in buildSelectorCandidates

Add scanner for variant/option UI elements. These are typically:
- `<select>` elements with option values for size/color/flavor
- Button groups or radio groups with class names containing "option", "variant", "swatch", "size", "color"
- Elements with `data-variant`, `data-option`, `data-swatch` attributes
- Elements inside containers with class names like "product-options", "variant-selector", "option-selector", "swatch-container"

For each discovered variant selector, record:
- The selector CSS for the parent container
- The option labels found (text of buttons/options)
- The field type hint (size, color, flavor/style — inferred from class names, labels, or nearby text)

These should be included in the *prompt* to the LLM, not as separate selectors. The LLM should output a `variantSelectionStrategy` field alongside the existing selectors.

### 3. Add variantSelectionStrategy to GeneratedSelectorProfile

```typescript
export interface GeneratedSelectorProfile {
  titleSelector: string | null;
  priceSelector: string | null;
  descriptionSelector: string | null;
  brandSelector: string | null;
  imagesSelector: string | null;
  /** Proposed variant/option selection strategy. The LLM suggests how to
   *  select the correct source-page variant for the product SKU. */
  variantSelectionStrategy?: {
    /** CSS selector for the variant/option container */
    containerSelector: string | null;
    /** Type of option widget: 'dropdown' | 'button_group' | 'radio' | 'unknown' */
    optionType: 'dropdown' | 'button_group' | 'radio' | 'unknown';
    /** The option labels/types detected on the page (e.g. "Small", "Blue") */
    detectedOptions: string[];
    /** Which option fields this represents (e.g. "size", "color", "flavor") */
    optionFields: string[];
  } | null;
}
```

### 4. Update the LLM prompt in buildLlmPrompt

Add a section describing the variant/option discovery candidates to the prompt. Ask the LLM to:
- Decide which of the discovered option elements are the actual product variant selectors
- Suggest a variantSelectionStrategy
- Include it in the JSON output alongside the existing fields

### 5. Update shapeFromParsed to parse variantSelectionStrategy

Parse the new field from the LLM JSON response. If present and valid, include it in the returned GeneratedSelectorProfile.

### 6. Add variantSelectionStrategy to ValidateRequest/Response schema

The worker's validate endpoint needs to know about the variant strategy so it can validate across samples. Add:
- To `ProfileProposalDraftSchema`: optional `variantSelectionStrategy` field
- To `ValidationSampleResultSchema.variantResult`: enhanced fields to check strategy correctness

### 7. (Later, not now) Wire variant strategy into trusted extract

The Phase 5 trusted extractor already receives `variantSelectionStrategy` in its request profile. Today it's always null. Once the LLM proposes a strategy and it's approved, the extractor should execute it. For now, just surface the proposed strategy — the extractor doesn't need changes.

## Output

Write the plan to: `docs/plans/variant-discovery-plan.md`

Include:
1. Files to modify
2. Exact changes per file  
3. The LLM prompt additions
4. Schema changes
5. Risk assessment
6. Suggested implementation order

Do NOT implement anything.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/bd87f862-07dd-40b6-9b92-1b05d7a1ff33/plan.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```