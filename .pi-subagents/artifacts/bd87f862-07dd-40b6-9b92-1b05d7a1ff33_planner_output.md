# Implementation Plan: Variant/Facet Discovery & Broader Image Candidate Patterns in the Profile Generator

## Goal
Expand the LLM-based proposal generator (`src/onboarding/profile-generator.ts`) so it (a) discovers a wider set of real Shopify/ecommerce product-image candidate patterns, (b) discovers variant/option/facet UI widgets and surfaces them to the LLM, (c) parses a structured `variantSelectionStrategy` out of the LLM response, and (d) threads that strategy through the worker validation schema so the validate endpoint can validate it across samples. The trusted deterministic extractor (`extract.ts`) is **not** changed in this phase (Task 7 in the spec is explicitly deferred).

---

## Key Findings From Reading The Code (read these before executing)

1. **`ProfileProposalDraftSchema.variantSelectionStrategy` ALREADY EXISTS** (`src/shared/schemas/extraction-worker.ts:90`) as a loose `z.record(z.string(), z.unknown()).nullable().default(null)`. Same for `ExtractRequestSchema.profile.variantSelectionStrategy` (line 174). So "add the field" is mostly already done; the real schema work is **tightening it to a structured shape** and **enhancing `ValidationSampleResultSchema.variantResult`**.

2. **CRITICAL: `getMinimizedDom` strips variant widgets.** `NOISY_TAGS` (`profile-generator.ts:120`) removes `form`, `button`, `input`, `select`, `textarea` (lines 131–133) before `buildSelectorCandidates` runs. `generateExtractorProfile` calls `buildSelectorCandidates(getMinimizedDom(html))` (line ~737). Therefore `<select>` dropdowns and `<button>`/`<input>` swatches are **gone** from the minimized DOM. Variant discovery (Task 3) MUST run against the **original (non-minimized) HTML**, not the minimized DOM, OR `getMinimizedDom` must be changed to preserve variant widgets. This plan recommends running variant discovery on the original HTML (see Task 3) to avoid disturbing the field-selector minimization. **This is the single most important implementation detail.**

3. **`buildSelectorCandidates` has no base URL**, but the spec requires deduping image candidates "by absolute URL." The function signature is `(html: string)`. The only callers are `generateExtractorProfile` (which has the URL) and the unit test. This plan adds an optional `baseUrl?: string` param and falls back to raw-src dedup when absent.

4. **`GeneratedSelectorProfile` is stored whole** into the generation row: `onboarding-routes.ts` does `selectors: generated as unknown as Record<string, unknown>` in `insertProfileGeneration` (line ~1366). So adding `variantSelectionStrategy` to the interface means it is persisted in `selectors_json` automatically — no DB migration needed for the proposal side.

5. **The promoter currently drops `variantSelectionStrategy`.** `profile-promoter.ts` `selectorsFromRevision` (line ~105) and `SELECTOR_KEYS` (line ~50) only carry the 5 string selector fields. So even after this plan, promotion to `extractor_profiles` will NOT carry the strategy yet. This is consistent with Task 7 ("Later, not now") and is listed as a residual risk, not a task here.

6. **The frontend hardcodes `variantSelectionStrategy: null`** when building the validate request (`ProfileBuilderWorkspace.tsx:488`). To actually exercise the validate-side strategy validation (Task 8), the frontend must pass the proposed strategy from the stored generation. This is a one-line wiring change and is included as Task 9 (flagged as needed-for-end-to-end).

7. **Existing variant inference is a different, parallel mechanism.** `page-extractor.ts:1316` `inferVariantFromExpectedName` selects a Shopify variant from embedded `productJSON` by token-overlap scoring — it does NOT use CSS selectors. The new `variantSelectionStrategy` is a CSS-selector-based strategy proposed by the LLM. They are complementary; this plan does not merge them.

---

## Tasks

