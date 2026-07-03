# Task for worker

## Task A3: Generate and persist a seedPreview at proposal time

Read these files:
- `src/onboarding/profile-generator.ts` — add buildSeedPreview function
- `src/onboarding/shopify-json.ts` — import extractProductJsonFromHtml
- `src/server/routes/onboarding-routes.ts` — /generate-profile route
- `src/onboarding/image-utils.ts` — image utility functions

### 1. Add `SeedPreview` interface and `buildSeedPreview` function to `src/onboarding/profile-generator.ts`

Add after the `GeneratedSelectorProfile` interface:

```typescript
export interface SeedPreview {
  title: string | null;
  description: string | null;
  images: string[];
  variantOptions: string[];
  strategy: 'shopify-json' | 'css';
  variantSelectionStrategy: GeneratedSelectorProfile['variantSelectionStrategy'];
}
```

Add the function after `shapeFromParsed` and before `generateExtractorProfile`:

```typescript
import { extractProductJsonFromHtml } from './shopify-json';
import { collectImageSourcesFromElement, cleanAndDeduplicateImages, addImageSource } from './image-utils';
```

```typescript
export function buildSeedPreview(
  html: string,
  profile: GeneratedSelectorProfile,
  sourceUrl: string,
): SeedPreview {
  // Try Shopify JSON first if the profile indicated it has one
  if (profile.shopifyJSONPath) {
    const productJSON = extractProductJsonFromHtml(html);
    if (productJSON) {
      const title = productJSON.title ?? null;
      const description = productJSON.body_html
        ? productJSON.body_html.replace(/<[^>]*>/g, '').trim()
        : (productJSON.description ?? null);
      const images: string[] = [];
      if (Array.isArray(productJSON.images)) {
        for (const img of productJSON.images) {
          const src = img.src ?? img.url ?? img;
          if (typeof src === 'string') {
            try {
              images.push(new URL(src, sourceUrl).href);
            } catch { images.push(src); }
          }
        }
      }
      const variantOptions: string[] = [];
      if (Array.isArray(productJSON.options)) {
        for (const opt of productJSON.options) {
          if (Array.isArray(opt.values)) {
            for (const v of opt.values) {
              if (typeof v === 'string' && !variantOptions.includes(v)) variantOptions.push(v);
            }
          }
        }
      }
      return {
        title,
        description: description?.slice(0, 500) ?? null,
        images,
        variantOptions,
        strategy: 'shopify-json',
        variantSelectionStrategy: profile.variantSelectionStrategy ?? null,
      };
    }
  }

  // Fall back to CSS selectors
  try {
    const $ = cheerio.load(html);
    const title = profile.titleSelector ? $(profile.titleSelector).first().text().trim() || null : null;
    const description = profile.descriptionSelector ? $(profile.descriptionSelector).first().text().trim().slice(0, 500) || null : null;
    let images: string[] = [];
    if (profile.imagesSelector) {
      const seen = new Set<string>();
      $(profile.imagesSelector).each((_, el) => {
        for (const src of collectImageSourcesFromElement($, el)) {
          addImageSource(src, seen, images);
        }
      });
      images = cleanAndDeduplicateImages(images, sourceUrl);
    }
    const variantOptions = profile.variantSelectionStrategy?.detectedOptions ?? [];
    return {
      title,
      description,
      images: images.slice(0, 10),
      variantOptions,
      strategy: 'css',
      variantSelectionStrategy: profile.variantSelectionStrategy ?? null,
    };
  } catch {
    return {
      title: null,
      description: null,
      images: [],
      variantOptions: [],
      strategy: 'css',
      variantSelectionStrategy: null,
    };
  }
}
```

### 2. Store seedPreview in the /generate-profile route

In `src/server/routes/onboarding-routes.ts`, find the `/generate-profile` handler (around line 1340). After the line that calls `validateGeneratedProfile(html, generated, ...)` and before `insertProfileGeneration`, add:

```typescript
import { buildSeedPreview } from '../../onboarding/profile-generator';

// ... in the handler, after validateGeneratedProfile:
const seedPreview = buildSeedPreview(html, generated, resolvedUrl);
```

Then in the `insertProfileGeneration` call, merge `seedPreview` into `fieldSamples`:

```typescript
fieldSamples: {
  ...validation.fieldSamples,
  seedPreview,
} as unknown as Record<string, unknown>,
```

Import `buildSeedPreview` at the top of the file if not already imported.

## Validation
- `bun run typecheck` passes with zero errors
- The function is pure (no DB imports)

## Handoff
Report all changes and typecheck result.

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: required by reviewer.

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