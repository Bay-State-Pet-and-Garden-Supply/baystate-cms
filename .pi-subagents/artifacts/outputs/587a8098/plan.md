# Implementation Plan: Visual Element Picker UX + Custom Field Support

## Goal

Overhaul the visual element picker to add an in-browser confirmation step with hover tooltips, and extend the entire profile system beyond the 3 fixed fields (Title/Description/Images) to support arbitrary custom field→selector mappings (e.g. "Size", "Variant", "SKU", "Weight").

---

## Tasks

### Part A: In-Browser Confirmation + Tooltip

#### Task 1: Rewrite `buildOverlayScript()` with state machine + confirmation
- **File:** `src/extraction-worker/routes/pick-element.ts`
- **Changes:** Replace the current overlay script (lines 55–167) with a new version that implements a three-state state machine:
  - **`hovering`**: Blue outline on hover. Bottom bar shows live element info: `tag.className — "text preview" — WxH`. Hover tooltip follows cursor.
  - **`candidate-selected`**: After click, the clicked element gets a green outline (3px solid #22c55e) + a green checkmark badge overlay. The bottom bar changes to: `✓ Selected: tag.className — "text preview" [✓ Confirm] [↻ Retry] [✗ Cancel]`. Clicks elsewhere on the page are ignored (or re-select a new element).
  - **`cancelled`**: Cancel button or Escape (when no candidate) calls `window.__elementPicked(null)`.
  - **Keyboard**: `Enter` = Confirm, `Escape` = Cancel (back to hovering if candidate exists, full cancel if not).
  - Only on "Confirm" does `window.__elementPicked(data)` fire. "Retry" clears the green outline and re-enters `hovering`.
- **Implementation detail:** The script must inject CSS for `.ep-confirm-bar`, `.ep-badge`, `.ep-tooltip` classes. The bottom bar should be a fixed-position element at `bottom: 0` (not `top: 0`) so it doesn't overlap the existing top bar. The top bar remains for the field label + Cancel.
- **Acceptance:** When the user clicks an element, the browser does NOT close. A green badge appears on the element, a confirmation bar appears at the bottom, and the browser only closes when the user clicks Confirm, Retry, or Cancel (or presses Enter/Escape).

#### Task 2: Update `ElementPickerButton` with post-pick feedback
- **File:** `src/client/components/ElementPickerButton.tsx`
- **Changes:**
  - After a successful pick (`result.data.selector` is non-empty), show an inline confirmation card below the button containing:
    - The generated selector in a `<code>` block
    - The stability badge (green/yellow/red)
    - A text preview (first 80 chars of `result.data.extractedText`)
    - If `result.data.screenshotRef` is present, show a small thumbnail image
  - The card stays visible until the user picks again or navigates away.
  - Remove the generic "Selector ready" status text; the card replaces it.
- **Acceptance:** After a successful pick, the user sees a card with the selector, stability, text preview, and screenshot thumbnail inline below the button.

#### Task 3: Remove the screenshot capture from `pickElement()` (defer to confirmation step)
- **File:** `src/extraction-worker/routes/pick-element.ts`
- **Changes:** Move the screenshot capture (lines 250–255) to happen AFTER the user confirms, not after the initial click. Since the browser stays open during the confirmation step, the screenshot should be taken right before `browser.close()` in the `finally` block — but only if the user confirmed (not if they cancelled).
- **Acceptance:** Screenshot is captured on confirm, not on initial click.

---

### Part B: Custom Field Support

#### Task 4: Add `customSelectors` to `ExtractorProfileSchema`
- **File:** `src/shared/schemas/onboarding.ts` (line ~163)
- **Changes:** Add `customSelectors: z.record(z.string(), z.string()).default(() => ({}))` to `ExtractorProfileSchema`. This is a `Record<fieldName, cssSelector>` map for arbitrary fields like `{ "size": "span.variant-size", "flavor": "div.flavor-name" }`.
- **Acceptance:** `z.infer<typeof ExtractorProfileSchema>` includes `customSelectors: Record<string, string>`.

#### Task 5: Add `customSelectors` to the DB repo and migration
- **File:** `src/db/repositories/extractor-profile-repo.ts`
  - Add `customSelectors?: Record<string, string>` to the `upsertProfile` selectors parameter.
  - Add `custom_selectors_json: string | null` to the `DbProfile` interface.
  - Update `mapToProfile()` to parse `custom_selectors_json` (JSON.parse or `{}`).
  - Update `upsertProfile()` to serialize `customSelectors` to JSON and store in `custom_selectors_json` column. For merge semantics: if `customSelectors` is provided, merge with existing (new keys override, existing keys preserved if not in the update).
  - Update `findProfileByDomain()` and `listAllProfiles()` — the `SELECT *` already covers the new column.
- **File:** `src/db/migrations.ts`
  - Add a migration block (following the existing `sitemap_product_url_pattern` pattern at line 84):
    ```typescript
    try {
      const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some(col => col.name === 'custom_selectors_json')) {
        db.exec('ALTER TABLE extractor_profiles ADD COLUMN custom_selectors_json TEXT;');
      }
    } catch (e) { console.error('Failed to add custom_selectors_json column:', e); }
    ```
- **Acceptance:** `bun run typecheck` passes. Existing profiles still load (customSelectors defaults to `{}`).

#### Task 6: Add `customFields` to `ExtractionDataSchema`
- **File:** `src/shared/schemas/onboarding.ts` (line ~63, after `packagingTitle`)
- **Changes:** Add `customFields: z.record(z.string(), z.string()).default(() => ({}))` to `ExtractionDataSchema`. This stores the extracted values from custom selectors, e.g. `{ "size": "Small", "flavor": "Lavender" }`.
- **Acceptance:** `ExtractionData` type includes `customFields: Record<string, string>`.

#### Task 7: Update `PickElementRequest` to accept arbitrary field names
- **File:** `src/shared/schemas/extraction-worker.ts` (line ~74)
- **Changes:** Change `field: z.enum(['title', 'description', 'images'])` to `field: z.string().min(1)`. This allows any field name like `"title"`, `"size"`, `"flavor"`, etc. The `field` parameter is used only for the overlay label and the image-gallery heuristic — it doesn't gate which elements can be selected.
- **File:** `src/extraction-worker/routes/pick-element.ts`
  - Update the `fieldLabel` derivation (line ~220) to handle arbitrary field names: `const fieldLabel = field === 'images' ? 'product image(s)' : field;` (any non-images field just uses its name as the label).
  - The image-gallery heuristic (line ~296, `field === 'images'`) should check `field === 'images' || field.toLowerCase().includes('image')`.
- **Acceptance:** `PickElementRequest.field` accepts any string. The overlay label uses the field name directly.

#### Task 8: Update `ElementPickerButton` to accept arbitrary field names
- **File:** `src/client/components/ElementPickerButton.tsx`
- **Changes:** Change `field: 'title' | 'description' | 'images'` to `field: string`. The button label can remain "🖱️ Visually Select" regardless of field name.
- **Acceptance:** `ElementPickerButton` accepts any string for `field`.

#### Task 9: Add custom field picker cards to the Build tab
- **File:** `src/client/components/ProfileBuilderWorkspace.tsx`
- **Changes:**
  - Add a new state: `const [customFields, setCustomFields] = useState<Array<{ name: string; selector: string; stability: string }>>([]);`
  - Add a new state: `const [newFieldName, setNewFieldName] = useState('');`
  - After the 3 fixed cards (Title, Description, Images), add an "+ Add Custom Field" section:
    - A text input for the field name (e.g. "Size", "Flavor", "Weight")
    - An "Add" button that creates a new card with an `ElementPickerButton` using `field={newFieldName}`
    - Each custom field card shows the field name, the picker button, and the result (selector + stability badge) — same layout as the fixed cards
    - A "Remove" (✕) button on each custom field card
  - The `pickedSelectors` state should be extended to include custom fields: `setPickedSelectors((prev) => ({ ...prev, [newFieldName]: { selector, stability } }))`
- **Acceptance:** User can type "Size", click Add, get a new picker card, visually select the size element, and see the selector inline.

#### Task 10: Update extraction to use custom selectors
- **File:** `src/onboarding/page-extractor.ts` (line ~410, `extractCustomSelectorsCheerio`)
- **Changes:**
  - After the 5 fixed selectors, iterate over `profile.customSelectors` (if it exists):
    ```typescript
    if (profile.customSelectors) {
      for (const [fieldName, selector] of Object.entries(profile.customSelectors)) {
        if (selector) {
          const value = $(selector).first().text().trim();
          if (value) data[fieldName] = value;
        }
      }
    }
    ```
  - Also update the Playwright-based `extractCustomSelectors()` function (around line ~291) to handle custom selectors the same way.
  - Update the extraction result merging to store custom field values in `extractionData.customFields`.
- **File:** `src/extraction-worker/routes/extract.ts`
  - The trusted profile runner receives `profile.selectors` as a `Record<string, string|null>`. Update it to also read `customSelectors` from the profile object and apply them.
- **Acceptance:** When a profile has `customSelectors: { "size": "span.variant-size" }`, extraction produces `extractionData.customFields: { "size": "Small" }`.

#### Task 11: Update the profile promoter to handle custom selectors
- **File:** `src/onboarding/profile-promoter.ts`
- **Changes:** The `promoteGeneratedProfile()` function writes approved selectors to `extractor_profiles`. Update it to also write custom field selectors:
  - If the approved fields include custom field keys (not in the fixed set), write them to `customSelectors` in the `upsertProfile()` call.
  - The `SELECTOR_KEYS` array (line ~24) should remain as the fixed set; custom fields are detected by not being in `SELECTOR_KEYS`.
- **Acceptance:** When a user approves a custom field selector, it gets written to `extractor_profiles.custom_selectors_json`.

#### Task 12: Update the Review tab to display custom field selectors
- **File:** `src/client/components/ProfileBuilderWorkspace.tsx` (`renderReview`)
- **Changes:** In the Review tab, if `pickedSelectors` contains keys beyond `title`/`description`/`images`, show them as additional rows in the review table with the same approve/reject UI. The field name is the key, the selector is the value.
- **Acceptance:** Custom field selectors appear in the Review tab alongside fixed fields.

---

## Files to Modify

| File | Task | Changes |
|---|---|---|
| `src/extraction-worker/routes/pick-element.ts` | 1, 3, 7 | Rewrite overlay script with state machine; move screenshot; accept arbitrary field names |
| `src/client/components/ElementPickerButton.tsx` | 2, 8 | Post-pick feedback card; accept arbitrary field names |
| `src/shared/schemas/onboarding.ts` | 4, 6 | Add `customSelectors` to ExtractorProfile; add `customFields` to ExtractionData |
| `src/db/repositories/extractor-profile-repo.ts` | 5 | Add `custom_selectors_json` column handling |
| `src/db/migrations.ts` | 5 | Add migration for `custom_selectors_json` column |
| `src/shared/schemas/extraction-worker.ts` | 7 | Change `PickElementRequest.field` to `z.string()` |
| `src/client/components/ProfileBuilderWorkspace.tsx` | 9, 12 | Add custom field cards to Build tab; display custom fields in Review |
| `src/onboarding/page-extractor.ts` | 10 | Extract custom selectors during extraction |
| `src/extraction-worker/routes/extract.ts` | 10 | Apply custom selectors in trusted runner |
| `src/onboarding/profile-promoter.ts` | 11 | Promote custom field selectors to profile |

## New Files

None — all changes are in existing files.

## Dependencies

- **Task 2** depends on **Task 1** (the confirmation card shows data from the improved picker response).
- **Task 3** depends on **Task 1** (screenshot timing changes with the confirmation step).
- **Task 5** depends on **Task 4** (repo needs the schema type).
- **Task 7** depends on **Task 4** (field type change in schema).
- **Task 8** depends on **Task 7** (client component uses the schema type).
- **Task 9** depends on **Tasks 7, 8** (custom field cards use the new field type).
- **Task 10** depends on **Tasks 4, 5, 6** (extraction reads customSelectors from the profile).
- **Task 11** depends on **Tasks 4, 5** (promoter writes customSelectors to the profile).
- **Task 12** depends on **Task 9** (Review tab shows what Build tab collected).

**Critical path:** Task 1 → Task 4 → Task 5 → Task 7 → Task 8 → Task 9 → Task 10 (Part B extraction works end-to-end). Task 1 → Task 2 → Task 3 (Part A UX works end-to-end).

## Risks

1. **Overlay script complexity (MEDIUM):** The state machine adds significant complexity to the injected JavaScript. Edge cases: rapid clicking, elements that disappear on hover, SPAs that re-render. **Mitigation:** Keep the script self-contained with no external dependencies; test with real product pages.

2. **DB migration on existing databases (LOW):** Adding `custom_selectors_json` column via `ALTER TABLE` is safe — SQLite supports `ADD COLUMN`. Existing rows will have `NULL` which the repo maps to `{}`. **Mitigation:** Follow the existing migration pattern used for `sitemap_product_url_pattern`.

3. **Breaking existing extraction (MEDIUM):** Changing `PickElementRequest.field` from enum to string could break callers that type-check the field. **Mitigation:** The only callers are `ElementPickerButton` (being updated in Task 8) and the `ProfileBuilderWorkspace` (being updated in Task 9). No other code references the field enum.

4. **Profile merge semantics for customSelectors (LOW):** When `upsertProfile` is called with partial custom selectors, the merge must preserve existing custom fields not in the update. **Mitigation:** Implement as: `const merged = { ...existingCustom, ...providedCustom }` — new keys override, existing keys preserved.

5. **Extraction worker compatibility (LOW):** The trusted profile runner (`extract.ts`) receives the profile as a plain object from the Bun server. Adding `customSelectors` to the profile object requires the Bun server to include it when calling the worker. **Mitigation:** The `ExtractRequest.profile.selectors` is already a `Record<string, string|null>` — custom selectors can be included as additional keys in this map rather than a separate field.

## Design Decisions (from supervisor)

1. **Custom fields storage:** `customSelectors: Record<string, string>` map on the profile. Fixed fields remain as dedicated columns for backward compatibility.
2. **Extraction handling:** Custom fields extracted via same Cheerio logic, stored in `extractionData.customFields: Record<string, string>`, provenance tracked as `'custom-selector'`.
3. **Field naming:** Free-form text input. User types whatever they want.
4. **Review/approval:** Same per-field approval flow as fixed fields.
5. **DB migration:** New column `custom_selectors_json TEXT` on `extractor_profiles` table.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Plan addresses both Part A (picker UX with confirmation state machine, hover tooltip, post-pick feedback card) and Part B (custom field support across schema, DB, repo, extraction, promoter, and UI) without widening scope beyond the two requested features. 12 tasks with exact file paths, changes, and acceptance criteria."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Plan references exact line numbers (e.g. pick-element.ts:55-167 for overlay script, onboarding.ts:163 for ExtractorProfileSchema, extractor-profile-repo.ts:61 for upsertProfile), includes dependency graph, risk analysis, and design decisions from supervisor. Another agent can execute without guessing."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read src/extraction-worker/routes/pick-element.ts",
      "result": "passed",
      "summary": "Read full pick-element.ts to understand overlay script, state machine, screenshot timing, and field label logic"
    },
    {
      "command": "read src/shared/schemas/onboarding.ts",
      "result": "passed",
      "summary": "Read ExtractorProfileSchema, SelectorFieldEnum, SELECTOR_FIELDS, ExtractionDataSchema to understand field limitations"
    },
    {
      "command": "read src/db/repositories/extractor-profile-repo.ts",
      "result": "passed",
      "summary": "Read upsertProfile merge semantics, mapToProfile, DbProfile interface to plan customSelectors column"
    },
    {
      "command": "read src/db/migrations.ts",
      "result": "passed",
      "summary": "Read existing migration pattern for sitemap_product_url_pattern and shopify_json_path columns"
    },
    {
      "command": "read src/onboarding/page-extractor.ts",
      "result": "passed",
      "summary": "Read extractCustomSelectorsCheerio to understand how selectors are applied during extraction"
    },
    {
      "command": "read src/client/components/ElementPickerButton.tsx",
      "result": "passed",
      "summary": "Read full component to understand field prop, busy/error/success states, and post-pick feedback"
    },
    {
      "command": "read src/client/components/ProfileBuilderWorkspace.tsx",
      "result": "passed",
      "summary": "Read renderBuild function to understand hardcoded Title/Description/Images cards"
    },
    {
      "command": "contact_supervisor",
      "result": "passed",
      "summary": "Supervisor confirmed design decisions: customSelectors as Record<string,string> map, customFields in extractionData, free-form field naming, same per-field approval, DB migration with custom_selectors_json column"
    }
  ],
  "validationOutput": [
    "No code changes made — this is a planning-only task",
    "Plan references 10 files to modify with exact line numbers and acceptance criteria",
    "12 tasks with dependency graph and critical path identified",
    "5 risks identified with mitigations"
  ],
  "residualRisks": [
    "Overlay script state machine complexity (rapid clicking, SPA re-renders) — test with real pages",
    "Profile merge semantics for customSelectors must preserve existing keys not in update"
  ],
  "noStagedFiles": true,
  "diffSummary": "No diff — planning only. Plan written to /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/587a8098/plan.md",
  "reviewFindings": [
    "no blockers — plan is implementation-ready"
  ],
  "manualNotes": "The plan should be executed in two phases: Part A (Tasks 1-3) can be shipped independently as a UX improvement. Part B (Tasks 4-12) is a larger feature that changes schemas, DB, extraction, and UI. Both share the pick-element.ts file so Task 1 and Task 7 should be done together to avoid double-editing."
}
```
