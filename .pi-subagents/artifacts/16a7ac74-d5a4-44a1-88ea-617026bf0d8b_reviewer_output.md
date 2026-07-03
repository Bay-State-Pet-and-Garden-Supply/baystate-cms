I now have all the evidence needed. Let me compile the final review.

## Review

### Correct (with evidence)

**`src/onboarding/profile-generator.ts`**
- **`GeneratedSelectorProfile.variantSelectionStrategy`** — Optional field present (lines 58-65), typed `{ containerSelector: string|null; optionType: 'dropdown'|'button_group'|'radio'|'unknown'; detectedOptions: string[]; optionFields: string[] } | null`.
- **`buildSelectorCandidates`** — Has `baseUrl?: string` param (line 489). 6 image patterns confirmed (lines 524-538): 1 original (`img[itemprop="image"]`, `product-image`, `gallery`) + 5 new (`data-media-gallery`/`data-product-media`/`data-gallery-role`; `product__media`/`pdp-gallery`/`swiper-wrapper`; `data-zoom`/`data-zoom-image`/`data-gallery-wrapper`; `pdp-carousel`/`product-carousel`/`media-gallery`; `data-slider`/`role="tabpanel"`). Called as `buildSelectorCandidates(minimized, _url)` in `generateExtractorProfile` (line 964).
- **`VariantOptionCandidate` + `buildVariantOptionCandidates`** — Interface at lines 437-443; function at line 615. 5 strategies implemented: (1) `<select>` dropdowns, (2) button groups in variant containers, (3) radio groups, (4) data-attribute widgets, (5) container-class driven. Runtime verification against realistic HTML produced 5 candidates across `dropdown`/`button_group`/`radio` types with correct option extraction and placeholder filtering.
- **`buildLlmPrompt`** — Has `variantCandidates: VariantOptionCandidate[]` param (line 528). Emits a `VARIANT/OPTION CANDIDATES` section when candidates exist. Instructions and JSON schema both include `variantSelectionStrategy`.
- **`shapeFromParsed`** — Parses `variantSelectionStrategy` defensively (lines 706-742): `null`/`undefined`→null; object→per-field parsing with `isSupportedSelectorSyntax` check on container, enum-validated optionType, array-filtered+slice-capped options/fields; other types→null. The **only** `return null` is gated on `!out.titleSelector` (line 744) — an invalid strategy never fails the profile.
- **`generateExtractorProfile`** — Builds `variantCandidates = buildVariantOptionCandidates(html, _url)` from **original** HTML (line 971), wrapped in try/catch, then passes to `buildLlmPrompt(candidates, variantCandidates, expected)` (line 980).

**`src/shared/schemas/extraction-worker.ts`**
- `VariantSelectionStrategySchema` (lines 89-94) with correct fields.
- `ProfileProposalDraftSchema.variantSelectionStrategy` (line 113) and `ExtractRequestSchema.profile.variantSelectionStrategy` (line 200) both use `VariantSelectionStrategySchema.nullable().default(null)`.
- `ValidationSampleResultSchema.variantResult` (lines 152-161) has the enhanced fields: `containerSelector`, `optionType`, `detectedOptions`, `optionFields`, `strategyValid`.

**`src/extraction-worker/routes/validate.ts`**
- Strategy typed `VariantSelectionStrategy | null` in `SampleValidationInput` and both fetch functions.
- Variant result block (lines 393-414) performs **real corroboration**: resolves `containerSelector` via `extractTextBySelector`, checks `containerFound && hasOptions`. No "not yet implemented" stub (grep confirmed empty).
- `strategyValid` handles all three cases: null/empty strategy→`variantResult = null`; container not found→`strategyValid=false`, error `'containerSelector did not resolve on sample page'`; missing options→`strategyValid=false`, error `'Strategy has no detected options'`.

**`src/client/components/ProfileBuilderWorkspace.tsx`**
- Hardcoded `null` replaced with `(latestGeneration?.selectors as any)?.variantSelectionStrategy ?? null` (in `handleValidate`). Data flow verified: `onboarding-routes.ts:1363` persists the full `GeneratedSelectorProfile` (incl. `variantSelectionStrategy`) as the generation's `selectors` blob, so the frontend read resolves the stored strategy.

**Architecture constraint** — ✅ Variant discovery correctly runs on original HTML, not minimized. The comment at line 968 explains why: `NOISY_TAGS` strips `select`/`button`/`input`, which would discard variant widgets from the minimized DOM. Confirmed `buildVariantOptionCandidates(html, ...)` uses original `html` while `buildSelectorCandidates(minimized, ...)` uses minimized.

### Type Safety
- `npx tsc --noEmit --skipLibCheck` → **passed, zero errors**.

### Tests
- Existing suites pass: `profile-generator.test.ts` (58), `page-extractor-images.test.ts` (3), `page-extractor-variant-inference.test.ts` (6), `page-extractor-profile-generation.test.ts` (2) = **69 passed**.

### Notes (not blockers)

1. **Test coverage gap** — No new/updated tests cover `buildVariantOptionCandidates` (the 5 strategies), `shapeFromParsed`'s variant parsing, the validate.ts variant corroboration (`strategyValid`), or the new extraction-worker schemas. Grep across `src/tests/` found zero references to `buildVariantOptionCandidates`/`variantSelectionStrategy`/`VariantOptionCandidate`. The new logic is exercised only by the runtime sanity checks I ran (not committed). Recommend adding unit tests for these before promotion to production use.

2. **`baseUrl` parameter unused** — `buildSelectorCandidates(html, baseUrl?)` (line 489) and `buildVariantOptionCandidates(html, baseUrl?)` (line 615) accept `baseUrl` but never read it. This was a task requirement (the param must exist), but it is currently dead and triggers `@typescript-eslint/no-unused-vars`. Intended for future URL-relative resolution; acceptable but worth a `// eslint-disable-next-line` or `_baseUrl` if lint gates CI.

3. **Lint (12 errors, all style)** — `eslint` on the 4 files reports only style nits: unused legacy imports (`getLlmConfig`/`callLlm`), unnecessary regex escapes, and `no-useless-assignment` on the `let x = init; try { x = ...; }` pattern (the initial value is reassigned before read — functionally correct, not a bug). None indicate a logic defect. `tsc` is the authoritative type gate and it passes.

4. **Variable shadowing** — In `shapeFromParsed` the local `const parsed` (line 718) shadows the function parameter `parsed: unknown`. Block-scoped so correct, but a readability nit.

5. **Variant containers get low-stability selectors** — `SEMANTIC_HINT_SUBSTRINGS` covers title/price/description/brand/image but not `variant`/`option`/`swatch`, so variant containers often fall through to `nth-of-type` (low stability). Not a bug (selectors still resolve and the LLM can refine), but worth noting for future selector-quality tuning.

### Blocker
None. All 24 required implementation points are present and verified; typecheck passes; existing tests pass; the architecture constraint (original-HTML variant discovery) is correctly honored.