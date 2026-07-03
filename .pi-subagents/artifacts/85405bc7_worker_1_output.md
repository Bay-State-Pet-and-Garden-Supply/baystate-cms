No files are staged. The implementation is complete.

## Summary

Implemented the backend refinements to `src/onboarding/source-discovery.ts` only, as scoped.

### Changes made

1. **Task 2 — Mandatory consolidated-name search in Pass 2**:
   - Replaced `const secondPassQueries: string[] = [];` with a `Pass2Query[]` array carrying an optional `mandatory` flag.
   - Added an `addSecondPassQuery(query, mandatory = false)` helper that deduplicates normalized queries.
   - Always enqueues one mandatory unrestricted query `${cleanSearchName} product page` (marked `mandatory: true`).
   - Mapped brand-domain queries (`${cleanSearchName} site:${domain}` + original-name fallback) and the low-candidate `${name} product page` fallback are kept but no longer gate the consolidated-name search.
   - The execution loop respects `if (!q.mandatory && candidates.length >= 15) break;` so mandatory queries are not skipped by the cap.
   - Added a per-query log `[SourceDiscovery] Pass 2 search for UPC ${upc}: "${q.query}"` for audit visibility.
   - Cleaned the search name with `cleanSearchName = searchName.replace(/"/g, '').trim()` so any stray quotes from the LLM don't break the query.
   - Updated the file/function-level comments to describe the actual two-pass strategy.

2. **Task 3 — Guarantee Pass 2 candidates survive the cap**:
   - Added a `selectTopCandidates<T>(candidates, limit)` helper that takes the top N by confidence but, when no `serper_name` candidate is in the slice and at least one exists unselected, swaps the lowest-confidence selected non-name candidate for the highest-confidence unselected `serper_name` candidate, then re-sorts by confidence.
   - Replaced `candidates.slice(0, 10)` with `selectTopCandidates(candidates, 10)`.
   - The clamping `Math.max(0, Math.min(1, c.confidence))` is still applied after selection.

### Validation
- `bun run typecheck` — clean (no output).
- `bun run test` — 200/200 tests pass, 0 fail.
- `bun run lint src/onboarding/source-discovery.ts` — no errors in the edited file.
- `git status` confirms only `src/onboarding/source-discovery.ts` is modified; nothing staged.