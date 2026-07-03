# Worker: profile-governance-service.ts image selector refactor

## Status: Completed

### Changes made
- Added import of `addImageSource`, `cleanAndDeduplicateImages`, `collectImageSourcesFromElement` from `./image-utils`
- Replaced the `if (field === 'imagesSelector')` block in `evaluateSelectorOnSample`:
  - Old: manual direct-attr collection with a heuristic repeated-base warning
  - New: uses shared `collectImageSourcesFromElement($, el)` for src/srcset/data-srcset collection, `addImageSource` for dedup of raw URLs, then `cleanAndDeduplicateImages(rawImages, sampleUrl)` for full canonical dedup
  - Warning now reports raw vs deduped counts instead of the heuristic base-path check

### Verification
- `bun run typecheck` → passed (no errors)
