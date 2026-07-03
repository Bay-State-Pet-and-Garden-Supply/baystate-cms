# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/85405bc7/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/85405bc7/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement the frontend changes from the plan. Edit ONLY src/client/components/PipelineBoard.tsx.

Key requirement: Group source candidates in the review drawer by their `sourceMethod` field ('serper_upc' vs 'serper_name') with clear section headers.

Important context:
- The drawer is in the `PipelineBoard` component
- Source candidates come from `reviewSources` state (type OnboardingSource[])
- Each source has a `sourceMethod` field (string, e.g. 'serper_upc' or 'serper_name')
- Sources are already sorted by confidence descending
- The drawer currently renders all sources in a flat list with no grouping
- The consolidated name is displayed via `reviewItem.expectedName` in a banner
- We should group sources by sourceMethod, showing "UPC Search Results" and "Name Search Results" headers
- The sourceMethod field should be clearly visible on each source card
- Keep the existing "🔍 Searching for:" banner that shows the consolidated name
- Do NOT modify the overall drawer structure, just the source list rendering

Only edit PipelineBoard.tsx. Do NOT modify any other files.

---
Previous step output:
No files are staged. The implementation is complete.

## Summary

Implemented the backend refinements to `src/onboarding/source-discovery.ts` only, as scoped.

### Changes made

1. **Task 2 — Mandatory consolidated-name search in Pass 2**:
   - Replaced `const secondPassQueries: string[] = [];` with a `Pass2Query[]` array carrying an optional `mandatory` flag.
   - Added an `addSecondPassQuery(query, mandatory = false)` helper that deduplicates normalized queries.
   - Always enqueues one mandatory unrestricted query `${cleanSearchName} product page` (marked `mandatory: true`).
   - Mapped brand-domain queries (`${cleanSearchName} site:${domain}` + original-name fallback) and the low-candidate `${name} product page` fallback are kept but no longer gate the consolidated-name search.
   - The execution loop respects `if (!q.mandatory && candidates.length >= 15) break;` so mandatory queries are not skipped by the cap.
   - Added a per-query log `[SourceDiscovery] Pass 2 search for UPC ${upc}: "${q.query}"` for audit visibility.
   - Cleaned the search name with `cleanSearchName = searchName.replace(/"/g, '').trim()` so any stray quotes from the LLM don't break the query.
   - Updated the file/function-level comments to describe the actual two-pass strategy.

2. **Task 3 — Guarantee Pass 2 candidates survive the cap**:
   - Added a `selectTopCandidates<T>(candidates, limit)` helper that takes the top N by confidence but, when no `serper_name` candidate is in the slice and at least one exists unselected, swaps the lowest-confidence selected non-name candidate for the highest-confidence unselected `serper_name` candidate, then re-sorts by confidence.
   - Replaced `candidates.slice(0, 10)` with `selectTopCandidates(candidates, 10)`.
   - The clamping `Math.max(0, Math.min(1, c.confidence))` is still applied after selection.

### Validation
- `bun run typecheck` — clean (no output).
- `bun run test` — 200/200 tests pass, 0 fail.
- `bun run lint src/onboarding/source-discovery.ts` — no errors in the edited file.
- `git status` confirms only `src/onboarding/source-discovery.ts` is modified; nothing staged.

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