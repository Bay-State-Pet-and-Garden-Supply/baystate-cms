# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/src/onboarding/image-utils.ts, /Users/nickborrello/Desktop/Projects/shopsite-cms/src/tests/unit/.keep]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Write unit tests for the shared image utilities in src/tests/unit/image-utils.test.ts.

Write a comprehensive Vitest test file. Import cheerio using: import * as cheerio from 'cheerio';

Import from: import { parseSrcsetCandidates, isUsableImageSource, collectImageSourcesFromElement, addImageSource, canonicalizeUrl, cleanAndDeduplicateImages } from '../../onboarding/image-utils';

Required test cases:
1. parseSrcsetCandidates — extracts just URLs from mixed descriptors (165w, 2x), handles null/empty
2. isUsableImageSource — rejects data: URIs, .svg files, empty strings; accepts http/https URLs
3. collectImageSourcesFromElement — reads src, data-src, data-lazy-src, data-original, data-image, data-zoom-image, srcset, data-srcset from img/source elements; handles wrapper elements
4. canonicalizeUrl — strips Shopify size suffixes: _80x80, _150x150_crop_center, _compact, _small, _thumb, _medium, _large, _icon, _grande; handles protocol-relative URLs
5. cleanAndDeduplicateImages — dedupes by canonical key; normalizes Shopify CDN URLs to width=1200 preserving v params; filters data URIs
6. When both a _80x80 thumbnail and an unsized original of the same image are present, dedup keeps only one canonical entry
7. Non-Shopify URLs pass through unchanged (no width=1200 injection)

Run `bunx vitest run src/tests/unit/image-utils.test.ts` to verify tests pass.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/43891f60/progress.md

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