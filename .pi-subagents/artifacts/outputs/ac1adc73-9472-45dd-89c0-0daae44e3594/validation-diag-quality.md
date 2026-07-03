## Review
- Correct: The Domain Diagnostics UI is integrated in the existing settings layout and reuses established inline styles: the section uses `styles.section`, its table uses `styles.table`, and cells/headers use `styles.th`/`styles.td` (`src/client/components/OnboardingSettings.tsx:894`, `src/client/components/OnboardingSettings.tsx:923`).
- Correct: Stable anchors are present for Brand Sites, Domain Extractor Profiles, Domain Diagnostics, and Generated Profile Governance (`src/client/components/OnboardingSettings.tsx:719`, `src/client/components/OnboardingSettings.tsx:770`, `src/client/components/OnboardingSettings.tsx:894`, `src/client/components/OnboardingSettings.tsx:1065`). Row links target those anchors (`src/client/components/OnboardingSettings.tsx:1028`, `src/client/components/OnboardingSettings.tsx:1034`, `src/client/components/OnboardingSettings.tsx:1040`).
- Correct: The Refresh button is read-only: it calls only `loadDomainDiagnostics` (`src/client/components/OnboardingSettings.tsx:899-905`), which calls only `getDomainDiagnostics()` and updates local state (`src/client/components/OnboardingSettings.tsx:204-213`). The client wrapper is a GET (`src/client/onboarding-api.ts:333-334`), the route returns `getDomainDiagnosticsResponse()` (`src/server/routes/onboarding-routes.ts:1057-1058`), and the service reads through list/summary repo functions only (`src/onboarding/domain-diagnostics-service.ts:141-146`).
- Correct: The empty state is clear and matches the plan wording (`src/client/components/OnboardingSettings.tsx:916-920`).
- Correct: Health badge colors match the requested mapping: ok green, blocked red, offline gray, mismatch amber, and unknown light-gray/outline (`src/client/components/OnboardingSettings.tsx:70-75`).
- Correct: I found no destructive controls in the Domain Diagnostics section; the only section button is Refresh, and the helper text explicitly says it does not fetch remote sitemaps, generate profiles, or clear caches (`src/client/components/OnboardingSettings.tsx:899-913`).
- Correct: Helper functions are small and focused: `domainHealthBadgeStyle`, `formatOptionalIsoDate`, and `truncateText` (`src/client/components/OnboardingSettings.tsx:78`, `src/client/components/OnboardingSettings.tsx:94`, `src/client/components/OnboardingSettings.tsx:101`).
- Correct: State management follows the component’s existing `useState`/`fetchData` pattern via diagnostics state at `src/client/components/OnboardingSettings.tsx:146-148` and settings-load refresh at `src/client/components/OnboardingSettings.tsx:232`.
- Correct: The section is placed naturally after Domain Extractor Profiles and before Generated Profile Governance (`src/client/components/OnboardingSettings.tsx:770`, `src/client/components/OnboardingSettings.tsx:894`, `src/client/components/OnboardingSettings.tsx:1065`).
- Correct: Tests cover the requested service scenarios: empty DB (`src/tests/unit/domain-diagnostics-service.test.ts:49`), single-source domains (`src/tests/unit/domain-diagnostics-service.test.ts:67`), full populate (`src/tests/unit/domain-diagnostics-service.test.ts:137`), and stale rows remaining present after diagnostics (`src/tests/unit/domain-diagnostics-service.test.ts:190`, `src/tests/unit/domain-diagnostics-service.test.ts:237-239`).
- Fixed: None; review-only task and no files were modified except this required report artifact.
- Blocker: None found.
- Note: `/Users/nickborrello/Desktop/Projects/shopsite-cms/progress.md` was not present. Full `bun run test`, lint, and browser/manual scroll-link smoke were not run; targeted service tests and typecheck passed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Reviewed implementation stays within the read-only Domain Diagnostics MVP: one GET-backed refresh, no diagnostics destructive buttons/routes, and no profile-generation or sitemap-refresh actions in the UI."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Findings cite file:line evidence for UI placement, anchors, links, refresh behavior, colors, helpers, tests, and validation commands."
    }
  ],
  "changedFiles": [
    "src/client/components/OnboardingSettings.tsx",
    "src/onboarding/domain-diagnostics-service.ts",
    "src/tests/unit/domain-diagnostics-service.test.ts",
    "src/client/onboarding-api.ts",
    "src/server/routes/onboarding-routes.ts",
    "src/shared/schemas/onboarding.ts",
    "src/db/repositories/domain-status-repo.ts",
    "src/db/repositories/sitemap-cache-repo.ts",
    "src/db/repositories/profile-generation-repo.ts"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/domain-diagnostics-service.test.ts"
  ],
  "commandsRun": [
    {
      "command": "bun run test:unit src/tests/unit/domain-diagnostics-service.test.ts",
      "result": "failed",
      "summary": "Vitest reported no files because vitest.config.ts excludes this Bun-run test file."
    },
    {
      "command": "bun test src/tests/unit/domain-diagnostics-service.test.ts",
      "result": "passed",
      "summary": "4 tests passed, 0 failed, 54 expect() calls."
    },
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "tsc --noEmit --skipLibCheck completed with exit code 0."
    },
    {
      "command": "git diff --cached --quiet && echo no-staged-files || echo staged-files-present",
      "result": "passed",
      "summary": "no-staged-files"
    }
  ],
  "validationOutput": [
    "Targeted Domain Diagnostics service test passed: 4 pass / 0 fail.",
    "Typecheck passed with no output from tsc.",
    "No staged files detected."
  ],
  "residualRisks": [
    "Full bun run test, bun run lint, and browser/manual UI smoke were not run in this review.",
    "progress.md was absent, so no progress notes could be reviewed."
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only Domain Diagnostics section integrated into Onboarding Settings with a GET-backed aggregation service and unit coverage for empty, single-source, full-populate, and stale-row preservation cases.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "Use bun test for src/tests/unit/domain-diagnostics-service.test.ts; the repo's Vitest config excludes this file for the test:unit path."
}
```