### Task 1 — Add `variantSelectionStrategy` to `GeneratedSelectorProfile`
- **File:** `src/onboarding/profile-generator.ts` — interface at line 42.
- **Changes:** Add the structured optional field exactly as specified in the task:
  ```typescript
  /** Proposed variant/option selection strategy. The LLM suggests how to
   *  select the correct source-page variant for the product SKU. */
  variantSelectionStrategy?: {
    containerSelector: string | null;
    optionType: 'dropdown' | 'button_group' | 'radio' | 'unknown';
    detectedOptions: string[];
    optionFields: string[];
  } | null;
  ```
- **Acceptance:** `bun run typecheck` passes. Existing `GeneratedSelectorProfile` literals in `profile-generator.test.ts` (e.g. line 388, 710) still compile because the field is optional. No behavior change yet.

### Task 2 — Expand image candidate discovery in `buildSelectorCandidates`
- **File:** `src/onboarding/profile-generator.ts` — image block at lines 570–574, `return candidates.slice(...)` at line 575.
- **Changes:**
  1. Add the additional image patterns from the spec, each calling `addCandidate(el, ['image'])`:
     ```typescript
     $('img[data-media-gallery], [data-product-media], [data-gallery-role]').each((_, el) => addCandidate(el, ['image']));
     $('[class*="product__media"] img, [class*="pdp-gallery"] img, [class*="swiper-wrapper"] img').each((_, el) => addCandidate(el, ['image']));
     $('img[data-zoom], img[data-zoom-image], [data-gallery-wrapper] img').each((_, el) => addCandidate(el, ['image']));
     $('[class*="pdp-carousel"] img, [class*="product-carousel"] img, [class*="media-gallery"] img').each((_, el) => addCandidate(el, ['image']));
     $('[data-slider] img, [role="tabpanel"] img').each((_, el) => addCandidate(el, ['image']));
     ```
  2. Add a tiny-thumbnail skip inside `addCandidate` (or a dedicated image gate): when the element is an `<img>`, read its `width`/`height` **HTML attributes** (Cheerio has no layout). If both are present and either is `< 50`, skip the candidate. If attributes are absent, keep it (cannot determine size from static HTML). Computed/layout dimensions are unavailable in Cheerio — do not attempt `clientWidth`.
  3. Add image-URL dedup: introduce a module-scoped `seenImageUrls: Set<string>` reset at the top of `buildSelectorCandidates`. In the image-scanning block, before `addCandidate`, resolve the candidate `<img>`'s primary src (`src`/`data-src`/`data-lazy-src`/`data-original`/`data-image`/`data-zoom-image`) against `baseUrl` when provided; skip if the resolved URL is already in `seenImageUrls`. Add an optional `baseUrl?: string` parameter to `buildSelectorCandidates(html: string, baseUrl?: string)`. When `baseUrl` is absent, dedup on the raw src string instead.
  4. Thread the base URL from `generateExtractorProfile`: change the call at line ~737 from `buildSelectorCandidates(minimized)` to `buildSelectorCandidates(minimized, _url)`.
- **Acceptance:** New unit test: a fixture with `data-media-gallery`, `product__media`, `swiper-wrapper`, `data-zoom`, `pdp-carousel`, `data-slider`, `role="tabpanel"` image containers produces image-hinted candidates. A fixture with `<img src="x.jpg" width="40" height="40">` is skipped. Two `<img>` with the same absolute URL (after resolving against a base) produce only one candidate.

