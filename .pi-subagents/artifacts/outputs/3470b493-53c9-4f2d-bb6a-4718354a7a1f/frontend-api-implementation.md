# Frontend API Client: Unified Domain Config Endpoint

## Summary

Added the `saveDomainConfig` API client function and `DomainConfigPayload` interface to `src/client/onboarding-api.ts`. This provides the frontend with a typed client for the new unified `PUT /api/onboarding/settings/domains/:domain` endpoint.

## Changed Files

### Modified: `src/client/onboarding-api.ts`

Two targeted edits:

1. **Import** — Added `DomainDiagnosticsEntry` to the `onboarding.ts` schema import block (line 21).

2. **New code** — Inserted `DomainConfigPayload` interface and `saveDomainConfig` function between the existing `deleteExtractorProfile` and `getDomainDiagnostics` exports (lines 334–364).

```typescript
export interface DomainConfigPayload {
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  sitemapProductUrlPattern?: string | null;
  brands?: Array<{
    id?: string;
    brandName: string;
    urlPattern?: string | null;
    successCount?: number;
  }>;
}

export async function saveDomainConfig(
  domain: string,
  data: DomainConfigPayload,
): Promise<DomainDiagnosticsEntry> {
  return request<{ domain: DomainDiagnosticsEntry }>(
    `/settings/domains/${encodeURIComponent(domain)}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    },
  ).then((r) => r.domain);
}
```

## Validation

- `bun run typecheck` (tsc --noEmit --skipLibCheck) — **passes with zero errors**
- The function follows existing patterns: uses `request<T>()` generic wrapper, `encodeURIComponent` for domain param, `method: 'PUT'` consistent with other update endpoints
- Exported interface uses optional (`?:`) markers matching the backend `DomainConfigUpsertSchema` partial semantics
- Return type `DomainDiagnosticsEntry` correctly unwraps the `!r.domain` envelope

## Residual Risks

- **No integration test** exercising the full round-trip (the backend endpoint exists but is not covered by a test in this step)
- **No error handling** beyond what `request()` provides — callers should handle rejected promises

## Acceptance Report

```json
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "DomainConfigPayload interface and saveDomainConfig function added to src/client/onboarding-api.ts without widening scope"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Changes verified via git diff and bun run typecheck -- zero type errors"
    }
  ],
  "changedFiles": [
    "src/client/onboarding-api.ts"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "cd /Users/nickborrello/Desktop/Projects/shopsite-cms && git diff src/client/onboarding-api.ts",
      "result": "passed",
      "summary": "Confirmed two targeted insertions: DomainDiagnosticsEntry import + DomainConfigPayload/saveDomainConfig"
    },
    {
      "command": "cd /Users/nickborrello/Desktop/Projects/shopsite-cms && bun run typecheck",
      "result": "passed",
      "summary": "tsc --noEmit --skipLibCheck — zero errors"
    }
  ],
  "validationOutput": [
    "tsc --noEmit --skipLibCheck passes with no errors"
  ],
  "residualRisks": [
    "No integration test for the full round-trip",
    "No HTTP error handling beyond request() base behavior"
  ],
  "noStagedFiles": true,
  "diffSummary": "Added DomainDiagnosticsEntry to imports; added DomainConfigPayload interface and saveDomainConfig function (PUT /settings/domains/:domain) in src/client/onboarding-api.ts",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "The wider diff also shows pre-existing additions from prior chain steps (getBatchStagedItems, advanceItems, etc.) that were already in the file before this task. Only the two targeted edits are scope of this task."
}
```
