# Task for planner

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Create a detailed implementation plan for an LLM-assisted CSS selector profile generation system for the ShopSite CMS onboarding pipeline.

## Background

We have a product page extraction pipeline in `src/onboarding/page-extractor.ts` that uses a layered architecture:
1. Custom CSS selectors (from `extractor_profiles` SQLite table)
2. JSON-LD structured data
3. Meta tags
4. Microdata
5. HTML heuristics (hardcoded fallback selectors)
6. Image gallery extraction
7. Shopify productJSON parsing

Extraction failures happen when a new brand domain has no profile, or existing selectors go stale. Currently, the code falls back to heuristics which are fragile.

## What We Want

An LLM-assisted selector profile generation system (NOT fully automatic "self-healing") with these constraints:

### Core Components
1. `src/onboarding/profile-generator.ts` — new file with:
   - `getMinimizedDom(html)`: strip scripts, styles, svg, iframe, nav, footer but preserve scripts containing product JSON
   - `buildSelectorCandidates(html)`: derive compact element candidate list (selector + tag + class/id/data + text snippet + nearby labels) instead of sending raw DOM to the LLM
   - `generateExtractorProfile(url, html, expected)`: send candidates to LLM via existing `src/onboarding/llm-client.ts`, get back JSON with title/price/description/brand/images selectors
   - `validateGeneratedProfile(html, selectors, expected)`: run proposed selectors against live HTML via Cheerio, verify they extract non-empty title

2. Schema: the LLM should return `{ titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector }` — all optional, at least titleSelector required

### Guardrails (Critical)
- Do NOT auto-update `extractor_profiles` during live extraction. Store as pending/proposed, or only auto-promote when confidence is very high and multi-sample validated.
- Only trigger on right failures: missing title, empty custom selectors, missing description/images despite product page existing. Do NOT trigger on Cloudflare blocks, 404s, catalog mismatches, or price-missing (brand sites often omit prices; we have `supplementPrice` for that).
- Fix `upsertProfile` so it doesn't null out unspecified selectors when updating. Either merge-style update or always pass full profile.
- Add a `profile_generation_enabled` feature flag / env toggle.

### Audit Trail
- Store generated output with metadata: source URL, expected product name, extracted title/price, confidence, validation result, generated-by model, timestamp.
- Could extend `extractor_profiles` table or add a new `profile_generations` table.

### Integration
- In `page-extractor.ts`, when custom selectors return empty but page is valid, optionally invoke profile generation (gated by feature flag), re-run extraction once with generated selectors, and record results.
- Validate on 2-3 product URLs from the same domain before trusting a profile, if available.

### Testing
- Unit tests for: HTML minimization, selector candidate building, validator behavior, profile generation with mock LLM responses, database upsert behavior.

## Existing Infrastructure
- LLM client: `src/onboarding/llm-client.ts` (provider-agnostic: DeepSeek, OpenAI, Ollama, with fallback to LCS)
- Profile CRUD: `src/db/repositories/extractor-profile-repo.ts` with `findProfileByDomain`, `upsertProfile`, `listAllProfiles`, `deleteProfile`
- Extractor profiles table: `domain TEXT UNIQUE, title_selector, price_selector, description_selector, brand_selector, images_selector`
- API keys: `src/db/repositories/api-key-repo.ts` (stores provider keys)
- Extraction validator: `src/onboarding/extraction-validator.ts` (validates results, categorizes failures)
- Domain status: `src/db/repositories/domain-status-repo.ts` (tracks domain health)
- Tests exist for `extractor-profiles.test.ts` and `extraction-remedies.test.ts`

## Request
Please produce a plan with concrete implementation phases (1-3), specific file changes, and estimated complexity. Prioritize safety — the system should never silently degrade extraction quality.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/c687aeb3/plans/self-healing-selectors-plan.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

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