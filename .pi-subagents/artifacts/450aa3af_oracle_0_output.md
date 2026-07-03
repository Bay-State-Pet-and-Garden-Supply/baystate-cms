Now let me provide my final oracle recommendation.

---

## Oracle Recommendation: Visual Element Picker Strategy

### Inherited decisions

The codebase encodes several hard invariants that form the contract for any new work:

1. **AI-generated profiles are proposals only.** Promotion requires explicit per-field human approval. Never auto-promote, regardless of confidence. (`profile-promoter.ts` line 44, `profile-governance-service.ts` lines 1-30)
2. **Approval is per field.** Approving `titleSelector` does not approve `imagesSelector`. The promoter writes only explicitly-approved fields.
3. **Image-selector approval requires 2+ validated samples** plus operator attestation of image preview review.
4. **Selector revisions are versioned.** A revision from operator feedback is a new row linked to its parent. Revisions are never overwritten.
5. **The extraction worker is a separate Node.js HTTP server** (port 3032, bearer-token auth). It cannot import `bun:sqlite`. The Bun API server proxies all client requests to it via `extraction-worker-client.ts`. The client never talks to the worker directly.
6. **The system is local** — `127.0.0.1` binding, standalone local CMS. This makes headful browser interaction feasible.
7. **`buildStableSelector` already exists** (`profile-generator.ts` line 318) — it generates stable CSS selectors from Cheerio DOM elements using a 6-tier priority hierarchy: unique id → stable data-* attrs → itemprop → semantic class → ancestor+child → nth-of-type (low stability).

### Diagnosis

**What is actually going on:** The AI generates CSS selectors from a **textual DOM dump** (`getMinimizedDom` strips noise, compresses to ≤60KB, and feeds it to the LLM). The LLM never sees the rendered page. It guesses based on class names and data attributes, which are frequently non-semantic or auto-generated (CSS modules, React keys, Shopify section IDs — all explicitly filtered by `isLikelyGeneratedId`). The result is fragile selectors that work on one page but break on other product pages from the same domain.

**What the main agent may be missing:** The system already has 80% of the infrastructure needed for a click-to-select feature. The missing piece is surprisingly small:

- `buildStableSelector` already generates stable selectors from DOM elements — it just needs to be called with a user-selected element instead of an LLM-selected one
- Playwright is already in the worker with a `rendered` runtime
- The snapshot route already navigates pages and captures screenshots
- The `ProfileProposalDrawer` already has per-field preview/approve/reject UI
- The `ProfileRevisionFeedbackForm` already has a `manualSelectorHint` input (buried as "advanced")
- The worker is local (`127.0.0.1`) — headful browser interaction is feasible

The user's question ("should we have the user paste elements or click on them?") frames this as an either/or choice. It's not. The right answer is a **layered hybrid** where each layer catches what the previous missed.

### Drift / contradiction check

**Drift risk 1: Throwing away the AI layer entirely.** The user says "I don't think the AI is capable of finding these selectors." This is true for complex/non-standard sites, but the AI works fine for standard Shopify/WooCommerce themes with `itemprop="name"`, `data-testid` attributes, and semantic class names. Replacing AI entirely with manual selection would slow down onboarding for the easy 60% of domains to fix the hard 40%. The AI should remain the **proposal layer**; visual correction should be the **verification/correction layer**.

**Drift risk 2: Bypassing the per-field approval invariant.** A visual picker that directly writes selectors to `extractor_profiles` would violate the core safety invariant. The visually-selected selector must still flow through the existing revision → validation → per-field approval → promotion path. The picker is a **selector source**, not a **promotion mechanism**.

**Drift risk 3: Assuming the worker can run Cheerio's `buildStableSelector` directly.** The worker is Node.js-only and currently imports `playwright` and `cheerio` directly (see `snapshot.ts`). However, `buildStableSelector` lives in `profile-generator.ts` which imports from `llm-client.ts` (Bun-dependent). The selector generation logic needs to be either (a) extracted into a shared module with no Bun dependencies, or (b) reimplemented in the worker using the same priority hierarchy. This is a real constraint the planner must account for.

### Recommendation

**Adopt a three-layer hybrid, built incrementally:**

#### Layer 1 (existing): AI Proposes
Keep the current LLM-based profile generation as the starting point. It provides a baseline proposal for every domain. For standard e-commerce themes, it will often be correct. No changes needed here.

#### Layer 2 (new, quick win): Paste-Element-to-Selector
Add a flow where the user pastes an element's outerHTML (copied from DevTools) into the existing `manualSelectorHint` field. The system runs `buildStableSelector` on the pasted HTML to generate a stable selector, shows a live extraction preview, and lets the user approve it through the existing per-field flow.

