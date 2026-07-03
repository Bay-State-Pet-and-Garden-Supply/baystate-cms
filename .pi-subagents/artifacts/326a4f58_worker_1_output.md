All committed and pushed: **`ea3d1a5`**. Here's what was implemented:

## Part A: Picker UX Fix ✅

The overlay now has a **3-state machine**:

| State | What user sees |
|---|---|
| `hovering` | Blue outline on hover. Bottom bar: `"Hovering: h1.product-title — 'Vintage Denim...'"` |
| `candidate-selected` | Green outline + checkmark badge. Bottom bar: `"✓ Selected — [Confirm ✓] [Retry] [Cancel]"` |
| Confirm | Browser closes, element data sent |
| Retry | Back to hovering mode |
| Cancel | Browser closes, no selection |

**Key change**: Browser never closes on first click. User explicitly confirms or cancels.

## Part B: Custom Fields ✅

The Build tab now has a **"Custom Fields"** section after the 3 fixed cards:

- Text input + "Add Field" button to name custom fields (Size, Flavor, Variant, etc.)
- Each added field gets its own 🖱️ picker button + selector display + stability badge
- Remove button (✕) deletes unwanted fields
- Custom selectors flow through the extraction pipeline:
  - `ExtractorProfile.customSelectors` → `Record<string, string>` stored as JSON
  - `ExtractionData.customFields` → extracted via CSS selectors, same as fixed fields
  - DB migration adds `custom_selectors_json` column to `extractor_profiles`

### Files changed

| File | Change |
|---|---|
| `pick-element.ts` | Overlay state machine (confirm/retry/cancel) + hover tooltip |
| `ElementPickerButton.tsx` | `field` prop accepts any string; inline confirmation card |
| `ProfileBuilderWorkspace.tsx` | Custom Fields section in Build tab |
| `page-extractor.ts` | Extracts custom selectors via Cheerio |
| `extract.ts` | Extracts custom selectors in both static + rendered paths |
| `plan.md` | Updated |