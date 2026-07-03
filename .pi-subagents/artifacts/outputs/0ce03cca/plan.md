# Implementation Plan: Visual Element Picker for Profile Building

## Goal

Build a three-layer hybrid selector strategy where the AI proposes selectors (Layer 1, existing), users can paste an element's outerHTML to generate a stable selector (Layer 2, new), and users can click on elements in a headful browser to generate selectors (Layer 3, new) — all flowing through the existing revision → validation → per-field approval → promotion pipeline.

## Architecture Summary (from codebase analysis)

The current system works as follows:
- `profile-generator.ts` builds a minimized DOM from product page HTML, extracts candidate elements, and asks an LLM to produce CSS selectors (`titleSelector`, `descriptionSelector`, `imagesSelector`).
- `buildStableSelector()` (line 318 of `profile-generator.ts`) generates stable CSS selectors from Cheerio DOM elements using a 6-tier priority hierarchy: unique id → stable data-* attrs → itemprop → semantic class → ancestor+child → nth-of-type (low stability).
- The extraction worker (`src/extraction-worker/server.ts`) is a separate Node.js HTTP server (port 3032) using Playwright. It has routes: `/health`, `/profile-tooling/snapshot`, `/profile-tooling/validate`, `/profile-runner/extract`.
- The Bun API server proxies all client→worker calls via `src/server/extraction-worker-client.ts`. The client never talks to the worker directly.
- `ProfileRevisionFeedbackForm.tsx` already has a `manualSelectorHint` text input (buried under "Advanced: I know the CSS selector"). It currently just appends the hint to the notes string — it does NOT generate a selector from it.
- The `ProfileGenerationRevisionSourceEnum` already includes `'manual_css'` as a valid source value.
- Structured feedback creates revisions via `reviseProfileFromStructuredFeedback()` in `profile-governance-service.ts`, which stores feedback and leaves `selectors_json` unchanged for a future LLM pass.

---

## Tasks

### Phase 1: Extract `buildStableSelector` into a shared module

#### Task 1: Create `src/shared/selector-utils.ts`
- **File:** `src/shared/selector-utils.ts` (new)
- **Changes:** Move the following functions and constants from `src/onboarding/profile-generator.ts` into this new file:
  - `STABLE_DATA_ATTRS` (line 265) — array of stable data-* attribute names
  - `SEMANTIC_HINT_SUBSTRINGS` (line 275) — record of field → semantic class substrings
  - `isLikelyGeneratedId()` (line 288) — detects auto-generated IDs
  - `classSet()` (line 301) — lowercases class string into a Set
  - `attrSelector()` (line 311) — builds a CSS attribute selector
  - `buildStableSelector()` (line 318) — the core function; takes `cheerio.CheerioAPI` + `cheerio.Element`, returns `{ selector, stability }`
  - `snippetOf()` (line 423) — trimmed text snippet from a Cheerio element
  - `isSupportedSelectorSyntax()` (line 796) — validates selector syntax (no XPath, no `:has()`, etc.)
- **Constraints:**
  - The module must import ONLY from `cheerio` (which is available in both Bun and Node.js). It must NOT import from `llm-client.ts`, `extraction-validator.ts`, `shopify-json.ts`, or `image-utils.ts` — those are Bun-dependent.
  - All functions should be `export`ed.
  - Add a `Stability` type: `export type Stability = 'high' | 'medium' | 'low';`
  - Add an exported `BuildStableSelectorResult` interface: `{ selector: string; stability: Stability }`.
- **Acceptance:** `bun run typecheck` passes with the new file. The module has zero imports from Bun-only modules.

#### Task 2: Update `profile-generator.ts` to import from the shared module
- **File:** `src/onboarding/profile-generator.ts`
- **Changes:**
  - Add import: `import { buildStableSelector, isLikelyGeneratedId, isSupportedSelectorSyntax, classSet, attrSelector, snippetOf, STABLE_DATA_ATTRS, SEMANTIC_HINT_SUBSTRINGS, type Stability } from '../shared/selector-utils';`
  - Remove the moved function and constant definitions from `profile-generator.ts` (lines 265–287, 288–300, 301–310, 311–317, 318–422, 423–429, 796–815).
  - Keep `nearbyLabelsOf()` (line 430) and `kindHintsFor()` (line 476) in `profile-generator.ts` — they are only used by `buildSelectorCandidates` and are not needed by the worker.
  - Keep `CURRENCY_PATTERN`, `PLAIN_NUMERIC_PRICE` constants in `profile-generator.ts` — they are only used by `kindHintsFor`.
