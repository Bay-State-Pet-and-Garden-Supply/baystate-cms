Inherited decisions:
- Profile generation proposals are human-reviewed before promotion.
- `imagesSelector` approval requires multi-sample validation plus image preview attestation.
- Validation runs in Cheerio/static HTML, so no `naturalWidth`, rendered visibility, or layout state.
- Current extractor profiles are CSS-selector based; schema changes should be avoided unless clearly necessary.
- Production extraction already has image URL canonicalization/deduping in `page-extractor.ts`.

Diagnosis:
- This is not mainly an LLM weakness. It is a selector/validation architecture limitation.
- The LLM can pick `.product-gallery img`, but CSS alone cannot reliably distinguish hero images from thumbnail indicators when both are similar `<img>` nodes.
- The current validation path is behind production extraction: `profile-governance-service.ts` image validation collects direct `src`-style attrs and only warns on repeated base paths; it does not reuse the stronger production image normalization logic.

Drift / contradiction check:
- Option D conflicts with the existing stable selector-profile schema and would widen scope.
- Option B relies on the LLM making a better choice, but the model may still lack a better selector if DOM structure does not expose one.
- Option C as a broad production-path change is risky and partly duplicative because production already calls `cleanAndDeduplicateImages`.
- The actual inconsistency is between validation previews and production extraction cleanup.

Recommendation:
- Implement **Option A first**, but not as a one-off naive regex-only filter.
- Best narrow implementation: extract/reuse the existing image canonicalization/deduping logic from `page-extractor.ts` in `profile-governance-service.ts` validation.
- Also make governance validation collect `srcset`/`data-srcset` candidates the same way the extractor does.
- Keep the warning, but return deduped/highest-quality previews so the reviewer sees what production would likely use.
- Do **not** implement B or D now. Consider C only as a follow-up if tests reveal production extraction still keeps the lower-res candidate due “first URL wins.”

Risks:
- URL heuristics can misclassify legitimate product images with size-like filenames.
- If only thumbnails are present in static HTML, filtering too aggressively could hide all image evidence.
- Existing `cleanAndDeduplicateImages` may need improvement to prefer highest-res candidate per canonical group, not merely first-seen.

Need from main agent:
- No decision needed; recommended path is A-with-shared-normalizer.

Suggested execution prompt:
- Implement a narrow image validation cleanup: extract reusable image URL collection/canonicalization/deduping helpers from `page-extractor.ts` into a shared onboarding utility; update `page-extractor.ts` to use the helper unchanged; update `profile-governance-service.ts` image selector validation to collect `src`, data image attrs, and `srcset` candidates, then return deduped/highest-quality image previews using the shared helper; preserve warnings for filtered duplicate/thumbnail candidates; add unit tests for Shopify-style `_80x80`, `_150x150_crop_center`, `_compact`, and high-res/unsized duplicate groups. Do not change selector schema or LLM prompt.