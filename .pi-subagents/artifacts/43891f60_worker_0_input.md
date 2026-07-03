# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/src/onboarding/image-utils.ts, /Users/nickborrello/Desktop/Projects/shopsite-cms/src/onboarding/page-extractor.ts]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Refactor src/onboarding/page-extractor.ts to import and use the shared helpers from src/onboarding/image-utils.ts instead of the local definitions.

The file src/onboarding/image-utils.ts has already been created with these exported functions:
- parseSrcsetCandidates
- isUsableImageSource
- collectImageSourcesFromElement  (was: collectImageSourcesCheerio)
- addImageSource
- canonicalizeUrl
- cleanAndDeduplicateImages

Your job:
1. Add this import near the top of page-extractor.ts (next to existing onboarding-local imports like findProfileByDomain):

```ts
import {
  addImageSource,
  canonicalizeUrl,
  cleanAndDeduplicateImages,
  collectImageSourcesFromElement,
} from './image-utils';
```

2. REMOVE the local definitions of these 6 functions:
   - parseSrcsetCandidates (line ~597)
   - isUsableImageSource (line ~605)
   - collectImageSourcesCheerio (line ~615)
   - addImageSource (line ~636)
   - canonicalizeUrl (line ~1193)
   - cleanAndDeduplicateImages (line ~1209)

3. UPDATE call sites:
   - In extractCustomSelectorsCheerio: replace `collectImageSourcesCheerio($, el)` with `collectImageSourcesFromElement($, el)`
   - In extractImagesCheerio: replace `collectImageSourcesCheerio($, el)` with `collectImageSourcesFromElement($, el)`
   - All other call sites (addImageSource, canonicalizeUrl, cleanAndDeduplicateImages) work unchanged with the import

IMPORTANT: Do NOT modify the browser-side page.evaluate() helpers in extractImages/extractCustomSelectors — those are browser-context code and cannot import Node modules.

After editing, run `bun run typecheck` to verify.

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