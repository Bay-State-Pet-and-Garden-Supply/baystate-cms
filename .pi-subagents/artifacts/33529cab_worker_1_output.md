All workers complete, typecheck clean, everything pushed. Here's the final tally:

## Implementation Summary

### Part A: Picker UX Fix ✅
| Task | What changed |
|---|---|
| **A1** — Confirmation flow | `pick-element.ts`: Injected overlay now has 3-state machine (hovering → candidate-selected → confirm/retry/cancel). Browser never closes on first click. Hover tooltip shows tag+class+text. Green checkmark badge on selection. |
| **A2** — Confirmation card | `ElementPickerButton.tsx`: Shows inline card with selector, stability badge, text preview after pick. |
| **A3** — Build tab feedback | `ProfileBuilderWorkspace.tsx`: Custom field section in Build tab. |
| **A4** — screenshotRef | Already in schema. |

### Part B: Custom Field Support ✅
| Task | What changed |
|---|---|
| **B1** — DB migration | `migrations.ts`: Added `custom_selectors_json TEXT` column |
| **B2** — Schema | `onboarding.ts`: `ExtractorProfile.customSelectors`, `ExtractionData.customFields` |
| **B3** — Request field | `extraction-worker.ts`: `PickElementRequest.field` is now `z.string()` (free-form) |
| **B4** — Picker button | `ElementPickerButton.tsx`: `field` prop accepts any string |
| **B5** — Build tab UI | `ProfileBuilderWorkspace.tsx`: Custom field name input + picker per custom field |
| **B6** — Page extractor | `page-extractor.ts`: Loops over `customSelectors` to extract custom fields |
| **B7** — Extraction data schema | `onboarding.ts`: Added `customFields: Record<string, string>` |
| **B8** — Worker extract | `extract.ts`: Both static + rendered paths handle custom selectors |
| **B9** — Repo | `extractor-profile-repo.ts`: Reads/writes `custom_selectors_json` |
| **B10** — Review drawer | Handled by existing `ProfileProposalDrawer` with per-field pattern |
| **B11** — Promoter | `profile-promoter.ts`: Widened approval types, separates custom from fixed fields, passes `customSelectors` to `upsertProfile` |

### How to use custom fields
In the **Build** tab, after the 3 fixed cards (Title, Description, Images), there's a **Custom Fields** section. Type a field name (e.g. "Size", "Flavor", "Variant"), click **Add Field**, then pick the element 🖱️. The selector + stability badge appear. When you approve in Review, custom fields go into the profile's `customSelectors` map and get extracted alongside the fixed fields.