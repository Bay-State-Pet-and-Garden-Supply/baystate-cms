# e10s04 — Image pick/approve surface at review time

> ✅ **UNBLOCKED — supervisor decisions signed off 2026-08-23** (see §Decisions). May be
> implemented independently of s01–s03/s05.

## Goal
Let reviewers choose/reorder/suppress candidate images and designate the primary image at
review time, so `missing_primary_image` is fixable in Review rather than only observable.

## Current reality (why this is net-new)
Images live inside `extraction_data_json` written wholesale by generic PUT; there is no media
selection endpoint, no reviewed-media persistence, and distributor approved-images are
display-only pending PI-6 rights verification. Editing raw extraction_data at review is
explicitly rejected by this epic (silent-fallback drift risk + distributor immutability guards).

## Decisions (signed off)
1. **Scope:** include in epic e10 now.
2. **Persistence:** namespaced `curation_data.reviewedMedia` key — no schema migration, rides
   the existing whole-JSON write path and `withoutRunOwnedCurationData` stripping rules
   (same pattern as `correctedCategoryPage`).
3. **Rollout:** ship under the single `VITE_REVIEW_UI_V2` flag — no independent flag.
4. **Suppression semantics: OVERWRITE.** Suppressed images are removed from consideration
   without preserving a separate audit copy of the original extraction proposal set.

### Consequences of the OVERWRITE decision (recorded residual risks — accepted)
- The original extraction-proposed image list is not recoverable from the item after
  suppression; if selection logic has bugs, there is no in-item audit trail of what
  extraction originally proposed. Mitigation available at need: re-run extraction, or rely on
  extraction attempt artifacts upstream (not guaranteed for all source types).
- After a first save, subsequent `/media` PUTs validate candidate URLs against the *already-
  overwritten* set, not the pristine extraction output. The route must therefore treat
  `curation_data.reviewedMedia` entries as part of the valid candidate universe.
- Distributor-record items remain constrained regardless: extraction_data is server-immutable;
  suppression applies to `reviewedMedia` only, and commerce approval still governed by PI-6
  `computeCommerceApproved`, never by reviewer assertion.

## Surface (as specced, decisions applied)
- `PUT /api/onboarding/items/:id/media` — body `{ primaryImage, orderedAdditional, suppressed }`;
  validates URLs against the union of the item's existing candidate set **plus** previously
  persisted `reviewedMedia` entries (no new fetches, no network); persists to
  `curation_data.reviewedMedia`; marks consequential via existing
  `markReviewInvalidated('consequential_edit')` path.
- Distributor-record items: selection limited to already-approved display images.
- Promoter reads `reviewedMedia.primaryImage` first, falls back to current resolution chain
  (unchanged).
- UI ships as the interactive media picker inside `ReviewListingPanel`'s listing
  form (V2-only via `onSaveMedia` wiring in `ReviewWorkspace`); the legacy
  display-only `ReviewMediaPanel.tsx` remains untouched behind the same
  `VITE_REVIEW_UI_V2` flag. (Spec originally said "ReviewMediaPanel extension";
  implementation colocates the picker with the full-field listing form instead.)

## Tests
- Route test: candidate-set validation rejects foreign URLs (including URLs that were valid
  before an earlier overwrite save but are now absent from both sets); consequential
  invalidation fires; distributor constraints enforced server-side.
- Component test: picker UI within ReviewMediaPanel extension; primary designation reflected in
  readiness gate (`missing_primary_image` clears).
