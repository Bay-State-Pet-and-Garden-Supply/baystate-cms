# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement the Domain Diagnostics MVP as a read-only section in the existing Onboarding Pipeline Settings page. Aggregate domains from extractor_profiles, sitemap_cache, domain_status, brand_sites, and profile_generations.

The full plan is at .pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/plan.md — read it first.

HARD CONSTRAINTS
- Evolve OnboardingSettings.tsx in place. Do not add a new top-level nav item or route.
- Diagnostics is read-only for this MVP. Do not add clear, delete, refresh-sitemap, generate-profile, approve, reject, promote, rollback, or extraction actions.
- Do not call getCachedSitemapUrls() from diagnostics; it deletes expired sitemap rows. Add/use listAllSitemapCaches() instead.
- Do not call getDomainStatus() from diagnostics; it deletes stale health rows. Add/use listAllDomainStatuses() instead.
- Do not merge generated profile governance, brand management, or manual extractor profile management into diagnostics. The diagnostics table may link to existing sections only.
- Do not add a schema migration.
- Keep direct SQL inside repository files. The new aggregation service must read through repo functions.

IMPLEMENTATION STEPS (from the plan):
1. In src/shared/schemas/onboarding.ts, add DomainHealthStatusEnum, DomainDiagnosticsBrandAssociationSchema, DomainDiagnosticsEntrySchema, and DomainDiagnosticsResponseSchema with matching type exports.
2. In src/db/repositories/domain-status-repo.ts, add listAllDomainStatuses() as a plain ORDER BY domain read. Do not apply 7-day eviction.
3. In src/db/repositories/sitemap-cache-repo.ts, add listAllSitemapCaches() as a plain ORDER BY domain read. Parse urls_json safely. Do not call getCachedSitemapUrls().
4. In src/db/repositories/profile-generation-repo.ts, add listProfileGenerationDomainSummaries() with COUNT(*) per domain and latest status by created_at DESC, rowid DESC.
5. Create src/onboarding/domain-diagnostics-service.ts. Export buildDomainDiagnostics() and getDomainDiagnosticsResponse(). Use only repo reads. Return one sorted entry per domain union from all 5 source tables. Derive sitemapStale from expiresAt vs now; derive healthStale from 7-day window. Do not call network fetchers, discovery, extraction, sitemap fetching, profile generation, or any write functions.
6. In src/server/routes/onboarding-routes.ts, add GET /onboarding/settings/domain-diagnostics near the settings extractor-profile routes.
7. In src/client/onboarding-api.ts, add getDomainDiagnostics(): Promise<DomainDiagnosticsResponse>.
8. In src/client/components/OnboardingSettings.tsx, add diagnostics state, loader, fetchData integration, formatting helpers, anchor ids on existing sections, and the new read-only diagnostics table between extractor profiles and generated governance.
9. Add tests: extraction-remedies.test.ts (listAllDomainStatuses), sitemap-cache-repo.test.ts (listAllSitemapCaches), profile-generation-repo.test.ts (summaries), new domain-diagnostics-service.test.ts (aggregation + stale flags + no mutation).
10. Run validation:
    - bun run typecheck
    - bun run test src/tests/unit/extraction-remedies.test.ts src/tests/unit/sitemap-cache-repo.test.ts src/tests/unit/profile-generation-repo.test.ts src/tests/unit/domain-diagnostics-service.test.ts
    - bun run test
    - bun run lint

SUCCESS CRITERIA
- GET /api/onboarding/settings/domain-diagnostics returns one row per known domain from the union of all five source tables.
- Expired sitemap rows and stale domain_status rows are visible and remain in the DB after the GET.
- The Settings UI shows Domain Diagnostics with profile, sitemap, health, brand, and generation columns plus links to existing sections.
- No destructive or side-effecting diagnostics actions exist in the MVP.

Report changed files, validation results, and any residual issues.

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