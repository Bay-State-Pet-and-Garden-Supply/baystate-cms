# Task for worker

Implement Task A from the UI implementation plan: Bun proxy routes for the extraction worker + client API functions.

Read these files:
- `docs/plans/domain-extractor-profile-worker-plan.md` — overall plan
- `src/server/routes/onboarding-routes.ts` — existing routes to add to
- `src/server/extraction-worker-client.ts` — existing Bun-side client for the worker
- `src/client/onboarding-api.ts` — existing frontend API client to extend
- `src/shared/schemas/extraction-worker.ts` — Zod schemas (SnapshotRequestSchema, ValidateRequestSchema, WorkerHealthResponseSchema, etc.)

## What to implement

### 1. Add Bun proxy routes to `src/server/routes/onboarding-routes.ts`

Add these routes AFTER the existing worker health route (around line 1100):

```typescript
// POST /api/onboarding/settings/profile-tooling/snapshot
// Proxies to the extraction worker's snapshot endpoint
// Validates request body with SnapshotRequestSchema before forwarding
// Returns { ok, data } on success, { ok: false, error } on failure
```

```typescript
// POST /api/onboarding/settings/profile-tooling/validate  
// Proxies to the extraction worker's validate endpoint
// Validates request body with ValidateRequestSchema before forwarding
// Returns { ok, data } on success, { ok: false, error } on failure  
```

```typescript
// GET /api/onboarding/settings/domain-diagnostics/:domain
// Single-domain diagnostics fetch. Filters full diagnostics by domain, returns entry or 404.
```

Import `SnapshotRequestSchema` and `ValidateRequestSchema` from `../../shared/schemas/extraction-worker`.
Import `snapshotPage`, `validateProfile` from `../extraction-worker-client`.
Import `getDomainDiagnosticsResponse` from `../../onboarding/domain-diagnostics-service`.

### 2. Add client functions to `src/client/onboarding-api.ts`

Add these functions:

```typescript
import type { WorkerHealthResponse, SnapshotRequest, SnapshotResponse, ValidateRequest, ValidateResponse } from '../shared/schemas/extraction-worker';

export async function getExtractionWorkerHealth(): Promise<WorkerHealthResponse | null> {
  return request<WorkerHealthResponse>('/settings/extraction-worker/health').catch(() => null);
}

export async function snapshotPageForBuilder(req: SnapshotRequest): Promise<{ ok: boolean; data?: SnapshotResponse; error?: string }> {
  return request('/settings/profile-tooling/snapshot', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function validateProfileDraft(req: ValidateRequest): Promise<{ ok: boolean; data?: ValidateResponse; error?: string }> {
  return request('/settings/profile-tooling/validate', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function getDomainDiagnosticsForDomain(domain: string): Promise<DomainDiagnosticsEntry> {
  return request(`/settings/domain-diagnostics/${domain}`);
}
```

Note: the `request` function already returns parsed JSON and throws on error. The `snapshotPageForBuilder` and `validateProfileDraft` need to handle the `{ ok, data, error }` wrapper shape. Look at how existing onboarding-api functions handle errors.

### 3. Add `ProfileBlockedItemSchema` to `src/shared/schemas/onboarding.ts`

Add after the `DomainDiagnosticsResponseSchema` block:

```typescript
export const ProfileBlockedItemSchema = z.object({
  itemId: z.string(),
  upc: z.string(),
  name: z.string(),
  expectedName: z.string().nullable(),
  brandHint: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  blockedAt: z.string(),
});
export type ProfileBlockedItem = z.infer<typeof ProfileBlockedItemSchema>;
```

### 4. Add retry-preview client function to `src/client/onboarding-api.ts`

```typescript
import type { ProfileBlockedItem } from '../shared/schemas/onboarding';

export async function getProfileRetryPreview(domain: string): Promise<{ items: ProfileBlockedItem[] }> {
  return request(`/settings/profile-retry-preview/${encodeURIComponent(domain)}`);
}

export async function retryProfileBlockedItems(domain: string, itemIds: string[]): Promise<{ accepted: number }> {
  return request(`/settings/profile-retry-preview/${encodeURIComponent(domain)}/retry`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}
```

## Constraints
- Follow existing code style in each file
- Use existing import patterns  
- Never break typecheck — verify with `bun run typecheck` before completing
- The snapshot/validate routes must NOT expose the worker token to the frontend — the Bun server holds it
- Return clear "worker unavailable" error messages when the worker is unreachable, matching the existing health route pattern

## Validation
1. `bun run typecheck` passes with zero errors
2. All new routes are registered in the correct file

## Handoff
Report all files changed, typecheck result, and any surprises.

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