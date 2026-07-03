```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Comprehensive dead code map written to output path. All 8 selector state variables, 3 orphaned functions, 3 dead imports, and all reference sites enumerated with exact line numbers and removal guidance."
    }
  ],
  "changedFiles": [
    "No files changed (scout-only task)"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "grep across src/client for selector-related identifiers",
      "result": "passed",
      "summary": "Confirmed all selector references are isolated to Onboarding.tsx dead paths"
    },
    {
      "command": "Read and analyzed Onboarding.tsx (1271 lines) and PipelineBoard.tsx (1775 lines)",
      "result": "passed",
      "summary": "Verified full dead code extent and confirmed PipelineBoard has independent review drawer with no selector editor"
    }
  ],
  "validationOutput": [
    "All 8 selector state variables (lines 70-77) have zero reads from rendered JSX or props",
    "testingSelectors state is never read anywhere — only set in dead handleTestSelectors",
    "handleTestSelectors and handleSaveSelectorProfile are never wired to any JSX event handler",
    "testExtractorProfile API function is dead system-wide (only referenced in dead handleTestSelectors in Onboarding.tsx)",
    "Entire old review drawer (lines 426-710) is orphaned. Migration to PipelineBoard.tsx is complete."
  ],
  "residualRisks": [
    "If the selector editor is ever needed again, it must be rebuilt inside PipelineBoard.tsx. The old code in Onboarding.tsx should not be reused as-is.",
    "testExtractorProfile API function (in onboarding-api.ts) may be entirely removable system-wide if no external consumers exist.",
    "Removing only the selector dead code (lines 501-574) from the import/state/functions without removing the parent orphaned functions (handleOpenReview etc.) would leave dangling references (setSelectorTestResults, loadSelectorProfileForUrl calls). In practice those parent functions are also dead so the code would never execute, but a full cleanup should remove the entire orphaned block (lines 426-710)."
  ],
  "noStagedFiles": true,
  "diffSummary": "No changes made (scout-only mapping task). Output artifact written to .pi-subagents/artifacts/outputs/b221a255-8448-442c-8bd0-7eea6637271a/scout-onboarding-deadcode.md",
  "reviewFindings": [
    "no blockers: dead code mapping complete with exact line-level precision",
    "info: testExtractorProfile appears to be dead system-wide — verify before removing from onboarding-api.ts",
    "info: lines 426-710 in Onboarding.tsx should be removed as a block in the cleanup PR — the selector dead code is a subset of this larger orphaned block"
  ],
  "manualNotes": "The selector dead code is a subset of a larger orphaned block (the old review drawer). When performing cleanup, recommend removing lines 426-710 as one unit rather than patching individual lines. PipelineBoard.tsx has its own complete review drawer with independent state management."
}
```