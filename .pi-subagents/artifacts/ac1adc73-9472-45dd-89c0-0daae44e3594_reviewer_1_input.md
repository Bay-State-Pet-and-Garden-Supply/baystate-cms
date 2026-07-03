# Task for reviewer

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/progress.md]

Review the Domain Diagnostics MVP for code quality and UI integration.

New/changed files to inspect:
- src/client/components/OnboardingSettings.tsx (focus on new Domain Diagnostics section)
- src/onboarding/domain-diagnostics-service.ts
- src/tests/unit/domain-diagnostics-service.test.ts

Verify these quality criteria:
1. Diagnostics section uses existing inline style patterns (styles.section, styles.table, etc.)
2. The section has stable id anchors for linking
3. Links from diagnostics rows to Brand Sites / Domain Extractor Profiles / Generated Profile Governance sections work
4. The Read-only Refresh button only re-fetches diagnostics, no side effects
5. Empty state message is clear
6. Health badge colors match the plan spec (ok=green, blocked=red, offline=gray, mismatch=amber, unknown=outline)
7. No destructive action buttons (no clear, delete, refresh-sitemap, generate-profile)
8. Helper functions (domainHealthBadgeStyle, formatOptionalIsoDate, truncateText) are clean
9. State management follows existing patterns (useState + fetchData integration)
10. The new section fits naturally between Domain Extractor Profiles and Generated Profile Governance
11. Tests cover: empty DB, single-source domains, full populate, stale rows NOT deleted

Report file:line references for any issues. Do not modify files.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/ac1adc73-9472-45dd-89c0-0daae44e3594/validation-diag-quality.md
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