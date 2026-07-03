# Task for worker

## Task A0: Extract Shopify productJSON parsing into shared pure module

Read these files first:
- `src/onboarding/page-extractor.ts` — lines 9, 1015-1165 contain the code to extract
- `src/onboarding/profile-generator.ts` — will import from the new module

### What to do

Create `src/onboarding/shopify-json.ts` — a pure module (no bun:sqlite, no DB dependencies) that exports Shopify productJSON extraction.

**Copy these functions verbatim** from `src/onboarding/page-extractor.ts` (lines 1015-1165):

1. `PRODUCT_JSON_ASSIGNMENT_PATTERNS` constant
2. `findObjectEnd(html, startIdx, maxChars?)` function
3. `ProductJsonCandidate` interface  
4. `collectProductJsonCandidates(html)` function
5. `extractProductJsonFromHtml(html)` function

The `extractProductJsonFromHtml` function in page-extractor.ts is NOT exported (no `export` keyword at line 1147). In the new module, **export all functions and interfaces**.

The module imports `* as vm from 'node:vm'` — this is pure Node and available in both Bun and vitest.

```typescript
import * as vm from 'node:vm';
```

**Then update `src/onboarding/page-extractor.ts`:**
- Remove lines 1015-1165 (the functions being moved)
- Add `import { extractProductJsonFromHtml } from './shopify-json';` at the top
- The call site at line 127 (`const productJSON = extractProductJsonFromHtml(html)`) stays exactly the same

### Constraints
- The new module must NOT import anything from the rest of the project (no `../shared/`, no `../db/`, no `./image-utils`)
- Only depend on `node:vm` and TypeScript types
- Export everything needed

### Validation
- `bun run typecheck` passes with zero errors
- The moved functions produce identical output for the same input

### Handoff
Report file created, file modified, typecheck result.

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