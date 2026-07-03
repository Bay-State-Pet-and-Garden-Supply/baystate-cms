# Task for reviewer

Final review of variant discovery and image expansion changes.

Read these files:
- `src/onboarding/profile-generator.ts` — FULL review. Verify:
  1. `GeneratedSelectorProfile` has the optional `variantSelectionStrategy` field
  2. `buildSelectorCandidates` has 6 image patterns (5 new + original), `baseUrl` parameter, and `buildSelectorCandidates(minimized, _url)` in `generateExtractorProfile`
  3. `VariantOptionCandidate` interface and `buildVariantOptionCandidates` function exist and implement 5 discovery strategies
  4. `buildLlmPrompt` has the variantCandidates parameter, VARIANT/OPTION CANDIDATES section in prompt, updated instructions, and variantSelectionStrategy in JSON schema
  5. `shapeFromParsed` parses variantSelectionStrategy from LLM JSON and doesn't fail the profile on invalid strategy
  6. `generateExtractorProfile` builds variantCandidates from original HTML and passes them to `buildLlmPrompt`

- `src/shared/schemas/extraction-worker.ts` — Verify:
  1. `VariantSelectionStrategySchema` exists with correct fields
  2. `ProfileProposalDraftSchema.variantSelectionStrategy` and `ExtractRequestSchema.profile.variantSelectionStrategy` use the new schema
  3. `ValidationSampleResultSchema.variantResult` has enhanced fields (containerSelector, optionType, detectedOptions, optionFields, strategyValid)

- `src/extraction-worker/routes/validate.ts` — Verify:
  1. Strategy is typed as `VariantSelectionStrategy | null`
  2. Variant result block has real corroboration (not the old 'not yet implemented' stub)
  3. `strategyValid` logic handles null strategy, container not found, and missing options

- `src/client/components/ProfileBuilderWorkspace.tsx` — Verify:
  1. The hardcoded `variantSelectionStrategy: null` was replaced with a read from the stored generation

## Review angles

1. **Completeness** — Are all required changes from the plan implemented?
2. **Correctness** — Does `buildVariantOptionCandidates` correctly scan the original HTML (not minimized DOM)? Are the 5 discovery strategies logically sound?
3. **Safety** — Does `shapeFromParsed` properly handle malformed LLM output without crashing or failing the profile? Is the strategy parsing defensive?
4. **Type safety** — Run `npx tsc --noEmit --skipLibCheck` and report any issues.
5. **Architecture** — Does the implementation follow the plan's key constraint (variant discovery runs on original HTML, not minimized)?

Return concise evidence-backed findings with file/line references. Do NOT modify any files.

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