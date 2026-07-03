# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
The user is considering enforcing a rule where discovery (source-discovery.ts) won't run for a product unless:
1. The product has a brand assigned (brandHint is non-null)
2. That brand has an official domain mapped in brand_sites

Current state:
- Discovery runs for all products regardless of brand/domain state
- Brand domains are optional — they're used for scoped searches when present, boosting confidence
- We just implemented a mandatory consolidated-name unrestricted Google search, so even without brand domains we try to find official pages
- Without brand domains, discovery relies entirely on open web search results, which often surface retailer pages rather than official brand pages
- The user was unhappy with discovery results surfacing random retailer URLs instead of official product pages

The user wants your second opinion on whether to enforce this gating rule. Consider:

1. Does this create too much friction? The operator must map every brand before discovery can start.
2. What about brands without a known official domain? Some products come from small brands, distributors, or discontinued lines.
3. The consolidated-name unrestricted search already tries to find official pages — is that sufficient without brand domains?
4. Should there be a bypass mechanism (e.g., a "run anyway" flag or a "no official domain" marking)?
5. What UX flow makes sense — should the Pipeline Board show items as "blocked — needs brand domain" rather than silently skipping them?
6. How does this interact with the batch onboarding flow? Users upload spreadsheets with potentially hundreds of products, many without brand hints.

Please provide a reasoned recommendation: enforce the gating, don't enforce it, or a middle-ground approach. Be specific about implementation implications.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return a concise result and residual risks when applicable

Required evidence: manual-notes, residual-risks

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