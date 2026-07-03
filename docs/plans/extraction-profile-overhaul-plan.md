# Implementation Plan: Extraction Profile Proposal Generation & Review Overhaul

> **Note on output location:** This plan was written to the authoritative runtime
> artifact path only (`.pi-subagents/artifacts/outputs/<run-id>/plan.md`) per the
> runtime output override. The task body also mentioned
> `docs/plans/extraction-profile-overhaul-plan.md`; that copy was **intentionally
> not created** because the override instructs to ignore other output paths. The
> parent may copy this file to `docs/plans/` if a committed copy is desired.
>
> **Implementation status note (Jul 2026):** This plan was implemented with
> different tab naming than originally proposed. The actual ProfileBuilderWorkspace
> uses tabs: **Build** (default, user-guided visual selection), **Review**
> (approve/reject), **Advanced** (domain info, deprecated AI proposal generator).
> The original "Overview" tab (AI proposal + quick actions) was replaced by
> "Advanced"; the original "Snapshot" tab (technical page data) was redesigned into
> the "Build" tab with visual element selection as the primary experience.

---

## 1. Summary

The proposal generator (`src/onboarding/profile-generator.ts`) today heuristically
discovers CSS-selector candidates and then **constrains** the LLM to pick only from
that list. When the heuristic misses the real selector (e.g. a Dawn-theme
`.product__media-wrapper` gallery), images silently fail and the LLM has no way to
recover. The review surface is **selector-centric** — operators approve CSS strings
field-by-field instead of approving the *extracted product data* — and the flow is
split across disjoint Generate / Validate / Approve buttons and two tabs.

This overhaul makes three changes, mirroring the oracle's three-phase recommendation:

- **Phase A (backend):** Unconstrain the LLM prompt (pass the minimized DOM, let the
  model write selectors not in the candidate list); add Shopify `productJSON` as a
  first-class extraction strategy (`shopifyJSONPath`); remove `price`/`brand` from
  the review/approval field set; generate and persist a `seedPreview` (actual
  extracted title/description/images/variant-options) at proposal time.
