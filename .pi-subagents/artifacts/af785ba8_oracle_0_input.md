# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
# Profile Building & Refinement UX Decision

## Current State
We just redesigned the profile proposal system so that:
- One proposal per domain (no duplicates)
- Auto-proposals are disabled
- Proposal review lives inline in the Domain Configuration accordion
- There's a side-by-side "Active vs Proposal" text comparison and per-field Approve/Reject buttons

## The Problem
The operator says: "I can't even see the results in detail. I can't even see the images that were extracted anymore."

The current inline panel is too compact. It shows:
- A table of Current Selector vs Proposed Selector with Approve/Reject buttons
- A "Preview Proposal" button next to "Test Selectors"
- Side-by-side text comparison (title, price, description, brand as strings; images as "N image(s)")
- No image thumbnails/previews at all
- No detailed field-by-field inspection

## What the operator needs
- Visual image previews (actual thumbnails of extracted images)
- Detailed per-field inspection of what selectors produce
- Ability to compare active vs proposal results field by field with rich data (images, long descriptions)
- A workflow for refining: test → see results → tweak → retest → approve

## The Architectural Context
- The existing `ProfileGenerationReview.tsx` component has a more detailed review view with validation tables, image previews, feedback forms, and rollback — but it was previously accessed from the now-removed bottom panel
- The existing `ProfileFieldValidationTable.tsx` component renders per-field validation with samples, extracted values, and image previews
- The previous flow was: Generate → bottom panel → click Review → detailed review page
- The new flow is: Generate → inline proposal table → Approve/Reject buttons only

## Key Question
**Should I bring back a modal/drawer for detailed profile review, or should I expand the inline panel?**

Trade-offs to consider:

### Option A: Modal/Drawer
- Opens when clicking a "Review Proposal" button in the inline section
- Shows full `ProfileGenerationReview`-style detail: image thumbnails, extracted values, validation results
- Keeps the domain accordion clean (summary inline, detail in modal)
- Familiar pattern — user knows they're entering a dedicated review workspace
- Risk: modal fatigue, extra click to get to details

### Option B: Expanded inline panel
- Expand the current inline section to show full detail: image thumbnails, per-field samples
- Everything visible without leaving the domain accordion
- Risk: the accordion becomes very tall, hard to navigate
- Risk: inline editing conflicts with the domain accordion's existing selector fields

### Option C: Hybrid — inline summary + slide-out drawer
- Keep a compact summary inline (proposed selectors, test URL, preview button)
- "View Details" opens a slide-out drawer or expands the accordion cell further
- Best of both: summary at a glance, detail on demand

### Option D: Dedicated "Profile Builder" page
- A separate route/tab for building and testing profiles
- Full-screen workspace with URL input, selector editor, live preview, image gallery
- Most powerful but most work

## What I need from you
1. Recommend the right UX pattern
2. Consider what the existing `ProfileGenerationReview` and `ProfileFieldValidationTable` components already provide — should we reuse them?
3. Define the minimal flow: what does the operator do step by step from "I generated a proposal" to "I'm confident enough to approve fields"?
4. Think about image approval: the governance rules require 2+ same-domain samples with image preview review. How does this fit into the chosen UX?

The project is a CRM/onboarding tool for a single store operator (not a multi-tenant SaaS). Simplicity and clarity are more important than scalability.

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