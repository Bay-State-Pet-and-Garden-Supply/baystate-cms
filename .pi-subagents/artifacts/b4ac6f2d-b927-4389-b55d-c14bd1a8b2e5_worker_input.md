# Task for worker

Fix the validation sample flow so the Profile Builder Workspace can actually validate across confirmed samples.

### Problem

When the user opens the Profile Builder Workspace for a domain (e.g., mywoof.com) and clicks "Validate Across Samples", the `handleValidate` function in `ProfileBuilderWorkspace.tsx` only uses `seedSampleUrl` from props. If no seed URL is provided (the normal case when opening from the workspace directly), it shows "No sample URLs available" even though the domain has confirmed samples.

The governance response (`getDomainProfileGovernance`) returns `validationSampleCount` (a number) but not the actual sample URLs. The frontend can't build validate requests without the URLs.

### Changes needed

#### 1. Add ValidationSampleRefSchema to `src/shared/schemas/onboarding.ts`

After `DomainProfileGovernanceSchema` and its `validationSampleCount` field, add before the closing:

```typescript
export const ValidationSampleRefSchema = z.object({
  url: z.string(),
  expectedName: z.string().nullable(),
  brandHint: z.string().nullable(),
  itemId: z.string(),
  confirmed: z.boolean(),
});
export type ValidationSampleRef = z.infer<typeof ValidationSampleRefSchema>;
```

Then update `DomainProfileGovernanceSchema` to include an array of samples:

```typescript
export const DomainProfileGovernanceSchema = z.object({
  domain: z.string(),
  activeProfile: ExtractorProfileSchema.nullable().default(null),
  generations: z.array(ProfileGenerationGenerationSchema).default(() => []),
  revisions: z.array(ProfileGenerationRevisionSchema).default(() => []),
  fieldDecisions: z.array(ProfileGenerationFieldDecisionSchema).default(() => []),
  validationSampleCount: z.number().int().default(0),
  validationSamples: z.array(ValidationSampleRefSchema).default(() => []),
});
```

#### 2. Update `listDomainProfileGovernance` in `src/onboarding/profile-governance-service.ts`

Find the function that returns the governance summary. It already calls `listValidationSamplesByDomain`. Change its output to include the actual sample data (not just the count):

```typescript
const validationSamples = listValidationSamplesByDomain(normalizedDomain, MAX_VALIDATION_SAMPLES);

return {
  domain: normalizedDomain,
  activeProfile: (activeProfile as ExtractorProfile | null) ?? null,
  generations,
  revisions,
  fieldDecisions,
  validationSampleCount: validationSamples.length,
  validationSamples: validationSamples.map(s => ({
    url: s.url,
    expectedName: s.expectedName,
    brandHint: s.brandHint,
    itemId: s.itemId,
    confirmed: true,
  })),
};
```

#### 3. Update `handleValidate` in `ProfileBuilderWorkspace.tsx`

Find the `handleValidate` function (around line 437-500). After building the samples from `seedSampleUrl`, add:

```typescript
// Also include confirmed validation samples from governance
if (governance?.validationSamples && governance.validationSamples.length > 0) {
  for (const vs of governance.validationSamples) {
    if (!samples.find(s => s.url === vs.url)) {
      samples.push({
        url: vs.url,
        confirmed: vs.confirmed,
        expectedName: vs.expectedName ?? undefined,
        upc: undefined,
      });
    }
  }
}
```

Import the new type at the top:
```typescript
import type { ValidationSampleRef } from '../../shared/schemas/onboarding';
```

## Validation
- `bun run typecheck` passes with zero errors
- When the workspace opens for mywoof.com and the user clicks "Validate Across Samples", it should use the confirmed samples from the governance response

## Handoff
Report all changed files and typecheck result.

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