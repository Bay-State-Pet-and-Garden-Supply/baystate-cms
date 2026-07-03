All requirements are satisfied. Here's the acceptance report:

---

## Implementation Summary

**Implemented**: Replaced the per-field approval table in `ProfileGenerationReview.tsx` with a preview-driven state machine flow (`previewing` → `validating` → `validated` → `promoting` → `promoted`, with `feedback` branching from `previewing`/`validated`).

**Changes made to `src/client/components/ProfileGenerationReview.tsx`**:
- Added `ProfileExtractionPreview` at the top showing the seed preview (from `latestRevision.fieldSamples.seedPreview`) or an on-demand fetched result via `testExtractorProfile`
- Added 6-state state machine (`previewing`, `validating`, `validated`, `promoting`, `promoted`, `feedback`) replacing the old per-field checkbox table
- **"Looks correct"** green button in `previewing` — calls `validateRevision`, transitions to `validated` on success
- **Validation summary** in `validated` — per-field pass/fail/warning tallies from `ValidationRunSummary.byField`, plus image-approval checkbox gate (≥2 passing image samples + operator attestation)
- **"Promote"** blue button in `validated` — calls `approveRevisionFields` with all 3 active fields set to `true`, transitions to `promoted`
- **"Something's wrong"** gray button in `previewing`/`validated` — opens the feedback form inline; after submit reloads and returns to `previewing`
- Removed `ProfileFieldValidationTable` usage, `rejectRevisionFields` call, per-field approve/reject checkbox rows, `approvedFields`/`rejectedFields` state, `runValidation` button, `validationResults`/`validation` state, `buildSummaryFromResults` helper
- Kept revision history accordion, field-decisions/rollback audit trail, delete generation button — all moved below the preview/action area
- Removed `governance` from destructuring to eliminate lint error (kept in interface for backward compatibility)