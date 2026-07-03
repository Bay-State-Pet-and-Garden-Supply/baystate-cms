I now have all the evidence needed for a comprehensive review. Let me compile my findings.

## Review

### Correct (with evidence)

- **Client→Bun→Worker flow respects all Phase 1/2 invariants.** The client (`onboarding-api.ts:pickElementVisually`) calls the Bun proxy `/api/onboarding/settings/profile-tooling/pick-element`; the Bun proxy (`onboarding-routes.ts:1249`) calls `pickElement()` in `extraction-worker-client.ts`, which talks to the worker at `127.0.0.1:3032` with bearer auth. The client never talks to the worker directly. The worker route uses only Node.js built-ins + `playwright` + `cheerio` (no Bun-only imports). ✓
- **Per-field approval invariant intact.** In `ProfileProposalDrawer.tsx`, the picker's `onPicked` only calls `setRevisedSelectors` + `handlePreview()` — it never calls `handleApprove`. The user must still click "Approve". ✓
- **Browser lifecycle is correctly handled.** `pick-element.ts` wraps the entire logic in `try/catch/finally` with `finally { if (browser) { await browser.close() } }` (lines 310–316), ensuring cleanup on success, cancel, error, and timeout. ✓
- **120s user-interaction timeout** is present (`pick-element.ts:228–235`) and the client mirrors it (`extraction-worker-client.ts` `pickElement` uses `timeoutMs: 120_000`). ✓
- **`exposeFunction('__elementPicked', ...)` is set up before navigation** (`pick-element.ts:198–206`), so the callback exists when the overlay calls it. ✓
- **`stopImmediatePropagation()` correctly prevents page reaction.** The click listener is on `document` in the capture phase (`true`) and calls `preventDefault() + stopPropagation() + stopImmediatePropagation()` (`pick-element.ts:126–128`), which blocks the target page's handlers. ✓
- **Proxy route follows the exact pattern** of the `generate-selector` proxy (`onboarding-routes.ts:1249–1271` vs `1156–1182`): JSON parse → `safeParse` → forward to worker → `{ ok, data }` / `{ ok: false, error }`. ✓
- **Schema validation is consistent.** `PickElementRequestSchema`/`PickElementResponseSchema` (`extraction-worker.ts:120–155`) follow the same Zod pattern as `GenerateSelector*`. The worker route validates input and passes the response through `PickElementResponseSchema.parse()` in the uncaught-error fallback (`pick-element.ts:488–496`), matching `generate-selector.ts`. ✓
- **Auth middleware covers the proxy route.** `app.ts:25–37` applies the bearer-token check to all `/api/*` non-GET requests, so the `POST` pick-element proxy is protected when `SHOPSITE_CMS_API_TOKEN` is set. ✓
- **Typecheck passes** (`tsc --noEmit` clean). ✓

---

### Blocker

**B1. `pick-element.ts:104` — `fieldLabel` is never interpolated into the overlay script; the overlay injection crashes at runtime.**

The `buildOverlayScript(fieldLabel)` function returns an outer template-literal (backtick) string. Inside it, line 104 reads:
```
bar.innerHTML = '<span><strong>Click on the ' + JSON.stringify(fieldLabel) + ' element</strong> …';
```
`JSON.stringify(fieldLabel)` is **bare text** inside the template literal — it is **not** wrapped in `${…}`, so the Node.js `fieldLabel` parameter is never interpolated into the browser script. ESLint confirms this: `pick-element.ts:55 'fieldLabel' is defined but never used`.

When the browser executes the injected IIFE, it hits `JSON.stringify(fieldLabel)` where `fieldLabel` is undefined in the browser scope → `ReferenceError: fieldLabel is not defined`. The IIFE throws, `page.evaluate()` rejects, the `catch` block returns a fallback with an empty selector, and the browser closes. **The entire visual picker is non-functional** — the user sees an error instead of the click overlay.

Fix: `JSON.stringify(fieldLabel)` → `${JSON.stringify(fieldLabel)}` so Node.js interpolates the quoted label into the string the browser receives.

---

### Fixed

(No edits applied — this is a review-only task.)

---

### Bug (moderate)

**B2. `pick-element.ts:146,161` — `document.querySelector('style').remove()` removes the wrong stylesheet.**

Both the click handler and the cancel handler clean up with `document.querySelector('style').remove()`. This selects the **first** `<style>` element in document order, which is almost always the page's own stylesheet — **not** the injected `highlightStyle` (which was `appendChild`ed to `document.head` at line 99). The injected picker style leaks, and a legitimate page stylesheet is removed. Impact is mitigated because the browser closes immediately after (in the `finally`), but the cleanup is incorrect. Fix: use the `highlightStyle` reference directly (`highlightStyle.remove()`).

