Typecheck passes cleanly and all 200 tests pass. The implementation is complete.

---

## Summary

Implemented the frontend refinements to `src/client/components/PipelineBoard.tsx` only, as scoped.

### Changes made

**Grouped source list rendering by `sourceMethod`** in the discovery review drawer:

1. **Replaced the flat source list** (`reviewSources.map((src) => ...)`) with a grouped IIFE that partitions sources by `sourceMethod`:
   - `serper_upc` → rendered in a **"UPC search"** group (blue badge, label `UPC search ("<upc>")`)
   - `serper_name` → rendered in a **"Name search"** group (purple badge, label `Name search ("<expectedName or name>")`)
   - Unknown/legacy method values (e.g. `serper`) → catch-all **"Other search"** group so nothing is silently dropped

2. **Group order is stable**: UPC group first, then Name group, then a single "other" bucket for any leftovers.

3. **Per-group header** shows: short method badge (color-coded), descriptive long label (e.g. `Name search ("Nature's Way Squirrel Baffle Dual Mount 16 Inch Plastic")`), and a `N results` count on the right.

4. **Per-source badge** — each candidate card now also shows a small colored method badge in its top-right row next to the confidence percentage, so the operator can see at a glance which pass produced each URL.

5. **Empty-state handling** — if a product has no sources at all, the drawer now renders a clear "No source candidates were returned for this product." message instead of an empty box.

6. **Preserved everything else**:
   - Existing "🔍 Searching for:" banner showing `reviewItem.expectedName` is untouched and still at the top of the section.
   - Click-to-select behavior is preserved per-card (each source card still has its own `onClick` handler calling the same `select-source` endpoint).
   - "✓ Selected" green highlight, snippet, URL line, and confidence % are unchanged.
   - Manual URL input and clickable URL block below the source list are untouched.

7. **Reduced the over-eager scroll container** — the outer wrapper is now the single scrollable area for all groups (instead of one scroll container wrapping the whole list), which behaves better with the new section structure.

### Validation
- `bun run typecheck` — clean (no output).
- `bun run test` — 200/200 tests pass, 0 fail.
- `npx eslint src/client/components/PipelineBoard.tsx` — 4 errors, all pre-existing (lines 64, 90, 91, 171 — unused `onRefreshBrandSites` prop, unused `drawerBrandName` / `drawerBrandDomain` state, unused `selectAllInColumn` function). None of them are in the modified source-list rendering area (lines 1043–1243).
- `git status` confirms only `src/client/components/PipelineBoard.tsx` was modified; nothing staged.

---

## Acceptance Report