- **Acceptance:** `bun run typecheck` passes. Existing profile-generation tests (`page-extractor-profile-generation.test.ts`) still pass. `bun run test` is green.

#### Task 3: Add unit tests for `src/shared/selector-utils.ts`
- **File:** `src/tests/unit/selector-utils.test.ts` (new)
- **Changes:** Add tests covering:
  - `buildStableSelector` with a unique stable id → returns `#id`, stability `'high'`
  - `buildStableSelector` with a `data-testid` attribute → returns `tag[data-testid="..."]`, stability `'high'`
  - `buildStableSelector` with `itemprop="name"` → returns `tag[itemprop="name"]`, stability `'high'`
  - `buildStableSelector` with a semantic class (e.g. `product-title`) → returns `tag.product-title`, stability `'medium'`
  - `buildStableSelector` with only positional info → returns `tag:nth-of-type(n)`, stability `'low'`
  - `buildStableSelector` skips auto-generated ids (React `__`, CSS modules `--`, hex hashes, numeric-only)
  - `isSupportedSelectorSyntax` rejects XPath (`//div`), `:has()`, `:is()`, `:where()`, empty strings
  - `isSupportedSelectorSyntax` accepts valid CSS (`h1`, `.product-title`, `[itemprop="name"]`, `div:nth-of-type(2)`)
  - `isLikelyGeneratedId` returns `true` for `__react-key`, `--css-module`, `a1b2c3d4`, `123`, `section-1`; returns `false` for `product-title`, `main`
- **Acceptance:** `bun run test src/tests/unit/selector-utils.test.ts` passes.

---

### Phase 2: Paste-Element-to-Selector

#### Task 4: Add Zod schemas for the generate-selector request/response
- **File:** `src/shared/schemas/extraction-worker.ts`
- **Changes:** Add two new schemas after the Snapshot section:
  ```typescript
  // ─── Generate Selector (Paste-Element) ───────────────────────────────────
  export const GenerateSelectorRequestSchema = z.object({
    /** Full page HTML (used to check selector uniqueness across the page). */
    html: z.string().min(1),
    /** The outerHTML of the element the user selected/copied from DevTools. */
    outerHTML: z.string().min(1),
  });
  export type GenerateSelectorRequest = z.infer<typeof GenerateSelectorRequestSchema>;

  export const GenerateSelectorResponseSchema = z.object({
    selector: z.string(),
    stability: z.enum(['high', 'medium', 'low']),
    extractedText: z.string().nullable().default(null),
    extractedImages: z.array(z.string()).default(() => []),
    matchCount: z.number().int(),
    warnings: z.array(z.string()).default(() => []),
  });
  export type GenerateSelectorResponse = z.infer<typeof GenerateSelectorResponseSchema>;
  ```
- **Acceptance:** `bun run typecheck` passes.

#### Task 5: Create worker route `POST /profile-tooling/generate-selector`
- **File:** `src/extraction-worker/routes/generate-selector.ts` (new)
- **Changes:**
  - Import `cheerio` and the shared `buildStableSelector`, `isSupportedSelectorSyntax` from `../../shared/selector-utils`.
  - Import `GenerateSelectorRequestSchema`, `GenerateSelectorResponseSchema` from `../../shared/schemas/extraction-worker`.
  - Import `collectImageSourcesFromElement` logic — but note the worker cannot import `image-utils.ts` (Bun-dependent). Re-implement a minimal `extractImagesFromElement($, el)` inline (the snapshot route already duplicates image helpers — follow the same pattern at `snapshot.ts` line ~210).
  - Handler signature: `export function handleGenerateSelector(req: IncomingMessage, res: ServerResponse): void`
  - Logic:
    1. Parse and validate request body with `GenerateSelectorRequestSchema`.
    2. Load the full page HTML with `cheerio.load(html)`.
    3. Parse the `outerHTML` string — load it in a separate Cheerio instance, find the root element, then find that same element in the full-page DOM by matching tag + attributes.
    4. Call `buildStableSelector($, el)` on the matched element in the full-page DOM.
    5. Count matches: `$(selector).length` to verify uniqueness.
    6. Extract text: `$(selector).first().text().trim()` (for title/description fields).
    7. Extract images: if the element is or contains `<img>` tags, collect their `src`/`data-src`/`srcset` URLs using the inline image helper.
    8. Validate the selector with `isSupportedSelectorSyntax`.
    9. Return `GenerateSelectorResponse` with `selector`, `stability`, `extractedText`, `extractedImages`, `matchCount`, and any `warnings` (e.g. "selector matches N elements — may not be unique").
  - Error handling: follow the snapshot route pattern — catch all errors, return a minimal response with the error in `warnings`, never throw.
