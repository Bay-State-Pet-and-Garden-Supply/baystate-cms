# Task for worker

## Task A5: Extend the /extractor-profiles/test route for preview support

Read these files:
- `src/server/routes/onboarding-routes.ts` — the `/extractor-profiles/test` route (~line 1395-1475)
- `src/client/onboarding-api.ts` — the `testExtractorProfile` client function
- `src/shared/schemas/onboarding.ts` — ExtractorProfileSchema (for shopifyJSONPath)

### What to change

**1. `src/server/routes/onboarding-routes.ts` — Extend the test route**

Find the `POST /onboarding/extractor-profiles/test` handler. Currently it destructures the 5 CSS selectors + URL from the request body. Add:

```typescript
const { url, titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector, shopifyJSONPath, variantSelectionStrategy } = await c.req.json();
```

In the `page.evaluate` block, when `shopifyJSONPath` is true, also extract `window.productJSON` and use it as the preferred source. Add AFTER the existing selector extraction and BEFORE building the result:

```typescript
// Shopify productJSON extraction (when flagged)
let shopifyImages: string[] = [];
let shopifyVariantOptions: string[] = [];
if (shopifyJSONPath) {
  try {
    const pj = await page.evaluate(() => {
      const w = window as any;
      const data = w.productJSON || w.ShopifyAnalytics?.product || null;
      if (!data) return null;
      return {
        title: data.title || null,
        images: Array.isArray(data.images) ? data.images.map((i: any) => i.src || i.url || '').filter(Boolean) : [],
        options: Array.isArray(data.options) ? data.options.flatMap((o: any) => Array.isArray(o.values) ? o.values : []) : [],
      };
    });
    if (pj) {
      if (pj.title && !extracted.title) extracted.title = pj.title;
      if (pj.images.length > 0) shopifyImages = pj.images;
      shopifyVariantOptions = pj.options;
    }
  } catch { /* fallback to CSS selectors */ }
}
```

Change the return shape to pass through `variantOptions` and `shopifyImages`:

```typescript
return c.json({ success: true, extracted: { ...extracted, variantOptions: shopifyVariantOptions } });
```

**2. `src/client/onboarding-api.ts` — Update the client function**

Find `testExtractorProfile` — update its input type to accept `shopifyJSONPath?: boolean` and `variantSelectionStrategy?`, and update its return type.

```typescript
export async function testExtractorProfile(data: {
  url: string;
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  shopifyJSONPath?: boolean;
}): Promise<{ success: boolean; extracted: Record<string, any> }> {
  return request('/extractor-profiles/test', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
```

## Validation
- `bun run typecheck` passes with zero errors
- Existing test route caller still works

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