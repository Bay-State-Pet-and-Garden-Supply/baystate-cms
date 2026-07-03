# Progress: Scout dead code in Onboarding.tsx

## Completed
- Read and analyzed `Onboarding.tsx` (1271 lines) in full
- Read `PipelineBoard.tsx` review drawer section to confirm migration
- Grep-searched across entire `src/client` for all selector-related identifiers
- Confirmed all 8 selector state variables, 3 selector functions, and 3 imports are completely dead
- Identified that the entire old review drawer (lines 426-710) is also orphaned — migrated to PipelineBoard
- Wrote comprehensive findings to output file

## Key Findings
- The selector editor UI was removed when the review drawer moved to PipelineBoard.tsx
- `handleTestSelectors` and `handleSaveSelectorProfile` are never called from any JSX event handler
- `testingSelectors` state is **never read** anywhere (only set)
- `testExtractorProfile` API function is dead system-wide (only used in dead path)
- Removing selector dead code alone requires also cleaning the parent orphaned functions

## Output
Written to: `/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b221a255-8448-442c-8bd0-7eea6637271a/scout-onboarding-deadcode.md`
