# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Evaluate whether building a unified "Domain Manager" for ShopSite CMS is worth doing now vs deferring. This would consolidate all per-domain data and management into one cohesive panel.

## Current State

The system already has 4 domain-level data tables, each managed in a different place (or nowhere):

| Table | What it stores | Current UI surface |
|---|---|---|
| `extractor_profiles` | CSS selectors for extraction (Layer 0) | Settings → "Domain Extractor Profiles" (just refactored — now has create/edit/delete) |
| `sitemap_cache` | Cached sitemap URLs (24h TTL, written by sitemap-fetcher, read by source-discovery) | **None** — completely invisible to operator. Only way to clear is `clearSitemapCache()` in code. |
| `domain_status` | Health per domain (ok/blocked/offline/mismatch, 7-day expiry, written by page-extractor + sitemap-fetcher, read by source-discovery for Serper ranking) | **None** — completely invisible. |
| `brand_sites` | Brand → domain mapping | Settings → "Cached Brand Sites" (view/delete only) |
| `profile_generations` + `profile_generation_field_decisions` | AI-generated selector proposals + per-field approval audit | Settings → "Generated Profile Governance" (full review/approve/rollback UI) |

### How sitemap caching works:
- Source discovery checks `getCachedSitemapUrls(domain)` first
- On cache miss, `fetchAndParseSitemap` discovers + parses the sitemap, then `insertSitemapCache` persists it
- `sitemapProductUrlPattern` (from extractor profile) filters which sitemap URLs are product pages
- Cache has 24h TTL, auto-expired on read

### How domain health works:
- Page extractor calls `recordDomainStatus(domain, 'ok'/'offline'/validation.status)` during extraction
- Sitemap fetcher records 'ok' when sitemaps are reachable
- Source discovery reads `getDomainStatus(domain)` to influence Serper result ranking
- Status expires after 7 days

## The Proposed Unified Domain Manager

A new top-level section (or Settings sub-page) that, for each known domain, shows a summary card with all domain-level data in one place:
- Extractor profile (edit inline, already built)
- Sitemap cache status (when last fetched, URL count, "Clear Cache" / "Refresh" buttons)
- Domain health status (ok/blocked/offline/mismatch badge, last checked)
- "Test Extraction" — run a sample URL through the extractor and show results
- AI-generated proposals count (link to existing governance panel)
- Brand association

## Questions for You

1. **Is this worth the engineering effort right now, or should it be deferred?** What's the highest-value part?

2. **What's the right architectural approach?** 
   - A) New "Domain Manager" page (top-level nav item)
   - B) Evolve the existing Settings section by grouping domain data under a "Domain Manager" sub-section
   - C) Start with just surfacing sitemap cache + domain health in the existing Settings sections first, then unify later

3. **What's the highest-impact piece to add first?** (Sitemap cache visibility? Domain health visibility? Extraction testing?)

4. **Any risks or anti-patterns** in consolidating domain-level data into a single management surface?

Challenge assumptions freely — this is advisory only, no implementation.

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