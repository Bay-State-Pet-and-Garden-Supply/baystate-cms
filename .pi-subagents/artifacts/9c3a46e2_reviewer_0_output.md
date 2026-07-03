I now have all the information needed for a comprehensive review. Let me compile my findings.

## Review

### Correct (with evidence)

- **Shared module extraction is clean.** `src/shared/selector-utils.ts` imports only `cheerio` (available in both Bun and Node.js). All 8 exported functions/constants were correctly moved from `profile-generator.ts`, which now imports them from the shared module (`src/onboarding/profile-generator.ts:23-31`). Zero Bun-only dependencies. ✓

- **32 selector-utils tests pass.** `src/tests/unit/selector-utils.test.ts` covers `isLikelyGeneratedId`, `classSet`, `attrSelector`, `isSupportedSelectorSyntax`, `snippetOf`, and `buildStableSelector` (all 6 tiers). Verified: `32 passed (32)`. ✓

- **Typecheck passes.** `tsc --noEmit --skipLibCheck` exits clean. ✓

- **Route registration follows existing patterns.** `src/extraction-worker/server.ts:44-48` registers `/profile-tooling/generate-selector` using the same `method + url` guard pattern as snapshot, validate, and extract routes. Auth middleware applies to all routes. ✓

- **Proxy routes follow the snapshot pattern.** `src/server/routes/onboarding-routes.ts:1158-1180` (generate-selector) mirrors the snapshot route: parse JSON → `safeParse` with `GenerateSelectorRequestSchema` → call worker client → return `{ ok, data }` or `{ ok: false, error }`. ✓

- **Worker client function follows `workerFetch` pattern.** `src/server/extraction-worker-client.ts:200-210` uses the same `workerFetch` helper with `GenerateSelectorResponseSchema` validation, 15s timeout. ✓

- **Client API functions follow existing patterns.** `src/client/onboarding-api.ts` — `generateSelectorFromElement` and `fetchPageHtml` use the `request` helper consistently with `snapshotPageForBuilder`. ✓

- **Fallback when element not found in full DOM is handled.** `generate-selector.ts:271-295` — when `findElementByOuterHTML` returns null, generates from outerHTML alone, downgrades stability to `'low'`, and adds a warning. ✓

- **"Never auto-promote" invariant preserved.** The governance service (`profile-governance-service.ts:656-664`) stores the manual selector in the revision's `selectors_json` via `updateRevisionSelectors` with `status: 'draft'`. Promotion still requires explicit per-field approval through `approveRevisionFields` → `promoteGeneratedProfile`. ✓

- **Revision versioning preserved.** The paste-element flow goes through `reviseProfileFromStructuredFeedback` which creates a new revision row linked to its parent (`profile-governance-service.ts:608-620`). Existing revisions are never overwritten. ✓

### Blocker

