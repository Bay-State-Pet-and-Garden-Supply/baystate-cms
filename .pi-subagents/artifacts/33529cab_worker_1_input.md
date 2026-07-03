# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Task: Update profile-promoter.ts to handle custom fields (B11)

File: `src/onboarding/profile-promoter.ts`

The promoter writes approved field selectors to `extractor_profiles`. Currently it handles 3 fixed keys: `titleSelector`, `descriptionSelector`, `imagesSelector`. Custom fields need to be written to the `customSelectors` map.

Find where approved fields are written (the `promoteGeneratedProfile` function or similar). Add logic to:
1. Detect if an approved field is NOT one of the 3 fixed keys
2. If it's a custom field, add it to a `customSelectors` accumulation object
3. Pass the accumulated custom selectors to the `upsertProfile` call

Key logic:
```typescript
const customSelectors: Record<string, string> = {};
for (const key of approvedKeys) {
  if (!SELECTOR_KEYS.includes(key as SelectorKey)) {
    // Custom field — extract the selector from the revision's selectors
    const selector = revision.selectors?.[key];
    if (selector && typeof selector === 'string') {
      customSelectors[key] = selector;
    }
  }
}
```

Then pass `customSelectors` to `upsertProfile`.

Read the file first to understand the existing promotion flow, then make targeted edits.

Verify with `bun run typecheck`.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/33529cab/progress.md

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