- **Acceptance:** Worker route responds with valid JSON matching `GenerateSelectorResponseSchema`.

#### Task 6: Register the route in the worker server
- **File:** `src/extraction-worker/server.ts`
- **Changes:**
  - Add import: `import { handleGenerateSelector } from './routes/generate-selector';`
  - Add router entry after the snapshot route block:
    ```typescript
    if (method === 'POST' && url === '/profile-tooling/generate-selector') {
      handleGenerateSelector(req, res);
      return;
    }
    ```
- **Acceptance:** `bun run typecheck` passes. Worker server recognizes the new route.

#### Task 7: Add worker client function in `extraction-worker-client.ts`
- **File:** `src/server/extraction-worker-client.ts`
- **Changes:**
  - Import `GenerateSelectorRequestSchema`/`GenerateSelectorResponseSchema`/types from `../shared/schemas/extraction-worker`.
  - Import `GenerateSelectorResponseSchema` for response validation.
  - Add function:
    ```typescript
    export async function generateSelectorFromElement(
      request: GenerateSelectorRequest,
    ): Promise<{ ok: true; data: GenerateSelectorResponse } | { ok: false; error: string }> {
      return workerFetch(GenerateSelectorResponseSchema, {
        method: 'POST',
        path: '/profile-tooling/generate-selector',
        body: request,
        timeoutMs: 15_000,
      });
    }
    ```
- **Acceptance:** `bun run typecheck` passes.

#### Task 8: Add Bun proxy route for generate-selector
- **File:** `src/server/routes/onboarding-routes.ts`
- **Changes:**
  - Import `GenerateSelectorRequestSchema` from `../../shared/schemas/extraction-worker`.
  - Import `generateSelectorFromElement` from `../extraction-worker-client`.
  - Add a new route after the snapshot proxy route (around line 1150):
    ```typescript
    /**
     * POST /api/onboarding/settings/profile-tooling/generate-selector
     * Proxies to the extraction worker's generate-selector endpoint.
     * Accepts pasted element outerHTML + full page HTML, returns a
     * stable CSS selector + extracted text/images preview.
     */
    route.post('/onboarding/settings/profile-tooling/generate-selector', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
      }
      const parsed = GenerateSelectorRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ ok: false, error: 'Invalid request body', details: parsed.error.flatten() }, 400);
      }
      const result = await generateSelectorFromElement(parsed.data);
      if (!result.ok) {
        return c.json({ ok: false, error: result.error });
      }
      return c.json({ ok: true, data: result.data });
    });
    ```
- **Acceptance:** `bun run typecheck` passes. Route is registered.

#### Task 9: Add client API function in `onboarding-api.ts`
- **File:** `src/client/onboarding-api.ts`
- **Changes:**
  - Import `GenerateSelectorRequest`, `GenerateSelectorResponse` types from `../shared/schemas/extraction-worker`.
  - Add function:
    ```typescript
    export async function generateSelectorFromElement(
      req: GenerateSelectorRequest,
    ): Promise<{ ok: boolean; data?: GenerateSelectorResponse; error?: string }> {
      return request('/settings/profile-tooling/generate-selector', {
        method: 'POST',
        body: JSON.stringify(req),
      });
    }
    ```
- **Acceptance:** `bun run typecheck` passes.

