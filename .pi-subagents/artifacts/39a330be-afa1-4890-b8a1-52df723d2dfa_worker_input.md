# Task for worker

## Tasks A1 + A2: Unconstrain the LLM prompt + Add shopifyJSONPath to profile shape

Read these files first:
- `src/onboarding/profile-generator.ts` — the proposal generator (main target)
- `src/onboarding/shopify-json.ts` — the new shared module created in A0
- `src/shared/schemas/onboarding.ts` — ExtractorProfileSchema
- `src/db/migrations.ts` — existing migration pattern for new columns
- `src/db/repositories/extractor-profile-repo.ts` — upsertProfile SQL
- `src/onboarding/profile-promoter.ts` — SELECTOR_KEYS, selectorsFromRevision

## Task A1: Unconstrain the LLM prompt and pass the minimized DOM

### In `src/onboarding/profile-generator.ts`:

**a) Add a new constant** near `MAX_MINIMIZED_BYTES`:
```typescript
/** Cap for the DOM payload sent to the LLM during proposal generation. */
const MAX_LLM_DOM_BYTES = 60_000;
```

**b) Change `buildLlmPrompt` signature** from:
```typescript
function buildLlmPrompt(
  candidates: SelectorCandidate[],
  variantCandidates: VariantOptionCandidate[],
  expected?: GeneratorExpectedContext,
): string {
```
to:
```typescript
function buildLlmPrompt(
  candidates: SelectorCandidate[],
  variantCandidates: VariantOptionCandidate[],
  minimizedDom: string,
  expected?: GeneratorExpectedContext,
): string {
```

**c) Replace the user prompt body** — find the current prompt string (it starts with "You are a CSS selector expert."). Replace it with:

```typescript
  let variantBlock = '';
  if (variantCandidates.length > 0) {
    const compact = variantCandidates.slice(0, 15).map((c, i) => {
      return `[${i}] ${c.containerSelector} | ${c.optionType} | ${c.optionFields.join(', ')} | ${c.detectedOptions.join(', ')}`;
    });
    variantBlock = `\nVARIANT/OPTION CANDIDATES (containerSelector — optionType — optionFields — detectedOptions):\n${compact.join('\n')}\n`;
  }

  const variantBlock = variantCandidates.length > 0 ? buildVariantBlock(variantCandidates) : '';

  const prompt = `You are a CSS selector expert. Write the best CSS selector for each product field for the product page below. The candidate list is provided as HINTS only — you MAY write a selector that is NOT in the candidate list when you can see a more stable or more accurate one in the minimized DOM. Prefer stable, semantic selectors (data-testid, itemprop, semantic class names) over positional pseudo-selectors (nth-of-type).
${expectedBlock}

MINIMIZED PRODUCT DOM (HTML):
${minimizedDom}

SELECTOR CANDIDATES (index — tag — selector — hints — text) — hints only, not a constraint:
${compact.join('\n')}
${variantBlock}
INSTRUCTIONS:
- Output ONLY a single valid JSON object. No commentary, markdown fences, or code blocks.
- Do not include JavaScript, XPath, or browser-only pseudo-selectors (e.g., :has(), :is(), :where(), :focus, :hover).
- All selectors must be valid CSS that Cheerio can evaluate against static HTML.
- For each field, write the single most accurate selector. Set a field to null only if you genuinely cannot identify a good selector for it.
- titleSelector is required (return null for the whole object if no good title selector exists).
- imagesSelector should target the container that wraps ALL gallery images (multiple <img>), not a single hero image, when a gallery exists. If the DOM shows a Shopify media wrapper (e.g. .product__media-wrapper, .product-single__media, [data-product-media]), target it.
- If you can see a Shopify product object embedded in a <script> (window.productJSON / productJSON / *_product_data / var meta = { product: ... }), set "shopifyJSONPath" to true and prefer that object for title/description/images; still provide CSS selectors as fallback.
- If one or more variant/option candidates correspond to the real product variant selectors, propose a "variantSelectionStrategy" object using the most stable "containerSelector" from the variant candidates. Set "optionType" to dropdown|button_group|radio|unknown. Copy the discovered "detectedOptions" and inferred "optionFields". If none is a real variant selector, set "variantSelectionStrategy" to null.
- An invalid or null "variantSelectionStrategy" does NOT invalidate the rest of the profile.

Return JSON with exactly these keys:
{
  "titleSelector": string|null,
  "descriptionSelector": string|null,
  "imagesSelector": string|null,
  "shopifyJSONPath": boolean,
  "variantSelectionStrategy": {
    "containerSelector": string|null,
    "optionType": "dropdown"|"button_group"|"radio"|"unknown",
    "detectedOptions": string[],
    "optionFields": string[]
  } | null
}`;
```

