# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
You are implementing tasks #3 and #4 of a profile proposal governance redesign for shopsite-cms.

## Context
The project is a local CMS with React + Vite frontend. We're redesigning how AI-generated CSS selector profiles are reviewed. The key decisions already made:
- Profiles are domain-scoped (one per domain)
- Proposals are created only via explicit "Generate Profile" button (auto-creation is disabled)
- The bottom "Generated Profile Governance" panel should be removed
- Profile review should be inline in the Domain Configuration accordion

## What already changed
- `src/onboarding/page-extractor.ts`: Auto proposal creation removed
- `src/server/routes/onboarding-routes.ts`: Generate-profile route now creates ONE proposal per domain with dedup
- `src/client/onboarding-api.ts`: `generateProfileForDomain` signature updated; `getLatestProposalForDomain` added
- `src/client/components/OnboardingSettings.tsx`: GeneratedProfilesPanel import removed, handleGenerateProfile updated

## What you need to do

### Task A: Remove bottom panel
In `src/client/components/OnboardingSettings.tsx`, remove the "Generated Profile Governance" section (the `<div id="generated-profile-governance">` block with `<GeneratedProfilesPanel />`).

### Task B: Add inline AI Proposal section to DomainDetailPanel
In `OnboardingSettings.tsx`, modify the `DomainDetailPanel` component to include an "AI Proposal" section. This section should:

1. **On mount** (when the domain expands), fetch the latest proposal using `getLatestProposalForDomain(entry.domain)` from `../onboarding-api`

2. **Show proposal selectors** as read-only fields below the existing selector fields, with a visual distinction (e.g., purple badge "🤖 AI Proposal"). Show each selector value or "—" if not proposed.

3. **Preview against a URL**: Add a second "Preview Proposal" button next to the existing "Test Selectors" button (or reuse the test URL). When clicked, it calls `testExtractorProfile` with the proposal's selectors. Also show the active profile's test results for side-by-side comparison.

4. **Side-by-side comparison**: When both active and proposal results exist, show them in two columns (Active | Proposal) so the operator can compare extracted values.

5. **Approve/reject buttons**: For each selector field with a proposed value different from the active value, show small "Approve" and "Reject" buttons. Approving writes the proposed selector to the active profile via `approveRevisionFields` from the onboarding API.

6. **Loading/empty states**: Show "No AI proposal yet" if no proposal exists. Show loading state while fetching.

### Key API functions available
```typescript
import { getLatestProposalForDomain, testExtractorProfile, approveRevisionFields, getProfileGenerationDetail } from '../onboarding-api';
import type { ProfileGenerationGeneration } from '../../shared/schemas/onboarding';
```

- `getLatestProposalForDomain(domain)` returns `ProfileGenerationGeneration | null`
- `testExtractorProfile({ url, titleSelector, priceSelector, ... })` returns `{ success, extracted: Record<string, any> }`
- `getProfileGenerationDetail(generationId)` returns `{ generation, revisions, fieldDecisions, validationResults }`
- `approveRevisionFields(generationId, revisionId, { approvedFields, imagePreviewsReviewed })` writes approved selectors

### Important notes
- The `onSave` callback should be called after approving fields to refresh the domain diagnostics
- The domainDiagnostics entry has `entry.domain` which you can use for fetching
- The `profiles` map in OnboardingSettings holds the active profiles — you'll need to pass it down or access active selectors differently
- Keep the UI consistent with existing styles (use `panelStyles.divider`, `panelStyles.sectionLabel`, etc.)
- The proposal's selectors are in `proposal.selectors` as a Record<string, unknown> — cast keys from GeneratedSelectorProfile

### Files to modify
- `src/client/components/OnboardingSettings.tsx` only

Read the entire file first to understand the current structure, then make precise edits. Run `bun run typecheck` after your changes to verify.

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