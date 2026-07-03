# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Task: Add custom field section to Build tab (B5)

File: `src/client/components/ProfileBuilderWorkspace.tsx`

After the 3 fixed visual select cards (Title, Description, Images), add a new section titled "Custom Fields" with:
1. A text input for the field name + an "Add Field" button
2. When "Add Field" is clicked, a new card appears with the field name and an ElementPickerButton
3. Each custom field card shows the picked selector inline (same pattern as the fixed cards)
4. A remove button (X) to delete custom fields

State to add:
```typescript
const [customFieldName, setCustomFieldName] = useState('');
const [customPickedFields, setCustomPickedFields] = useState<Record<string, { selector: string; stability: string }>>({});
```

Read the file, find the section where the 3 fixed cards end and the Progress div begins. Insert the custom fields section between them.

Verify with `bun run typecheck`.

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/326a4f58/progress.md

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