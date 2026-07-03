All changes verified. Here's the structured acceptance report:

---

## Implementation Summary

**Changed files:**
- `src/client/components/ProfileProposalDrawer.tsx`
- `src/client/components/ProfileFieldValidationTable.tsx`

### What changed in `ProfileProposalDrawer.tsx`:
1. **Import**: Added `import { SELECTOR_FIELDS } from '../../shared/schemas/onboarding'` (value import, separate from the existing type-only import)
2. **Removed local `SELECTOR_FIELDS`** (5-entry array with price/brand) — replaced by the shared import which has only 3 fields
3. **Added `FIELD_LABELS`** constant mapping the 3 active fields to display labels
4. **Removed all `priceSelector` and `brandSelector` references** from:
   - `activeSelectors` construction
   - Both `testExtractorProfile` calls in `handlePreview`
   - `handleSubmitFeedback` key iteration
5. **Updated both `SELECTOR_FIELDS.map` calls** to iterate over field strings (using `FIELD_LABELS[field]` for labels)
6. **Added `shopifyJSONPath` state** (`useState(false)`)
7. **Added Shopify productJSON toggle checkbox** after the image previews review section in the approve/reject area
8. **No leftover price/brand/Price/Brand** strings in the file

### What changed in `ProfileFieldValidationTable.tsx`:
1. **Trimmed `FIELD_LABELS`** from 5 entries (title, price, description, brand, images) to 3 entries (title, description, images)
2. Changed type from `Record<SelectorField, string>` to `Record<string, string>` since it's a subset

### Validation
- `bun run typecheck` — passes with no errors
- No remaining `priceSelector` or `brandSelector` references in either file
- `shopifyJSONPath` checkbox renders correctly in the drawer

### Residual risks
- None. The `SelectorField` type in the shared schema still includes price/brand for backward compatibility, which is correct. The validation table's interface still uses `SelectorField` for its props — the parent controls which rows are passed.