## Review
- Correct: `src/shared/schemas/onboarding.ts:161-170` includes `sitemapProductUrlPattern: z.string().nullable().default(null)` on `ExtractorProfileSchema`.
- Correct: `src/client/onboarding-api.ts:311-319` includes `sitemapProductUrlPattern?: string | null` in `saveExtractorProfile`'s parameter type, and the body sends the full `data` object.
- Correct: `src/server/routes/onboarding-routes.ts:1023-1033` destructures `sitemapProductUrlPattern` from the request JSON and passes it through to `upsertProfile`.
- Correct: `src/client/components/OnboardingSettings.tsx` has the expected create/edit profile flow: form state maps the sitemap pattern (`:27-58`), `+ New Profile` opens the inline create form (`:707-735`), Edit inserts an inline row form (`:778-804`), the domain input is disabled/read-only in edit mode (`:917-936`), the sitemap field is present (`:994-1003`), Test calls `testExtractorProfile` (`:302-318`), Save calls `saveExtractorProfile` with the sitemap pattern (`:329-346`), and Cancel resets form/edit state (`:292-296`, `:1089-1092`).
- Correct: `src/client/components/Onboarding.tsx` no longer contains selector-profile state/import/call references such as `getExtractorProfiles`, `saveExtractorProfile`, `testExtractorProfile`, `titleSelector`, or `selectorTest*`; the selected-batch view delegates to `PipelineBoard` (`:1150-1158`).
- Fixed: none; review-only task and no source files were modified.
- Blocker: Existing full test suite does not pass. `bun run test` exits with code 1: 250 pass / 3 fail, all in `src/tests/unit/extraction-remedies.test.ts` (`:29`, `:41`, `:49`) where domain status repository expectations receive `undefined`/`false`.
- Note: Focused domain-extractor persistence/migration tests pass (`bun test src/tests/unit/extractor-profiles.test.ts src/tests/unit/db-migration.test.ts`: 23 pass). `bun run typecheck` also passes.
- Note: The requested root `/Users/nickborrello/Desktop/Projects/shopsite-cms/progress.md` file was not present (read returned ENOENT), so this review used `plan.md` and the git diff.
- Note: Broader legacy onboarding pipeline/review handlers and imports remain in `Onboarding.tsx` (`startSourceDiscovery`/`startExtraction`/`startCuration` imports at `:7-10`, old review/selection state at `:54-83`, handlers beginning around `:308`). They are not selector-profile remnants and did not break typecheck, but the file is still not fully simplified outside the requested selector cleanup.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The requested sitemapProductUrlPattern plumbing is present in the schema, client API type, server route, and settings UI without requiring source edits during review. Onboarding.tsx selector-profile references were removed."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Review cites concrete file/line evidence, changed files inspected, tests observed, commands run, validation outputs, and residual risks."
    }
  ],
  "changedFiles": [
    "src/shared/schemas/onboarding.ts",
    "src/client/onboarding-api.ts",
    "src/server/routes/onboarding-routes.ts",
    "src/client/components/OnboardingSettings.tsx",
    "src/client/components/Onboarding.tsx",
    "src/tests/unit/extractor-profiles.test.ts",
    "src/tests/unit/db-migration.test.ts"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/extractor-profiles.test.ts",
    "src/tests/unit/db-migration.test.ts"
  ],
  "commandsRun": [
    {
      "command": "git status --short && git diff --stat -- src/shared/schemas/onboarding.ts src/client/onboarding-api.ts src/server/routes/onboarding-routes.ts src/client/components/OnboardingSettings.tsx src/client/components/Onboarding.tsx",
      "result": "passed",
      "summary": "Confirmed the five requested files are modified and reviewed the diff stat."
    },
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "tsc --noEmit --skipLibCheck completed successfully."
    },
    {
      "command": "bun run test",
      "result": "failed",
      "summary": "Full suite failed: 250 pass, 3 fail in src/tests/unit/extraction-remedies.test.ts domain status repository tests."
    },
    {
      "command": "bun test src/tests/unit/extractor-profiles.test.ts src/tests/unit/db-migration.test.ts",
      "result": "passed",
      "summary": "Relevant extractor profile and migration tests passed: 23 pass, 0 fail."
    },
    {
      "command": "git diff --cached --quiet",
      "result": "passed",
      "summary": "No staged files detected."
    }
  ],
  "validationOutput": [
    "ExtractorProfileSchema includes sitemapProductUrlPattern as nullable/default-null at src/shared/schemas/onboarding.ts:169.",
    "saveExtractorProfile accepts sitemapProductUrlPattern at src/client/onboarding-api.ts:318.",
    "Server route passes sitemapProductUrlPattern to upsertProfile at src/server/routes/onboarding-routes.ts:1023-1033.",
    "OnboardingSettings create/edit form includes immutable edit domain, sitemap field, test/save/cancel handlers, and inline row editing.",
    "bun run typecheck passed.",
    "bun run test failed with 3 extraction-remedies failures unrelated to the five reviewed files."
  ],
  "residualRisks": [
    "No component/UI test was found for the OnboardingSettings create/edit form; form behavior was validated by static code review.",
    "Full test suite is red until the extraction-remedies/domain-status failures are fixed or triaged."
  ],
  "noStagedFiles": true,
  "diffSummary": "Adds sitemapProductUrlPattern across extractor profile schema/API/route/settings UI, moves extractor profile editing into OnboardingSettings, removes selector-profile references from Onboarding.tsx, and updates extractor-profile/migration tests.",
  "reviewFindings": [
    "blocker: src/tests/unit/extraction-remedies.test.ts:29 - bun run test fails because recordDomainStatus returns undefined where entry.domain is expected.",
    "blocker: src/tests/unit/extraction-remedies.test.ts:41 - bun run test fails because normalized recordDomainStatus result is undefined.",
    "blocker: src/tests/unit/extraction-remedies.test.ts:49 - bun run test fails because clearDomainStatus returns false instead of true.",
    "note: no code correctness regressions found in the requested sitemapProductUrlPattern plumbing or settings form by static review."
  ],
  "manualNotes": "No source files were modified by this review. The requested root progress.md was absent (ENOENT), so review proceeded from plan.md plus git diff."
}
```