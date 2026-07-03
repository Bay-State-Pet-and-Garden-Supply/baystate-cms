# Task for worker

## Task B2: Rewrite ProfileGenerationReview to preview-driven review flow

Read these files first:
- `src/client/components/ProfileGenerationReview.tsx` — the current review component (read fully, 659 lines)
- `src/client/components/ProfileExtractionPreview.tsx` — the new preview component (just created)
- `src/client/components/ProfileRevisionFeedbackForm.tsx` — existing feedback form
- `src/client/onboarding-api.ts` — API functions (testExtractorProfile, approveRevisionFields, validateRevision)
- `src/shared/schemas/onboarding.ts` — SELECTOR_FIELDS

### What to do

Replace the current per-field approval table with a preview-driven state machine. The flow:

**States**: `previewing` → `validating` → `validated` → `promoting` → `promoted`, with `feedback` branching from `previewing` or `validated`.

**Key changes:**

1. **Replace the per-field approval table** — Remove `ProfileFieldValidationTable` usage and the "Approve selected fields" / "Reject selected fields" button row. The existing `approveRevisionFields` call should be replaced with a single **Promote** action that approves all 3 active fields at once.

2. **Add `ProfileExtractionPreview` at the top** — Show the extracted data from the generation's `seedPreview` (stored in `latestRevision.fieldSamples?.seedPreview`). When absent (e.g., feedback revisions), call `testExtractorProfile` on mount to get an `onDemandResult`.

3. **"Looks correct" button** — In previewing state, a green button "Looks correct" that calls `validateRevision(generationId, latestRevision?.id)`. On success transitions to `validated`.

4. **Validation summary** — In validated state, show the aggregate pass/fail per field from the validation result, plus the image approval checkbox. Keep the image-approval gate (≥2 passing image samples + checkbox).

5. **"Promote" button** — In validated state, a blue button "Promote" that calls `approveRevisionFields({ titleSelector: true, descriptionSelector: true, imagesSelector: true }, imagePreviewsReviewed)`. On success transitions to `promoted`.

6. **"Something's wrong" button** — In previewing or validated state, a gray button "Something's wrong" that opens the feedback form. After submit, reloads and returns to previewing.

7. **Keep below the fold**: revision history list, field-decisions audit, delete generation button — move these below the preview/action area.

### Implementation sketch

```tsx
type ReviewState = 'previewing' | 'validating' | 'validated' | 'promoting' | 'promoted' | 'feedback';

const [reviewState, setReviewState] = useState<ReviewState>('previewing');
const [validationResult, setValidationResult] = useState<any>(null);
const [validationBusy, setValidationBusy] = useState(false);
const [promoteBusy, setPromoteBusy] = useState(false);
const [imagePreviewsReviewed, setImagePreviewsReviewed] = useState(false);
const [onDemandPreview, setOnDemandPreview] = useState<any>(null);

// On mount, if no seedPreview in latestRevision, fetch on-demand preview
useEffect(() => {
  const seedPreview = (latestRevision as any)?.fieldSamples?.seedPreview;
  if (!seedPreview && generation?.sourceUrl) {
    testExtractorProfile({
      url: generation.sourceUrl,
      titleSelector: proposedSelectors.titleSelector,
      descriptionSelector: proposedSelectors.descriptionSelector,
      imagesSelector: proposedSelectors.imagesSelector,
      shopifyJSONPath: (latestGeneration?.selectors as any)?.shopifyJSONPath ?? false,
    }).then(res => {
      if (res?.extracted) setOnDemandPreview(res.extracted);
    }).catch(() => {});
  }
}, []);
```

**Actions:**
```tsx
const handleLooksCorrect = async () => {
  setReviewState('validating');
  try {
    const result = await validateRevision(generationId, latestRevision?.id);
    setValidationResult(result);
    setReviewState('validated');
  } catch {
    setReviewState('previewing');
  }
};

const handlePromote = async () => {
  setReviewState('promoting');
  try {
    await approveRevisionFields({
      generationId,
      approvedFields: { titleSelector: true, descriptionSelector: true, imagesSelector: true },
      imagePreviewsReviewed,
    });
    setReviewState('promoted');
    onChange?.(); // reload governance
  } catch {
    setReviewState('validated');
  }
};
```

### Keep from the existing component
- Revision history accordion (below the preview/actions)
- Field decisions / rollback audit trail
- Delete generation button
- Loading/error states for the generation data

### Removal scope
- Per-field checkbox approval table
- Individual approve/reject buttons
- `ProfileFieldValidationTable` import (if used)

### Constraints
- Do NOT modify `ProfileExtractionPreview.tsx` (Task B1)
- Only modify `ProfileGenerationReview.tsx`
- The component is embedded in `ProfileBuilderWorkspace.tsx` — keep the same props interface
- `bun run typecheck` must pass

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