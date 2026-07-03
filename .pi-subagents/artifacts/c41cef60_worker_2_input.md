# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Handle unused exports from `src/server/` and `src/db/repositories/`.

These are genuinely unused exports. Auto-fix them with `fallow fix --yes` targeting these specific files.

Files in `src/server/`:
- `src/server/extraction-worker-client.ts` — unused exports: proposeProfile, trustedExtract, submitWorkerJob, getWorkerJobStatus
- `src/server/services/product-service.ts` — unused: DEFAULT_HEALTH_RULES, getHealthRulesRecord, DraftOverlay, BulkImportItem, BulkImportResult, CatalogHealthReport, HealthRuleConfig, HealthConfig
- `src/server/services/workspace-service.ts` — unused: saveRecentWorkspaces, addRecentWorkspace, autoLoadLastWorkspace, backfillProductIndex, RecentWorkspace
- `src/server/services/sync-service.ts` — unused: BootstrapResult

Files in `src/db/repositories/`:
- `src/db/repositories/audit-log-repo.ts` — unused: listAuditLogs
- `src/db/repositories/change-set-repo.ts` — unused: deleteChangeSetItem
- `src/db/repositories/classification-config-repo.ts` — unused: listConfigFiles, getCachedGuidance, getCachedModelPolicy
- `src/db/repositories/classification-run-repo.ts` — unused: getRecentRun, getRun, getEvidenceBySku, getProposalsBySku, getDecisionsByProposal, getHistoryBySku
- `src/db/repositories/drift-repo.ts` — unused: findBlockingDriftForSku
- `src/db/repositories/llm-task-config-repo.ts` — unused: LLM_PROVIDERS (but keep the type exports)
- `src/db/repositories/onboarding-batch-repo.ts` — unused: getBatchStageDistribution, updateBatchStatus, incrementBatchCounters
- `src/db/repositories/onboarding-extraction-repo.ts` — unused: listExtractionsByItem
- `src/db/repositories/onboarding-item-repo.ts` — unused: PIPELINE_STAGES, mapRowToItem, updateItemStatus, updateItemSourceUrl, updateItemExtractionData, updateItemCurationData, countItemsByStatus, getNextPendingItems
- `src/db/repositories/page-repo.ts` — unused: getPageByName, unassignProductFromPage, getPageProducts
- `src/db/repositories/product-index-repo.ts` — unused: updateProductSyncStatus, deleteProductIndex
- `src/db/repositories/profile-generation-field-decision-repo.ts` — unused: PROFILE_GENERATION_FIELD_DECISIONS
- `src/db/repositories/profile-generation-repo.ts` — unused: PROFILE_GENERATION_STATUSES
- `src/db/repositories/profile-generation-revision-repo.ts` — unused: PROFILE_GENERATION_REVISION_STATUSES, PROFILE_GENERATION_REVISION_SOURCES, PROFILE_GENERATION_VALIDATION_STATUSES
- `src/db/repositories/validation-repo.ts` — unused: listValidationResultsByScope
- `src/db/repositories/workspace-repo.ts` — unused: findWorkspaceById

Strategy: Read each file, find each unused export, and either:
- Remove the `export` keyword (for functions) — making them local
- Add `// fallow-ignore-next-line unused-export` before the line (for constants that might be needed later)
- Delete the function entirely if it's truly dead code

Be conservative — if an export might be needed by future code, just suppress it rather than deleting.

Verify with `bun run typecheck` and `bun run test src/tests/unit/` for the affected repo tests.

IMPORTANT: Do NOT touch `src/db/driver.ts` (createDatabase is used externally).

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