### Task 3 — Add variant/facet option discovery (NEW function `buildVariantOptionCandidates`)
- **File:** `src/onboarding/profile-generator.ts` — add a new exported function + interface near the candidate-generation section (after `buildSelectorCandidates`, before the LLM-integration section at line 583).
- **Why a separate function (not inlined into `buildSelectorCandidates`):** variant candidates have a different shape (container selector + option labels + field-type hint) than field `SelectorCandidate`s, and — critically — they must scan the **original HTML** (not the minimized DOM, which strips `select`/`button`/`input`). Keeping them separate preserves the existing `buildSelectorCandidates` test contract (`SelectorCandidate[]`) and lets each scanner run on the right input.
- **New interface:**
  ```typescript
  export interface VariantOptionCandidate {
    /** CSS selector for the parent container (built via buildStableSelector). */
    containerSelector: string;
    /** Widget kind inferred from the element/tag. */
    optionType: 'dropdown' | 'button_group' | 'radio' | 'unknown';
    /** Option labels found (text of <option>/<button>/radio labels). */
    detectedOptions: string[];
    /** Inferred option field(s): e.g. "size", "color", "flavor", "style". */
    optionFields: string[];
    /** Stability of the container selector. */
    stability: 'high' | 'medium' | 'low';
  }
  ```
- **New function signature:** `export function buildVariantOptionCandidates(html: string, baseUrl?: string): VariantOptionCandidate[]`
- **Scanning logic (run on the ORIGINAL html):**
  1. `<select>` elements whose `<option>` (non-empty, non-placeholder) count ≥ 2 → `optionType: 'dropdown'`. Collect option text labels (skip the first if it looks like a placeholder, e.g. "Choose…"/"Select size").
  2. Button groups: containers whose class/id contains `option`, `variant`, `swatch`, `size`, `color` AND contain ≥ 2 `<button>` or `[role="button"]` children → `optionType: 'button_group'`. Collect button text/value labels.
  3. Radio groups: `<input type="radio">` sets sharing a `name` (≥ 2) whose enclosing label/class contains option/variant/size/color → `optionType: 'radio'`. Collect label text.
  4. Attribute-driven: elements with `data-variant`, `data-option`, `data-swatch` attributes → inspect children for buttons/options; `optionType` from tag context.
  5. Container-class driven: elements inside containers with class names like `product-options`, `variant-selector`, `option-selector`, `swatch-container`, `product-form__controls` → scan their interactive children.
  - For each discovered widget, build `containerSelector` via the existing `buildStableSelector($, el)` on the **container** (not the individual options). Limit `detectedOptions` to the first ~12 labels; cap total candidates at ~20 (new `VARIANT_CANDIDATE_LIMIT = 20`).
  - **Field-type inference (`optionFields`):** lowercase class/id/label/nearby-text scan against a mapping:
    - `size`, `dimension`, `length` → `"size"`
    - `color`, `colour`, `swatch` → `"color"`
    - `flavor`, `flavour`, `flavour`, `taste`, `variety` → `"flavor"`
    - `style`, `material`, `pattern`, `scent`, `fragrance`, `bundle` → `"style"`
    - otherwise → `[]` (unknown) and let the LLM infer.
- **Acceptance:** Unit tests with a Shopify-style `<select>` size dropdown, a `swatch` button group, and `data-variant` attribute widgets each yield a `VariantOptionCandidate` with the right `optionType`, non-empty `detectedOptions`, and an inferred `optionFields` entry. A page with no variant widgets returns `[]`.

### Task 4 — Update the LLM prompt in `buildLlmPrompt`
- **File:** `src/onboarding/profile-generator.ts` — `buildLlmPrompt` at line 632.
- **Changes:**
  1. Change signature to `buildLlmPrompt(candidates: SelectorCandidate[], variantCandidates: VariantOptionCandidate[], expected?: GeneratorExpectedContext)`.
  2. Add a compact variant-candidate block (cap at ~15) after the field-candidate block:
     ```
     VARIANT/OPTION CANDIDATES (containerSelector — optionType — optionFields — detectedOptions):
     [0] select.variant-selector | dropdown | size | Small, Medium, Large, X-Large
     [1] div.swatch-container | button_group | color | Blue, Red, Forest Green
     ```
  3. Add an INSTRUCTIONS bullet section:
     - "If one or more variant/option candidates correspond to the real product variant selectors, propose a `variantSelectionStrategy` object. Choose the most stable `containerSelector` from the variant candidates. Set `optionType` to one of `dropdown | button_group | radio | unknown`. Copy the discovered `detectedOptions` and inferred `optionFields`. If no candidate is a real variant selector, set `variantSelectionStrategy` to null."
     - "The `variantSelectionStrategy` is advisory; an invalid or null value does not invalidate the rest of the profile."
  4. Update the JSON output schema in the prompt to add `variantSelectionStrategy`:
     ```
     "variantSelectionStrategy": {
       "containerSelector": string|null,
       "optionType": "dropdown"|"button_group"|"radio"|"unknown",
       "detectedOptions": string[],
       "optionFields": string[]
     } | null
     ```