---

### Functional gaps

**G1. `ProfileBuilderWorkspace.tsx` — picker results are discarded (`console.log` only).**

All three picker buttons in the Snapshot tab (Title/Description/Images) have `onPicked` handlers that only do `console.log('…selector picked:', result.selector)` (e.g. lines ~414, ~425, ~436). The picked selector is **not displayed, not stored, and not usable** by the operator. The feature does not work end-to-end in this surface — the user can pick an element but the result vanishes.

**G2. `ProfileProposalDrawer.tsx` — the picked selector is never persisted on approval.**

The picker's `onPicked` updates local state (`setRevisedSelectors`) and runs a preview, which correctly updates the "Proposed Selector" column display. However, `handleApprove` (lines ~129–146) sends only `approveRevisionFields(proposal.id, revisionId, { approvedFields: { [field]: true } })` — it sends a boolean per field, **not** the picked selector value. The server promotes the **revision's originally-stored selector**, not the visually-picked one. So if the user picks a better selector, previews it successfully, and clicks "Approve", the wrong (original) selector is promoted and the picked one is lost. The picker needs a path to persist the picked selector as a revision (or send it as `proposedValue`) before/during approval.

---

### Notes

**N1. Element matching is weaker than the established `generate-selector.ts` pattern.** `pick-element.ts` re-implements element matching inline (Strategies 1–2 + image-gallery case + outerHTML fallback) rather than reusing `findElementByOuterHTML` from `generate-selector.ts` (which has 4 strategies). Differences:
- Missing stable attrs `data-product-id`, `data-product-sku` (present in `generate-selector.ts:106` and `selector-utils.ts:34`).
- No class-based narrowing when multiple data-* matches (generate-selector narrows with `.class`).
- No Strategy 3 (tag + class best-effort) or Strategy 4 (first same-tag fallback).
- Result: for elements without an id or stable data-* attr (common for title/description), matching falls through to the outerHTML-alone fallback (`pick-element.ts:271–289`), which returns `stability: 'low'` and a warning "uniqueness not verified against full DOM". The inline comment at line 19 claims "same as generate-selector.ts" but it is not.

**N2. Image extraction is less thorough.** `pick-element.ts:298–308` only checks `src` on descendant `<img>`s, while `generate-selector.ts`'s `collectImageSourcesFromElement` also checks `data-src` and `srcset`. The inlined `collectImageSourcesFromHtml` (used only in the fallback path) checks `src` + `data-src` via regex but not `srcset`.

**N3. No tests added** for `pick-element.ts`, `ElementPickerButton.tsx`, or the proxy route. The AGENTS.md testing guidance and the established pattern (tests exist for `selector-utils`, `profile-generator`, etc.) suggest coverage should be added, at minimum for the element-matching strategies and the `buildOverlayScript` interpolation.

**N4. Dead code / lint errors in new files:**
- `pick-element.ts:108` — `BAR_HEIGHT = 46` declared, never used.
- `pick-element.ts:197` — `pickResult` assigned (line 204), never read (the resolved promise value `picked` is used instead).
- `ElementPickerButton.tsx:37` — `FIELD_LABELS` constant defined, never used (button text is hardcoded).
- `ProfileProposalDrawer.tsx:10` — `useEffect` imported, unused; `:16` — `getProfileGenerationDetail` imported, unused.
- `ProfileBuilderWorkspace.tsx:340` — `latestGeneration` derived, unused.

**N5. Timeout timer is never cleared.** The `setTimeout` in the `Promise.race` (`pick-element.ts:229–235`) is not cleared when the user picks before 120s. `Promise.race` attaches handlers to both promises so there's no unhandled rejection, but the timer reference lingers up to 120s. Minor.

**N6. Mouseover/mouseout highlight can flicker** if a browser fires `mouseover` before `mouseout` (non-standard ordering). The `mouseout` handler unconditionally clears `highlightedEl` to `null`, which could wipe a just-set highlight. Using `mouseenter`/`mouseleave` semantics or a guard would be more robust, though the standard event order makes this an edge case.

**N7. Minor spec deviation: button color.** The task describes a "Purple button" but `ElementPickerButton.tsx` uses blue (`#2563eb`), matching the primary/snapshot button palette rather than the purple (`#9333ea`) used by the nearby "Suggest Revision" button. Cosmetic only.

**N8. Test suite: 8 pre-existing failures unrelated to this feature.** The failures are all in `domain-diagnostics-service.test.ts` and `extraction-remedies.test.ts` (domain-status-repo), with 0 references to pick-element/overlay code. They stem from other uncommitted changes in the working tree, not from the Phase 3 picker work.

---

### Acceptance report