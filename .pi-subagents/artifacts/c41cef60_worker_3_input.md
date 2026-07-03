# Task for worker

[Read from: /Users/nickborrello/Desktop/Projects/shopsite-cms/context.md, /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Handle unused exports from `src/onboarding/` and `src/client/`.

These are genuinely unused exports. Fix them.

Files in `src/onboarding/`:
- `src/onboarding/job-queue.ts` — unused: normalizeDiscoveryDomain, isOfficialDomainMatch, getOfficialDomainsForBrand
- `src/onboarding/lcs-extractor.ts` — unused: stripSiteSuffix
- `src/onboarding/llm-client.ts` — unused: callLlm, LmConfig type (the task-routing versions are used instead)
- `src/onboarding/page-extractor.ts` — unused: extractViaHttp
- `src/onboarding/product-curator.ts` — unused: extractPackagingTitle, finalizeTitle, classifyProduct
- `src/onboarding/profile-generator.ts` — unused: buildVariantOptionCandidates, MIN_MULTI_SAMPLE_PASS
- `src/onboarding/profile-governance-service.ts` — unused: markGenerationValidated, markGenerationRejected, listAllActiveProfiles, RejectRevisionFieldsResult type, RollbackProfileFieldInput type, RollbackProfileFieldResult type
- `src/onboarding/shopify-json.ts` — unused: PRODUCT_JSON_ASSIGNMENT_PATTERNS, findObjectEnd, collectProductJsonCandidates, ProductJsonCandidate type
- `src/onboarding/sitemap-fetcher.ts` — unused: SitemapFetchResult type
- `src/onboarding/spreadsheet-parser.ts` — unused: ParsedSpreadsheet type
- `src/onboarding/sse-emitter.ts` — unused: OnboardingEvent type
- `src/onboarding/vlm-client.ts` — unused: VlmConfig type

Files in `src/client/`:
- `src/client/api.ts` — unused exports: listProductTypes, getProductType, createProductType, deleteProductType, upsertProductTypeField, deleteProductTypeField, listPages, upsertPage, deletePage, getProductPages, saveProductPages
- `src/client/onboarding-api.ts` — unused: completeReviewStage, deleteBrandSite, saveExtractorProfile, deleteExtractorProfile, getClassificationConfig, migrateLegacyClassification, validateProfileDraft, getDomainDiagnosticsForDomain
- `src/client/components/ElementPickerButton.tsx` — unused: `default` export (the component is already exported as named export; remove the duplicate default)
- `src/client/components/ProfileBuilderWorkspace.tsx` — unused: `default` export (same pattern)
- `src/client/components/ProfileExtractionPreview.tsx` — unused: `default` export (same)
- `src/client/components/ProfileProposalDrawer.tsx` — unused: `default` export (same)
- `src/client/components/ProfileRetryPreview.tsx` — unused: `default` export (same)
- `src/client/components/ProfileRevisionFeedbackForm.tsx` — unused: TEXT_FIELDS (the re-export), `default` export

Strategy:
For types: add `// fallow-ignore-next-line unused-type` before them.
For functions: remove the `export` keyword (making them local).
For `default` exports: remove the `export default` line (the named export is sufficient).
For TEXT_FIELDS re-export: remove the re-export line `export { TEXT_FIELDS }` but keep the original const.

Verify with `bun run typecheck` and then `bun run test`.}

---
Update progress at: /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/progress/c41cef60/progress.md

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