- **Acceptance:** Snapshot/characterization test: `buildLlmPrompt(fieldCandidates, variantCandidates)` output contains the `VARIANT/OPTION CANDIDATES` header and the `variantSelectionStrategy` JSON key.

### Task 5 — Update `shapeFromParsed` to parse `variantSelectionStrategy`
- **File:** `src/onboarding/profile-generator.ts` — `shapeFromParsed` at line 675.
- **Changes:**
  1. After the existing 5-key loop, read `obj.variantSelectionStrategy`.
  2. If `null`/`undefined` → `out.variantSelectionStrategy = null`.
  3. If present and an object, validate defensively:
     - `containerSelector`: `string | null`; if a non-empty string, require `isSupportedSelectorSyntax(...)` (reuse existing helper); if unsupported, set the whole strategy to `null` (do NOT fail the profile).
     - `optionType`: must be one of `'dropdown' | 'button_group' | 'radio' | 'unknown'`; else default to `'unknown'`.
     - `detectedOptions`: must be an array of strings; truncate to ~20; non-string entries dropped.
     - `optionFields`: must be an array of strings; truncate to ~8; non-string entries dropped.
  4. On any structural problem (not an object, wrong shape), set `out.variantSelectionStrategy = null` but **still return the profile** (the 5-field loop already ran). The `titleSelector` requirement remains the only hard gate.
- **Acceptance:** Tests: valid strategy object → returned as-is; missing → `null`; `optionType: "checkbox"` → coerced to `"unknown"`; `containerSelector: "//div"` (XPath) → strategy set to `null`, profile still returned; non-object strategy (`"auto"`) → `null`, profile still returned.

