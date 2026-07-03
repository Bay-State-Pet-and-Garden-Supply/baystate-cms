# Task for reviewer

Review all UI and backend changes made to build the extraction profile system UI. This is the final review check.

Read ALL these files:
- `src/client/components/ProfileBuilderWorkspace.tsx` — NEW, domain-first profile builder (4 tabs)
- `src/client/components/ProfileRetryPreview.tsx` — NEW, profile blocked items retry
- `src/client/components/OnboardingSettings.tsx` — MODIFIED, tab restructure + worker health + profile health + open builder button
- `src/client/components/PipelineBoard.tsx` — MODIFIED, extraction status badges + onOpenProfileBuilder callback
- `src/client/components/Onboarding.tsx` — MODIFIED, wires ProfileBuilderWorkspace overlay
- `src/client/onboarding-api.ts` — MODIFIED, new client functions
- `src/server/routes/onboarding-routes.ts` — MODIFIED, proxy routes + single-domain diagnostics + retry-preview endpoints
- `src/shared/schemas/onboarding.ts` — MODIFIED, ProfileBlockedItem schema
- `src/shared/schemas/extraction-worker.ts` — existing, referenced by UI
- `docs/plans/domain-extractor-profile-worker-plan.md` — the plan

## Review angles

1. **Architecture consistency** — Do the UI changes follow the domain model in CONTEXT.md? ProfileBuilderWorkspace is domain-first, not item-attached? Pipeline Board badges distinguish fail reasons? OnboardingSettings has the Profiles tab with health indicators?

2. **Code quality** — Are there any obvious React issues (missing keys, stale closures, infinite loops in useEffects)? Any imports that are missing? Any broken JSX?

3. **Backend safety** — The new backend routes (proxy snapshot/validate, retry-preview query/retry): do they expose any sensitive data? Do they handle errors gracefully? Are they properly auth-gated by the existing API token middleware (Bun routes use GET-exempt convention)?

4. **Type safety** — Run `npx tsc --noEmit --skipLibCheck` and report any issues.

5. **Backward compatibility** — Does the OnboardingSettings tab restructure break any existing flows (profile proposal drawer, domain detail accordion, generation review)? Are existing handlers still wired?

6. **Missing imports or patterns** — Check that the new components import from the correct paths and use consistent patterns with existing onboarding code.

Return concise evidence-backed findings. Do NOT modify any files.

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