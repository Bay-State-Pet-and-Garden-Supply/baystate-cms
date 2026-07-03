# Task for worker

## Task B4: Clean up ProfileProposalDrawer and ProfileFieldValidationTable

Read these files:
- `src/client/components/ProfileProposalDrawer.tsx` — the old drawer-based proposal review
- `src/client/components/ProfileFieldValidationTable.tsx` — the field-level validation table
- `src/shared/schemas/onboarding.ts` — SELECTOR_FIELDS (now has 3 members)

### What to change

**1. `src/client/components/ProfileProposalDrawer.tsx`**

Find the local `SELECTOR_FIELDS` declaration (around line 47). It's likely an array of `{field, label}` objects with 5 entries. Replace it with the shared import:

```typescript
import { SELECTOR_FIELDS } from '../../shared/schemas/onboarding';
```

Add labels locally since the shared `SELECTOR_FIELDS` only has string types:
```typescript
const FIELD_LABELS: Record<string, string> = {
  titleSelector: 'Title',
  descriptionSelector: 'Description',
  imagesSelector: 'Images',
};
```

Update any loops that iterate over selectors to use these 3 fields instead of 5. Search for `SELECTOR_FIELDS.map` or similar iteration patterns.

Also add the `shopifyJSONPath` toggle in the review area. After the existing field rows, add a simple checkbox/toggle for Shopify productJSON:
```tsx
<div style={{ marginTop: 12, padding: 12, background: '#f8f9fa', borderRadius: 8 }}>
  <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
    <input type="checkbox" checked={shopifyJSONPath} onChange={(e) => onUpdate('shopifyJSONPath', e.target.checked)} />
    <strong>Shopify productJSON</strong>
    <span style={{ color: '#888' }}>— prefer embedded Shopify data for title and images</span>
  </label>
</div>
```

Add state for it:
```typescript
const [shopifyJSONPath, setShopifyJSONPath] = useState(false);
```

Make sure the `onUpdate` callback (or whatever mechanism passes data back) includes `shopifyJSONPath`.

**2. `src/client/components/ProfileFieldValidationTable.tsx`**

Find `FIELD_LABELS` or a similar local constant that maps selector field names to display labels. Trim it to only the 3 active fields:
```typescript
const FIELD_LABELS: Record<string, string> = {
  titleSelector: 'Title',
  descriptionSelector: 'Description',
  imagesSelector: 'Images',
};
```

Remove any price/brand related rows or references.

### Acceptance
- No price/brand fields appear in the drawer
- shopifyJSONPath checkbox is available
- Validation table only shows title, description, images
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