### Task 6 — Thread variant candidates through `generateExtractorProfile`
- **File:** `src/onboarding/profile-generator.ts` — `generateExtractorProfile` at line 710, candidate build at ~735–740, prompt call at line 741.
- **Changes:**
  1. After `const minimized = getMinimizedDom(html);` and `candidates = buildSelectorCandidates(minimized, _url);`, add `const variantCandidates = buildVariantOptionCandidates(html, _url);` — note this runs on the **original** `html`, not `minimized` (see Finding #2).
  2. Wrap variant-candidate build in its own try/catch defaulting to `[]` (mirrors the existing candidates try/catch).
  3. Change `buildLlmPrompt(candidates, expected)` → `buildLlmPrompt(candidates, variantCandidates, expected)`.
  4. `shapeFromParsed` already returns the strategy (Task 5); no further change needed here.
- **Acceptance:** Integration test with mocked LLM returning a `variantSelectionStrategy` object: `generateExtractorProfile` returns a profile whose `variantSelectionStrategy` equals the parsed object. Test with LLM returning no strategy key: `variantSelectionStrategy` is `null` and the profile is still returned.

### Task 7 — Schema: tighten `variantSelectionStrategy` + enhance `variantResult`
- **File:** `src/shared/schemas/extraction-worker.ts`.
- **Changes:**
  1. Introduce a structured schema (keep it permissive enough for the loose existing callers):
     ```typescript
     export const VariantSelectionStrategySchema = z.object({
       containerSelector: z.string().nullable().default(null),
       optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).default('unknown'),
       detectedOptions: z.array(z.string()).default(() => []),
       optionFields: z.array(z.string()).default(() => []),
     });
     export type VariantSelectionStrategy = z.infer<typeof VariantSelectionStrategySchema>;
     ```
  2. **`ProfileProposalDraftSchema.variantSelectionStrategy` (line 90):** change from `z.record(z.string(), z.unknown())` to `VariantSelectionStrategySchema.nullable().default(null)`. Verify callers: `ProfileBuilderWorkspace.tsx:488` passes `null` (valid); `validate.ts` reads it as `Record<string, unknown> | null` (typing will need a small update in Task 8). The `ExtractRequestSchema.profile.variantSelectionStrategy` (line 174) is for the deferred extractor wiring — leave as the loose record OR upgrade to `VariantSelectionStrategySchema.nullable().default(null)` for consistency; **recommend upgrading for consistency** since today it is always `null` (no caller breaks).
  3. **`ValidationSampleResultSchema.variantResult` (≈ line 129):** enhance to:
     ```typescript
     variantResult: z.object({
       selected: z.boolean(),
       variantTitle: z.string().nullable().default(null),
       error: z.string().nullable().default(null),
       // NEW — strategy-corroboration fields:
       containerSelector: z.string().nullable().default(null),
       optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).nullable().default(null),
       detectedOptions: z.array(z.string()).default(() => []),
       optionFields: z.array(z.string()).default(() => []),
       strategyValid: z.boolean().default(false),
     }).nullable().default(null),
     ```
- **Acceptance:** `bun run typecheck` passes. New schema test (Task 10): a `ValidateResponse` payload with the enhanced `variantResult` parses; a payload using the old 3-field shape still parses (new fields default). `null` `variantResult` still parses.

### Task 8 — Populate enhanced `variantResult` in worker `validate.ts`
- **File:** `src/extraction-worker/routes/validate.ts` — `validateSample` variant block at ~line 397–403; the `SampleValidationInput.variantSelectionStrategy` type at line 253/443/520.
- **Changes:**
  1. Update the `variantSelectionStrategy` input type from `Record<string, unknown> | null` to `VariantSelectionStrategy | null` (import from the schema).
  2. Replace the stub:
     ```typescript
     variantResult = { selected: true, variantTitle: 'not yet implemented', error: null };
     ```
     with real corroboration (validation evidence only — does NOT decide Profile Health, per the route's existing docstring):
     - If no strategy (null/empty) → `variantResult = null` (unchanged behavior).
     - If strategy present:
       - `containerSelector`: run `extractTextBySelector(html, strategy.containerSelector)` (the route's existing regex-based extractor) OR, better, load with `cheerio` if available — note this route currently uses **regex-based** `extractTextBySelector`, not Cheerio. Use `extractTextBySelector` for consistency; if it returns null/empty, `strategyValid = false`, `error = 'containerSelector did not resolve'`.
       - `optionType`: echo `strategy.optionType`.
       - `detectedOptions`/`optionFields`: echo the strategy's arrays (the static-fetch path cannot click options; for `rendered` we could query the DOM, but keep parity: echo proposed arrays and mark `strategyValid` on container resolution + non-empty options).
       - `selected`: set `true` when `strategyValid && detectedOptions.length > 0`, else `false`.
       - `variantTitle`: leave `null` (actual variant selection is the deferred extractor's job).
       - `error`: populate on failure.
  3. Keep the summary's `variantSamplesPassing` logic (line ~665) working: a sample with `variantResult.strategyValid === true` counts as passing; `null` variantResult still counts as trivially passing (unchanged).
- **Acceptance:** Unit/integration test: a `ValidateRequest` with a `variantSelectionStrategy` whose `containerSelector` matches the sample HTML yields `variantResult.strategyValid === true` and echoed `detectedOptions`. A non-matching container selector yields `strategyValid === false` with an error. `null` strategy yields `variantResult === null`.

### Task 9 — Frontend: pass proposed strategy into the validate request (needed-for-end-to-end)
- **File:** `src/client/components/ProfileBuilderWorkspace.tsx` — validate request build at line 488 (`variantSelectionStrategy: null`).
- **Changes:** Replace the hardcoded `null` with the proposed strategy read from the stored generation:
  ```typescript
  variantSelectionStrategy:
    (latestGeneration?.selectors as any)?.variantSelectionStrategy ?? null,
  ```
  Also widen the `latestSelectors` cast (line 377–378) handling so the nested object is not silently dropped — read `variantSelectionStrategy` directly off `latestGeneration.selectors` rather than the `Record<string, string|null>` cast.
- **Scope note:** This is the minimal wiring required so Task 8 is actually exercised by a real request. Without it the validate endpoint always receives `null` and the enhanced `variantResult` is never produced. Flagged here because the task spec focuses on the generator + schema; confirm with reviewer that this one-line frontend wiring is in scope (recommended: yes, it completes Task 6's intent without widening behavior).
- **Acceptance:** Manual/Storybook check or unit test: when a generation carries a `variantSelectionStrategy`, the constructed `ValidateRequest.profileDraft.variantSelectionStrategy` equals it; otherwise `null`.

### Task 10 — Tests
- **File:** `src/tests/unit/profile-generator.test.ts` (extend existing suite).
- **Add:**
  - `buildSelectorCandidates`: new image patterns found; tiny-thumbnail skip; URL dedup with `baseUrl`.
  - `buildVariantOptionCandidates`: dropdown / button_group / radio / data-variant / container-class discovery; field-type inference; empty page → `[]`; limit cap.
  - `buildLlmPrompt`: includes `VARIANT/OPTION CANDIDATES` section and `variantSelectionStrategy` JSON key.
  - `shapeFromParsed`: valid / missing / invalid-optionType / unsupported-containerSelector / non-object strategy.
  - `generateExtractorProfile` (mocked LLM): returns `variantSelectionStrategy` when LLM provides it; `null` when absent; still returns profile when strategy malformed.
- **New file:** `src/tests/unit/extraction-worker-schema.test.ts` — schema parse tests for `VariantSelectionStrategySchema`, enhanced `ValidationSampleResultSchema.variantResult` (new fields default, old shape still parses, `null` parses), and `ProfileProposalDraftSchema` with structured strategy.
- **Acceptance:** `bun run test` green; `bun run typecheck` green; `bun run lint` green.

### Task 11 — DEFERRED: wire variant strategy into trusted extract (NOT in this plan)
- **File (future):** `src/extraction-worker/routes/extract.ts` — already receives `profile.variantSelectionStrategy` (schema line 174) but ignores it.
- **Future work:** execute the approved strategy deterministically (resolve `containerSelector`, pick the option matching the expected name/UPC/spreadsheet hints, fail closed on ambiguity), mirroring the deterministic spirit of `page-extractor.ts:inferVariantFromExpectedName` (line 1316) but driven by the CSS-selector strategy rather than embedded `productJSON`. Also extend `profile-promoter.ts` `selectorsFromRevision`/`SELECTOR_KEYS` (line 50/105) to carry `variantSelectionStrategy` from the approved generation into `extractor_profiles` so it reaches `ExtractRequest`. **Do not implement now.**

---

## Files to Modify
- `src/onboarding/profile-generator.ts` — Tasks 1–6: interface, image patterns + dedup/baseUrl, new `buildVariantOptionCandidates` + `VariantOptionCandidate`, prompt section, `shapeFromParsed` strategy parsing, orchestration in `generateExtractorProfile`.
- `src/shared/schemas/extraction-worker.ts` — Task 7: add `VariantSelectionStrategySchema`; tighten `ProfileProposalDraftSchema.variantSelectionStrategy` and `ExtractRequestSchema.profile.variantSelectionStrategy`; enhance `ValidationSampleResultSchema.variantResult`.
- `src/extraction-worker/routes/validate.ts` — Task 8: type the strategy input; populate enhanced `variantResult` with corroboration; keep summary logic.
- `src/client/components/ProfileBuilderWorkspace.tsx` — Task 9: pass proposed `variantSelectionStrategy` from the stored generation into the validate request (replace hardcoded `null` at line 488).
- `src/tests/unit/profile-generator.test.ts` — Task 10: extend suite.
- `src/tests/unit/extraction-worker-schema.test.ts` — Task 10: NEW schema tests.

## New Files
- `src/tests/unit/extraction-worker-schema.test.ts` — Zod parse tests for the new/enhanced schemas.
- (No new production files; all generator logic stays in `profile-generator.ts` to match the existing module layout.)

## Dependencies
- Task 1 (interface) → Tasks 4, 5, 6 (prompt/parse/orchestrate all reference the new field).
- Task 3 (variant discovery fn) → Tasks 4 and 6 (prompt + orchestrate consume variant candidates).
- Task 2 (image dedup) is independent but should land with Task 1 since both touch `profile-generator.ts`.
- Task 7 (schema) → Task 8 (validate.ts types against the new schema).
- Task 8 → Task 9 (frontend must send the strategy for Task 8 to be exercised end-to-end).
- Task 10 (tests) depends on Tasks 1–8.

## Suggested Implementation Order
1. Task 1 (interface) + Task 7 (schema) — foundational types; run `typecheck` after each.
2. Task 2 (image patterns) — isolated, low risk.
3. Task 3 (variant discovery) — the meatiest new logic; run with `bun run test` after.
4. Task 4 (prompt) + Task 5 (shapeFromParsed) + Task 6 (orchestrate) — wire the LLM round-trip.
5. Task 8 (validate.ts population) — depends on Task 7 schema.
6. Task 9 (frontend wiring) — unblocks end-to-end.
7. Task 10 (tests) — add alongside each step but finalize last; run `bun run test && bun run typecheck && bun run lint`.

## LLM Prompt Additions (concrete)
Insert after the field-candidate block in `buildLlmPrompt`:

```
VARIANT/OPTION CANDIDATES (containerSelector — optionType — optionFields — detectedOptions):
[0] <containerSelector> | <optionType> | <optionFields joined> | <detectedOptions joined, max 12>
... (cap 15)
```

Add to INSTRUCTIONS:
- "If one or more variant/option candidates correspond to the real product variant selectors, propose a `variantSelectionStrategy` object using the most stable `containerSelector` from the variant candidates. Set `optionType` to `dropdown | button_group | radio | unknown`. Copy the discovered `detectedOptions` and inferred `optionFields`. If none is a real variant selector, set `variantSelectionStrategy` to null."
- "An invalid or null `variantSelectionStrategy` does NOT invalidate the rest of the profile."

Add to the JSON output schema in the prompt:
```json
"variantSelectionStrategy": {
  "containerSelector": string|null,
  "optionType": "dropdown"|"button_group"|"radio"|"unknown",
  "detectedOptions": string[],
  "optionFields": string[]
} | null
```

## Schema Changes (concrete)
- **NEW** `VariantSelectionStrategySchema` (object: `containerSelector: string|null`, `optionType: enum`, `detectedOptions: string[]`, `optionFields: string[]`).
- **`ProfileProposalDraftSchema.variantSelectionStrategy`**: `z.record(...)` → `VariantSelectionStrategySchema.nullable().default(null)`.
- **`ExtractRequestSchema.profile.variantSelectionStrategy`**: recommend same upgrade (today always `null`, no caller breaks).
- **`ValidationSampleResultSchema.variantResult`**: add `containerSelector`, `optionType` (nullable enum), `detectedOptions`, `optionFields`, `strategyValid` (boolean) alongside existing `selected`/`variantTitle`/`error`.

## Risk Assessment

1. **HIGH — `getMinimizedDom` strips `select`/`button`/`input` (NOISY_TAGS, line 120/131–133).** If variant discovery is run on the minimized DOM it will find nothing. **Mitigation (in plan):** run `buildVariantOptionCandidates` on the **original** `html` in `generateExtractorProfile` (Task 6). Do NOT rely on the minimized DOM for variant widgets. Verify with a fixture containing a `<select>` size dropdown.

2. **MEDIUM — image dedup "by absolute URL" needs a base URL** that `buildSelectorCandidates` does not currently accept. **Mitigation:** add optional `baseUrl?` param; fall back to raw-src dedup when absent. Only caller change is `generateExtractorProfile` passing `_url`. Confirm the unit test still calls `buildSelectorCandidates(html)` with no base URL (it will use raw-src dedup — acceptable).

3. **MEDIUM — tightening `ProfileProposalDraftSchema.variantSelectionStrategy` from loose record to structured object** could reject pre-existing stored drafts that contain arbitrary keys. **Mitigation:** stored proposals today set `variantSelectionStrategy: null` (frontend hardcodes null, promoter drops it), so no real stored data carries a loose object. Still, consider `VariantSelectionStrategySchema.nullable().default(null)` plus a `.passthrough()`/catchall OR keep the schema permissive. Recommend the structured form without passthrough (cleaner) but verify no DB row currently persists a non-null loose object via a quick check before merging.

4. **MEDIUM — `validate.ts` uses regex-based `extractTextBySelector`, not Cheerio**, so container-selector corroboration is approximate (it handles `.class`, `#id`, simple `[attr]`, tag selectors — not compound/descendant selectors well). **Mitigation:** for `strategyValid`, treat "extractTextBySelector returned non-empty OR Cheerio-based check" as pass. If the route can import `cheerio` (it already does in snapshot/extract), prefer a Cheerio `$(containerSelector).length > 0` check for robustness. Decide during implementation; surface if the route intentionally avoids Cheerio.

5. **LOW–MEDIUM — LLM prompt size growth.** Adding variant candidates + a JSON key increases tokens. **Mitigation:** cap variant candidates at 15 and `detectedOptions` at 12 in the prompt; the field candidates are already capped at 80.

6. **LOW — `optionType`/`optionFields` inference heuristics** may mislabel (e.g. a "size" swatch that is actually flavor). **Mitigation:** this is advisory; the LLM re-infers from labels, and the human reviewer approves. Document that inferred `optionFields` are hints, not final.

7. **RESIDUAL (by design) — promoter does not carry `variantSelectionStrategy`** (`profile-promoter.ts:50/105`). After this plan, the proposed strategy is surfaced and validated, but promotion to `extractor_profiles`/`ExtractRequest` is deferred (Task 11). The trusted extractor still receives `null`. This is intentional per the spec's "Later, not now."

8. **AMBIGUITY — is Task 9 (frontend wiring) in scope?** The spec's "Required changes" (1–6) center on the generator + schema and explicitly defer the extractor. Task 9 is the minimal wiring to make Task 8 functional end-to-end. **Recommendation:** include it (one line). If the reviewer wants the frontend untouched, Task 8 remains correct but unexercised until a later frontend change; document that.

## Validation Plan (for the implementing agent)
- `bun run typecheck` — must pass after Tasks 1, 7.
- `bun run test` — must pass after Tasks 2, 3, 5, 6, 8, 10.
- `bun run lint` — must pass.
- Manual: generate a proposal against a real Shopify PDP with a size `<select>` and a color swatch button group; confirm the returned `GeneratedSelectorProfile.variantSelectionStrategy` is non-null with the right `containerSelector` and `detectedOptions`. Then run the Profile Builder validation and confirm `variantResult.strategyValid === true` for a matching sample.

## Out of Scope (explicit)
- Wiring `variantSelectionStrategy` into `src/extraction-worker/routes/extract.ts` (Task 7 of spec — deferred).
- Extending `profile-promoter.ts` `SELECTOR_KEYS`/`selectorsFromRevision` to carry the strategy into `extractor_profiles` (deferred with the extractor).
- Merging the new CSS-selector strategy with the existing `productJSON`-based `inferVariantFromExpectedName` in `page-extractor.ts`.
- Any DB migration (the strategy rides in the existing `selectors_json` blob).
