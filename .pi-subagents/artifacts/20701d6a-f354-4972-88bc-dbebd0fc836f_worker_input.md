# Task for worker

Fix two issues in the LLM proposal generator (`src/onboarding/profile-generator.ts`):

### Fix 1: Expand image discovery

**a) Add more product scope selectors** in `getMinimizedDom` (around line 199):
Add after `'#product-detail'`:
```typescript
    '.product-single',
    '.product-gallery',
    '.media-gallery',
    '[class*="product-single"]',
    '[class*="product__media"]',
    '[class*="media-gallery"]',
    '.product-media',
    '.product__wrapper',
```

**b) Add more image patterns** in `buildSelectorCandidates` (after the existing 6 patterns, before `return candidates`):
```typescript
$('[class*="product-single"] img, [class*="product__media"] img, .media-gallery img, .product-gallery img').each(
  (_, el) => addCandidate(el, ['image']),
);
$('img[data-media-id], .slick-slide img, .product__slides img, .product__media-item img, .swiper-slide img').each(
  (_, el) => addCandidate(el, ['image']),
);
$('[class*="product-media"] img, .product-single__thumbnail img, [class*="thumbnail"] img').each(
  (_, el) => addCandidate(el, ['image']),
);
```

**c) Expand `SEMANTIC_HINT_SUBSTRINGS.image`** (around line 259):
Add more hint keywords:
```typescript
image: ['product-image', 'gallery', 'hero-image', 'pdp-image', 'product-photo', 'product-media', 'product-single', 'media-gallery', 'slides', 'carousel', 'swiper', 'slick'],
```

### Fix 2: Stop proposing price and brand selectors

**a)** Remove price and brand candidate scanning from `buildSelectorCandidates`. Find these blocks and remove them:
- Price candidates block (lines ~560-567): 
  ```typescript
  $('[itemprop="price"], [itemprop="lowPrice"], [itemprop="highPrice"]').each(...)
  $('[class*="price" i], [id*="price" i], [class*="amount" i]').each(...)
  $('[class*="sale" i], [data-product-price]').each(...)
  ```
- Brand candidates block (lines ~568-576):
  ```typescript
  $('[itemprop="brand"]').each(...)
  $('[class*="brand" i], [id*="brand" i], [class*="vendor" i]').each(...)
  ```

**b)** Remove `priceSelector` and `brandSelector` from the LLM JSON output schema in `buildLlmPrompt` (around line 851). Change:
```typescript
Return JSON with exactly these keys:
{
  "titleSelector": string|null,
  "priceSelector": string|null,
  "descriptionSelector": string|null,
  "brandSelector": string|null,
  "imagesSelector": string|null,
  "variantSelectionStrategy": ...
```
to:
```typescript
Return JSON with exactly these keys:
{
  "titleSelector": string|null,
  "descriptionSelector": string|null,
  "imagesSelector": string|null,
  "variantSelectionStrategy": ...
```
Remove the outdated instructions about price overlap check too (if present).

**c)** Remove `'priceSelector'` and `'brandSelector'` from `SELECTOR_PROFILE_KEYS` (around line 820). The array should be:
```typescript
const SELECTOR_PROFILE_KEYS = [
  'titleSelector',
  'descriptionSelector',
  'imagesSelector',
];
```
And update the `out` initialization in `shapeFromParsed` (around line 873-879) to match.

**d)** Keep the `GeneratedSelectorProfile` interface fields (`priceSelector`, `brandSelector`) for backward compatibility — they'll just be `null`. But remove them from the LLM pipeline since we don't want them proposed.

**e)** Update the INSTRUCTIONS in the prompt — remove the bullet about price overlap check if it exists.

## Validation
- `bun run typecheck` passes with zero errors
- The profile generator no longer asks the LLM for price/brand selectors
- Images have many more discovery patterns

## Handoff
Report all changes and typecheck result.

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