#### Task 10: Update `ProfileRevisionFeedbackForm.tsx` — paste-element flow
- **File:** `src/client/components/ProfileRevisionFeedbackForm.tsx`
- **Changes:**
  - Add a new UI section above the "Advanced: I know the CSS selector" checkbox, labeled "Paste element HTML to generate a selector".
  - Add state: `const [pastedHtml, setPastedHtml] = useState<string>('');`, `const [generatedSelector, setGeneratedSelector] = useState<string | null>(null);`, `const [generating, setGenerating] = useState(false);`, `const [generateError, setGenerateError] = useState('');`.
  - The form needs the source page URL to fetch the full HTML. Add a new prop: `sourcePageUrl?: string | null`.
  - When the user pastes outerHTML and clicks "Generate Selector":
    1. Fetch the page HTML — either use the existing `testExtractorProfile` endpoint with just the URL (returns nothing useful for HTML), OR better: use the existing snapshot endpoint to get HTML. Actually, the simplest approach: the form already has access to the page URL from `ProfileProposalDrawer`. Add an input for the page URL if not provided, then call `snapshotPageForBuilder({ url, runtime: 'static', captureScreenshot: false, captureNetwork: false })` to get the HTML ref, OR — simpler — just send the outerHTML to the worker and have the worker fetch the page. But the worker generate-selector route needs full page HTML for uniqueness checking.
    2. **Revised approach:** Add a `pageUrl` prop. When "Generate" is clicked, call `generateSelectorFromElement({ html: '', outerHTML: pastedHtml })` — but the worker needs the full page HTML. So instead, have the client fetch the page HTML via a simple fetch to the URL (CORS may block this). The better path: the Bun server fetches the page server-side. Add a new lightweight Bun route `POST /api/onboarding/settings/profile-tooling/fetch-html` that takes `{ url }` and returns `{ html }`. Then the client calls fetch-html first, then generate-selector.
    3. **Simplest approach that fits existing patterns:** Add `pageUrl` as a required field in the paste-element section. When the user clicks "Generate", call a single new client function `generateSelectorFromPastedElement({ pageUrl, outerHTML })` that hits a new Bun route which: (a) fetches the page HTML server-side, (b) calls the worker's generate-selector endpoint. This keeps the client simple and avoids CORS.
  - Show the generated selector in a read-only code box with a stability badge (green=high, yellow=medium, red=low).
  - Show the extracted text/images preview inline.
  - Pre-fill the `manualSelectorHint` field with the generated selector (so it flows into the existing revision creation as `source: 'manual_css'`).
  - The generated selector also gets shown in the "Advanced" section so the user can see and edit it before submitting.
- **Acceptance:** User can paste an element's outerHTML, click "Generate Selector", see the generated CSS selector + extracted preview, and the selector is pre-filled into the manual hint field. Submitting the form creates a revision with the selector in the notes.

#### Task 11: Add server-side HTML fetch route (for paste-element flow)
- **File:** `src/server/routes/onboarding-routes.ts`
- **Changes:** Add a new route:
  ```typescript
  /**
   * POST /api/onboarding/settings/profile-tooling/fetch-html
   * Fetches raw HTML from a URL server-side (avoids CORS issues).
   * Used by the paste-element selector generation flow.
   */
  route.post('/onboarding/settings/profile-tooling/fetch-html', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const url = (body as any)?.url;
    if (!url || typeof url !== 'string') {
      return c.json({ ok: false, error: 'url is required' }, 400);
    }
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 ...', 'Accept': 'text/html,...' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return c.json({ ok: false, error: `HTTP ${response.status}` });
      }
      const html = await response.text();
      return c.json({ ok: true, html });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  ```
- **File:** `src/client/onboarding-api.ts`
- **Changes:** Add:
  ```typescript
  export async function fetchPageHtml(url: string): Promise<{ ok: boolean; html?: string; error?: string }> {
    return request('/settings/profile-tooling/fetch-html', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }
  ```
- **Acceptance:** Client can fetch page HTML server-side and pass it to the generate-selector endpoint.

#### Task 12: Wire paste-element selector into revision creation
- **File:** `src/onboarding/profile-governance-service.ts`
- **Changes:** In `reviseProfileFromStructuredFeedback()`, when the feedback notes contain `Advanced selector hint: <selector>`, parse the selector and apply it to the revision's `selectors_json` for the relevant field. Currently (line 582) the function "leaves `selectors_json` unchanged." Add logic:
  - If `input.notes` contains `Advanced selector hint:`, extract the selector string.
  - Determine which field is being revised from `input.feedback.field` (for text feedback) or `'imagesSelector'` (for image feedback).
  - Update the revision's `selectors` object: set the relevant field key to the extracted selector.
  - Set `source` to `'manual_css'` instead of `'manager_feedback'` when a manual selector hint is present.
- **Acceptance:** When a user submits feedback with a generated/pasted selector, the new revision's `selectors_json` contains the selector for the correct field, and the revision source is `manual_css`.

---

### Phase 3: Click-to-Select Visual Picker

