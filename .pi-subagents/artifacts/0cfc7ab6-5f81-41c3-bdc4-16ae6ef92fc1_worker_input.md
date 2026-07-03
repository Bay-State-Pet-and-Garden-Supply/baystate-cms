# Task for worker

## Task 2: Pipeline Board extraction status badges + Onboarding wiring

Read these files:
- `src/client/components/PipelineBoard.tsx` — the Kanban board
- `src/client/components/Onboarding.tsx` — the parent onboarding page
- `src/client/components/ProfileBuilderWorkspace.tsx` — the new workspace component (created in Task 1)
- `src/client/onboarding-api.ts` — API functions

## Changes needed

### 1. `src/client/components/PipelineBoard.tsx`

**a) Add a new prop to PipelineBoardProps:**
```tsx
onOpenProfileBuilder?: (domain: string, item: OnboardingItem) => void;
```

**b) Add a helper function at the top of the file:**
```tsx
function deriveProfileFailReason(errorMessage: string | null): 'no_profile' | 'ambiguous_match' | 'structure_mismatch' | null {
  if (!errorMessage) return null;
  if (/no (healthy )?profile/i.test(errorMessage) || /profile.*required/i.test(errorMessage)) return 'no_profile';
  if (/ambiguous/i.test(errorMessage)) return 'ambiguous_match';
  if (/structure.*mismatch|page.*structure.*signal/i.test(errorMessage)) return 'structure_mismatch';
  return null;
}
```

**c) In the card rendering (find where errorMessage is displayed), add badge rendering:**
- When `item.stage === 'extraction'` and `item.stageStatus === 'failed'`, derive the profile fail reason
- For `no_profile`: show an amber pill "⚠ Profile required" next to the error, plus a clickable "Open Profile Builder →" link
- For `ambiguous_match`: show an orange pill "⚠ Ambiguous match"
- For `structure_mismatch`: show a red pill "⚠ Structure mismatch"
- Keep existing `errorMessage` display for unmatched cases

**d) Extract domain from the item:**
```tsx
const itemDomain = item.sourceUrl ? new URL(item.sourceUrl).hostname.replace(/^www\./, '') : item.brandHint || '';
```

**e) Pass the callback when clicking "Open Profile Builder →":**
```tsx
{onOpenProfileBuilder && (
  <a href="#" onClick={(e) => { e.preventDefault(); onOpenProfileBuilder(itemDomain, item); }}>Open Profile Builder →</a>
)}
```

### 2. `src/client/components/Onboarding.tsx`

Read this file fully to understand how it renders PipelineBoard and other components.

**Changes:**
- Add import for ProfileBuilderWorkspace
- Add state: `const [profileBuilderDomain, setProfileBuilderDomain] = useState<string | null>(null)`
- Add state: `const [profileBuilderSeed, setProfileBuilderSeed] = useState<{ url?: string; item?: any } | null>(null)`
- When rendering PipelineBoard, pass `onOpenProfileBuilder={(domain, item) => { setProfileBuilderDomain(domain); setProfileBuilderSeed({ item }); }}`
- When `profileBuilderDomain` is set, render `<ProfileBuilderWorkspace>` as an overlay:
```tsx
{profileBuilderDomain && (
  <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ background: '#fff', borderRadius: 12, width: '90vw', height: '90vh', overflow: 'auto', padding: 24 }}>
      <ProfileBuilderWorkspace
        domain={profileBuilderDomain}
        onClose={() => { setProfileBuilderDomain(null); setProfileBuilderSeed(null); }}
        seedSampleUrl={profileBuilderSeed?.url}
        seedItem={profileBuilderSeed?.item}
      />
    </div>
  </div>
)}
```

## Constraints
- Do NOT modify the card layout structure — only add the badge near the error message
- Find the exact rendering location by looking for errorMessage display in PipelineBoard.tsx renderCard
- Keep existing errorMessage text visible; the badge is an addition, not a replacement
- Follow existing code style

## Validation
1. `bun run typecheck` passes with zero errors
2. No other existing files are modified

## Handoff
Report all changes, typecheck result, and any issues.

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