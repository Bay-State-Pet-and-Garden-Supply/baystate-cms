# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
# Profile Proposal Governance Redesign

I need you to analyze the current profile proposal system and recommend how it should work.

## Current State

### What it does
The system can ask an LLM to propose CSS selectors (title, price, description, brand, images) for extracting product data from a domain's product pages. These selectors are domain-scoped — one profile per domain like `mywoof.com`.

### How profiles are generated
1. The "Generate Profile" button on the Domain Configuration UI picks up to 3 cached sitemap URLs for a domain (e.g., `/products/pupsicle`, `/products/treat-tray`, `/products/shaker-bottle`)
2. For each URL, it fetches the HTML, calls the LLM to propose selectors, and inserts a separate `profile_generations` row in the database
3. So 3 sitemap URLs → 3 separate profile proposals for the same domain

### The UX (what the user sees)
- An "Onboarding Settings" page with several sections, ending with a "Generated Profile Governance" panel at the bottom
- That panel shows a table of domains with counts of proposals by status
- Clicking a domain opens its generation list (multiple rows if the generate button was pressed, since each sampled URL creates one)
- Clicking "Review" on a generation opens a review screen showing the proposed selectors, a per-field validation table, and buttons to approve/reject/revise
- The validation ("Re-validate across confirmed samples") fetches HTML from `is_selected = 1` source URLs — these are completely different from the URLs used during generation. The user has no idea where these validation products come from or why they're being used
- The review screen shows revision history, field decisions, and rollback options

### User complaints
1. "Clicking Generate is easy, but the results are confusing"
2. "That component at the bottom of the settings page confuses me"
3. "We have multiple proposals" for the same domain — the user expects ONE profile per domain
4. "None of which when I click on them show me the actual results of running the extraction with those selectors" — the review screen shows proposed selectors and validation against unknown products, but never shows a simple "run these selectors on this specific product and show me what comes out"
5. "When I click a validation run it runs it with other products that I have no idea where they come from, and multiple of them"
6. "I just want to validate a single product at a time" — the user wants to pick a specific product URL, run the proposed selectors against it, and see what gets extracted

### Key architecture facts
- The canonical profile key is `domain` (not brand), per the governance doc
- The extractor profile has 5 fields: titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector
- These live in `extractor_profiles` table (the production table actually used by the page extractor)
- Proposals live in `profile_generations` table (audit-only, never applied without explicit per-field human approval)
- The page extractor already fires proposal creation automatically during extraction via `maybeCreateGeneratedProfileProposal` — this is how proposals get created even without clicking the "Generate" button
- There's a `testExtractorProfile` API that runs selectors against a single URL and returns extracted values — this is used in the Domain Configuration accordion's "Test Selectors" feature
- The governance doc says: "Approval is per selector field, never all-or-nothing", "Image-selector approval requires multi-product validation with image previews", "Text-selector approval with one sample gets a warning"

## What I want you to figure out

Given these complaints and the architecture, recommend:
1. **How should profile proposals be generated?** Should it be one proposal per domain (using the best/most representative page)? Should we generate from one page and then let the user add validation pages one by one?
2. **Where should profile governance live in the UI?** Should it be part of the Domain Configuration accordion (next to "Test Selectors") rather than a separate panel at the bottom?
3. **How should validation work?** Should it be single-product-at-a-time, user-chosen URLs? Should multi-product validation be an optional step you can add URLs to rather than a batch you can't control?
4. **What should the review flow look like?** For a single domain with a single proposal, what does the operator do step by step?
5. **How should the proposal and the active profile relate?** Should the UI clearly show "here's what the active profile extracts" vs "here's what the proposal would extract" side by side?

The user's core need is: I want to pick a product URL, see what my proposed selectors produce when run against it, and decide whether to promote those selectors to the active profile. I don't want automated batch validation with products I didn't choose.

Think about this from first principles. What's the simplest workflow that meets the governance requirements (per-field approval, human in the loop) without overwhelming the operator?

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