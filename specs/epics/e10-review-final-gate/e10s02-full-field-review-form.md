# e10s02 — Full-field review form (editability matrix)

## Goal
Expand the review inspector from 5 editable fields to the full curated-field inventory per the
matrix in `specs/review-ui-rebuild-plan.md` §3, honoring source-type mutability, behind
`VITE_REVIEW_UI_V2`.

## Files
- **Edit:** `src/client/components/onboarding/review/review-types.ts` — extend `ReviewDraft`
  (price, quantity; grouped RO sections modeled separately) + add `ReviewFieldEditability`
  derivation types.
- **New:** `src/client/components/onboarding/review/review-editability.ts` — pure
  `fieldEditability(sourceType, field): 'editable' | 'readonly' | 'locked-with-note'` implementing
  the §3 matrix. Unit-tested independently.
- **Edit:** `ReviewListingPanel.tsx` → becomes the listing form: add price/quantity inputs;
  RO groups for dimensions/MPN/case pack/UOM/ingredients/distributorCategory/bullets/custom
  fields (collapsible "Listing facts", tolerant of `.passthrough()` unknown keys); provenance
  badges (titleSource, curationMethod, packagingOcrTitle).
- **Edit:** `ReviewWorkspace.tsx` — draft state extension, explicit Save (existing
  `handleSaveEdit` PUT flow extended with new keys), dirty-state navigation guard.
- Reuse: `SearchableBrandSelector`, `EvidenceCitationList`, existing `rv-*` CSS.

## Behavioral contract
- Explicit/debounced save only — NO keystroke autosave (consequential-edit invalidation:
  every save triggers server `markReviewInvalidated('consequential_edit')`; autosave would
  thrash durable review state).
- Distributor-record rows: price input rendered disabled WITH visible explanatory note
  ("Distributor pricing set centrally"); no price key ever sent in PUT payload; extraction_data /
  source_url affordances hidden (server rejects them 400).
- Weight edits preserve lbs normalization (`convertToLbs`) and show unit label.
- Unknown extraction keys render as generic RO rows or are ignored — never invented editors.
- After save: invalidate cached detail, eager reload, silent queue refresh (existing pattern).

## Tests
- New `src/tests/unit/review-editability.test.ts`: matrix truth table across both source types.
- New `src/tests/unit/review-listing-form.test.tsx`: edit/save PUT payloads per source type;
  disabled price + note on distributor rows; unknown-key tolerance; weight unit handling.
- Extend `src/tests/unit/onboarding-review-state.test.ts` expectations: consequential saves
  still invalidate (no regression).

## Acceptance criteria
- Every field marked Edit in plan §3 is viewable and editable by a reviewer on official_page
  items under the flag; distributor constraints are communicated, never dead silent fields.
- Flag off ⇒ component tree and payloads byte-equivalent to today's behavior.
