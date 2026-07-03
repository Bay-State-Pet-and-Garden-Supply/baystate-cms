# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
You are serving as a decision oracle for the ShopSite CMS project. The team has identified that profile generation for product page image extraction struggles with duplicate low-res carousel thumbnails. The LLM picks a CSS selector like `.product-gallery img` which matches ALL images in the gallery — both the high-res hero and the 80px thumbnail indicators. The LLM has no dimensional awareness because it works from static HTML (Cheerio), not a live browser DOM.

Four options have been proposed. Analyze the tradeoffs and recommend which to implement:

**Option A: URL-based dimension filtering in validation (low effort, high impact)**
Add a filter to `profile-governance-service.ts` `validateSingleField` that inspects image URLs for thumbnail/size indicators (e.g., `_150x150`, `_80x`, `_thumb`, `_small`, `_icon`, `_compact`) and excludes them. Simple regex, no architectural changes.

**Option B: Enrich candidate generation with URL dimension hints**
In `profile-generator.ts` `buildSelectorCandidates`, parse image `src`/`srcset` attributes and add `thumbnail` to `kindHints` when the URL contains size indicators. Lets the LLM see which candidates are likely thumbnails. More complex, LLM-dependent.

**Option C: Add a dimension-aware post-filter in the page extractor**
In `page-extractor.ts` `extractImagesCheerio` / `collectImageSourcesCheerio`, parse URL dimension suffixes and prefer higher-resolution variants when duplicates are detected. Builds on existing `canonicalizeUrl` logic that already strips some Shopify size suffixes. Touches the production extraction path.

**Option D: Multi-stage selector approach**
Generate both an `imagesSelector` and an `imagesExcludeSelector`. The LLM would output selectors for both the gallery container AND elements to exclude (thumbnails). More complex prompt, changes the selector profile schema, hardest to get consistent LLM results.

Key constraints:
- The system uses a "human-in-the-loop" model — profiles are always reviewed before promotion
- The validation path runs via Cheerio (static HTML), not Playwright (no naturalWidth access)
- Shopify product pages (Woof, Mywoof, Pupsicle) are the primary target
- The existing `canonicalizeUrl` in page-extractor.ts already strips dimension suffixes like `_150x150_crop_center` — this exact pattern could be reused
- There's already a heuristic in `profile-governance-service.ts` line 307 that detects carousel images via repeated base paths and surfaces a warning, but doesn't filter them

Read the relevant source files to understand the constraints deeply, then deliver a verdict with reasoning. Key files:
- src/onboarding/profile-generator.ts
- src/onboarding/profile-governance-service.ts
- src/onboarding/page-extractor.ts

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