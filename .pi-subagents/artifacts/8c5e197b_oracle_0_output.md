Inherited decisions:
- Profiles are domain-scoped; `extractor_profiles.domain` is the production key.
- Generated selectors are proposals only; no auto-application.
- Approval remains per field.
- Image selector approval requires 2+ same-domain validation samples with image preview review.
- Text fields may be approved from one sample, but must show a limited-evidence warning.
- Revisions/decisions/rollback history should remain auditable.

Diagnosis:
- The current system confuses “sample pages” with “profile proposals.” Because the profile is domain-scoped, 3 sampled URLs should not create 3 competing proposals.
- The user’s mental model is simpler and correct: “Show me what this proposed profile does on this product page.”
- Current validation is governance-correct but UX-wrong: it silently pulls `is_selected = 1` sources, so the operator does not understand why those products are being tested.
- The bottom “Generated Profile Governance” panel is too detached from the domain/profile workflow.

Drift / contradiction check:
- Current route creates one `profile_generations` row per sitemap sample, conflicting with the “canonical key is domain” decision.
- Batch validation against hidden confirmed samples honors prior safety rules, but violates operator control/legibility.
- User wants single-product validation. This is compatible for text fields, but not sufficient for image approval unless decision #3 is revised. I recommend preserving the image rule.

Recommendation:
1. Generate one active proposal per domain, not one per sampled URL.
   - The Generate button should use one explicit anchor URL.
   - Default can be a selected source or first cached product URL, but it must be visible/editable.
   - If an open proposal already exists for the domain, “Generate” should open it or create a new revision, not another parallel proposal.
   - Auto-created proposals from extraction should be deduped or disabled until the UX is fixed.

2. Move proposal review into the Domain Configuration accordion.
   - Replace the bottom governance table with either nothing or a compact “Domains needing profile review” link.
   - Inside each domain row show:
     - Active profile selectors.
     - AI proposal selectors.
     - Validation/preview runs.
     - Field approval buttons.
     - Collapsed history/rollback.

3. Make validation single-product-at-a-time and user-chosen.
   - Add a “Validation product URL” input.
   - Operator pastes or selects a product URL.
   - System runs the active profile and proposed profile on that same URL.
   - Show side-by-side extracted title, price, description, brand, and image previews.
   - Persist each validation run as evidence.
   - Let the operator add another URL when they want broader confidence.

4. Keep multi-product validation as an accumulated evidence gate, not an invisible batch.
   - Text fields: approve after one passing validation with warning.
   - Images: require two distinct user-visible validation runs with reviewed previews.
   - Optional suggested URLs may be offered, but the user must choose/run them intentionally.

5. Show “active vs proposal” clearly.
   - For each field:
     - Current active selector and extracted value.
     - Proposed selector and extracted value.
     - Warnings.
     - Approve/reject/keep current.
   - Ideally preview the full extractor result using a temporary in-memory profile override, labeled “preview only,” so this does not violate the no-unapproved-application invariant.

Best operator flow:
1. Open domain row.
2. Enter or confirm one product URL.
3. Click Generate AI Proposal.
4. See one proposal for that domain.
5. Click Preview on that same product URL.
6. Compare active extraction vs proposal extraction.
7. Approve/reject fields individually.
8. Add another validation URL only if desired/needed.
9. Image selector approval unlocks only after 2 passing previewed URLs.
10. Approved fields merge into `extractor_profiles`.

Risks:
- Existing historical duplicate proposals need cleanup or grouping.
- If auto proposal creation remains enabled, it can recreate confusion unless deduped.
- “Full extraction preview with temporary selectors” may need a new read-only API; existing `testExtractorProfile` is close but likely not sufficient for persistent approval evidence.
- If the user wants image approval from one product only, that conflicts with the existing locked image-safety decision.

Need from main agent:
- Decide whether to disable automatic proposal creation entirely or keep it with strict one-open-proposal-per-domain dedupe.
- Decide whether to keep a minimal global review queue or remove the bottom panel from normal settings UX.

Suggested execution prompt:
- No implementation handoff is strictly warranted until the above UX direction is accepted.