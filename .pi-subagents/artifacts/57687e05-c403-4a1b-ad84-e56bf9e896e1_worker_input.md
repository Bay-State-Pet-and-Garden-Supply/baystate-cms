# Task for worker

Implement Phase 4 of the extraction worker plan: profile validation sweeps.

Read the full plan first: `docs/plans/domain-extractor-profile-worker-plan.md`

## What already exists

Worker shell at `src/extraction-worker/`:
- `server.ts` — routes requests to handlers (mounts /health and /profile-tooling/snapshot)
- `auth.ts` — bearer token auth
- `routes/health.ts` — GET /health
- `routes/snapshot.ts` — POST /profile-tooling/snapshot (static + rendered)
- `artifacts.ts` — artifact file writing to `.shopsite-cms/artifacts/profile-builder/<domain>/<job-id>/`

Shared schemas at `src/shared/schemas/extraction-worker.ts`:
- `ValidateRequestSchema` — { profileDraft: ProfileProposalDraftSchema, samples: ValidationSampleSchema[] }
- `ValidateResponseSchema` — { summary: { sampleCount, confirmedSampleCount, passingSamples, failingSamples, variantSamplesPassing }, results: ValidationSampleResultSchema[] }
- `ValidationSampleSchema` — { url, confirmed, expectedName?, upc?, spreadsheetHints }
- `ValidationSampleResultSchema` — per-sample field results, image results, variant results
- `ProfileProposalDraftSchema` — the shape of a profile draft (domain, urlPatterns, pageStructureSignals, runtime, selectors, imageRules, variantSelectionStrategy)

## What to implement

### 1. Create `src/extraction-worker/routes/validate.ts`

A POST handler at `/profile-tooling/validate` that:

Input: `{ profileDraft, samples }` where samples is an array of `{ url, confirmed, expectedName?, upc?, spreadsheetHints }`

For each sample:
- Fetch the page (static runtime uses fetch; rendered uses Playwright — read the profileDraft.runtime to decide)
- Apply the profile's selectors to extract field values from the page
- Score each field result as pass/warning/fail
- Collect image candidates and check if the primary image rule would work
- If variantSelectionStrategy is set, run the strategy and report success/failure
- Write per-sample HTML to artifacts

Field validation rules:
- For each selector in profileDraft.selectors, check if the selector returns a non-empty value on the page
- If selector returns empty → fail for that field
- If field is titleSelector and expectedName is provided, check word overlap > 15% 
- If field is priceSelector, check value contains a numeric price
- If field is imagesSelector, collect all matching image URLs and check > 0 returned
- Record extracted value (up to 500 chars for text; count for images)

Image validation:
- Apply imageRules if present (for now, just check that the images selector returns at least 1 non-SVG image)
- Set primaryImageMatch based on whether any image candidate was found

Variant validation:
- If variantSelectionStrategy is present in the profile, report that the strategy was evaluated (for now, return `{ selected: true, variantTitle: "not yet implemented" }` — actual variant running comes in Phase 5)

Return the full `ValidateResponseSchema`-shaped result.

### 2. Register the route in `src/extraction-worker/server.ts`

```typescript
import { handleValidate } from './routes/validate';

// In the route function:
if (method === 'POST' && url === '/profile-tooling/validate') {
  handleValidate(req, res);
  return;
}
```

### 3. Update the plan

Add "✅ DONE" and file listing to Phase 4 in `docs/plans/domain-extractor-profile-worker-plan.md`.

## Code patterns to follow

- Use `resolveArtifactDir`, `writeArtifact`, `extractDomainFromUrl`, `generateJobId` from `../artifacts`
- Use the same HTTP extraction headers and user agents from `snapshot.ts`
- For rendered samples, reuse the Playwright browser launch pattern from `snapshot.ts`
- Parse Zod on input: `ValidateRequestSchema.safeParse(parsedBody)`
- Return `ValidateResponseSchema.parse(result)` on output
- Catch errors and surface in warnings; never throw uncaught

## Constraints

- Use Node.js built-in `http` module — no Express, no Hono
- Use `import { chromium } from 'playwright'` for rendered profiles
- Keep field extraction logic in the worker (extraction = worker responsibility)
- This endpoint is VALIDATION EVIDENCE only — it does NOT decide Profile Health (Bun owns that)
- No LLM calls
- Parse request body manually (chunk collection pattern from snapshot.ts)

## Validation

After creating the files:
1. Run `npx tsc --noEmit --skipLibCheck` and verify no errors
2. Start the worker: `npx tsx src/extraction-worker/server.ts &` on port 3032
3. POST a validation request and verify the response shape is correct
4. Kill the worker

## Handoff

Report all files created/changed, typecheck result, any surprises, and decisions needing parent approval.

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