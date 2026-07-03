# Task for worker

## Task 5: Onboarding Settings tab restructure

Read `src/client/components/OnboardingSettings.tsx` fully (~1606 lines). This is a single-page settings view with sequential sections. Convert it to a tabbed layout.

**Read the entire file first.** The sections are:
1. Header/back button area
2. Source Discovery (Serper API key setup)
3. LLM Providers
4. AI Model Routing
5. Curation Targets
6. Domain Configuration (domain diagnostics table + detail panels — now includes worker health, profile health column, Open Profile Builder button from Task 3)

**Changes:**

1. **Add a settingsTab state**: `const [settingsTab, setSettingsTab] = useState<'general' | 'llm' | 'curation' | 'profiles'>('general')`
   Stick it near the existing state declarations.

2. **Add a tab bar** between the header/back area and the content sections. Use a simple horizontal tab bar matching the app's style:
```tsx
<div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid #dee2e6' }}>
  {[
    { id: 'general', label: 'General' },
    { id: 'llm', label: 'LLM Providers' },
    { id: 'curation', label: 'Curation' },
    { id: 'profiles', label: 'Extractor Profiles' },
  ].map(tab => (
    <button
      key={tab.id}
      onClick={() => setSettingsTab(tab.id as any)}
      style={{
        padding: '10px 20px',
        border: 'none',
        background: settingsTab === tab.id ? '#fff' : 'transparent',
        borderBottom: settingsTab === tab.id ? '2px solid #007bff' : '2px solid transparent',
        fontWeight: settingsTab === tab.id ? 600 : 400,
        cursor: 'pointer',
        fontSize: 14,
        color: settingsTab === tab.id ? '#007bff' : '#495057',
      }}
    >
      {tab.label}
    </button>
  ))}
</div>
```

3. **Wrap each section in a conditional render** based on `settingsTab`:
   - `<div style={{ display: settingsTab === 'general' ? 'block' : 'none' }}>...</div>` around General content (Serper section)
   - LLM Providers + AI Model Routing sections together under `settingsTab === 'llm'`
   - Curation Targets under `settingsTab === 'curation'`
   - Domain Configuration (the entire Domain Configuration block with worker health indicator, domain diagnostics table, Profile Health column, Open Profile Builder, etc.) under `settingsTab === 'profiles'`

4. **Make sure existing state/handlers still work** — the sections use the same state variables regardless of which tab is active. Only the rendering visibility changes.

5. **Keep the Proposal Drawer overlay** — it's unrelated to tabs and should still render at the bottom of the component when triggered.

## Critical rules
- The existing sections should appear in their entirety under the correct tab — do NOT modify section content
- Only add tab state + tab bar + visibility wrappers
- If something appears OUTSIDE the main sections (like the Domain Configuration section might span multiple areas), carefully determine which tab it belongs to
- Verify with `bun run typecheck` that the file still compiles

## Validation
- `bun run typecheck` passes with zero errors
- All existing functionality preserved - just wrapped in tab visibility

## Handoff
Report all changes, typecheck result, line counts.

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