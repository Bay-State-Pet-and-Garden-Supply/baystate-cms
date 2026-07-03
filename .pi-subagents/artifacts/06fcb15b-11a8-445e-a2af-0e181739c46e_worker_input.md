# Task for worker

## Task 9: Frontend — pass variantSelectionStrategy into validate request

Read `src/client/components/ProfileBuilderWorkspace.tsx`. Find where the validate request is built — specifically where `variantSelectionStrategy: null` is hardcoded (around line 488 in the original, may have shifted).

## What to change

Replace the hardcoded `null` with the proposed strategy read from the stored generation. 

Find the validate request construction block. It likely looks something like:

```typescript
const validateReq = {
  profileDraft: {
    ...latestSelectors,
    variantSelectionStrategy: null,  // ← THIS LINE
  },
  samples: [...]
};
```

Change to:

```typescript
  variantSelectionStrategy:
    (latestGeneration?.selectors as any)?.variantSelectionStrategy ?? null,
```

You may also need to look at how `latestSelectors` is built (around line 377-378). The selectors are cast as `Record<string, string | null>` which would strip nested objects. Make sure the `variantSelectionStrategy` is read directly from `latestGeneration.selectors` rather than from the flattened `latestSelectors` object.

## Constraints
- Only change this one line (and supporting type handling if needed)
- `bun run typecheck` must pass
- Do NOT modify any other files

## Validation
- `bun run typecheck` passes with zero errors

## Handoff
Report the exact change, line number, and typecheck result.

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