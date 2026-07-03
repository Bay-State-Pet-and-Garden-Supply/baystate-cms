# Task for worker

## Tasks 1, 2, and 7 — Foundational changes for variant discovery and image expansion

Read these files first:
- `src/onboarding/profile-generator.ts` — the proposal generator
- `src/shared/schemas/extraction-worker.ts` — Zod schemas
- `src/extraction-worker/routes/validate.ts` — the validate route (for Task 7 reference)
- `docs/plans/variant-discovery-plan.md` — the full plan (if exists)

### Task 1: Add `variantSelectionStrategy` to `GeneratedSelectorProfile` interface

In `src/onboarding/profile-generator.ts`, find the `GeneratedSelectorProfile` interface (around line 42). Add after `imagesSelector`:

```typescript
/** Proposed variant/option selection strategy. The LLM suggests how to
 *  select the correct source-page variant for the product SKU. */
variantSelectionStrategy?: {
  containerSelector: string | null;
  optionType: 'dropdown' | 'button_group' | 'radio' | 'unknown';
  detectedOptions: string[];
  optionFields: string[];
} | null;
```

Also add `variantSelectionStrategy` to the `SELECTOR_PROFILE_KEYS` array (line 580). Wait — no, that array controls the LLM field loop. Actually looking at the code, `SELECTOR_PROFILE_KEYS` is used by `shapeFromParsed` to iterate over the expected JSON keys from the LLM. We should add `variantSelectionStrategy` to it so the field passes through. Let me check...

Actually, looking at the plan more carefully: Task 5 handles `shapeFromParsed` parsing of `variantSelectionStrategy` separately. For now, the field should be on the interface but NOT added to `SELECTOR_PROFILE_KEYS` because that array is used by the LLM field loop and `variantSelectionStrategy` is a nested object, not a string selector. Task 5 will handle it.

So: just add the optional field to the interface. That's it for Task 1.

### Task 2: Expand image candidate discovery in `buildSelectorCandidates`

In `src/onboarding/profile-generator.ts`, find the image candidate section (around line 570-575). It currently looks like:

```typescript
$('img[itemprop="image"], [class*="product-image" i] img, [class*="gallery" i] img').each(
  (_, el) => addCandidate(el, ['image']),
);
```

**Add these additional patterns AFTER the existing one:**

```typescript
$('img[data-media-gallery], [data-product-media], [data-gallery-role]').each(
  (_, el) => addCandidate(el, ['image']),
);
$('[class*="product__media"] img, [class*="pdp-gallery"] img, [class*="swiper-wrapper"] img').each(
  (_, el) => addCandidate(el, ['image']),
);
$('img[data-zoom], img[data-zoom-image], [data-gallery-wrapper] img').each(
  (_, el) => addCandidate(el, ['image']),
);
$('[class*="pdp-carousel"] img, [class*="product-carousel"] img, [class*="media-gallery"] img').each(
  (_, el) => addCandidate(el, ['image']),
);
$('[data-slider] img, [role="tabpanel"] img').each(
  (_, el) => addCandidate(el, ['image']),
);
```

**Add the `baseUrl` parameter:**
Change `buildSelectorCandidates` signature from:
```typescript
export function buildSelectorCandidates(html: string): SelectorCandidate[] {
```
to:
```typescript
export function buildSelectorCandidates(html: string, baseUrl?: string): SelectorCandidate[] {
```

**In `generateExtractorProfile` (~line 737):**
Change `buildSelectorCandidates(minimized)` to `buildSelectorCandidates(minimized, _url)`.

### Task 7: Schema changes for variant strategy

In `src/shared/schemas/extraction-worker.ts`:

**a) Add `VariantSelectionStrategySchema`** after the existing schemas (find a good spot, maybe after `SpreadsheetHintSchema`):

```typescript
export const VariantSelectionStrategySchema = z.object({
  containerSelector: z.string().nullable().default(null),
  optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).default('unknown'),
  detectedOptions: z.array(z.string()).default(() => []),
  optionFields: z.array(z.string()).default(() => []),
});
export type VariantSelectionStrategy = z.infer<typeof VariantSelectionStrategySchema>;
```

**b) Update `ProfileProposalDraftSchema.variantSelectionStrategy`:**
Find the field (around line 90) that is currently `z.record(z.string(), z.unknown()).nullable().default(null)`. Change it to `VariantSelectionStrategySchema.nullable().default(null)`.

**c) Update `ExtractRequestSchema.profile.variantSelectionStrategy`:**
Find the field (around line 174) that is currently `z.record(z.string(), z.unknown()).nullable().default(null)`. Change it to `VariantSelectionStrategySchema.nullable().default(null)`.

**d) Enhance `ValidationSampleResultSchema.variantResult`:**
Find the `variantResult` field (around line 129). It currently looks like:
```typescript
variantResult: z.object({
  selected: z.boolean(),
  variantTitle: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
}).nullable().default(null),
```

Change it to:
```typescript
variantResult: z.object({
  selected: z.boolean(),
  variantTitle: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  containerSelector: z.string().nullable().default(null),
  optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).nullable().default(null),
  detectedOptions: z.array(z.string()).default(() => []),
  optionFields: z.array(z.string()).default(() => []),
  strategyValid: z.boolean().default(false),
}).nullable().default(null),
```

## Validation
- `bun run typecheck` passes with zero errors
- Only modify the specified files/lines
- Report all changes made

## Handoff
Report each file changed, what was added, and the typecheck result.

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