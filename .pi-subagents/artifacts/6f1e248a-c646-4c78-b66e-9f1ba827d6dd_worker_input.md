# Task for worker

## Task 8: Populate enhanced `variantResult` in worker `validate.ts`

Read these files:
- `src/extraction-worker/routes/validate.ts` — the multi-sample validation route (especially the variant block around line 397-403 and the SampleValidationInput type around line 253)
- `src/shared/schemas/extraction-worker.ts` — the `VariantSelectionStrategy` schema and enhanced `ValidationSampleResultSchema.variantResult`

## What to change

### 1. Update imports in validate.ts

Add import:
```typescript
import type { VariantSelectionStrategy } from '../../shared/schemas/extraction-worker';
```

Update the `SampleValidationInput` interface (or wherever `variantSelectionStrategy` is typed) to use `VariantSelectionStrategy | null` instead of `Record<string, unknown> | null`.

### 2. Replace the stub variant result with real corroboration

Find the variant result block (search for 'not yet implemented' or the variantResult assignment around line 397-403). Currently it looks like:
```typescript
variantResult = { selected: true, variantTitle: 'not yet implemented', error: null };
```

Replace with:
```typescript
if (!strategy || !strategy.containerSelector) {
  variantResult = null;
} else {
  const containerEl = extractTextBySelector(html, strategy.containerSelector);
  const containerFound = containerEl !== null && containerEl !== '';
  const hasOptions = strategy.detectedOptions.length > 0;
  const strategyValid = containerFound && hasOptions;

  variantResult = {
    selected: strategyValid,
    variantTitle: null,
    error: strategyValid ? null : containerFound ? 'Strategy has no detected options' : 'containerSelector did not resolve on sample page',
    containerSelector: strategy.containerSelector,
    optionType: strategy.optionType ?? 'unknown',
    detectedOptions: strategy.detectedOptions ?? [],
    optionFields: strategy.optionFields ?? [],
    strategyValid,
  };
}
```

Make sure the `variantResult` variable is typed to allow the new fields. If there's a type annotation, update it.

### 3. Keep the summary's `variantSamplesPassing` logic working

A sample with `variantResult.strategyValid === true` should count as passing.
A sample with `variantResult === null` (no strategy) should still count as trivially passing (unchanged behavior).

Find the variantSamplesPassing counter and make sure it uses `variantResult?.strategyValid !== false` or similar logic.

## Constraints
- The route imports `cheerio` — prefer using it for containerSelector validation if available
- For now, use the existing `extractTextBySelector` regex-based approach for consistency (it handles `.class`, `#id`, simple `[attr]`, tag selectors)
- `bun run typecheck` must pass

## Validation
- `bun run typecheck` passes with zero errors

## Handoff
Report all changes, line numbers, typecheck result.

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