#### Task 13: Add Zod schemas for the pick-element request/response
- **File:** `src/shared/schemas/extraction-worker.ts`
- **Changes:** Add:
  ```typescript
  // ─── Pick Element (Visual Picker) ────────────────────────────────────────
  export const PickElementRequestSchema = z.object({
    url: z.string().url(),
    /** Which field the user is selecting: title, description, or images. */
    field: z.enum(['title', 'description', 'images']),
    /** Whether to allow selecting a parent container (for image galleries). */
    allowParentContainer: z.boolean().default(true),
  });
  export type PickElementRequest = z.infer<typeof PickElementRequestSchema>;

  export const PickElementResponseSchema = z.object({
    selector: z.string(),
    stability: z.enum(['high', 'medium', 'low']),
    extractedText: z.string().nullable().default(null),
    extractedImages: z.array(z.string()).default(() => []),
    matchCount: z.number().int(),
    outerHTML: z.string().nullable().default(null),
    screenshotRef: z.string().nullable().default(null),
    warnings: z.array(z.string()).default(() => []),
  });
  export type PickElementResponse = z.infer<typeof PickElementResponseSchema>;
  ```
- **Acceptance:** `bun run typecheck` passes.

#### Task 14: Create worker route `POST /profile-tooling/pick-element`
- **File:** `src/extraction-worker/routes/pick-element.ts` (new)
- **Changes:**
  - Import `chromium` from `playwright`.
  - Import `cheerio`.
  - Import `buildStableSelector`, `isSupportedSelectorSyntax` from `../../shared/selector-utils`.
  - Import `PickElementRequestSchema`, `PickElementResponseSchema` from `../../shared/schemas/extraction-worker`.
  - Import `resolveArtifactDir`, `writeArtifact`, `generateJobId`, `extractDomainFromUrl` from `../artifacts`.
  - Handler: `export function handlePickElement(req: IncomingMessage, res: ServerResponse): void`
  - Logic:
    1. Parse and validate request with `PickElementRequestSchema`.
    2. Launch **headful** Playwright Chromium: `chromium.launch({ headless: false })`.
    3. Navigate to the URL with standard headers and a 25s timeout.
    4. Wait for networkidle + 2s dwell (same as snapshot route).
    5. Inject a JavaScript overlay via `page.addInitScript()` or `page.evaluate()`:
       - Create a fixed-position, high-z-index overlay bar at the top of the page with text "Click on the {field} element" and a "Cancel" button.
       - Add a `mouseover` listener that highlights the hovered element with a blue outline.
       - Add a `click` listener (preventDefault + stopPropagation) that:
         - Captures the clicked element's `outerHTML`.
         - Captures the element's tag name, attributes, text content, and image sources.
         - Sends the data back to Node via `window.__pickedElement` or a `page.exposeFunction()` callback.
    6. Use `page.exposeFunction('___pickElement', (data) => { ... })` to receive the picked element data.
    7. Wait for the user to click (with a 120s timeout — the user is interacting).
    8. Once the element is picked:
       - Get the full page HTML via `page.content()`.
       - Load it in Cheerio.
       - Find the clicked element in the Cheerio DOM by matching tag + attributes (use the outerHTML to find it).
       - Call `buildStableSelector($, el)`.
       - Count matches.
       - Extract text/images.
       - Take a screenshot for confirmation.
       - Close the browser.
    9. Return `PickElementResponse`.
  - Handle the image-gallery case: if `field === 'images'` and the clicked element is a single `<img>`, also check the parent container and offer it as an alternative (include both selectors in the response, or prefer the parent if it contains multiple images).
  - Error handling: same pattern as snapshot — catch all, return minimal response with warnings, never throw. If the browser can't launch headful (no display), return a warning "Headful browser not available — use paste-element flow instead."
- **Acceptance:** Worker route opens a headful browser, user can click an element, and the route returns a valid `PickElementResponse` with a generated selector.

#### Task 15: Register the pick-element route in the worker server
- **File:** `src/extraction-worker/server.ts`
- **Changes:**
  - Add import: `import { handlePickElement } from './routes/pick-element';`
  - Add router entry:
    ```typescript
    if (method === 'POST' && url === '/profile-tooling/pick-element') {
      handlePickElement(req, res);
      return;
    }
    ```
- **Acceptance:** `bun run typecheck` passes.

