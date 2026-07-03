# Task for context-builder

Map the sitemap_cache repository and build context for a Domain Diagnostics panel.

Read these files completely:
- src/db/repositories/sitemap-cache-repo.ts (getCachedSitemapUrls, insertSitemapCache, clearSitemapCache)
- src/server/routes/onboarding-routes.ts (look for existing /onboarding/settings/ routes pattern)
- src/client/onboarding-api.ts (look at existing API function patterns)

Produce a compact spec for:
1. What NEW read-only repo function is needed (list all sitemap caches without expiring them)
2. What NEW clear-by-domain repo function is needed
3. What NEW server route(s) are needed (GET /onboarding/settings/domain-diagnostics, POST clear-sitemap-cache)
4. What NEW client API function(s) are needed
5. The exact data shape to return per domain: domain, sitemapUrlsCount, sitemapFetchedAt, sitemapExpiresAt, sitemapSourceUrl

Include an implementation-ready meta-prompt section at the end.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/context-build/sitemap-layer.md
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