**Why this first:** It can be built in hours. It immediately solves the reliability problem (user provides the exact element, system generates a stable selector). It leverages `buildStableSelector` which already exists. It fits into the existing `ProfileRevisionFeedbackForm` which already has the input field. The only new code is: (a) extract `buildStableSelector` into a shared module, (b) add a worker route or Bun route that accepts HTML and returns a stable selector, (c) update the feedback form to show the generated selector and extraction preview.

#### Layer 3 (new, ideal end state): Click-to-Select Visual Picker
Add a new worker route (`/profile-tooling/pick-element`) that:
1. Launches a **headful** Playwright Chromium (feasible because the system is local)
2. Navigates to the product URL
3. Injects a JavaScript overlay that highlights elements on hover and captures clicks
4. On click, extracts the element's outerHTML and generates a stable selector (either via `buildStableSelector` on the extracted HTML, or via a live-DOM selector generation function that checks uniqueness in the actual page)
5. Returns the selector + extracted text/images + a screenshot for confirmation

The client adds a "Visually Select" button per field in `ProfileProposalDrawer`. Clicking it calls the worker, the headful browser opens, the user clicks on the title/description/image element, and the selector flows back into the existing review/approve UI.

**Why this is the end state:** It's the most user-friendly (no CSS knowledge needed), most reliable (user sees what they're selecting), and leverages all existing infrastructure. The headful browser approach is the simplest implementation for a local tool — no iframe embedding, no screenshot streaming, no WebSocket. The user interacts with a real browser window.

### Invariants that must be preserved

| Invariant | How the new feature respects it |
|---|---|
| Never auto-promote | Visually-selected selectors go through the same revision → validation → per-field approval → promotion path |
| Per-field approval | The picker operates on one field at a time (user selects Title, then Description, then Images) |
| Image approval needs 2+ samples | The image picker produces a selector that still needs multi-sample validation before promotion |
| Revisions are versioned | A visually-corrected selector creates a new revision (source: `manual_css` or a new `visual_picker` source), linked to its parent |
| Worker is Node.js-only | `buildStableSelector` must be extracted into a shared module with no Bun dependencies, or reimplemented in the worker |
| Client never talks to worker directly | New picker calls go through the Bun server proxy (same as `snapshotPageForBuilder`) |

### Risks

1. **`buildStableSelector` extraction risk:** The function currently lives in `profile-generator.ts` which transitively imports `llm-client.ts` (Bun-dependent). Extracting it into a shared module requires cutting those imports. Low risk but must be done carefully.
2. **Headful browser availability:** The headful approach assumes a display is available. If the CMS is ever run headless (e.g., in a Docker container), the click-to-select feature won't work. The paste-element fallback (Layer 2) covers this case.
3. **Selector uniqueness in live DOM vs static HTML:** `buildStableSelector` checks uniqueness against the Cheerio-loaded HTML. In a live browser, the DOM may have dynamically-added elements. The selector generation should ideally check uniqueness in the live DOM via `page.evaluate`. This is a refinement, not a blocker.
4. **Element-to-field mapping:** When the user clicks on an element for "Images", they might click on a single `<img>` rather than the gallery container. The picker needs to offer "use this element" vs "use parent container" options, especially for image galleries.
5. **Overlay injection reliability:** The injected overlay script must not break the target page's layout or JavaScript. Using a Shadow DOM or high-z-index fixed-position overlay mitigates this.

### Need from main agent

None. I have sufficient context to provide this recommendation. The planner can proceed directly.

### Suggested execution prompt for planner

The planner should produce an implementation plan with these phases:

**Phase 1: Extract `buildStableSelector` into a shared module**
- Move `buildStableSelector`, `isLikelyGeneratedId`, `STABLE_DATA_ATTRS`, `SEMANTIC_HINT_SUBSTRINGS`, `classSet`, `attrSelector`, and `snippetOf` from `profile-generator.ts` into a new `src/shared/selector-utils.ts` (or `src/onboarding/selector-utils.ts` with no Bun-dependent imports)
- Update `profile-generator.ts` to import from the new module
- Add unit tests for the extracted module

**Phase 2: Paste-Element-to-Selector (Layer 2)**
- Add a new worker route `POST /profile-tooling/generate-selector` that accepts `{ html: string, outerHTML: string }` and returns `{ selector: string, stability: string, extractedText: string }`
- Add a Bun server proxy route at `/api/onboarding/settings/profile-tooling/generate-selector`
- Update `ProfileRevisionFeedbackForm` to accept pasted HTML, call the endpoint, and show the generated selector + extraction preview
- Wire the generated selector into the existing revision creation flow (source: `manual_css`)

**Phase 3: Click-to-Select Visual Picker (Layer 3)**
- Add a new worker route `POST /profile-tooling/pick-element` that launches headful Playwright, injects an overlay, captures clicks, and returns the selector
- Add a Bun server proxy route
- Add a new client component `ElementPickerButton` that triggers the picker and receives the selector
- Integrate into `ProfileProposalDrawer` as a "Visually Select" button per field
- Handle the image-gallery case (offer "use this element" vs "use parent container")

---