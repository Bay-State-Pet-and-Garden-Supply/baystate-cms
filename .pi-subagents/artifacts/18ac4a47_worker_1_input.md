# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Task: Schema and migration updates for custom fields (B1, B2, B3, B7)

### B1: DB migration
File: `src/db/migrations.ts`

Add after the last migration:
```typescript
// Migration 2026-07-03: Add custom_selectors_json to extractor_profiles
db.run(`ALTER TABLE extractor_profiles ADD COLUMN custom_selectors_json TEXT DEFAULT '{}'`);
```

### B2: ExtractorProfileSchema
File: `src/shared/schemas/onboarding.ts`

Find the `ExtractorProfileSchema` object and add after `imagesSelector`:
```typescript
  customSelectors: z.record(z.string()).default(() => ({})),
```
Also add `customSelectors` to the `ExtractorProfile` type shape.

### B3: PickElementRequest
File: `src/shared/schemas/extraction-worker.ts`

Find `PickElementRequestSchema` and change `field` from enum to string:
```typescript
  field: z.string(),
```

### B7: ExtractionDataSchema
File: `src/shared/schemas/onboarding.ts`

Find `ExtractionDataSchema` and add after `packagingTitle`:
```typescript
  customFields: z.record(z.string()).default(() => ({})),
```

Read each file to find exact text to match, then make targeted edits.

Verify with `bun run typecheck`.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/18ac4a47/progress.md

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