#### Task 16: Add worker client function for pick-element
- **File:** `src/server/extraction-worker-client.ts`
- **Changes:**
  - Import `PickElementRequestSchema`/`PickElementResponseSchema`/types.
  - Add function:
    ```typescript
    export async function pickElement(
      request: PickElementRequest,
    ): Promise<{ ok: true; data: PickElementResponse } | { ok: false; error: string }> {
      return workerFetch(PickElementResponseSchema, {
        method: 'POST',
        path: '/profile-tooling/pick-element',
        body: request,
        timeoutMs: 120_000, // user is interacting — long timeout
      });
    }
    ```
- **Acceptance:** `bun run typecheck` passes.

#### Task 17: Add Bun proxy route for pick-element
- **File:** `src/server/routes/onboarding-routes.ts`
- **Changes:**
  - Import `PickElementRequestSchema` and `pickElement`.
  - Add route after the generate-selector route:
    ```typescript
    /**
     * POST /api/onboarding/settings/profile-tooling/pick-element
     * Launches a headful browser for the user to click on an element.
     * Returns the generated selector + extracted preview.
     */
    route.post('/onboarding/settings/profile-tooling/pick-element', async (c) => {
      let body: unknown;
      try { body = await c.req.json(); } catch {
        return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
      }
      const parsed = PickElementRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ ok: false, error: 'Invalid request body', details: parsed.error.flatten() }, 400);
      }
      const result = await pickElement(parsed.data);
      if (!result.ok) {
        return c.json({ ok: false, error: result.error });
      }
      return c.json({ ok: true, data: result.data });
    });
    ```
- **Acceptance:** `bun run typecheck` passes.

#### Task 18: Add client API function for pick-element
- **File:** `src/client/onboarding-api.ts`
- **Changes:**
  - Import `PickElementRequest`, `PickElementResponse` types.
  - Add function:
    ```typescript
    export async function pickElementVisually(
      req: PickElementRequest,
    ): Promise<{ ok: boolean; data?: PickElementResponse; error?: string }> {
      return request('/settings/profile-tooling/pick-element', {
        method: 'POST',
        body: JSON.stringify(req),
      });
    }
    ```
- **Acceptance:** `bun run typecheck` passes.

#### Task 19: Create `ElementPickerButton` client component
- **File:** `src/client/components/ElementPickerButton.tsx` (new)
- **Changes:**
  - Props: `{ field: 'title' | 'description' | 'images'; url: string; onPicked: (result: PickElementResponse) => void; disabled?: boolean }`.
  - Renders a button "🖱️ Visually Select" that calls `pickElementVisually({ url, field, allowParentContainer: true })`.
  - While waiting, shows "Click on the element in the browser window…" with a spinner.
  - On success, calls `onPicked(result)`.
  - On error, shows the error message with a suggestion to use the paste-element fallback.
- **Acceptance:** Component renders, triggers the worker, and passes the result to the parent.

#### Task 20: Integrate `ElementPickerButton` into `ProfileProposalDrawer.tsx`
- **File:** `src/client/components/ProfileProposalDrawer.tsx`
- **Changes:**
  - Import `ElementPickerButton`.
  - In the per-field approval table, add a "Visually Select" button next to each field's "Suggest Revision" button.
  - When `onPicked` fires:
    1. Update the `revisedSelectors` state with the picked selector for that field.
    2. Show the extracted text/images preview inline (same as the preview results).
    3. The user can then click "Approve" to promote the field through the existing approval flow.
  - The picked selector does NOT bypass the approval invariant — it updates the proposal's selectors, but the user still must click "Approve" per field.
- **Acceptance:** User can click "Visually Select" per field, the headful browser opens, they click an element, and the selector + preview appears in the drawer. The user can then approve it.

#### Task 21: Integrate `ElementPickerButton` into `ProfileBuilderWorkspace.tsx`
- **File:** `src/client/components/ProfileBuilderWorkspace.tsx`
- **Changes:**
  - In the "Snapshot" tab, after a snapshot is taken, add a "Visually Select Elements" section that shows `ElementPickerButton` for each field (title, description, images).
  - When an element is picked, show the generated selector in the "Active Profile" table preview.
  - The user can then navigate to the "Review" tab to approve the selectors through the normal flow.
- **Acceptance:** Snapshot tab has visual picker buttons that produce selectors.

---

## Files to Modify

