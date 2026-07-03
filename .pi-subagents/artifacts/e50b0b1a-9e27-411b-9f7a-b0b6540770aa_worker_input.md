# Task for worker

## Task 1: Create ProfileBuilderWorkspace (domain-first profile building surface)

Read these files first for context on existing patterns and reusable components:
- `src/client/components/ProfileProposalDrawer.tsx` — existing drawer-based profile builder (reuse patterns, not the drawer wrapping)
- `src/client/components/ProfileGenerationReview.tsx` — embed this for field-level approval
- `src/client/components/ProfileFieldValidationTable.tsx` — reuse for sample validation display
- `src/client/components/ImagePreviewGrid.tsx` — reuse for image previews
- `src/client/components/GeneratedProfilesPanel.tsx` — use for generation list pattern
- `src/client/components/OnboardingSettings.tsx` — search for `domainHealthBadgeStyle`, `healthStatus` rendering patterns
- `src/client/onboarding-api.ts` — the API functions created in Task A
- `src/shared/schemas/onboarding.ts` — DomainProfileGovernance, DomainDiagnosticsEntry types
- `src/shared/schemas/extraction-worker.ts` — SnapshotResponse, ValidateResponse types

## What to create

### `src/client/components/ProfileBuilderWorkspace.tsx`

A full-page component (rendered as an overlay/modal, not a drawer) for domain-first profile building.

**Props:**
```tsx
interface ProfileBuilderWorkspaceProps {
  domain: string;
  onClose: () => void;
  seedSampleUrl?: string | null;
  seedItem?: { expectedName?: string | null; upc?: string | null; brandHint?: string | null } | null;
}
```

**State:**
- `governance` — from `getDomainProfileGovernance(domain)` (on mount)
- `workerHealth` — from `getExtractionWorkerHealth()` (on mount)
- `snapshot` — from `snapshotPageForBuilder(...)` (on user click)
- `snapshotBusy: boolean`, `snapshotError: string`
- `validation` — from `validateProfileDraft(...)` (on user click)
- `validationBusy: boolean`, `validationError: string`
- `selectedGenerationId: string | null`
- `proposalGenerating: boolean`
- `activeTab` — for section tabs within the workspace: `'overview' | 'snapshot' | 'proposals' | 'validation'`

**Layout sections (as tabs):**

### Overview tab:
1. **Domain header**: domain name, healthStatus badge, worker health indicator (colored dot + version), confirmed-sample count
2. **Existing profiles list**: show the active extractor profile (from governance.activeProfile). Display its selectors in a small table. If no active profile, show "No active profile" state.
3. **Quick actions**: "Generate profile proposal" button (calls existing `generateProfileForDomain(domain, seedSampleUrl)`), "Snapshot page" button (opens Snapshot tab), "Validate across samples" button (opens Validation tab)

### Snapshot tab:
1. URL input field (pre-filled from `seedSampleUrl`)
2. Runtime toggle (static/rendered)
3. Checkboxes: "Capture screenshot", "Capture network"
4. "Take Snapshot" button
5. Results panel (shown after snapshot completes):
   - JSON-LD count (expandable list)
   - Image candidates as thumbnail grid (reuse ImagePreviewGrid style)
   - Page structure signals as badge pills
   - Screenshot (shown as an img if the path can be resolved, or a placeholder)
   - Warnings list
6. Error state when worker unavailable

### Proposals tab:
1. List of profile generations for this domain (from governance.generations)
2. Each generation row: status badge, confidence, date, source URL
3. Clicking a generation opens it in the embedded ProfileGenerationReview
4. "Generate new proposal" button (calls existing generate endpoint)
5. Embedded `<ProfileGenerationReview generationId={selectedGenerationId} governance={governance} onChange={reload} onClose={() => setSelectedGenerationId(null)} />` when a generation is selected

### Validation tab:
1. Summary cards showing: total samples, confirmed samples, passing/failing samples
2. "Run validation across samples" button (calls `validateProfileDraft` using the latest generation's selectors and the domain's confirmed samples)
3. Results table (per-sample): URL, confirmed status, per-field status (pass/warning/fail), warnings
4. Image previews section for image selector samples
5. **Promote to healthy gate**: a section at the bottom that shows:
   - Checklist: "≥2 confirmed samples passing", "Image previews reviewed", "No failing title samples"
   - Each item checked or unchecked based on validation results
   - "Promote to healthy" button (disabled until all checks pass)
   - This buttons calls the existing generation approval endpoint

**Important patterns:**
- Use the same styled-components or inline styles as the existing onboarding UI (look at PipelineBoard.tsx, OnboardingSettings.tsx for patterns)
- Use the existing `domainHealthBadgeStyle` from OnboardingSettings for health badge rendering
- For the screenshot: artifact refs are file paths, not URLs. Show a placeholder with the file path text. A future task will add an artifact-serving route.
- The "Generate profile proposal" button should use the existing `/settings/domain-diagnostics/${domain}/generate-profile` POST endpoint via `request()`.
- The worker snapshot/validate buttons should call `snapshotPageForBuilder` and `validateProfileDraft` from the onboarding-api.

**DO NOT modify any existing files. Only create the new file.**

## Style and patterns
- Use React functional components with hooks
- Follow the existing code style in the project (look at similar components)
- Use inline styles or the CSS module approach used by other onboarding components
- Keep the component focused on the domain-scoped view — it's a workspace for one domain at a time

## Validation
- `bun run typecheck` passes with zero errors  
- No existing files were modified
- The component renders and compiles cleanly

## Handoff
Report the file created, line count, any issues found, and typecheck result.

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