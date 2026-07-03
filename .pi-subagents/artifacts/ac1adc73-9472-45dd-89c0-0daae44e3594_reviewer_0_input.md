# Task for reviewer

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/progress.md]

Review the Domain Diagnostics MVP for correctness and regressions.

New/changed files to inspect:
- src/onboarding/domain-diagnostics-service.ts (new)
- src/shared/schemas/onboarding.ts (look for DomainDiagnostics schemas)
- src/db/repositories/domain-status-repo.ts (look for listAllDomainStatuses)
- src/db/repositories/sitemap-cache-repo.ts (look for listAllSitemapCaches)
- src/db/repositories/profile-generation-repo.ts (look for listProfileGenerationDomainSummaries)
- src/server/routes/onboarding-routes.ts (look for domain-diagnostics GET route)
- src/client/onboarding-api.ts (look for getDomainDiagnostics)
- src/client/components/OnboardingSettings.tsx (look for Domain Diagnostics section)

Verify these invariants:
1. listAllDomainStatuses does NOT call getDomainStatus (no 7-day eviction)
2. listAllSitemapCaches does NOT call getCachedSitemapUrls (no expiry deletion)
3. domain-diagnostics-service.ts reads ONLY through repo functions, never calls network fetchers, discovery, extraction, or write functions
4. The GET route returns getDomainDiagnosticsResponse() with no side effects
5. The domain union includes domains from all 5 source tables
6. Stale flags are derived correctly (sitemapStale from expiresAt, healthStale from 7-day window)
7. Typecheck passes and targeted tests pass

Report file:line references for any issues. Do not modify files.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/ac1adc73-9472-45dd-89c0-0daae44e3594/validation-diag-correctness.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```