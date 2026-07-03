# Task for reviewer

Review the implementation of the paste-element-to-selector flow (Phase 2 of the Visual Element Picker plan).

## What was implemented

### Phase 1: Shared module extraction
- Created `src/shared/selector-utils.ts` — extracted `buildStableSelector`, `isLikelyGeneratedId`, `isSupportedSelectorSyntax`, `classSet`, `attrSelector`, `snippetOf`, `STABLE_DATA_ATTRS`, `SEMANTIC_HINT_SUBSTRINGS` from `profile-generator.ts` with zero Bun dependencies
- Updated `src/onboarding/profile-generator.ts` — removed moved functions, imports from shared module
- Created `src/tests/unit/selector-utils.test.ts` — 32 tests covering all functions

### Phase 2: Paste-element-to-selector
- Added `GenerateSelectorRequestSchema`/`GenerateSelectorResponseSchema` to `src/shared/schemas/extraction-worker.ts`
- Created `src/extraction-worker/routes/generate-selector.ts` — worker route POST /profile-tooling/generate-selector
- Registered route in `src/extraction-worker/server.ts`
- Added `generateSelectorFromElement` to `src/server/extraction-worker-client.ts`
- Added Bun proxy routes in `src/server/routes/onboarding-routes.ts`:
  - POST /api/onboarding/settings/profile-tooling/generate-selector
  - POST /api/onboarding/settings/profile-tooling/fetch-html
- Added client API functions in `src/client/onboarding-api.ts`: `generateSelectorFromElement`, `fetchPageHtml`
- Updated `src/client/components/ProfileRevisionFeedbackForm.tsx`:
  - Added `sourcePageUrl` prop
  - Added paste-element section with textarea, Generate button, selector preview with stability badge
  - Pre-fills `manualSelectorHint` with generated selector
- Updated `src/onboarding/profile-governance-service.ts`:
  - Imports `isSupportedSelectorSyntax` from shared module
  - Detects `Advanced selector hint:` in notes and applies the selector to the revision's `selectors_json`
  - Sets `source` to `manual_css` when a manual selector is present

### Invariants preserved
1. Never auto-promote — generated selector goes into a revision via feedback, still needs per-field approval
2. Per-field approval — paste-element operates on one field at a time
3. Image approval needs 2+ samples + attestation — unchanged
4. Revisions are versioned — paste-element creates a new revision via the existing `createRevisionFromFeedback` flow
5. Worker is Node.js-only — `selector-utils.ts` only imports `cheerio`, worker routes import it directly

## What to review

Please check all the modified files for:

1. **Correctness**: Does the paste-element flow work end-to-end? Client calls fetch-html → Bun proxy → worker fetch, then generate-selector → Bun proxy → worker → returns selector to client.

2. **Pattern consistency**: Do the new routes follow the existing patterns (snapshot route, route registration, proxy pattern, client API)?

3. **Edge cases**: What happens when:
   - The pasted HTML doesn't match any element in the full page DOM?
   - The pasted HTML is invalid?
   - The source page URL is not provided?
   - The worker is unavailable?
   - The generated selector uses unsupported syntax?

4. **Selector generation**: Is `buildStableSelector` being used correctly? Is the fallback case (when element not found in full DOM) handled properly?

5. **Governance wiring**: Is the `Advanced selector hint:` parsing robust? What if the notes field has multiple `Advanced selector hint:` tags?

6. **Invariant compliance**: Does the flow respect the "never auto-promote" invariant? Does the generated selector flow through the existing revision → per-field approval → promotion path?

## Files to read

- `src/shared/selector-utils.ts`
- `src/onboarding/profile-generator.ts` (check imports)
- `src/tests/unit/selector-utils.test.ts`
- `src/shared/schemas/extraction-worker.ts` (check new schemas)
- `src/extraction-worker/routes/generate-selector.ts`
- `src/extraction-worker/server.ts` (check route registration)
- `src/server/extraction-worker-client.ts` (check new function)
- `src/server/routes/onboarding-routes.ts` (check proxy routes)
- `src/client/onboarding-api.ts` (check client API functions)
- `src/client/components/ProfileRevisionFeedbackForm.tsx` (check paste-element section)
- `src/onboarding/profile-governance-service.ts` (check manual selector parsing)

Report findings with file paths and line numbers. Call out any issues clearly.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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