- **Phase B (UI):** Replace the selector-approval table with a **preview-driven**
  review panel ("Looks correct" → validate-across-samples → promote; "Something's
  wrong" → feedback → regenerate). Merge the **Proposals** and **Validation** tabs in
  `ProfileBuilderWorkspace` into a single **Review** flow.
- **Phase C (UI):** Surface `variantSelectionStrategy` (detected option pills +
  container selector) inside the preview panel.

Scope is strictly the proposal-generation + review surface. The trusted production
extractor's behaviour is touched only minimally (to consume `shopifyJSONPath`); the
auto-trigger (`shouldAttemptProfileGeneration`) is lightly adjusted, not redesigned.

---

## 2. Phase A — Proposal Generator (Backend)

### Shared prerequisite

#### Task A0 — Extract Shopify `productJSON` parsing into a shared pure module
- **Files:**
  - New: `src/onboarding/shopify-json.ts`
  - Modify: `src/onboarding/page-extractor.ts`
- **Changes:**
  - Move `PRODUCT_JSON_ASSIGNMENT_PATTERNS`, `findObjectEnd`,
    `collectProductJsonCandidates`, `ProductJsonCandidate`, and
    `extractProductJsonFromHtml` **verbatim** from `page-extractor.ts`
    (currently ~lines 1005–1145) into `src/onboarding/shopify-json.ts`.
  - `shopify-json.ts` must be **pure**: depend only on `node:vm` and TypeScript
    types (no `bun:sqlite`, no DB). Export `extractProductJsonFromHtml` and
    `collectProductJsonCandidates`.
  - In `page-extractor.ts`, replace the moved code with
    `import { extractProductJsonFromHtml } from './shopify-json';` (and the
    candidate fn if used elsewhere). Keep the call sites
    (`extractProductJsonFromHtml(html)` at ~line 127 and the rendered
    `window.productJSON` path at ~line 314 unchanged — the rendered path uses
    `page.evaluate` so it does **not** need the shared fn).
- **Why:** `profile-generator.ts` and the trusted extractor (`extract.ts`) must both
  parse `productJSON` without importing `page-extractor.ts` (which is Bun/DB-bound
  and would break `profile-generator`'s pure vitest suite). A single pure module is
  the shared source of truth (per AGENTS.md "shared schemas/utilities" guidance).
- **Acceptance:**
  - `bun run typecheck` clean.
  - Existing `page-extractor` behaviour unchanged: any existing page-extractor tests
    still pass; `extractProductJsonFromHtml` returns identical output for the same
    input.
  - `import { extractProductJsonFromHtml } from '../onboarding/shopify-json'` resolves
    from `src/tests/...` without pulling `bun:sqlite`.

---

#### Task A1 — Unconstrain the LLM prompt and pass the minimized DOM
- **Files:** `src/onboarding/profile-generator.ts` (functions `buildLlmPrompt`,
  `generateExtractorProfile`; constant near `MAX_MINIMIZED_BYTES`).
- **Changes:**
  - Add `const MAX_LLM_DOM_BYTES = 60_000;` (separate from the 200KB validation cap).
    The DOM payload sent to the LLM is `minimized.slice(0, MAX_LLM_DOM_BYTES)` +
    `'<!--truncated-->'` when truncated.
  - Change `buildLlmPrompt` signature from
    `(candidates, variantCandidates, expected?)` to
    `(candidates, variantCandidates, minimizedDom, expected?)`.
  - Replace the user prompt body. **Exact new user prompt text:**

    ```
    You are a CSS selector expert. Write the best CSS selector for each product field for the product page below. The candidate list is provided as HINTS only — you MAY write a selector that is NOT in the candidate list when you can see a more stable or more accurate one in the minimized DOM. Prefer stable, semantic selectors (data-testid, itemprop, semantic class names) over positional pseudo-selectors (nth-of-type).
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
    }
    ```

  - Keep the system prompt unchanged:
    `'You are a precise assistant that returns ONLY valid JSON. No markdown, no commentary, no code fences.'`
  - In `generateExtractorProfile`, after computing `minimized`, pass
    `minimized.slice(0, MAX_LLM_DOM_BYTES)` (with truncation marker) as the new
    `minimizedDom` argument to `buildLlmPrompt`. The full `minimized` is still used
    for `buildSelectorCandidates` and (via the original `html`) for variant
    candidates.
- **New LLM JSON output schema (authoritative):**
  ```json
  {
    "titleSelector": "string | null",
    "descriptionSelector": "string | null",
    "imagesSelector": "string | null",
    "shopifyJSONPath": "boolean",
    "variantSelectionStrategy": {
      "containerSelector": "string | null",
      "optionType": "dropdown | button_group | radio | unknown",
      "detectedOptions": ["string"],
      "optionFields": ["string"]
    } | null
  }
  ```
- **Acceptance:**
  - The prompt string contains "you MAY write a selector that is NOT in the candidate
    list" (verifiable by reading the file).
  - `buildLlmPrompt` includes a `MINIMIZED PRODUCT DOM` section (non-empty when HTML
    is non-empty).
  - Unit test: with a mocked LLM returning a selector **not** present in the
    candidate list (e.g. `.product__media-wrapper`), `generateExtractorProfile`
    returns it unchanged (no filtering against candidates).

---

#### Task A2 — Add `shopifyJSONPath` to the profile shape, parser, and storage
- **Files:**
  - `src/onboarding/profile-generator.ts` (`GeneratedSelectorProfile`,
    `shapeFromParsed`, `validateGeneratedProfile`)
  - `src/shared/schemas/onboarding.ts` (`ExtractorProfileSchema`)
  - `src/db/migrations.ts` (extractor_profiles migration block ~lines 57–88)
  - `src/db/repositories/extractor-profile-repo.ts` (`ExtractorProfile`,
    `DbProfile`, `mapToProfile`, `upsertProfile`)
  - `src/onboarding/profile-promoter.ts` (`resolveSelectors`,
    `selectorsFromRevision`, `promoteGeneratedProfile` writeSelectors)
- **Changes:**
  - `GeneratedSelectorProfile`: add `shopifyJSONPath: boolean;` (default `false`).
    Remove `priceSelector` and `brandSelector` from this interface (see Task A4).
  - `shapeFromParsed`: parse `obj.shopifyJSONPath` → boolean (default `false`).
    Remove the `priceSelector`/`brandSelector` initialisations on `out`.
  - `ExtractorProfileSchema`: **add** `shopifyJSONPath: z.boolean().default(false)`.
    **Keep** `priceSelector`/`brandSelector` as nullable on this *storage* schema
    (legacy columns remain; the trusted extractor still reads them).
  - **Migration:** add a column-add block mirroring the existing
    `sitemap_product_url_pattern` pattern (~lines 80–88):
    ```ts
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(c => c.name === 'shopify_json_path')) {
      db.exec('ALTER TABLE extractor_profiles ADD COLUMN shopify_json_path INTEGER NOT NULL DEFAULT 0;');
    }
    ```
  - `extractor-profile-repo.ts`: add `shopify_json_path INTEGER` to `DbProfile`;
    `mapToProfile` returns `shopifyJSONPath: !!db.shopify_json_path`;
    `upsertProfile` accepts `shopifyJSONPath?: boolean | null` and applies the same
    merge semantics as other selectors (default `false` on insert; preserve existing
    on update when `undefined`; `true`/`false` writes). Update the `UPDATE`/`INSERT`
    SQL to include `shopify_json_path`.
  - `profile-promoter.ts`: `selectorsFromRevision` returns `shopifyJSONPath`
    (default `false`); in `promoteGeneratedProfile`, include
    `shopifyJSONPath: selectors.shopifyJSONPath` in `writeSelectors` when the
    operator approved any field (it's a domain-level strategy flag, written
    alongside the approved selectors — not a per-field approval).
- **Naming note / clarification:** `shopifyJSONPath` is typed as a **boolean**
  ("prefer the embedded Shopify productJSON for title/description/images") rather
  than a string path, because Shopify exposes a single canonical
  `window.productJSON`/`var meta` object. If the reviewer prefers a literal JSON
  pointer path, change to `z.string().nullable()` — flagged in Risks.
- **Acceptance:**
  - A profile promoted with `shopifyJSONPath: true` persists `shopify_json_path = 1`
    in `extractor_profiles` and round-trips through `findProfileByDomain`.
  - Existing profiles default to `shopifyJSONPath: false` after migration.
  - `profile-promoter.test.ts` updated; existing promoter tests still pass.

---

#### Task A3 — Generate and persist a `seedPreview` at proposal time
- **Files:**
  - `src/onboarding/profile-generator.ts` (new exported `buildSeedPreview`)
  - `src/server/routes/onboarding-routes.ts` (`/generate-profile` route ~lines
    1340–1390)
  - `src/onboarding/profile-governance-service.ts`
    (`createInitialRevisionForGeneration` already copies `fieldSamples` — no change
    needed; verify)
- **Changes:**
  - Add `buildSeedPreview(html, profile, sourceUrl)` to `profile-generator.ts`
    (pure; imports `cheerio`, `./image-utils`
    (`collectImageSourcesFromElement`, `cleanAndDeduplicateImages`, `addImageSource`),
    and `./shopify-json` (`extractProductJsonFromHtml`)). Returns:
    ```ts
    interface SeedPreview {
      title: string | null;
      description: string | null;
      images: string[];          // absolute, deduped URLs
      variantOptions: string[];  // e.g. ["Small", "Medium", "Large"]
      strategy: 'shopify-json' | 'css';
      variantSelectionStrategy: GeneratedSelectorProfile['variantSelectionStrategy'];
    }
    ```
    Logic:
    - If `profile.shopifyJSONPath` **and** `extractProductJsonFromHtml(html)` returns
      an object: `title` = `productJSON.title`; `description` = stripped
      `productJSON.body_html` (fall back to `productJSON.description`);
      `images` = `productJSON.images.map(i => i.src)` (or `media`), resolved
      absolute; `variantOptions` = flatten `productJSON.options.map(o => o.values)`;
      `strategy = 'shopify-json'`.
    - Else (CSS): `title` = `$(titleSelector).first().text()`; `description` =
      `$(descriptionSelector).first().text()`; `images` = collected+d eduped URLs
      from `imagesSelector` (reuse the governance service's
      `collectImageSourcesFromElement` + `cleanAndDeduplicateImages` pattern);
      `variantOptions` = derived from `variantSelectionStrategy.detectedOptions`
      when present; `strategy = 'css'`.
    - `variantSelectionStrategy` is passed through from `profile` for the UI.
  - In the `/generate-profile` route, after `validateGeneratedProfile(...)`, call
    `buildSeedPreview(html, generated, resolvedUrl)` and merge into the
    `fieldSamples` record passed to `insertProfileGeneration`:
    ```ts
    fieldSamples: { ...validation.fieldSamples, seedPreview: buildSeedPreview(...) }
    ```
    Store inside `field_samples_json` (no new column). The initial revision inherits
    it via `createInitialRevisionForGeneration`.
- **Acceptance:**
  - After generation, `GET /settings/profile-generations/:id` returns a revision
    whose `fieldSamples.seedPreview` contains a non-null `title`, ≥1 image URL, and
    `strategy`.
  - Unit test: `buildSeedPreview` on a Shopify HTML fixture with
    `shopifyJSONPath:true` returns `strategy:'shopify-json'` and the productJSON
    title/images.
  - Unit test: `buildSeedPreview` with CSS-only selectors returns `strategy:'css'`
    and the selector-derived title.

---

#### Task A4 — Remove `price`/`brand` from the review/approval field set
- **Files:**
  - `src/onboarding/profile-generator.ts` (`GeneratedSelectorProfile`,
    `validateGeneratedProfile`, `shouldAttemptProfileGeneration`)
  - `src/shared/schemas/onboarding.ts` (`SELECTOR_FIELDS`, `SelectorFieldEnum` doc
    comment)
  - `src/onboarding/profile-promoter.ts` (`SELECTOR_KEYS`, `selectorsFromRevision`,
    `promoteGeneratedProfile` normalizedApproval)
  - `src/onboarding/profile-governance-service.ts` (`tally()`,
    `evaluateSelectorOnSample` price branch, `textFieldsHaveStrongEvidence`/
    `textFieldsHaveLimitedEvidence`)
- **Design decision (low-risk, non-breaking):**
  - **Keep** `SelectorFieldEnum` as the 5-member union (`titleSelector`,
    `priceSelector`, `descriptionSelector`, `brandSelector`, `imagesSelector`) so
    historical `profile_generation_field_decisions` rows with `price`/`brand` still
    parse and `StructuredFeedback` types stay valid.
  - **Change the iterating arrays** to the 3 active fields:
    - `SELECTOR_FIELDS` (in `onboarding.ts`) →
      `['titleSelector', 'descriptionSelector', 'imagesSelector']`. Update the
      doc comment from "five selector fields" to "active selector fields managed in
      review/approval (price/brand retained on the enum for historical rows only)".
    - `SELECTOR_KEYS` (in `profile-promoter.ts`) → same 3 fields.
  - This removes price/brand from every review table and the approval write path
    (both iterate the arrays) without breaking historical data.
- **`profile-generator.ts` changes:**
  - `GeneratedSelectorProfile`: drop `priceSelector` and `brandSelector`.
  - `validateGeneratedProfile`: delete the `if (selectors.priceSelector) {…}` and
    `if (selectors.brandSelector) {…}` blocks. Re-tune confidence weights so a
    title+description+images+expected pass still clears the `valid` threshold (≥0.5)
    and `readyForReview` (≥0.8): title `0.45`, description `0.15`, images `0.10`,
    expected-name `0.10` (max ≈ 0.80). Keep the `:nth-of-type` low-stability flag.
  - `shouldAttemptProfileGeneration`: replace
    `hasImprovementTarget = !description || !brand` with
    `hasImprovementTarget = !input.extractionResult.description` (brand is no longer
    a managed selector field). Keep the price-only exclusion as-is.
- **`profile-governance-service.ts` changes:**
  - `tally()` (the local `EMPTY_FIELD_TALLY` initializer): keep only
    `titleSelector`, `descriptionSelector`, `imagesSelector` (remove
    `priceSelector`/`brandSelector`).
  - `evaluateSelectorOnSample`: delete the `if (field === 'priceSelector') {…}`
    numeric-check branch (the loop no longer visits price since `SELECTOR_KEYS`
    dropped it).
  - `textFieldsHaveStrongEvidence`/`textFieldsHaveLimitedEvidence`: change the field
    list from `['titleSelector','descriptionSelector','brandSelector']` to
    `['titleSelector','descriptionSelector']`.
- **`profile-promoter.ts` changes:**
  - `SELECTOR_KEYS` → 3 fields. `normalizedApproval` initialiser drops price/brand.
    `selectorsFromRevision` no longer reads price/brand.
- **Acceptance:**
  - `bun run typecheck` + `bun run test` pass.
  - `validateGeneratedProfile` no longer references `priceSelector`/`brandSelector`.
  - Promoting a generation writes only title/description/images (+
    `shopifyJSONPath`); price/brand columns in `extractor_profiles` are untouched by
    promotion.
  - `profile-generator.test.ts`, `profile-governance-service.test.ts`,
    `profile-promoter.test.ts` updated (mocked LLM payloads drop price/brand; add
    `shopifyJSONPath`).

---

#### Task A5 — Extend the `/extractor-profiles/test` route to support the full preview
- **Files:** `src/server/routes/onboarding-routes.ts` (`/extractor-profiles/test`
  route ~lines 1395–1475), `src/client/onboarding-api.ts`
  (`testExtractorProfile` signature ~line 401).
- **Changes:**
  - Destructure `shopifyJSONPath` and `variantSelectionStrategy` from the request
    body (in addition to the CSS selectors). Keep accepting `priceSelector`/
    `brandSelector` for backward compat but do not render them in the result.
  - In the `page.evaluate`, when `shopifyJSONPath` is true, also extract
    `window.productJSON` (and the `var meta`/`*_product_data` patterns via a small
    in-page scan) and prefer it for `title`/`description`/`images`; fall back to CSS
    selectors. Expose `variantOptions` derived from `productJSON.options` or from
    `variantSelectionStrategy.detectedOptions`.
  - Return shape: `{ success, extracted: { title, description, images, variantOptions } }`
    (drop `price`/`brand` from the typed `ExtractorTestResult`).
  - Update `testExtractorProfile` client signature to accept `shopifyJSONPath?:
    boolean` and `variantSelectionStrategy?` and return the new shape.
- **Why:** Phase B's preview panel needs an on-demand preview for **feedback
  revisions** (which lack a stored `seedPreview`). This route already fetches + runs
  selectors in Playwright; extending it avoids a second fetch path.
- **Acceptance:**
  - `POST /extractor-profiles/test` with `shopifyJSONPath:true` on a Shopify fixture
    returns the productJSON title and ≥1 image.
  - The drawer's existing preview button continues to work with the new return
    shape.

---

#### Task A6 — (Optional, lower priority) Consume `shopifyJSONPath` in the trusted static extractor
- **Files:** `src/extraction-worker/routes/extract.ts` (`doStaticExtract`).
- **Changes:**
  - When `profile.selectors.shopifyJSONPath` is truthy, call
    `extractProductJsonFromHtml(html)` (from the new `shopify-json` module) and use
    its `title`/`description`/`images`/`variants` as the **preferred** source
    (mirroring `page-extractor`'s `mergeExtractionLayers` precedence), with the CSS
    selectors as fallback. The rendered path already auto-discovers `productJSON`
    via `page.evaluate`, so only the static path needs this.
- **Scope note:** This makes the stored `shopifyJSONPath` flag functional in
  production. If the reviewer wants to keep this phase strictly to
  proposal/review, this task can be **deferred** (flag the field as
  proposal-preview-only until a follow-up). See §5 Deferred.
- **Acceptance:**
  - Static extraction on a Shopify page with `shopifyJSONPath:true` returns
    productJSON-derived title even when `titleSelector` is empty.
  - Existing `extract.ts` tests still pass.

---

## 3. Phase B — Preview-Driven Review UI

### New component

#### Task B1 — `ProfileExtractionPreview.tsx`
- **File (new):** `src/client/components/ProfileExtractionPreview.tsx`
- **Purpose:** Present the extracted product data (not CSS strings) from a
  `seedPreview` (or an on-demand `testExtractorProfile` result for revisions
  lacking one).
- **Props:**
  ```ts
  interface ProfileExtractionPreviewProps {
    seedPreview: SeedPreview | null;     // from revision.fieldSamples.seedPreview
    sourceUrl: string;
    onDemandResult?: { title?: string; description?: string; images?: string[]; variantOptions?: string[] } | null;
    busy?: boolean;
  }
  ```
- **Renders:** extracted **title** (large), **description** (clamped), **image
  thumbnails** via the existing `ImagePreviewGrid` (compact, readOnly), and
  **variant option pills** (Phase C). Falls back to `onDemandResult` when
  `seedPreview` is null. Shows a `strategy` badge (`shopify-json` vs `css`).
- **Acceptance:**
  - Renders title/description/images/variantOptions from `seedPreview` with no
    network calls.
  - Image thumbnails use `ImagePreviewGrid`.

### Review flow state machine

The current flow (Generate → Validate → Approve, across Proposals + Validation
tabs) is replaced by a single **Review** state machine hosted in
`ProfileGenerationReview.tsx` (embedded in the merged Review tab).

```
                        ┌──────────────────────────────────────────────┐
                        │                                              │
   idle ──(load gen)──▶ previewing ──(Looks correct)──▶ validating ──┤ success
                          │   ▲                            │           │
                          │   │                            │ error     ▼
                   (Something's wrong)        (re-validate)       validated
                          │   ▲                            │           │
                          ▼   │                            │ promote   │
                       feedback ──(submit)──▶ previewing    ▼           ▼
                                                     promoting ──▶ promoted
```

**States** (`reviewState`):
- `idle` — no generation loaded.
- `previewing` — showing the seedPreview / on-demand preview. Buttons: **Looks
  correct**, **Something's wrong**.
- `validating` — `validateRevision(generationId, latestRevision.id)` in flight.
- `validated` — aggregate validation summary shown (passing/failing samples per
  field, image previews). Button: **Promote** (gated: ≥2 passing samples, image
  previews reviewed, no failing titles). Button: **Something's wrong**.
- `promoting` — `approveRevisionFields(all 3 fields, imagePreviewsReviewed)` in
  flight.
- `promoted` — success state; reload governance.
- `feedback` — `ProfileRevisionFeedbackForm` open; on submit calls
  `createRevisionFromFeedback`, then reloads → returns to `previewing` with the new
  revision.

**Transitions** (exact):
1. `idle --(generation loaded)--> previewing`
2. `previewing --(Looks correct)--> validating` [calls `validateRevision`]
3. `validating --(success)--> validated`
4. `validating --(error)--> previewing` (show error banner)
5. `validated --(Promote, gates met)--> promoting` [calls `approveRevisionFields`]
6. `promoting --(success)--> promoted` (reload governance)
7. `promoting --(error)--> validated` (show error banner)
8. `previewing|validated --(Something's wrong)--> feedback`
9. `feedback --(submit)--> previewing` (new revision loaded)

#### Task B2 — Rewrite `ProfileGenerationReview.tsx` to the preview flow
- **File:** `src/client/components/ProfileGenerationReview.tsx`
- **Changes:**
  - Replace the per-field approval table (`ProfileFieldValidationTable` usage) and
    the "Approve selected fields" / "Reject selected fields" button row with the
    state machine above.
  - Render `ProfileExtractionPreview` (Task B1) at the top using
    `latestRevision.fieldSamples?.seedPreview`. When absent (feedback revision),
    fire `testExtractorProfile({ url: generation.sourceUrl, ...proposedSelectors,
    shopifyJSONPath, variantSelectionStrategy })` on mount to populate
    `onDemandResult`.
  - Keep: revision history list, field-decisions & rollback list, delete
    generation. These remain useful audit surfaces below the preview.
  - Replace the bulk `submitApproval` with the **Promote** action that approves all
    3 active fields at once:
    `{ titleSelector: true, descriptionSelector: true, imagesSelector: true }`
    (only fields the proposal actually produced are written — the promoter already
    no-ops empty ones).
  - The image-approval gate (≥2 passing image samples + "I reviewed the previews"
    checkbox) stays, surfaced as a checkbox inside `validated`.
- **Acceptance:**
  - No "Approve selected fields" / per-field checkbox table remains.
  - "Looks correct" triggers validation; "Promote" only enables when gates met.
  - "Something's wrong" opens the feedback form and, after submit, returns to a fresh
    preview.

#### Task B3 — Merge Proposals + Validation tabs in `ProfileBuilderWorkspace.tsx`
- **File:** `src/client/components/ProfileBuilderWorkspace.tsx`
- **Changes:**
  - Change `TabId` from `'overview'|'snapshot'|'proposals'|'validation'` to
    `'build'|'review'|'advanced'`.
  - Replace the `proposals` and `validation` tab render functions with a single
    `renderReview()` that: lists generations (with Generate button) and, when one
    is selected, embeds `ProfileGenerationReview` (Task B2). Move the
    snapshot-driven "Run Validation" / "Promote to Healthy" checklist **into** the
    review component's `validated` state (the standalone Validation tab is removed).
  - Update `SELECTOR_FIELD_LABELS` (local const ~line 96) to drop `priceSelector`/
    `brandSelector`.
  - The Build tab's visual selection cards should drop price/brand (only title,
    description, images).
- **Acceptance:**
  - Only three tabs remain: Build (default), Review, Advanced.
  - The Generate → Preview → Validate → Promote path is reachable entirely within
    the Review tab.

#### Task B4 — Clean up `ProfileProposalDrawer.tsx` and `ProfileFieldValidationTable.tsx`
- **Files:** `src/client/components/ProfileProposalDrawer.tsx`,
  `src/client/components/ProfileFieldValidationTable.tsx`.
- **Changes:**
  - `ProfileProposalDrawer`: replace the local 5-field `SELECTOR_FIELDS` array with
    the 3-field `SELECTOR_FIELDS` imported from `../../shared/schemas/onboarding`
    (so it stays in sync). Update the per-field approval table and the
    `revisedSelectors` mapping loop (which iterates `['titleSelector',
    'priceSelector', 'descriptionSelector', 'brandSelector', 'imagesSelector']`)
    to the 3 active fields + `shopifyJSONPath`.
  - `ProfileFieldValidationTable`: trim `FIELD_LABELS` to the 3 active fields. (If
    B2 stops using this component entirely, mark it deprecated but keep the file
    for the read-only history view — confirm with reviewer.)
- **Acceptance:**
  - Neither component references `priceSelector`/`brandSelector` in its rendered
    output.
  - `bun run lint` + `typecheck` clean.

---

## 4. Phase C — Variant Strategy in Review

#### Task C1 — Surface `variantSelectionStrategy` in the preview
- **Files:** `src/client/components/ProfileExtractionPreview.tsx` (Task B1),
  `src/onboarding/profile-generator.ts` (`SeedPreview.variantSelectionStrategy`
  already carried through by Task A3).
- **Changes:**
  - When `seedPreview.variantSelectionStrategy` is non-null, render a "Variant
    strategy" subsection showing:
    - the detected option values as **pills** (reuse the `s.pill` style from
      `ProfileBuilderWorkspace`).
    - the `containerSelector` as a `<code>` snippet.
    - the `optionType` as a small badge.
  - When `variantOptions` (from productJSON/options) is non-empty, render those as
    pills too (distinct from the strategy's detected options).
- **Acceptance:**
  - A proposal with a `variantSelectionStrategy` shows the container selector and
    option pills in the preview panel.
  - A proposal with `variantSelectionStrategy: null` shows no variant subsection
    (no empty UI).

---

## 5. Deferred (out of scope)

- **Narrowing `SelectorFieldEnum` to 3 members.** Kept at 5 to preserve historical
  decision rows and feedback types. A future cleanup could narrow it and relax
  `ProfileGenerationFieldDecisionSchema.selectorField` to `z.string()`.
- **Rebuilding `seedPreview` for feedback revisions server-side.** Phase B uses
  on-demand `testExtractorProfile` for feedback revisions. A follow-up could have
  the revision-creation route re-fetch the seed URL and store a fresh
  `seedPreview`.
- **Trusted-extractor `shopifyJSONPath` consumption (Task A6).** Functional but
  optional in this phase; can be deferred to keep scope on proposal/review.
- **Removing the `price_selector`/`brand_selector` columns** from
  `extractor_profiles` (SQLite cannot `DROP COLUMN` cleanly pre-3.35; not worth a
  table rebuild). They remain nullable and unused by promotion.
- **Structured price feedback (`StructuredFeedbackPriceSchema`).** Left in place; it
  expresses "ignore price for domain", which is orthogonal to the selector-approval
  removal. Reviewer may choose to remove if desired.
- **LLM-driven revision pass** (the `profile_revision` LLM task that rewrites
  `selectors_json` from feedback). The feedback flow creates the revision row; the
  AI rewrite step itself is a separate, existing concern and is not changed here.

---

## 6. Implementation Order (dependencies)

```
A0 (shared shopify-json module)
 ├──▶ A1 (unconstrain prompt + DOM)
 ├──▶ A2 (shopifyJSONPath shape/schema/migration/repo/promoter)
 └──▶ A3 (buildSeedPreview) ──▶ A5 (extend test route)
A4 (remove price/brand) — independent of A0–A3; can parallelize
A6 (trusted extractor) — depends on A0 + A2; lowest priority
─────────────────────────────────────────────────────
B1 (ProfileExtractionPreview) — depends on A3 (SeedPreview shape)
B2 (rewrite ProfileGenerationReview) — depends on B1 + A5 (on-demand preview)
B3 (merge tabs) — depends on B2
B4 (drawer + validation table cleanup) — depends on A4; parallel with B2/B3
─────────────────────────────────────────────────────
C1 (variant surfacing) — depends on B1
```

Recommended sequence: **A0 → A1 → A2 → A3 → A4 → A5 → (A6 optional) → B1 → B2 →
B3 → B4 → C1**. Run `bun run typecheck` and `bun run test` after A4 and after each
Phase B task.

---

## 7. Risk Assessment

1. **Prompt-injection / token cost (A1).** Passing the minimized DOM to the LLM
   reverses a deliberate safety/token optimisation (the code comment says
   candidate-constraining "dramatically improves selector stability and reduces
   prompt-injection risk"). Mitigations: `MAX_LLM_DOM_BYTES = 60_000` cap; keep
   candidate hints; `validateGeneratedProfile` still rejects bad selectors;
   `isSupportedSelectorSyntax` still blocks XPath/`:has()`. **Validate** the DOM
   payload size on a real Shopify PDP before shipping.
2. **`shopifyJSONPath` naming/typing ambiguity (A2).** Typed as boolean; the name
   implies a path. If the reviewer expects a JSON-pointer string, A2's schema +
   `buildSeedPreview` logic must change. **Needs reviewer confirmation.**
3. **Historical decision rows (A4).** If any `profile_generation_field_decisions`
   row has `selector_field` = `priceSelector`/`brandSelector`, narrowing the enum
   would break loads. The plan keeps the enum at 5 to avoid this — verify no code
   path assumes `SELECTOR_FIELDS` has 5 members (search all imports).
4. **Migration column-add idempotency (A2).** The `ALTER TABLE … ADD COLUMN`
   pattern must be wrapped in the `PRAGMA table_info` check (matching the existing
   `sitemap_product_url_pattern` block) or it will throw on re-run. Verify the
   migration runs cleanly on an already-migrated DB.
5. **`profile-generator.ts` must stay pure (A3).** Importing `page-extractor.ts`
   would pull Bun/DB deps and break the vitest suite. Task A0's shared pure module
   is mandatory — do not shortcut by importing `page-extractor` directly.
6. **Playwright in the test route (A5).** The `/extractor-profiles/test` route
   launches Chromium; extending its `page.evaluate` must not regress the existing
   preview button. Keep the CSS-only path as the fallback when
   `shopifyJSONPath` is false.
7. **UI regression surface (B2/B3).** The drawer and workspace are large components
   with inline-styled state. The merge must preserve the snapshot tab and the
   overview's active-profile table. Recommend screenshot/manual smoke after B3.
8. **Backward-compat of stored generations.** Existing `profile_generations` rows
   lack `seedPreview` in `field_samples_json`. The UI must gracefully fall back to
   on-demand preview (A5) for these — do not assume `seedPreview` is always
   present.
9. **Scope creep into the auto-trigger.** `shouldAttemptProfileGeneration` is only
   lightly touched (drop brand from the improvement target). Do not redesign the
   trigger in this overhaul.

---

## Files to Modify (summary)

- `src/onboarding/shopify-json.ts` — **new**, pure productJSON parser.
- `src/onboarding/page-extractor.ts` — import from `shopify-json.ts`; remove moved
  code.
- `src/onboarding/profile-generator.ts` — unconstrain prompt; add `shopifyJSONPath`;
  `buildSeedPreview`; drop price/brand; re-tune validation.
- `src/shared/schemas/onboarding.ts` — `ExtractorProfileSchema.shopifyJSONPath`;
  `SELECTOR_FIELDS` → 3 fields.
- `src/db/migrations.ts` — `shopify_json_path` column migration.
- `src/db/repositories/extractor-profile-repo.ts` — `shopifyJSONPath` in
  interface/`DbProfile`/`mapToProfile`/`upsertProfile`.
- `src/onboarding/profile-promoter.ts` — `SELECTOR_KEYS` → 3; carry
  `shopifyJSONPath` on promote.
- `src/onboarding/profile-governance-service.ts` — `tally()` 3 fields; drop price
  branch; adjust evidence field lists.
- `src/server/routes/onboarding-routes.ts` — store `seedPreview` in
  `/generate-profile`; extend `/extractor-profiles/test`.
- `src/client/onboarding-api.ts` — `testExtractorProfile` new shape.
- `src/client/components/ProfileExtractionPreview.tsx` — **new** preview panel.
- `src/client/components/ProfileGenerationReview.tsx` — rewrite to preview state
  machine.
- `src/client/components/ProfileBuilderWorkspace.tsx` — merge tabs; drop
  price/brand labels.
- `src/client/components/ProfileProposalDrawer.tsx` — import shared
  `SELECTOR_FIELDS`; drop price/brand.
- `src/client/components/ProfileFieldValidationTable.tsx` — trim `FIELD_LABELS`.
- `src/extraction-worker/routes/extract.ts` — (optional A6) consume
  `shopifyJSONPath` in static path.
- Tests: `src/tests/unit/profile-generator.test.ts`,
  `src/tests/unit/profile-promoter.test.ts`,
  `src/tests/unit/profile-governance-service.test.ts`,
  `src/tests/unit/page-extractor-profile-generation.test.ts` (if it asserts the
  prompt/candidate constraint).

## New Files
- `src/onboarding/shopify-json.ts` — pure Shopify `productJSON` extraction (moved
  from `page-extractor.ts`).
- `src/client/components/ProfileExtractionPreview.tsx` — preview-driven review
  panel.

## Dependencies
See §6. A0 unblocks A1/A2/A3; A3 + A5 unblock B1/B2; B2 unblocks B3; A4 is
independent; C1 depends on B1.
