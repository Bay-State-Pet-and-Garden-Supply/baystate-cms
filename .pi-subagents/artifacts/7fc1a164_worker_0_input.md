# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Fix the ProfileBuilderWorkspace modal wrapper in OnboardingSettings.tsx.

File: `src/client/components/OnboardingSettings.tsx`

The current wrapper around ProfileBuilderWorkspace (lines ~1268-1280) nests a fixed-position component inside another fixed-position scrollable div. This breaks the internal z-indexing and layout of the ProfileBuilderWorkspace (which uses its own `position: fixed` overlay and modal with `inset: 0`).

Current broken code:
```tsx
      {/* ── Profile Builder Workspace Overlay ── */}
      {workspaceDomain && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '90vw', height: '90vh', overflow: 'auto', padding: 24 }}>
            <ProfileBuilderWorkspace
              domain={workspaceDomain}
              onClose={() => setWorkspaceDomain(null)}
            />
          </div>
        </div>
      )}
```

Replace with just the ProfileBuilderWorkspace directly (it already renders its own overlay and modal with `position: fixed`):
```tsx
      {/* ── Profile Builder Workspace Overlay ── */}
      {workspaceDomain && (
        <ProfileBuilderWorkspace
          domain={workspaceDomain}
          onClose={() => setWorkspaceDomain(null)}
        />
      )}
```

This matches how it's rendered in `Onboarding.tsx` at line 1172.

Read the file to find the exact text to match, then make the edit.

Verify with `bun run typecheck`.

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