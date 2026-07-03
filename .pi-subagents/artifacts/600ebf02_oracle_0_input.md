# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
# Profile Review UX Decision (short)

We redesigned AI-generated CSS selector profile review to live inline inside a domain accordion. The current inline view is too compact — shows selector text comparison and Approve/Reject buttons but NO image thumbnails, no detailed extracted values, no per-field samples.

The operator says: "I can't even see the images that were extracted anymore."

## Existing reusable components
- `ProfileGenerationReview.tsx` — full detail view with validation tables, image previews, field decisions, rollback, feedback forms
- `ProfileFieldValidationTable.tsx` — per-field validation table with sample URLs, extracted values, image previews, warnings

## Four options
A. Modal — "Review Proposal" button opens a modal with full detail
B. Expanded inline — blow up the accordion cell with full detail
C. Hybrid — compact inline summary + slide-out drawer on "View Details"
D. Dedicated Profile Builder page — separate route with URL input, live preview, image gallery

## What I need
Single recommendation for a single-store operator CMS. Prioritize clarity over scalability. Image previews are essential — operator needs to see thumbnails before approving imagesSelector. Keep the existing governance constraints (image approval needs 2+ samples with preview review).

Give me ONE recommendation with rationale.

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