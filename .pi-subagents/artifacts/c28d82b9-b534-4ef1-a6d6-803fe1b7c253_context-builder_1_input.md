# Task for context-builder

Map the domain_status repository and OnboardingSettings.tsx structure for a Domain Diagnostics panel.

Read these files completely:
- src/db/repositories/domain-status-repo.ts (getDomainStatus, recordDomainStatus, clearDomainStatus)
- src/client/components/OnboardingSettings.tsx (focus on section structure, state patterns, styles object, how sections are composed)
- src/shared/schemas/onboarding.ts (look at existing types)

Produce a compact spec for:
1. What NEW list-all-domain-statuses repo function is needed (without expiring stale entries — read-only view)
2. What NEW server route(s) are needed
3. What NEW client API function(s) are needed
4. The exact data shape per domain: domain, healthStatus (ok/blocked/offline/mismatch), healthCheckedAt, healthReason
5. How to integrate the new "Domain Diagnostics" section into OnboardingSettings.tsx — where to insert it, what inline style patterns to reuse, how state management should work

Include an implementation-ready meta-prompt section at the end.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/context-build/domain-status-layer.md
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