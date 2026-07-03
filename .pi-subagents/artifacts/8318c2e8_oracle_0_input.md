# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
## Context: Profile-Required Badge & Visual Picker Are Unreachable

The user reports that:
1. Products advance into extraction and run extraction **even when no domain profile exists** — they don't fail with a "profile required" error
2. The "⚠ Profile required" badge and "Open Profile Builder →" link never appear in the PipelineBoard
3. Therefore the click-to-select visual picker (`ProfileBuilderWorkspace`) is unreachable through the pipeline UI flow

### Root Cause Analysis from Codebase

**The extraction pipeline has no "profile required" fail-fast:**

In `src/onboarding/page-extractor.ts` (line 176):
```typescript
const profile = domain ? findProfileByDomain(domain) : null;
```
When `profile` is null, extraction proceeds anyway using fallback strategies (JSON-LD, meta tags, microdata, HTML heuristics). It never checks "does this domain need a profile?" and never fails with a profile-related error message.

In `src/onboarding/job-queue.ts` (line 354):
```typescript
const extractedData = await extractProductData(item.sourceUrl, {...});
```
The job queue calls extraction with no profile-awareness — it doesn't check if the domain has an extractor profile before running.

**The badge logic depends on a non-existent error message:**

In `src/client/components/PipelineBoard.tsx` (lines 585-596):
```typescript
const failReason = deriveProfileFailReason(item.errorMessage);
if (failReason === 'no_profile') {
  render badge + "Open Profile Builder →" link
}
```

`deriveProfileFailReason` checks if `errorMessage` contains "no profile" or "profile required":
```typescript
function deriveProfileFailReason(errorMessage: string | null) {
  if (!errorMessage) return null;
  if (/no (healthy )?profile/i.test(errorMessage) || /profile.*required/i.test(errorMessage)) return 'no_profile';
  ...
}
```

But extraction **never sets this error message** — when no profile exists, it just falls through to generic extraction. The badge never renders.

### The Result

The full click-to-select visual picker flow (Phase 3) is unreachable because:
1. No "no profile" error → badge never shows → link never renders → ProfileBuilderWorkspace never opens

The only working entry points are:
- The `ProfileBuilderWorkspace` is imported but **unused** in `OnboardingSettings.tsx` (no button wired to it)
- The `PipelineBoard` has the `onOpenProfileBuilder` prop and link rendering code, but the condition (`failReason === 'no_profile'`) is never met

### History

The design intent was:
- Extraction should detect that a domain lacks an extractor profile and fail-fast with a "profile required" error
- The PipelineBoard renders the badge from that error message
- The link opens the ProfileBuilderWorkspace so the user can visually build a profile

But the extraction code was never updated to produce this error. The fallback extraction strategies were always treated as a safety net, not as an indicator that the domain needs a profile.

### Question for Oracle

What's the right fix? Should we:
1. Add a pre-extraction check in `page-extractor.ts` or `job-queue.ts` that fails-fast with "profile required" when no extractor profile exists for the domain?
2. Add a `needsProfile` flag to the item stage status so the PipelineBoard can show the badge without relying on error message parsing?
3. Wire the `ProfileBuilderWorkspace` directly into the OnboardingSettings Profiles tab UI so it's accessible without going through a failed extraction?
4. Some hybrid — fail extraction with profile-required error for domains with no profile, AND add a direct button in the Profiles tab?

### Files already reviewed
- `src/onboarding/page-extractor.ts` — line 176, no profile check
- `src/onboarding/job-queue.ts` — line 354, no profile awareness
- `src/client/components/PipelineBoard.tsx` — lines 585-596, badge depends on errorMessage
- `src/client/components/OnboardingSettings.tsx` — imports ProfileBuilderWorkspace but never uses it
- `src/client/components/Onboarding.tsx` — only passes onOpenProfileBuilder through PipelineBoard

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

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