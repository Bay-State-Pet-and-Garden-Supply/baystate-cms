# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Update `AGENTS.md` to reflect the current architecture.

File: `AGENTS.md`

The scout found these issues:
1. Line 52 references `src/onboarding/product-curator.ts` as the "Curator Orchestrator" — this is the old monolithic architecture. The classification system ADRs plan to replace it with modular stages. Update to note this is transitional.
2. Lines 44-57 describe the onboarding pipeline in simplified terms that don't reflect the domain model in CONTEXT.md or the classification ADRs.

Changes to make:
1. Update the "Curator Orchestrator" reference to note that product-curator.ts is the current implementation but modular classification stages (per ADRs 0004) are being phased in. Add a reference to CONTEXT.md for the authoritative domain model.
2. Update the Onboarding Pipeline section to reference CONTEXT.md for the detailed domain model.
3. Add a note about the new profile builder (visual selection) as the primary method for building extractor profiles.

Read the file first, then make targeted edits. Preserve the Security Mandates and Architectural Guidelines sections as-is.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/47fc311f/progress.md

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