# Task for context-builder

Build the integration plan: how to unify sitemap cache + domain status + extractor profiles into one Domain Diagnostics section.

Read:
- The current Domain Extractor Profiles section in OnboardingSettings.tsx (the one we just refactored)
- The Generated Profile Governance section in OnboardingSettings.tsx
- src/db/repositories/extractor-profile-repo.ts (listAllProfiles)
- src/db/repositories/brand-site-repo.ts (listAllBrandSites)

Produce:
1. The unified DomainDiagnosticsEntry type that combines: domain, activeProfile (has profile?), sitemapUrlsCount, sitemapFetchedAt, sitemapExpiresAt, sitemapSourceUrl, healthStatus, healthCheckedAt, healthReason, brandAssociations, generationCount
2. New server GET endpoint design: /api/onboarding/settings/domain-diagnostics — aggregates across extractor_profiles, sitemap_cache, domain_status, brand_sites, profile_generations
3. Client API function signature: getDomainDiagnostics()
4. UI section design: summary table with per-domain rows, inline expand/collapse for details, action buttons (clear sitemap, clear health, refresh sitemap)
5. Where to place it in OnboardingSettings.tsx (recommend: right after Domain Extractor Profiles, before Generated Profile Governance)

Include an implementation-ready meta-prompt section at the end.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/context-build/integration-plan.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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