# Implementation Plan: Element Picker UX Fix + Custom Field Support

## Goal
Fix the visual element picker's broken UX (no confirmation before browser closes) AND extend it to support arbitrary custom fields beyond just Title/Description/Images.

---

## Part A: Picker UX Fix — Confirmation Flow & Hover Tooltip

### Tasks

#### A1. Rewrite `buildOverlayScript()` in `pick-element.ts`
Replace the current click-immediately-closes behavior with a state machine:

```
States: hovering → candidate-selected → confirm/retry/cancel
```

- **Hovering state**: Blue outline on hover. Bottom info bar showing: `"Hovering: h1.product-title — 'Vintage Denim...'"`
- **Candidate-selected state**: Green outline (2px solid #22c55e) with checkmark badge on clicked element. Bottom bar switches to: `"✓ Selected: h1.product-title — [Confirm ✓] [Retry] [Cancel]"`
- **Confirm**: Calls `window.__elementPicked(candidateData)` → closes browser
- **Retry**: Clears selection, re-enters hovering mode
- **Cancel**: Calls `window.__elementPicked(null)`
- **Keyboard**: Enter = Confirm, Escape = Cancel (back to hover if selection exists, full cancel if none)

File: `src/extraction-worker/routes/pick-element.ts`
Changes: Rewrite the `buildOverlayScript` function (~150 lines replaced with ~250 lines)

#### A2. Update `ElementPickerButton.tsx` — show inline confirmation card
After a successful pick, show an inline card with:
- The generated selector (monospace code)
- A text preview snippet
- A stability badge
- The screenshot thumbnail (if available)

File: `src/client/components/ElementPickerButton.tsx`
Changes: Add `pickedResult` state + conditional confirmation card rendering

#### A3. Update `ProfileBuilderWorkspace.tsx` — show screenshot in Build tab
When a picked selector has a `screenshotRef`, show a small thumbnail image in the Build tab's visual select card.

File: `src/client/components/ProfileBuilderWorkspace.tsx`
Changes: In each `pickedSelectors` display block, add `{picked.screenshotRef && <img src={...} />}`

#### A4. Update `PickElementResponseSchema` — ensure screenshotRef flows through
The screenshot is already captured in `pick-element.ts` but verify it's returned in the response.

File: `src/shared/schemas/extraction-worker.ts`
Changes: Verify `PickElementResponseSchema` has `screenshotRef`

---

## Part B: Custom Field Support

### Tasks

#### B1. DB Migration — add `custom_selectors_json` to `extractor_profiles`
Add a new TEXT column to store arbitrary field→selector mappings.

```sql
ALTER TABLE extractor_profiles ADD COLUMN custom_selectors_json TEXT DEFAULT '{}';
```

File: `src/db/migrations.ts`

#### B2. Update `ExtractorProfileSchema` — add `customSelectors`
Add a `customSelectors` field to the Zod schema.

```typescript
export const ExtractorProfileSchema = z.object({
  id: z.string(),
  domain: z.string(),
  titleSelector: z.string().nullable().default(null),
  priceSelector: z.string().nullable().default(null),
  descriptionSelector: z.string().nullable().default(null),
  brandSelector: z.string().nullable().default(null),
  imagesSelector: z.string().nullable().default(null),
  customSelectors: z.record(z.string()).default(() => ({})),
  // ... existing fields
});
```

File: `src/shared/schemas/onboarding.ts`

#### B3. Update `PickElementRequest` — accept arbitrary field names
Change `field` from a fixed enum to a string that accepts any value.

```typescript
export const PickElementRequestSchema = z.object({
  url: z.string().url(),
  field: z.string(), // was: z.enum(['title', 'description', 'images'])
  allowParentContainer: z.boolean().default(true),
});
```

File: `src/shared/schemas/extraction-worker.ts`

#### B4. Update `ElementPickerButton` — accept custom field names
The `field` prop currently takes `'title' | 'description' | 'images'`. Change to `string`.

File: `src/client/components/ElementPickerButton.tsx`
Changes: Update prop type from `'title' | 'description' | 'images'` to `string`

#### B5. Add "Custom Field" mode to the Build tab
In the Build tab, add a section below the 3 fixed cards:
- An "Add Custom Field" button
- When clicked, shows an inline form: text input for field name + "Pick Element 🖱️" button
- After picking, shows the selector with a remove button

File: `src/client/components/ProfileBuilderWorkspace.tsx`
Changes: Add new state `customPickedSelectors: Record<string, { selector: string; stability: string }>` + render section

#### B6. Update extraction to apply custom selectors
In `page-extractor.ts`, the `extractCustomSelectorsCheerio` function currently reads only the 5 fixed fields. Add a loop over `profile.customSelectors` to extract custom fields too.

```typescript
// In extractCustomSelectorsCheerio or equivalent:
if (profile.customSelectors) {
  for (const [fieldName, selector] of Object.entries(profile.customSelectors)) {
    const val = $(selector).first().text().trim();
    if (val) {
      data.customFields = data.customFields ?? {};
      data.customFields[fieldName] = val;
    }
  }
}
```

File: `src/onboarding/page-extractor.ts`

#### B7. Update `ExtractionDataSchema` — add `customFields`
Add a key-value map to the extraction data schema.

```typescript
export const ExtractionDataSchema = z.object({
  // ...existing fields...
  customFields: z.record(z.string()).default(() => ({})),
});
```

File: `src/shared/schemas/onboarding.ts`

#### B8. Update trusted profile runner (`extract.ts`) to handle custom selectors
The worker's extract route needs to apply custom selectors the same way.

File: `src/extraction-worker/routes/extract.ts`
Changes: After the 5 fixed fields are processed, loop over `selectors.customSelectors` (or similar) and extract each.

#### B9. Update `ExtractorProfile` DB repo — read/write custom selectors
The repo functions (`findProfileByDomain`, `upsertProfile`) need to read/write the new `custom_selectors_json` column.

File: `src/db/repositories/extractor-profile-repo.ts`
Changes: Add `custom_selectors_json` to the SQL queries and map it to/from the `customSelectors` field.

#### B10. Update Profile Proposal Drawer — show custom fields for approval
The review drawer (`ProfileProposalDrawer`) shows per-field approval for Title/Description/Images. Add a section for custom fields with the same approve/reject flow.

File: `src/client/components/ProfileProposalDrawer.tsx`

#### B11. Update profile promoter — handle custom fields
The promoter (`profile-promoter.ts`) writes approved selectors to `extractor_profiles`. Add logic to write custom fields into `custom_selectors_json`.

File: `src/onboarding/profile-promoter.ts`

---

## Files to Modify

| File | Part | Change |
|---|---|---|
| `src/extraction-worker/routes/pick-element.ts` | A | Rewrite overlay script with state machine + tooltip + confirmation |
| `src/client/components/ElementPickerButton.tsx` | A, B | Add confirmation card; accept string field type |
| `src/client/components/ProfileBuilderWorkspace.tsx` | A, B | Show screenshot; add custom field section |
| `src/shared/schemas/extraction-worker.ts` | B | Change `field` to string |
| `src/shared/schemas/onboarding.ts` | B | Add `customSelectors`, `customFields` to schemas |
| `src/db/migrations.ts` | B | Add `custom_selectors_json` column |
| `src/db/repositories/extractor-profile-repo.ts` | B | Read/write custom selectors column |
| `src/onboarding/page-extractor.ts` | B | Loop over custom selectors during extraction |
| `src/extraction-worker/routes/extract.ts` | B | Same for trusted profile runner |
| `src/client/components/ProfileProposalDrawer.tsx` | B | Custom field approval |
| `src/onboarding/profile-promoter.ts` | B | Write custom fields on promotion |

## Dependencies

- **A1** is independent (just the overlay script)
- **A2, A3** depend on A1
- **B1** must come before B2, B9
- **B2** must come before B3-B11
- **B3** must come before B4, B5
- **B6, B8** depend on B2
- **B10, B11** depend on B2, B9

## Risks

1. **Part A (confirmation flow)**: The state machine adds complexity to the injected script. Must handle edge cases: double-click, clicking the overlay bar itself, page navigation during pick, browser crash during pick.
2. **Part B (custom fields)**: DB migration for existing installations. The `Record<string, string>` type loses type safety compared to fixed fields. Custom field names could collide with fixed field names — need validation.
3. **Extraction integration**: The extraction pipeline (`page-extractor.ts`) has layered fallbacks (JSON-LD → meta → microdata → heuristics). Custom field extraction via CSS selectors should only fire when a custom selector exists — never fall back.
4. **Review UI**: The per-field approval UI in `ProfileProposalDrawer` is designed for 3 fixed fields. Adding dynamic custom fields requires UI changes to render them generically.
