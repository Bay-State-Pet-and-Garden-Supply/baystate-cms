# Task for planner

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md]

Read these context files and create a detailed implementation plan for the Domain Diagnostics MVP:

=== Parallel Task 1 (context-builder) ===
Output saved to: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/context-build/sitemap-layer.md (20.8 KB, 300 lines). Read this file if needed.

=== Parallel Task 2 (context-builder) ===
Output saved to: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/context-build/domain-status-layer.md (35.5 KB, 599 lines). Read this file if needed.

=== Parallel Task 3 (context-builder) ===
Output saved to: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/context-build/integration-plan.md (38.0 KB, 616 lines). Read this file if needed.

Constraints from oracle:
- Read-only first (no destructive actions by default)
- Do NOT merge generated governance, brand management, or manual profiles into one approval path — link to them
- Evolve Settings in place, no new top-level nav
- getCachedSitemapUrls auto-expires stale entries — need a read-only variant for the display
- Diagnostic extraction should avoid side effects (no profile generation, no status writes)

Produce a plan.md with:
1. Files to change (ordered list)
2. Exact changes per file
3. New types/schemas
4. New repo functions
5. New API routes
6. New client API functions
7. UI changes in OnboardingSettings.tsx
8. Validation contract (typecheck + tests)
9. Implementation-ready meta-prompt for the worker

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/plan.md
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