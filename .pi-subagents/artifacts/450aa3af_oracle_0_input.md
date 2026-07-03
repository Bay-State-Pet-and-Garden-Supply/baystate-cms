# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Context

The project is ShopSite CMS, a local CMS for ShopSite 15 stores. The onboarding pipeline includes an extraction system that scrapes product data from brand/manufacturer websites using CSS selector profiles.

## Current Architecture

The system uses an LLM to generate CSS selector profiles for extracting product data (title, description, images) from product pages. Here's how it works:

1. **Snapshot**: A page URL is fetched (static HTTP or rendered Playwright)
2. **DOM Minimization**: Non-product noise is stripped (scripts, nav, footer, etc.), leaving a compressed HTML structure
3. **Candidate Extraction**: `buildSelectorCandidates()` extracts ~80 candidate elements with their selectors, stability ratings, and semantic hints
4. **LLM Profile Generation**: The minimized DOM + candidates are sent to an LLM which produces a `GeneratedSelectorProfile` with CSS selectors for title, description, images, plus a Shopify JSON path flag and variant selection strategy
5. **Validation**: Selectors are validated against the source HTML — title is required, empty selectors are rejected, stability flags (`:nth-of-type`) lower confidence
6. **Human Review**: A UI shows proposed selectors vs active selectors, with side-by-side extraction previews. The operator approves/rejects individual fields, or gives structured feedback which triggers an AI revision
7. **Promotion**: Never auto-promotes. Every field requires explicit human approval. Image selectors need 2+ validated samples + attestation.

## The Problem

The AI is generating CSS selectors from a **textual DOM dump** — it never sees the rendered page. It doesn't know which `h1` is the product title vs. a section heading. It guesses based on class names and data attributes, which are often non-semantic or auto-generated. The result is fragile selectors that break across different product pages on the same domain.

## The Question

We're debating three approaches:

**A) AI guesswork (current)**: LLM proposes selectors from minimized DOM text. Low effort, medium reliability, requires technical reviewer to approve/reject CSS strings they may not fully understand.

**B) User pastes selectors/elements**: User inspects the target page via DevTools and pastes CSS selectors or relevant HTML. High reliability, requires CSS expertise. Partially exists as a "manual selector hint" in the `ProfileRevisionFeedbackForm`.

**C) User clicks on elements**: Fire up a Playwright browser, overlay a click-to-select tool on the live page, user clicks on the title/description/images, system generates stable selectors from the click target. Highest reliability, lower skill required, higher implementation cost.

## Key Files Already Reviewed

- `src/onboarding/profile-generator.ts` — LLM profile generation, DOM minimization, candidate building, selector validation
- `src/onboarding/page-extractor.ts` — Playwright/HTTP extraction with layered approach (custom selectors → JSON-LD → meta → microdata → heuristics)
- `src/onboarding/profile-promoter.ts` — Per-field approval, never auto-promote invariant
- `src/onboarding/profile-governance-service.ts` — Business rules: per-field approval, multi-sample validation, revision versioning
- `src/extraction-worker/routes/snapshot.ts` — Snapshot route, static and rendered runtimes
- `src/extraction-worker/routes/extract.ts` — Trusted profile runner, deterministic extraction
- `src/client/components/ProfileBuilderWorkspace.tsx` — Profile builder UI (Overview/Snapshot/Review tabs)
- `src/client/components/ProfileProposalDrawer.tsx` — Slide-out drawer with preview, approve/reject, feedback
- `src/client/components/ProfileGenerationReview.tsx` — State machine review flow
- `src/client/components/ProfileRevisionFeedbackForm.tsx` — Structured feedback form with manual CSS hint input
- `src/extraction-worker/artifacts.ts` — Artifact storage for snapshots
- `src/shared/schemas/onboarding.ts` — Zod schemas for profiles, selectors, revisions

## My Analysis

I see a clear pattern: the system is designed around AI proposals + human approval, but the human is approving CSS selectors they can't visually verify. The extraction preview helps (shows side-by-side results), but when results look wrong, the user's only recourse is to give "structured feedback" (text corrections) or type a manual CSS hint.

The existing infrastructure already supports the click-to-select approach:
- Playwright is already in the extraction worker (`src/extraction-worker/routes/snapshot.ts`) with rendered browser support
- The `rendered` runtime captures screenshots and network data
- The artifact system stores job outputs
- The `ProfileProposalDrawer` already has per-field preview, approve/reject, and feedback
- The `buildSelectorCandidates` function in profile-generator.ts already generates stable selectors from DOM elements

The missing piece is: no flow where the user visually points at elements on a live page.

## Questions for the Oracle

1. Should we move toward a click-to-select visual element picker (approach C), improve the AI approach with better candidate extraction (approach A), or rely on user-pasted selectors (approach B)?
2. What's the right hybrid — AI proposes, user visually corrects?
3. Is there a simpler intermediate step we should take before building a full visual element picker?
4. What invariants from the existing architecture must be preserved?

---
Create and maintain progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/chain-runs/450aa3af/progress.md

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return a concise result and residual risks when applicable

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

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