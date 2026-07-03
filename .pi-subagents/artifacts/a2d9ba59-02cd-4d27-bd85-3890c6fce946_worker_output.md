All changes are verified and typecheck passes. Here's the full acceptance report.

---

## Acceptance Report

Implemented Tasks 1, 2, and 7 as specified.

### Changed files:

1. **`src/onboarding/profile-generator.ts`**
   - **Task 1:** Added `variantSelectionStrategy` optional nested object field to `GeneratedSelectorProfile` interface (after `imagesSelector`)
   - **Task 2a:** Added 5 new CSS selector patterns for image candidate discovery after the existing pattern
   - **Task 2b:** Added `baseUrl?: string` parameter to `buildSelectorCandidates` function signature
   - **Task 2c:** Changed `buildSelectorCandidates(minimized)` → `buildSelectorCandidates(minimized, _url)` in `generateExtractorProfile`

2. **`src/shared/schemas/extraction-worker.ts`**
   - **Task 7a:** Added `VariantSelectionStrategySchema` Zod object and its inferred type after `SpreadsheetHintSchema`
   - **Task 7b:** Updated `ProfileProposalDraftSchema.variantSelectionStrategy` from `z.record(z.string(), z.unknown())` to `VariantSelectionStrategySchema.nullable().default(null)`
   - **Task 7c:** Updated `ExtractRequestSchema.profile.variantSelectionStrategy` identically
   - **Task 7d:** Enhanced `ValidationSampleResultSchema.variantResult` with `containerSelector`, `optionType`, `detectedOptions`, `optionFields`, and `strategyValid` fields

3. **`src/extraction-worker/routes/validate.ts`** (required fixup)
   - Updated the `variantResult` type annotation and construction block to include all new fields matching the enhanced schema

### Validation:
- `bun run typecheck` passes with zero errors
- All key change points verified via grep

### Commands run:
| Command | Result | Summary |
|---------|--------|---------|
| `bun run typecheck` | passed | Zero TypeScript errors |
| `grep` on all changed files | passed | All new field names, selectors, and signature changes confirmed present |

### No staged files
Confirmed via `git status --short`: all changed files are in working tree (repo has no initial commit yet), none staged.