| File | Phase | Changes |
|---|---|---|
| `src/shared/selector-utils.ts` | 1 | **NEW** — extracted selector generation functions |
| `src/onboarding/profile-generator.ts` | 1 | Remove moved functions, import from shared module |
| `src/tests/unit/selector-utils.test.ts` | 1 | **NEW** — unit tests for extracted module |
| `src/shared/schemas/extraction-worker.ts` | 2, 3 | Add generate-selector and pick-element schemas |
| `src/extraction-worker/routes/generate-selector.ts` | 2 | **NEW** — worker route for paste-element |
| `src/extraction-worker/routes/pick-element.ts` | 3 | **NEW** — worker route for visual picker |
| `src/extraction-worker/server.ts` | 2, 3 | Register new routes |
| `src/server/extraction-worker-client.ts` | 2, 3 | Add client functions |
| `src/server/routes/onboarding-routes.ts` | 2, 3 | Add proxy routes |
| `src/client/onboarding-api.ts` | 2, 3 | Add client API functions |
| `src/client/components/ProfileRevisionFeedbackForm.tsx` | 2 | Paste-element UI |
| `src/onboarding/profile-governance-service.ts` | 2 | Wire manual selector into revision |
| `src/client/components/ElementPickerButton.tsx` | 3 | **NEW** — visual picker button |
| `src/client/components/ProfileProposalDrawer.tsx` | 3 | Integrate visual picker |
| `src/client/components/ProfileBuilderWorkspace.tsx` | 3 | Integrate visual picker in snapshot tab |

## New Files

- `src/shared/selector-utils.ts` — Stable CSS selector generation (extracted from profile-generator.ts, no Bun dependencies)
- `src/tests/unit/selector-utils.test.ts` — Unit tests for selector-utils
- `src/extraction-worker/routes/generate-selector.ts` — Worker route: paste-element → stable selector
- `src/extraction-worker/routes/pick-element.ts` — Worker route: headful browser click-to-select
- `src/client/components/ElementPickerButton.tsx` — UI button that triggers the visual picker

## Dependencies

- **Task 2** depends on **Task 1** (must create the shared module before importing from it).
- **Task 3** depends on **Task 1** (tests need the module to exist).
- **Task 5** depends on **Task 1** and **Task 4** (worker route needs the shared module and schemas).
- **Task 6** depends on **Task 5** (register the route handler).
- **Task 7** depends on **Task 4** (client needs the schema types).
- **Task 8** depends on **Task 7** (proxy route calls the client function).
- **Task 9** depends on **Task 4** (client API needs schema types).
- **Task 10** depends on **Task 9** and **Task 11** (form calls both generate-selector and fetch-html).
- **Task 11** is independent (can be done in parallel with Task 4–9).
- **Task 12** depends on **Task 10** (wiring depends on the form sending the selector hint).
- **Task 14** depends on **Task 1** and **Task 13** (worker route needs shared module and schemas).
- **Tasks 15–18** depend on **Task 14** and **Task 13**.
- **Task 19** depends on **Task 18** (component calls the client API).
- **Task 20** depends on **Task 19** (drawer uses the component).
- **Task 21** depends on **Task 19** (workspace uses the component).

**Critical path:** Task 1 → Task 2 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9 → Task 10 → Task 12 (Phase 2 complete). Then Task 13 → Task 14 → Task 15–18 → Task 19 → Task 20–21 (Phase 3 complete).

## Risks

1. **`buildStableSelector` extraction risk (MEDIUM):** The function uses `cheerio.CheerioAPI` and `cheerio.Element` types. Cheerio is available in both Bun and Node.js, so this is safe. However, the function currently accesses `el.name` (domhandler property) and `parentNode.tagName` — these are Cheerio internals that could differ between Cheerio versions. The extraction must preserve the exact same behavior. **Mitigation:** Run the existing `page-extractor-profile-generation.test.ts` tests after extraction to verify no behavioral change.

2. **Worker cannot import `image-utils.ts` (MEDIUM):** The `collectImageSourcesFromElement` function lives in `src/onboarding/image-utils.ts` which may have Bun dependencies. The snapshot route already duplicates image helpers inline. The generate-selector and pick-element routes must do the same. **Mitigation:** Copy the minimal image extraction logic (srcset parsing, data-URL/blob filtering) inline, following the snapshot route pattern.

