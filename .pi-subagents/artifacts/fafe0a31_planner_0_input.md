# Task for planner

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/fafe0a31/context.md]
[Write to: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/fafe0a31/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Create an implementation plan for changing the discovery auto-selection policy in the ShopSite CMS onboarding worker.

**Current behavior** (in src/onboarding/job-queue.ts, processDiscovery method):
- After discovery, if confidence > 0.6 (essentially always), it auto-selects the top candidate by calling setDiscoverySourceUrl() and marking the source as selected
- This means every product gets a URL auto-selected, even if it's a random retailer page

**Desired behavior**:
- Only auto-select when:
  1. The product has a brand hint (brandHint is non-null)
  2. That brand has a mapped official domain in brand_sites table
  3. The top candidate's domain matches that official domain (exact or suffix, e.g. 'mywoof.com' or 'us.mywoof.com' matching 'mywoof.com')
- When conditions aren't met: insert candidates into the DB but do NOT auto-select — leave sourceUrl null and mark the stage as completed with a 'needs_review' warning
- The operator must then manually review and select from the drawer

**Key files**:
- src/onboarding/job-queue.ts: processDiscovery method (lines ~120-195)
- src/db/repositories/brand-site-repo.ts: findBrandSites function
- src/db/repositories/onboarding-item-repo.ts: setDiscoverySourceUrl function

**Implementation details**:
- Use findBrandSites(item.brandHint) to get mapped domains
- Match the top candidate's domain against those domains using exact/suffix comparison (not broad includes)
- When auto-selecting, keep existing behavior (setDiscoverySourceUrl + mark source as selected)
- When NOT auto-selecting, still insert all sources but don't call setDiscoverySourceUrl — instead call updateItemStageStatus(item.id, 'completed')
- Log clearly whether auto-selection happened or not
- The SSE event should include a flag like 'needsManualReview: true' when no auto-selection occurred

Create a precise, step-by-step plan with exact code changes.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

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