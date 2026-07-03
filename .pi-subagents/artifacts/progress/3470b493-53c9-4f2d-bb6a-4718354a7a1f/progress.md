# Progress: Frontend Component Rewrite

## Status: Complete ✅

### Done
- Rewrote `src/client/components/OnboardingSettings.tsx` (908 insertions, 364 deletions, net -249 lines)
- Replaced 3 separate sections (Cached Brand Sites, Domain Extractor Profiles, Domain Diagnostics) with 1 unified Domain Configuration section
- Accordion-expandable table rows with inline DomainDetailPanel
- Single-save model via `saveDomainConfig` (PUT /settings/domains/:domain)
- Brand associations with full-replacement semantics
- TypeScript compiles with zero errors

### Output
- `/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/3470b493-53c9-4f2d-bb6a-4718354a7a1f/frontend-component-implementation.md`

### Next (by others)
- Integration test for the save→refresh round-trip
- Pre-populate profile selectors on expand (requires diagnostics endpoint to include selector data)
