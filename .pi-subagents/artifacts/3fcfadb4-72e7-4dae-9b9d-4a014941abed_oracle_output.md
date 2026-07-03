Inherited decisions:
- `extractor_profiles` are active domain-level extraction config, used before fallback extraction layers.
- AI-generated profiles are proposal-only and require explicit per-field human approval before promotion.
- `upsertProfile` merge semantics are important: omitted fields preserve existing values; explicit `null` clears.
- Domain profile UI should not live in item review. The review drawer is item/product-stage work, while profiles affect future extraction by domain.
- Settings already owns onboarding configuration and already has both Custom Extractor Profiles and Generated Profile Governance.

Diagnosis:
- The proposed direction is correct: active/manual domain profiles belong in Settings.
- The real gap is wider than UI: `sitemapProductUrlPattern` exists in repo/migration/tests and is used by source discovery, but is missing from the shared `ExtractorProfileSchema`, client save type, and server POST route.
- Do not fully unify manual and generated profiles in one data path right now. Generated profiles have audit/approval invariants that manual edits do not. Keep them adjacent in Settings, not merged.

Drift / contradiction check:
- Adding a `PUT /:id` route may be scope creep unless you intend to support domain renames. Current repo updates by normalized domain, not id.
- Safer narrow path: keep POST/upsert for create/update, make domain editable only for new profiles, and treat existing profile domain as immutable.
- If you add a sitemap field in the form but skip shared schema/client/server updates, the refactor will remain internally inconsistent.
- Removing only the selector-profile dead code from `Onboarding.tsx` is appropriate; avoid broad removal of old review-drawer functions unless separately scoped.

Recommendation:
- Proceed with a narrow Settings-based active profile editor.
- Rename/clarify section as “Active Domain Extractor Profiles” if feasible.
- Add create/edit inline form with:
  - domain
  - title/price/description/brand/images selectors
  - sitemap product URL pattern
  - sample product URL for testing
- Reuse existing `testExtractorProfile`.
- Extend `saveExtractorProfile`, shared schema, and server POST to include `sitemapProductUrlPattern`.
- Do not add `PUT` unless the main agent explicitly wants id-based editing/domain rename semantics.

Risks:
- Manual edits bypass generated-profile governance history and rollback. Acceptable for this narrow fix, but worth noting as future audit work.
- Selector testing requires Playwright/browser availability and may fail for network/anti-bot reasons.
- Worktree appears already heavily dirty; implementation worker must avoid touching unrelated files.

Need from main agent:
- One decision only if needed: should existing profile domain be immutable? I recommend yes for this pass.

Suggested execution prompt:
```text
Implement the narrow Settings-based domain extractor profile refactor.

Scope:
- Add full create/edit UI for active domain extractor profiles in src/client/components/OnboardingSettings.tsx.
- Use existing getExtractorProfiles/deleteExtractorProfile/saveExtractorProfile/testExtractorProfile APIs.
- Add sitemapProductUrlPattern support through shared schema, client API type, and server POST route.
- Remove dead selector-profile imports/state/handlers/calls from src/client/components/Onboarding.tsx only.
- Keep Generated Profile Governance as-is.
- Do not add a PUT route unless absolutely required. Existing rows should have immutable domain in edit mode; domain changes can be done by delete/create.

Validation:
- Run bun run typecheck.
- Run targeted tests if feasible: bun test src/tests/unit/extractor-profiles.test.ts src/tests/unit/db-migration.test.ts.
- Report changed files, commands, failures, and residual risks.
```