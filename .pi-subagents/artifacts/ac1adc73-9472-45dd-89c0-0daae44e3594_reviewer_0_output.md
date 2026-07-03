## Review
- Correct: `listAllDomainStatuses()` directly selects from `domain_status` and maps rows without calling `getDomainStatus()` or deleting stale records (`src/db/repositories/domain-status-repo.ts:111-122`).
- Correct: `listAllSitemapCaches()` directly selects all sitemap cache rows and parses them without calling `getCachedSitemapUrls()` or deleting expired/malformed rows (`src/db/repositories/sitemap-cache-repo.ts:131-168`).
- Correct: `domain-diagnostics-service.ts` imports only read-oriented repository functions plus shared types (`src/onboarding/domain-diagnostics-service.ts:22-40`), reads those five sources (`src/onboarding/domain-diagnostics-service.ts:141-146`), and unions domains from profiles, sitemap cache, health status, brand sites, and profile-generation summaries (`src/onboarding/domain-diagnostics-service.ts:166-179`). I found no network fetcher, discovery, extraction, generation, validation, write, or destructive repo call in the service.
- Correct: Stale flags are derived in the service from `sitemapExpiresAt` and the 7-day health window (`src/onboarding/domain-diagnostics-service.ts:52-63`, `src/onboarding/domain-diagnostics-service.ts:107-109`). Missing sitemap/health rows are reported as non-stale with default counts/statuses (`src/onboarding/domain-diagnostics-service.ts:116-124`).
- Correct: Shared schemas define the Domain Diagnostics entry/response envelope used by client/server, including `unknown` health status for domains without health rows (`src/shared/schemas/onboarding.ts:533-577`).
- Correct: The GET route is a side-effect-free wrapper around `getDomainDiagnosticsResponse()` (`src/server/routes/onboarding-routes.ts:1057-1058`).
- Correct: The client API and settings UI are wired to the new read-only endpoint and render a Domain Diagnostics table with stale indicators (`src/client/onboarding-api.ts:333-334`, `src/client/components/OnboardingSettings.tsx:204-209`, `src/client/components/OnboardingSettings.tsx:894-1056`).
- Correct: Unit coverage exercises the five-source union (`src/tests/unit/domain-diagnostics-service.test.ts:67-105`) and verifies stale sitemap/health rows remain in the DB after diagnostics (`src/tests/unit/domain-diagnostics-service.test.ts:190-239`). Repository tests also cover read-only sitemap cache listing (`src/tests/unit/sitemap-cache-repo.test.ts:132-225`) and per-domain generation summaries (`src/tests/unit/profile-generation-repo.test.ts:264-300`).
- Fixed: none; review-only task, no implementation files modified.
- Blocker: none found in the reviewed Domain Diagnostics MVP scope.
- Note: `progress.md` was requested as input but does not exist in the repo (`ENOENT`); `plan.md` was read. No route/component automated test was found for the GET route or UI rendering, but the route is trivial and service/repository tests cover the core invariants. Full `bun run test` was not run; targeted diagnostics/repository tests and typecheck passed. The working tree contains many unrelated unstaged/untracked changes outside the requested review scope, which I did not assess.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Reviewed the requested Domain Diagnostics files only; the service is read-only, unions the five source tables, uses non-destructive repository list functions, and the route/client/UI wiring stays within the diagnostics MVP scope."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Report includes file:line evidence for invariants, tests inspected, commands run, validation output, residual risks, and no-staged-files status."
    }
  ],
  "changedFiles": [
    "src/onboarding/domain-diagnostics-service.ts",
    "src/shared/schemas/onboarding.ts",
    "src/db/repositories/domain-status-repo.ts",
    "src/db/repositories/sitemap-cache-repo.ts",
    "src/db/repositories/profile-generation-repo.ts",
    "src/server/routes/onboarding-routes.ts",
    "src/client/onboarding-api.ts",
    "src/client/components/OnboardingSettings.tsx"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/domain-diagnostics-service.test.ts",
    "src/tests/unit/sitemap-cache-repo.test.ts",
    "src/tests/unit/profile-generation-repo.test.ts"
  ],
  "commandsRun": [
    {
      "command": "git status --short; git diff --stat; git diff --name-status; git diff --cached --name-only",
      "result": "passed",
      "summary": "Inspected working tree and confirmed no staged files; many unrelated unstaged/untracked changes exist outside the requested review scope."
    },
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "tsc --noEmit --skipLibCheck completed with exit 0."
    },
    {
      "command": "bun test src/tests/unit/domain-diagnostics-service.test.ts src/tests/unit/sitemap-cache-repo.test.ts src/tests/unit/profile-generation-repo.test.ts",
      "result": "passed",
      "summary": "28 pass, 0 fail, 158 expect() calls across 3 files."
    }
  ],
  "validationOutput": [
    "Typecheck: TYPECHECK_EXIT=0; output: $ tsc --noEmit --skipLibCheck.",
    "Targeted tests: TARGETED_TESTS_EXIT=0; 28 pass, 0 fail across domain diagnostics, sitemap cache, and profile generation repository tests.",
    "No staged files: git diff --cached --name-only produced no output."
  ],
  "residualRisks": [
    "No automated route/component test was found for the GET handler or OnboardingSettings rendering; verified by static inspection only.",
    "Full bun run test was not run; validation was limited to typecheck plus targeted diagnostics/repository tests.",
    "The repo has many unrelated unstaged/untracked changes outside the requested review scope."
  ],
  "noStagedFiles": true,
  "diffSummary": "Domain Diagnostics MVP adds a read-only aggregation service, non-destructive repository listing helpers, shared response schemas, a GET route, client API method, Settings UI section, and focused unit coverage. No blockers found in the reviewed files.",
  "reviewFindings": [
    "no blockers",
    "note: src/tests/unit/domain-diagnostics-service.test.ts:67-105 covers five-source union; src/tests/unit/domain-diagnostics-service.test.ts:190-239 covers stale rows remaining after diagnostics",
    "note: no route/UI automated test found; static inspection confirms route and UI wiring"
  ],
  "manualNotes": "Read plan.md successfully. progress.md was requested but missing (ENOENT). No implementation files were modified by this review; only the required review artifact was written."
}
```
