# Task for worker

## Task B3: Merge Proposals + Validation tabs into single Review tab

Read `src/client/components/ProfileBuilderWorkspace.tsx` fully (~1598 lines). This is the main workspace component with 4 tabs: Overview, Snapshot, Proposals, Validation.

### What to change

**1. Change TabId type** from 4 tabs to 3:
```typescript
type TabId = 'overview' | 'snapshot' | 'review';
```

Update the `activeTab` state default from `'overview'` (keep same).

**2. Update the tab bar** — Replace the 4-tab rendering with 3:
```typescript
TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'snapshot', label: 'Snapshot' },
  { id: 'review', label: 'Review' },
];
```

**3. Replace `renderProposals` and `renderValidation` with a single `renderReview`**

Find the `renderProposals` function (which shows the list of generations + embedded ProfileGenerationReview) and the `renderValidation` function (which shows the "Run Validation Across Samples" + results table + promote gate).

Replace both with a single `renderReview` function that:

a) Shows the list of generations (kept from renderProposals) with "Generate New Proposal" button.

b) When a generation is selected, embeds the rewritten `<ProfileGenerationReview>` (from B2) which handles the entire preview → validate → approve flow internally.

c) Remove the standalone "Run Validation Across Samples" button + results table + promote checklist from the old validation tab — all of this is now handled inside ProfileGenerationReview's state machine.

d) Remove the `handleValidate`, `snapshot-driven validate results`, and `validationResult` state that was specific to the validation tab.

**4. Update `SELECTOR_FIELD_LABELS`** — Find the local constant (around line 96). If it still includes price/brand, trim to 3 fields:
```typescript
const SELECTOR_FIELD_LABELS: Record<string, string> = {
  titleSelector: 'Title',
  descriptionSelector: 'Description',
  imagesSelector: 'Images',
};
```

**5. Overview tab** — The "Active Profile" selector table should only show the 3 active fields. If it iterates over all 5 SELECTOR_FIELDS, update it.

### What to keep
- Overview tab completely unchanged (domains header, active profile table, quick actions)
- Snapshot tab completely unchanged (URL input, runtime toggle, results panel)
- The overlay wrapper and close button
- All existing state variables that are still used

### What to remove
- The standalone `handleValidate` function (validation is now inside ProfileGenerationReview)
- `validationResult` state, `validationBusy`, `validationError`
- The `renderValidation` function entirely
- Any validation-tab-specific state that's no longer referenced

### Acceptance
- Only 3 tabs: Overview, Snapshot, Review
- Review tab shows generations list + "Generate New Proposal" button
- Clicking a generation opens ProfileGenerationReview with the preview-driven flow
- The entire generate → preview → validate → approve path is reachable within the Review tab
- `bun run typecheck` passes

### Handoff
Report all changes, typecheck result.

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