# Task for reviewer

## Final review of Phase A implementation

Read these files and verify the implementation matches the plan:

1. `src/onboarding/shopify-json.ts` — Verify it's a pure module (only `node:vm`), exports all needed functions, has no project imports
2. `src/onboarding/page-extractor.ts` — Verify the inlined code was replaced with `import { extractProductJsonFromHtml } from './shopify-json';`
3. `src/onboarding/profile-generator.ts` — Verify:
   - `buildLlmPrompt` has `minimizedDom` parameter and includes `MINIMIZED PRODUCT DOM` section in prompt
   - `SELECTOR_PROFILE_KEYS` has `shopifyJSONPath`
   - `shapeFromParsed` parses `shopifyJSONPath`
   - `MAX_LLM_DOM_BYTES` constant exists (60_000)
   - `buildSeedPreview` function exists and is pure
   - `validateGeneratedProfile` no longer references price/brand
   - `shouldAttemptProfileGeneration` uses `!input.extractionResult.description`
   - Prompt says "you MAY write a selector that is NOT in the candidate list"
4. `src/shared/schemas/onboarding.ts` — Verify:
   - `SELECTOR_FIELDS` has 3 members
   - `ExtractorProfileSchema` has `shopifyJSONPath: z.boolean().default(false)`
5. `src/onboarding/profile-promoter.ts` — Verify `SELECTOR_KEYS` has 3 members
6. `src/onboarding/profile-governance-service.ts` — Verify no price/brand in tally or textFieldsHaveStrongEvidence
7. `src/server/routes/onboarding-routes.ts` — Verify seedPreview is stored in the generate-profile route, and test route accepts shopifyJSONPath
8. `src/client/onboarding-api.ts` — Verify testExtractorProfile accepts shopifyJSONPath
9. `src/db/migrations.ts` — Verify shopify_json_path column migration exists
10. `src/db/repositories/extractor-profile-repo.ts` — Verify shopifyJSONPath handling in upsertProfile

Run `npx tsc --noEmit --skipLibCheck` and report any errors.

### Review angles
- **Completeness**: All 6 A-phase tasks implemented?
- **Purity**: shopify-json.ts has zero project imports?
- **Correctness**: Prompt says "you MAY write a selector that is NOT in the candidate list"? seedPreview uses extractProductJsonFromHtml?
- **Safety**: Historical rows still parse? Enum at 5, arrays at 3?
- **Storage**: shopifyJSONPath persisted end-to-end (LLM → profile → migration → repo → promoter)?

Return evidence-backed findings. Do NOT modify files.

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