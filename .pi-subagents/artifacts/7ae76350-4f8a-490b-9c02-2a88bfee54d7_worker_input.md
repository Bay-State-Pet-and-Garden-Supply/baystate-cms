# Task for worker

## Task 4: Profile Retry Preview — UI component + backend query

This task builds the Profile Retry Preview UI and its backend query endpoint. The UI shows items blocked in Extraction due to missing/unhealthy profiles, and lets operators retry them.

Read these files:
- `src/client/onboarding-api.ts` — already has `getProfileRetryPreview` and `retryProfileBlockedItems` from Task A
- `src/shared/schemas/onboarding.ts` — already has `ProfileBlockedItemSchema` from Task A
- `src/server/routes/onboarding-routes.ts` — existing onboarding routes
- `src/shared/schemas/onboarding.ts` — check the OnboardingItem types for stage/status fields
- `src/db/repositories/onboarding-item-repo.ts` — check if there's a query function we can reuse

## Changes

### 1. Backend: Add retry-preview query and retry endpoint

Add to `src/server/routes/onboarding-routes.ts`:

**a) Import needed:**
```typescript
import { listItemsByBatchStaged, findItemById, updateItemStageStatus } from '../../db/repositories/onboarding-item-repo';
import { listBatches } from '../../db/repositories/onboarding-batch-repo';
```

**b) Add `GET /api/onboarding/settings/profile-retry-preview/:domain`:**
```typescript
// Query all active batches' items blocked in Extraction with profile-related errors
// Filter by domain (match against sourceUrl domain or brandHint)
// Return items with ProfileBlockedItemSchema shape
```

Implementation approach: query all active items, filter by stage='extraction' and stageStatus='failed', filter by domain match (sourceUrl hostname or brandHint), filter by errorMessage matching profile-related patterns. This is a simple in-memory filter query — use the existing `OnboardingWorker` query pattern.

**c) Add `POST /api/onboarding/settings/profile-retry-preview/:domain/retry`:**
```typescript
// Accept { itemIds: string[] }
// Reset each item's stage_status to 'pending' so the worker picks it up
// Return { accepted: number }
```

Implementation:
```typescript
import { getDb } from '../../db/connection';

// Reset items to pending
for (const itemId of body.itemIds) {
  updateItemStageStatus(itemId, 'pending');
  // Also clear error_message for a clean retry
  getDb().query('UPDATE onboarding_items SET error_message = NULL, retry_count = 0 WHERE id = ?').run(itemId);
}
```

### 2. UI: `src/client/components/ProfileRetryPreview.tsx`

A component showing blocked items that can be retried now that a profile exists.

**Props:**
```tsx
interface ProfileRetryPreviewProps {
  domain: string;
  onClose: () => void;
}
```

**State:**
- `items: ProfileBlockedItem[]` — from `getProfileRetryPreview(domain)`
- `loading: boolean`
- `error: string | null`
- `selectedIds: Set<string>`
- `retrying: boolean`
- `retriedCount: number | null`

**Layout:**
1. Header: domain name, close button
2. Loading state: spinner or "Checking for blocked items..."
3. Error state: if the backend endpoint returns a 404 or errors, show a friendly message:
   "Retry preview is not yet fully implemented. Blocked items can be retried manually from the Pipeline Board."
4. Empty state: "No blocked items found for this domain."
5. Items table (when items exist):
   - Checkbox column
   - UPC
   - Product name
   - Source URL (truncated)
   - Error message (truncated)
   - Blocked at date
6. "Retry Selected" button (disabled when nothing selected or retrying)
7. Per-item status after retry: show checkmark for accepted

**Styling:** Follow the same inline styles as other onboarding components. Use a card-like container with sections similar to the workspace.

### 3. Entry points

The ProfileRetryPreview is shown:
- Inside `ProfileBuilderWorkspace.tsx` after "promote to healthy" succeeds — BUT don't modify that file now. Instead, just create the component.
- As a standalone overlay from OnboardingSettings — wire it in with a "Show blocked items" button somewhere accessible in the profiles tab.

## Constraints
- The backend query is intentionally simple (in-memory filter) — it doesn't need a new repository function
- The `updateItemStageStatus` function already exists and resets items for retry
- The UI must degrade gracefully if the backend endpoint fails
- Do NOT modify ProfileBuilderWorkspace.tsx

## Validation
- `bun run typecheck` passes with zero errors

## Handoff
Report all files changed/created, typecheck result, line counts.

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