3. **Headful browser availability (HIGH):** The click-to-select feature (Phase 3) requires a display. If the CMS runs in a headless environment (Docker, SSH), the headful browser won't open. **Mitigation:** The paste-element flow (Phase 2) is the fallback. The pick-element route should detect headful launch failure and return a clear error message directing the user to the paste-element flow. Do NOT make Phase 3 a hard dependency for Phase 2.

4. **Overlay injection breaking target pages (MEDIUM):** The JavaScript overlay injected into the target page could interfere with the page's own scripts, layout, or event handlers. **Mitigation:** Use `page.addInitScript()` to inject before page scripts run. Use a Shadow DOM for the overlay UI to avoid CSS conflicts. Use `stopImmediatePropagation()` on the click handler to prevent the page from reacting to the pick click. Clean up all listeners before returning.

5. **Element matching between live DOM and Cheerio (MEDIUM):** The pick-element route captures the clicked element's `outerHTML` from the live DOM, then needs to find that same element in the Cheerio-loaded `page.content()` HTML. Dynamic attributes (React keys, data-reactid) may differ between the live DOM snapshot and `page.content()`. **Mitigation:** Match by a combination of tag name + stable attributes (id, class, data-testid, itemprop) rather than exact outerHTML match. If no match is found, fall back to running `buildStableSelector` on a standalone Cheerio instance loaded with just the outerHTML (uniqueness check won't be possible but a selector can still be generated).

6. **Selector uniqueness in live DOM vs static HTML (LOW):** `buildStableSelector` checks uniqueness against the Cheerio-loaded HTML. In a live browser, dynamically-added elements may cause the selector to match more elements than expected. **Mitigation:** For Phase 3, additionally check uniqueness in the live DOM via `page.evaluate((sel) => document.querySelectorAll(sel).length)` before returning. If the live count differs from the Cheerio count, add a warning.

7. **Image gallery selection (MEDIUM):** When selecting images, users may click a single `<img>` rather than the gallery container. **Mitigation:** In the pick-element route, when `field === 'images'` and the clicked element is an `<img>`, automatically check the parent element. If the parent contains 2+ images, prefer the parent's selector and include both in the response with a note. The UI can offer "Use this element" vs "Use parent container (N images)".

8. **CORS for client-side HTML fetch (LOW):** The client cannot fetch arbitrary product page HTML directly due to CORS. **Mitigation:** Task 11 adds a server-side fetch-html route that bypasses CORS. This is already accounted for in the plan.

9. **Long-running pick-element request (LOW):** The pick-element route has a 120s timeout because the user is interacting. The Bun proxy and worker client must not time out before the worker. **Mitigation:** Set `timeoutMs: 120_000` in the worker client function (Task 16) and ensure the Bun route doesn't have its own shorter timeout.

10. **`reviseProfileFromStructuredFeedback` parsing of selector hints (LOW):** The current code appends `Advanced selector hint: <selector>` to the notes string. Task 12 parses this back out. This is fragile string parsing. **Mitigation:** Consider adding a dedicated `manualSelector` field to the `StructuredFeedback` schema instead of parsing notes. However, this widens scope (schema change + migration). For now, parse the notes string with a regex `Advanced selector hint: (.+)` and document the format clearly. If the selector contains newlines (unlikely for CSS selectors), this could break — but CSS selectors don't contain newlines.

## Invariant Compliance Checklist

| Invariant | How each phase respects it |
|---|---|
| Never auto-promote | Paste-element and visual-picker selectors flow into the revision as `source: 'manual_css'`. They still require per-field approval via `approveRevisionFields()` before writing to `extractor_profiles`. |
| Per-field approval | Both the paste-element form and the visual picker operate on one field at a time (the form's `field` prop, the picker's `field` parameter). |
| Image approval needs 2+ samples | The picked/pasted image selector is stored in the revision but cannot be approved without the existing governance gate in `approveRevisionFields()` which checks `readyForImageApproval` and `imagePreviewsReviewed`. |
| Revisions are versioned | Both flows call `reviseProfileFromStructuredFeedback()` / `createRevisionFromFeedback()` which creates a new revision row linked to its parent. |
| Worker is Node.js-only | `selector-utils.ts` imports only from `cheerio`. Worker routes import from `selector-utils.ts` and `cheerio` directly. No Bun-only imports. |
| Client never talks to worker directly | All new client calls go through Bun proxy routes (`/api/onboarding/settings/profile-tooling/generate-selector`, `.../pick-element`, `.../fetch-html`). |
