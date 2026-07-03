# Task for planner

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/85405bc7/context.md]
[Write to: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/85405bc7/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Create an implementation plan for discovery flow refinements in the ShopSite CMS project. Here's the analysis:

**Problem**: The source discovery system (`src/onboarding/source-discovery.ts`) computes a consolidated product name using an LLM in Pass 2, but only uses it for a second search when brand domains are mapped OR when fewer than 5 UPC results were found. For products without brand domains (the common case), the consolidated name is computed but never used for a search. This means the system never tries to find the official brand/product page — it only surfaces retail/distributor pages found via UPC search.

**Files involved**:
- `src/onboarding/source-discovery.ts` — the `discoverSources` function with two-pass search
- `src/client/components/PipelineBoard.tsx` — the review drawer that shows discovery results
- `src/onboarding/job-queue.ts` — the worker that calls discoverSources and stores consolidatedName
- `src/db/repositories/onboarding-item-repo.ts` — stores expectedName
- `src/shared/schemas/onboarding.ts` — OnboardingSource schema has sourceMethod field

**Required Changes**:

1. **source-discovery.ts**: Always run at least one unrestricted Google search using the consolidated name (e.g., '"Nature\'s Way Squirrel Baffle Dual Mount 16 Inch Plastic"') regardless of whether brand domains exist or how many UPC results were found. This ensures we always attempt to find the official brand/product page. The current code gates this behind `if (candidates.length < 5)` inside Pass 2.

2. **PipelineBoard.tsx**: In the review drawer, group source candidates by their `sourceMethod` field (`serper_upc` vs `serper_name`) with clear section headers so users can see which results came from the UPC search and which came from the consolidated name search. This makes the consolidated name's impact visible.

Please create a step-by-step implementation plan with exact code changes needed.

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