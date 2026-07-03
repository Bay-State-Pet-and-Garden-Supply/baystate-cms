# Task for planner

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Create a detailed implementation plan for the following work on the ShopSite CMS project:

## Background
Profile generation for product page image extraction shows duplicate low-res carousel thumbnails in the governance validation previews because `profile-governance-service.ts` uses simplified image collection (only direct `src` attrs, no srcset, no canonicalization/deduping) while `page-extractor.ts` has a mature `cleanAndDeduplicateImages` pipeline that handles this correctly.

## Task
Extract the image URL collection, canonicalization, and deduping logic from `page-extractor.ts` into a shared utility `src/onboarding/image-utils.ts`, then wire both `page-extractor.ts` and `profile-governance-service.ts` to use it. Add unit tests for Shopify URL patterns.

## Key files to read
- src/onboarding/page-extractor.ts (look at `collectImageSourcesCheerio`, `cleanAndDeduplicateImages`, `canonicalizeUrl`, `parseSrcsetCandidates`, `isUsableImageSource`, `addImageSource`)
- src/onboarding/profile-governance-service.ts (look at the image validation block around line 285, the `validateSingleField` function)
- Existing test files under src/tests/

## Oracle's specific guidance
1. Extract shared helpers: `collectImageSourcesFromElement`, `cleanAndDeduplicateImages`, `canonicalizeUrl`, `parseSrcsetCandidates`, `isUsableImageSource` into `src/onboarding/image-utils.ts`
2. Update `page-extractor.ts` to import from the shared utility — behavior must remain unchanged
3. Update `profile-governance-service.ts` image selector validation to:
   - Collect `src`, data attrs, AND `srcset`/`data-srcset` candidates (same as extractor)
   - Run the shared `cleanAndDeduplicateImages` before returning previews
   - Keep the carousel warning but make it after dedup (informational)
4. Add unit tests for Shopify-style patterns: `_80x80`, `_150x150_crop_center`, `_compact`, high-res/unsized duplicate groups
5. Do NOT change selector schema or LLM prompt

Read the relevant source files to understand exactly what needs to move and what stays. Produce a step-by-step plan with file paths and function signatures.

---
**Output:**
Write your findings to exactly this path: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/43010940/plan.md
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