Keep the existing system prompt unchanged: `'You are a precise assistant that returns ONLY valid JSON. No markdown, no commentary, no code fences.'`

**d) Update `generateExtractorProfile`** — after the line `const minimized = getMinimizedDom(html);`, add:
```typescript
const llmDom = minimized.length > MAX_LLM_DOM_BYTES
  ? minimized.slice(0, MAX_LLM_DOM_BYTES) + '<!--truncated-->'
  : minimized;
```

Then change the prompt call from:
```typescript
const prompt = buildLlmPrompt(candidates, variantCandidates, expected);
```
to:
```typescript
const prompt = buildLlmPrompt(candidates, variantCandidates, llmDom, expected);
```

**e) Update the `SELECTOR_PROFILE_KEYS`** to include `shopifyJSONPath`:
```typescript
const SELECTOR_PROFILE_KEYS = [
  'titleSelector',
  'descriptionSelector',
  'imagesSelector',
  'shopifyJSONPath',
];
```

## Task A2: Add shopifyJSONPath to the profile shape, parser, storage, and promotion

### In `src/onboarding/profile-generator.ts`:

**a) `GeneratedSelectorProfile` interface** — Add `shopifyJSONPath: boolean;` field. Remove `priceSelector` and `brandSelector` (they're already gone from the interface from A4).

**b) `shapeFromParsed`** — After the existing key loop, add:
```typescript
// Parse shopifyJSONPath boolean
if (typeof obj.shopifyJSONPath === 'boolean') {
  out.shopifyJSONPath = obj.shopifyJSONPath;
}
```

### In `src/shared/schemas/onboarding.ts`:

**a) `ExtractorProfileSchema`** — Add:
```typescript
shopifyJSONPath: z.boolean().default(false),
```

### In `src/db/migrations.ts`:

**a)** Find the extractor_profiles migration block (around line 80-88). After the `sitemap_product_url_pattern` column addition, add:
```typescript
// Ensure extractor_profiles has shopify_json_path column
try {
  const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some(col => col.name === 'shopify_json_path')) {
    db.exec('ALTER TABLE extractor_profiles ADD COLUMN shopify_json_path INTEGER NOT NULL DEFAULT 0;');
  }
} catch (e) {
  console.error('Failed to update extractor_profiles columns:', e);
}
```

### In `src/db/repositories/extractor-profile-repo.ts`:

**a)** Add `shopify_json_path: number;` to `DbProfile` interface.

**b)** In `mapToProfile`, add:
```typescript
shopifyJSONPath: !!db.shopify_json_path,
```

**c)** In `ExtractorProfile` interface, add:
```typescript
shopifyJSONPath: boolean;
```

**d)** In `upsertProfile`, update the `resolve` helper (which currently returns `string | null`). Since `shopify_json_path` is an INTEGER, handle it separately — add after the string selector resolutions:
```typescript
const shopifyJSONPath = existing ? (selectors.shopifyJSONPath ?? !!existing.shopify_json_path) : (selectors.shopifyJSONPath ?? false);
```

Update the SQL to include `shopify_json_path`:
```typescript
db.query(`
  UPDATE extractor_profiles
  SET title_selector = ?, price_selector = ?, description_selector = ?, brand_selector = ?, images_selector = ?, sitemap_product_url_pattern = ?, shopify_json_path = ?, updated_at = ?
  WHERE domain = ?
`).run(tSel, pSel, dSel, bSel, iSel, sSel, shopifyJSONPath ? 1 : 0, now, normalizedDomain);
```

And for INSERT:
```typescript
db.query(`
  INSERT INTO extractor_profiles (id, domain, title_selector, price_selector, description_selector, brand_selector, images_selector, sitemap_product_url_pattern, shopify_json_path, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(id, normalizedDomain, tSel, pSel, dSel, bSel, iSel, sSel, shopifyJSONPath ? 1 : 0, now, now);
```

### In `src/onboarding/profile-promoter.ts`:

**a)** In `selectorsFromRevision` and `selectorsFromRevision`-related code, include `shopifyJSONPath`:
```typescript
shopifyJSONPath: (source.shopifyJSONPath as boolean) ?? false,
```

**b)** In `promoteGeneratedProfile`, when building `writeSelectors`, include:
```typescript
shopifyJSONPath: selectors.shopifyJSONPath,
```

## Validation
- `bun run typecheck` passes with zero errors
- `bun run test` passes

## Handoff
Report all files changed and typecheck + test results.

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