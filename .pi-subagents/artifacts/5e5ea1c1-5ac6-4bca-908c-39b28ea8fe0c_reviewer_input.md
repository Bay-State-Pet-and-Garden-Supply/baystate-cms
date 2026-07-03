# Task for reviewer

## Review the overhaul plan for extraction profile proposal generation and review

Read the plan at: `/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/f0f613e7-185d-4313-b723-3ae79bd32470/plan.md`

Also read these files to verify the plan's correctness and feasibility:
- `src/onboarding/profile-generator.ts` — the proposal generator being overhauled
- `src/onboarding/page-extractor.ts` — lines 1005-1145 where the productJSON extraction currently lives (being moved to shopify-json.ts)
- `src/onboarding/profile-promoter.ts` — SELECTOR_KEYS and promotion logic
- `src/onboarding/profile-governance-service.ts` — tally() and validation logic
- `src/client/components/ProfileGenerationReview.tsx` — the review component being rewritten
- `src/client/components/ProfileBuilderWorkspace.tsx` — tabs being merged
- `src/db/repositories/extractor-profile-repo.ts` — upsertProfile SQL
- `src/shared/schemas/onboarding.ts` — SELECTOR_FIELDS, ExtractorProfileSchema
- `src/extraction-worker/routes/extract.ts` — trusted extractor (for A6)

## Review angles

1. **Completeness** — Does the plan cover all three phases from the oracle analysis? Are all tasks specified with enough detail for a worker to implement?

2. **Correctness** — 
   - A0: Is `extractProductJsonFromHtml` truly pure? Does it use `node:vm`? Verify the actual function in page-extractor.ts.
   - A1: Is 60KB a reasonable MAX_LLM_DOM_BYTES? Is the prompt change safe (no regression on existing sites)?
   - A2: Is `shopifyJSONPath` as boolean correct, or should it be a string path? Will the migration break existing DBs?
   - A4: Does dropping price/brand from SELECTOR_FIELDS break any downstream consumers? Check every file that imports SELECTOR_FIELDS.

3. **Safety** — 
   - A1: Passing minimized DOM to LLM increases token cost and injection surface. Are the mitigations sufficient?
   - A4: The enum stays at 5 but the iterating arrays change to 3. Are there any code paths that assume `SELECTOR_FIELDS.length === 5` or iterate the enum directly?
   - A3: `buildSeedPreview` must stay pure. Does the plan guarantee this?

4. **Feasibility** — Is the implementation order realistic? Are there any hidden dependencies?

5. **Consistency** — Does the plan align with the oracle's recommendations? Are there contradictions?

Return findings with file/line references where applicable. Identify any blockers that would prevent implementation. Do NOT modify any files.

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