1. **`CSS.escape` not available in Node.js worker** — `src/extraction-worker/routes/generate-selector.ts:124`

   `findElementByOuterHTML` uses `CSS.escape(id)` to escape IDs for selector construction:
   ```javascript
   const byId = $(`#${CSS.escape(id)}`);
   ```
   `CSS` is a browser-only global. Verified with `node -e`: `ReferenceError: CSS is not defined`. The worker runs in Node.js (`server.ts` uses `node:http`). When a pasted element has an `id` that doesn't start with `_`, this throws. The outer try/catch in `handleGenerateSelector` (line 251) catches it and returns a fallback with `selector: ''` and `warnings: ['Uncaught error: CSS is not defined']`. This means **every element with a semantic ID fails to generate a selector** — a very common case in real-world HTML.

   The shared `buildStableSelector` in `selector-utils.ts:103` correctly avoids this with a regex-based escape: `id.replace(/(["'\\\s\[\]:.])/g, '\\$1')`. The worker route should use the same approach (or use `attrSelector('id', id)` which avoids ID-selector escaping entirely). The implementer was aware of this limitation (per artifact notes) but missed it in the worker route.

2. **`sourcePageUrl` not passed by parent components** — the paste-element UI is invisible to users

   `ProfileRevisionFeedbackForm` accepts `sourcePageUrl` and conditionally renders the paste-element section with `{sourcePageUrl && (...)}` (`ProfileRevisionFeedbackForm.tsx:265`). However, neither consumer passes it:
   - `src/client/components/ProfileProposalDrawer.tsx:670` — has `previewUrl` state (initialized from `proposal.sourceUrl`) but doesn't pass `sourcePageUrl={previewUrl}`
   - `src/client/components/ProfileGenerationReview.tsx:629` — has `generation.sourceUrl` but doesn't pass `sourcePageUrl={generation.sourceUrl}`

   Since `sourcePageUrl` is always `undefined`, the paste-element section never renders. The feature cannot be used by operators. (Note: these parent files are not in the "Files to read" list, so this may be intentionally out of scope for this PR, but it blocks end-to-end functionality.)

### Note

3. **No tests for the worker route** — `src/extraction-worker/routes/generate-selector.ts` has zero test coverage. The `findElementByOuterHTML` and `generateSelector` functions are untested. A basic integration test would have caught the `CSS.escape` blocker.

4. **Price feedback kind not handled in governance** — `src/onboarding/profile-governance-service.ts:651-655`. The manual selector application handles `feedback.kind === 'text'` and `feedback.kind === 'images'`, but not `'price'`. If the form were shown for `priceSelector`, the generated selector would be silently dropped. In practice this is theoretical since `SELECTOR_FIELDS` (used by parent components to iterate fields) only includes `titleSelector`, `descriptionSelector`, `imagesSelector` — not `priceSelector`.

5. **SSRF vector in fetch-html route** — `src/server/routes/onboarding-routes.ts:1187-1220`. The route accepts any URL and fetches it server-side without URL validation (no blocklist for `localhost`, `127.0.0.1`, `169.254.169.254`, private IP ranges). Protected by API token auth when `SHOPSITE_CMS_API_TOKEN` is set, but unauthenticated in default local dev. Consistent with existing patterns (governance service's `fetchSampleHtml` has the same gap). Worth noting for a security review pass.

6. **Multiple `Advanced selector hint:` tags** — `src/onboarding/profile-governance-service.ts:644`. The regex `notes.match(/Advanced selector hint:\s*(.+)/)` is non-global, so only the first occurrence is matched and applied. If notes contain multiple hints, subsequent ones are silently ignored. Acceptable behavior but undocumented.

7. **`manualSelectorHint` submitted regardless of "Advanced" checkbox** — `ProfileRevisionFeedbackForm.tsx:147-149`. When paste-element generates a selector, it sets `manualSelectorHint` via `setManualSelectorHint(data.selector)`. On submit, `manualSelectorHint.trim()` is checked regardless of `showAdvancedCss`. This is correct for the paste-element flow, but the "Advanced: I know the CSS selector" checkbox label becomes misleading — the selector is submitted even when unchecked. If a user checks "Advanced", types a selector, then unchecks it, the selector is still submitted.

8. **Lint errors (6 total)** in the new/modified files:
   - `selector-utils.ts:103` — unnecessary escape `\[` in regex character class (cosmetic)
   - `generate-selector.ts:308` — `let matchCount = 0` flagged as useless assignment (harmless; needed for scope in catch block)
   - `profile-governance-service.ts` — 4 errors (unused `ValidationSampleRef` import, unused `generationIds` var, useless assignment, empty interface). These may predate the paste-element change since the file is entirely new in this uncommitted diff.

### Edge case verification summary

| Edge case | Handled? | Evidence |
|---|---|---|
| Pasted HTML doesn't match element in full DOM | ✓ | `generate-selector.ts:271-295` — fallback to outerHTML-only, stability downgraded to `low`, warning added |
| Pasted HTML is invalid | ✓ | `findElementByOuterHTML:114-116` and fallback `generate-selector.ts:277-284` — returns null/empty with warning |
| Source page URL not provided | ✓ | `ProfileRevisionFeedbackForm.tsx:76-78` — shows error; section hidden when `sourcePageUrl` falsy (line 265) |
| Worker unavailable | ✓ | `extraction-worker-client.ts:88-92` — `workerFetch` catches network errors, returns `{ ok: false, error }` |
| Generated selector uses unsupported syntax | ✓ | `generate-selector.ts:301-303` — warning added; `profile-governance-service.ts:647` — `isSupportedSelectorSyntax` check before applying |
| Element has a semantic ID | ✗ **Blocker** | `generate-selector.ts:124` — `CSS.escape` throws `ReferenceError` in Node.js |