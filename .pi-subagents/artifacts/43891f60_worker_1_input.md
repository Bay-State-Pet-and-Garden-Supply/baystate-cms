# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/src/onboarding/image-utils.ts, /Users/nickborrello/Desktop/Projects/shopsite-cms/src/onboarding/profile-governance-service.ts]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Update src/onboarding/profile-governance-service.ts to use the shared image utilities for image selector validation.

The file src/onboarding/image-utils.ts has already been created with:
- collectImageSourcesFromElement
- addImageSource
- cleanAndDeduplicateImages

Your job: Replace the simplified image extraction in the validateSingleField function (around the `if (field === 'imagesSelector')` block).

CURRENT CODE collects images with just direct src attrs:
```ts
if (field === 'imagesSelector') {
    const images: string[] = [];
    const seen = new Set<string>();
    $(selector).each((_, el) => {
      const $img = $(el);
      const src =
        $img.attr('src') ??
        $img.attr('data-src') ??
        $img.attr('data-lazy-src') ??
        $img.attr('data-original') ??
        $img.attr('data-image') ??
        '';
      if (src && !seen.has(src)) {
        seen.add(src);
        images.push(src);
      }
    });
    // Heuristic: if all images share a base path...
    ...
```

REPLACE with:
```ts
if (field === 'imagesSelector') {
    // Collect raw candidate URLs using the shared extractor logic
    // (includes srcset/data-srcset, not just direct src attrs).
    const rawImages: string[] = [];
    const seenRaw = new Set<string>();
    $(selector).each((_, el) => {
      for (const src of collectImageSourcesFromElement($, el)) {
        addImageSource(src, seenRaw, rawImages);
      }
    });

    // Deduplicate and normalize the same way the production
    // extractor does, so governance previews match reality.
    const images = cleanAndDeduplicateImages(rawImages, sampleUrl);

    // Warn when raw candidates exceed deduped (carousel/thumbnail dupes).
    if (rawImages.length > images.length) {
      warnings.push(
        `Image selector returned ${rawImages.length} raw candidates; deduped to ${images.length}. May include duplicate or low-res carousel images.`,
      );
    }

    return {
      field,
      sampleUrl,
      itemId,
      expectedName,
      brandHint,
      extractedText: null,
      extractedImages: images,
      warnings,
      status: images.length > 0 ? 'pass' : 'fail',
    };
  }
```

Add this import at the top:
```ts
import {
  addImageSource,
  cleanAndDeduplicateImages,
  collectImageSourcesFromElement,
} from './image-utils';
```

IMPORTANT:
- Keep the existing zero-selector check BEFORE the new image block
- Keep the existing non-image field handling UNCHANGED
- The `images` variable is the deduped result — use it for status and extractedImages

After editing, run `bun run typecheck` to verify.

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