I have verified all 10 verification points plus the review angles. Here is my final review.

## Review

### Correct (evidence-backed)
- **`shopify-json.ts` purity** (`src/onboarding/shopify-json.ts:10`): The only import is `import * as vm from 'node:vm';`. No project imports. Exports `PRODUCT_JSON_ASSIGNMENT_PATTERNS`, `findObjectEnd`, `ProductJsonCandidate`, `collectProductJsonCandidates`, `extractProductJsonFromHtml`. Header comment explicitly states the no-project-imports contract.
- **`page-extractor.ts` import replacement** (`src/onboarding/page-extractor.ts:11`): `import { extractProductJsonFromHtml } from './shopify-json';` is present. The HTTP path (`extractViaHttpDetailed`) calls `extractProductJsonFromHtml(html)` (Layer 6). No duplicated HTML-parsing logic remains. The Playwright path uses `page.evaluate(() => (window as any).productJSON …)` which is a different, browser-context mechanism (acceptable, not a duplicate).
- **`profile-generator.ts`**:
  - `buildLlmPrompt` has a `minimizedDom: string` parameter and emits a `MINIMIZED PRODUCT DOM (HTML):` section (line ~851).
  - `SELECTOR_PROFILE_KEYS` includes `shopifyJSONPath` (4 keys: title/description/images/shopifyJSONPath).
  - `shapeFromParsed` parses `shopifyJSONPath` boolean (`if (typeof obj.shopifyJSONPath === 'boolean')`).
  - `MAX_LLM_DOM_BYTES = 60_000` constant exists.
  - `buildSeedPreview` exists, is pure (uses `extractProductJsonFromHtml` + cheerio + image-utils helpers; no DB, no network).
  - `validateGeneratedProfile` confidence calc is title(0.45)+description(0.15)+images(0.10)+expected(0.10) — no price/brand references.
  - `shouldAttemptProfileGeneration` uses `!input.extractionResult.description` as the improvement target.
  - Prompt text (line 849): "The candidate list is provided as HINTS only — **you MAY write a selector that is NOT in the candidate list** when you can see a more stable or more accurate one in the minimized DOM."
- **`onboarding.ts`**: `SelectorFieldEnum` has **5** members (incl. `priceSelector`, `brandSelector` for historical compat); `SELECTOR_FIELDS` has **3** members; `ExtractorProfileSchema` has `shopifyJSONPath: z.boolean().default(false)`.
- **`profile-promoter.ts`**: `SELECTOR_KEYS` has **3** members (title/description/images). `shopifyJSONPath` is always written via `writeSelectors.shopifyJSONPath = selectors.shopifyJSONPath;` (not a per-field approval — by design).
- **`profile-governance-service.ts`**: `tally()` returns only `titleSelector/descriptionSelector/imagesSelector`; `textFieldsHaveStrongEvidence` checks only `['titleSelector','descriptionSelector']`. No price/brand selector references (only contextual `brandHint`).
- **`onboarding-routes.ts`**: generate-profile route calls `buildSeedPreview(html, generated, resolvedUrl)` and stores it in `fieldSamples.seedPreview` (lines 1362–1371). Test route destructures `shopifyJSONPath` from the body and uses it (line 1406/1482).
- **`onboarding-api.ts`**: `testExtractorProfile` accepts `shopifyJSONPath?: boolean` (line 408).
- **`migrations.ts`**: `shopify_json_path INTEGER NOT NULL DEFAULT 0` ALTER migration present (guarded by `PRAGMA table_info` check).
- **`extractor-profile-repo.ts`**: `upsertProfile` handles `shopifyJSONPath` in both INSERT and UPDATE paths, with merge semantics (`existing ? (selectors.shopifyJSONPath ?? !!existing.shopify_json_path) : (selectors.shopifyJSONPath ?? false)`).
- **End-to-end storage**: LLM (`shapeFromParsed`) → schema (`ExtractorProfileSchema`) → migration (`shopify_json_path`) → repo (`upsertProfile`) → promoter (`writeSelectors.shopifyJSONPath`). Complete chain.

### Safety
- Historical rows still parse: `SelectorFieldEnum` retains `priceSelector`/`brandSelector` (5 members) while active arrays (`SELECTOR_FIELDS`, `SELECTOR_KEYS`) use 3. Confirmed.

### Validation
- `npx tsc --noEmit --skipLibCheck` → exit 0, no errors.
- `npx vitest run` (full suite) → 13 files, 202 tests, all passed.
- No staged files (`git diff --cached --name-only` empty).

### Note (residual risk, non-blocking)
- `buildSeedPreview` has **no dedicated unit test** (grep across `src/tests` returned no matches for `buildSeedPreview`/`seedPreview`). The function is exercised only indirectly via the route (which is not unit-mocked). The `shopifyJSONPath: true` branch (Shopify-JSON preview path) in `buildSeedPreview` is not covered by any unit test. This is a test-coverage gap, not an implementation defect.

No blockers found. No files were modified (review-only).