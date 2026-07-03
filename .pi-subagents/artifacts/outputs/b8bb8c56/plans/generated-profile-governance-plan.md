# Implementation Plan

## Goal
Implement domain-level generated-profile governance where AI selector proposals are versioned, validated, revised by structured store-manager feedback, and promoted per field only after explicit human approval, with task-specific LLM routing.

## Current Code Findings
- **high: `src/onboarding/profile-generator.ts`** - `generateExtractorProfile()` still uses generic `getLlmConfig()`/`callLlm()`. This violates decisions 15-19 because profile generation must use explicit `profile_generation` task config and fail closed if missing.
- **high: `src/onboarding/page-extractor.ts`** - the recent direct edit appears to prevent generated selectors from affecting current extraction, but the helper is still named/commented as an in-memory retry and returns `MaybeRetryOutcome`. This should be refactored to proposal-only semantics and covered by tests.
- **high: `src/db/repositories/onboarding-source-repo.ts`** - `listValidationSamplesByDomain()` currently falls back to high-confidence non-selected sources and uses broad `%domain%` matching. Decision 8 requires selected/confirmed source URLs with expected product names; matching should be exact/suffix-safe.
- **medium: `src/onboarding/profile-promoter.ts`** - per-field approval is implemented, but decisions/revisions are stored in `profile_generations.validation` JSON. Decision 14 requires normalized revision and field-decision tables, and per-field rollback needs previous selector snapshots.
- **medium: `src/onboarding/profile-generator.ts`** - `GeneratedProfileValidation.canPromote` and `MultiSampleValidationResult.canAutoPromote` remain. These names conflict with the approval-required invariant and should be replaced with review-readiness terminology after API/UI consumers are updated.
- **medium: `src/client/components/OnboardingSettings.tsx`** - active profile CRUD exists, but there is no generated-profile queue, revision UI, per-field validation table, image preview review, task-model config UI, or rollback surface.
- **low: `src/onboarding/profile-generator.ts`** - `applyGeneratedProfileToCheerio()` is no longer used by `page-extractor.ts`. Keep it only if renamed/reused by the governance validation service; otherwise remove its export/tests.

## Tasks

### Phase 0 — Enforce proposal-only extraction semantics

1. **Refactor generated profile integration from retry to proposal creation**
   - File: `src/onboarding/page-extractor.ts`
   - Changes:
     - Rename `maybeRetryWithGeneratedProfile()` to `maybeCreateGeneratedProfileProposal()`.
     - Replace `MaybeRetryOutcome` with a void/summary result such as `{ proposalCreated: boolean; generationId?: string }`.
     - Remove all `usedRetry` return branches from HTTP and Playwright paths; callers should always return the original deterministic extraction result.
     - Update comments to state generated selectors are never applied until approved.
     - Keep audit insertion of `profile_generations` rows for generated/validated/rejected proposals.
   - Acceptance:
     - Generated selectors cannot alter `ExtractionData` in the current run.
     - Logs say “proposal validated/created; awaiting approval,” never “retry applied.”

2. **Add regression test for decision 20**
   - File: `src/tests/unit/page-extractor-profile-generation.test.ts` or extend existing page-extractor profile-generation tests if present.
   - Changes:
     - Mock LLM/generator to propose a selector that would change title/description/images.
     - Enable `SHOPSITE_CMS_PROFILE_GENERATION_ENABLED`.
     - Verify extraction output remains the original deterministic output while an audit row is inserted/updated.
   - Acceptance:
     - Test fails if generated custom selectors are applied in memory.

3. **Clean review-readiness naming in generator validation**
   - File: `src/onboarding/profile-generator.ts`
   - Changes:
     - Replace `GeneratedProfileValidation.canPromote` with `readyForReview` or `eligibleForReview`.
     - Remove or deprecate `canAutoPromote` after checking all usages; prefer removing it in this implementation since no real external caller exists in repo.
     - Update tests in `src/tests/unit/profile-generator.test.ts`.
   - Acceptance:
     - `grep -R "canAutoPromote\|canPromote\|auto-promote" src` has no production code references except historical test descriptions/docs explicitly saying auto-promote is forbidden.

### Phase 1 — Database schema and repositories for governance history

4. **Add normalized governance tables**
   - File: `src/db/migrations.ts`
   - Changes:
     - Create `profile_generation_revisions`:
       - `id TEXT PRIMARY KEY`
       - `generation_id TEXT NOT NULL REFERENCES profile_generations(id) ON DELETE CASCADE`
       - `revision_number INTEGER NOT NULL`
       - `parent_revision_id TEXT REFERENCES profile_generation_revisions(id)`
       - `source TEXT NOT NULL` (`initial_generation`, `manager_feedback`, `manual_css`, `system_validation`)
       - `feedback_json TEXT`
       - `selectors_json TEXT NOT NULL`
       - `field_samples_json TEXT`
       - `validation_summary_json TEXT`
       - `status TEXT NOT NULL` (`draft`, `validated`, `rejected`, `superseded`)
       - `confidence REAL NOT NULL DEFAULT 0`
       - `llm_task TEXT`
       - `llm_provider TEXT`
       - `llm_model TEXT`
       - `error_message TEXT`
       - `created_at TEXT NOT NULL`
       - `updated_at TEXT NOT NULL`
     - Create `profile_generation_validation_results` for per-revision/per-field/per-sample evidence:
       - `id TEXT PRIMARY KEY`
       - `revision_id TEXT NOT NULL REFERENCES profile_generation_revisions(id) ON DELETE CASCADE`
       - `selector_field TEXT NOT NULL`
       - `sample_url TEXT NOT NULL`
       - `item_id TEXT`
       - `expected_name TEXT`
       - `brand_hint TEXT`
       - `extracted_value_json TEXT`
       - `image_previews_json TEXT`
       - `warnings_json TEXT`
       - `status TEXT NOT NULL` (`pass`, `warning`, `fail`)
       - `created_at TEXT NOT NULL`
     - Create `profile_generation_field_decisions`:
       - `id TEXT PRIMARY KEY`
       - `generation_id TEXT NOT NULL REFERENCES profile_generations(id) ON DELETE CASCADE`
       - `revision_id TEXT REFERENCES profile_generation_revisions(id)`
       - `domain TEXT NOT NULL`
       - `selector_field TEXT NOT NULL`
       - `decision TEXT NOT NULL` (`approved`, `rejected`, `rolled_back`)
       - `previous_selector TEXT`
       - `proposed_selector TEXT`
       - `approved_selector TEXT`
       - `feedback_json TEXT`
       - `validation_result_ids_json TEXT`
       - `decided_at TEXT NOT NULL`
       - `decided_by TEXT`
       - `notes TEXT`
     - Add indexes by `generation_id`, `revision_id`, `(domain, selector_field)`, and `(domain, decision)`.
   - Acceptance:
     - Migrations are idempotent for fresh and existing DBs.
     - Tables support revision history, per-field decisions, image validation evidence, and rollback.

5. **Add governance repositories**
   - New Files:
     - `src/db/repositories/profile-generation-revision-repo.ts`
     - `src/db/repositories/profile-generation-field-decision-repo.ts`
   - Changes:
     - Add typed interfaces and JSON round-trip helpers.
     - Revision repo functions:
       - `insertProfileGenerationRevision(input)`
       - `findProfileGenerationRevisionById(id)`
       - `listRevisionsByGeneration(generationId)`
       - `updateProfileGenerationRevisionStatus(id, status, fields?)`
       - `insertRevisionValidationResults(revisionId, results)`
       - `listValidationResultsByRevision(revisionId)`
     - Field decision repo functions:
       - `insertProfileFieldDecision(input)`
       - `listFieldDecisionsByDomain(domain)`
       - `listFieldDecisionsByGeneration(generationId)`
       - `findFieldDecisionById(id)`
       - `findLatestApprovedFieldDecision(domain, selectorField)`
   - Acceptance:
     - JSON fields round-trip.
     - Domain normalization matches `extractor-profile-repo.ts`.
     - Tests cover insert/list/update/history ordering.

6. **Update old JSON-based promoter audit to use normalized decisions**
   - File: `src/onboarding/profile-promoter.ts`
   - Changes:
     - Keep `promoteGeneratedProfile(generationId, approvedFields)` as a compatibility wrapper only if useful, but internally resolve the latest validated revision and write normalized `profile_generation_field_decisions` rows.
     - Capture `previous_selector` from `findProfileByDomain(domain)` before `upsertProfile()`.
     - Remove approval/rejection appends into `profile_generations.validation.approvals` except possibly a small compatibility summary.
     - Remove global title requirement when approving non-title fields; require only that each approved field has a proposed selector and passes field-specific gates.
   - Acceptance:
     - Per-field approval produces a field decision row with old/new selector values.
     - Existing unapproved fields in `extractor_profiles` are preserved.
     - Tests prove approving images requires explicit `imagesSelector: true` and required validation evidence.

7. **Add rollback service**
   - File: `src/onboarding/profile-promoter.ts` or new `src/onboarding/profile-governance-service.ts`
   - Changes:
     - Add `rollbackProfileField(decisionId)` or `rollbackProfileField(domain, selectorField, decisionId)`.
     - Read `previous_selector` from the approved decision.
     - Call merge-style `upsertProfile(domain, { [selectorField]: previousSelectorOrNull })`.
     - Insert a `rolled_back` field decision row.
   - Acceptance:
     - Rollback restores the previous field and does not alter unrelated fields.

8. **Add repository tests**
   - New Files:
     - `src/tests/unit/profile-generation-revision-repo.test.ts`
     - `src/tests/unit/profile-generation-field-decision-repo.test.ts`
   - Changes:
     - Use isolated SQLite DBs with `runMigrations()`.
     - Cover revisions, validation results, field decisions, and rollback data.
   - Acceptance:
     - Add DB-dependent tests to `package.json` explicit `bun test` list and `vitest.config.ts` excludes.

### Phase 2 — Task-specific LLM routing

9. **Add `llm_task_configs` schema and repo**
   - Files:
     - `src/db/migrations.ts`
     - New: `src/db/repositories/llm-task-config-repo.ts`
   - Changes:
     - Create table:
       - `id TEXT PRIMARY KEY`
       - `task TEXT NOT NULL UNIQUE`
       - `provider TEXT NOT NULL` (`deepseek`, `openai`, `ollama`)
       - `model TEXT NOT NULL`
       - `base_url_override TEXT`
       - `temperature REAL`
       - `created_at TEXT NOT NULL`
       - `updated_at TEXT NOT NULL`
     - Add task union/constants:
       - `product_name_consolidation`
       - `profile_generation`
       - `profile_revision`
       - `product_curation`
       - `category_classification`
       - optional `classification_evidence_extraction`
     - Repo functions: `upsertLlmTaskConfig`, `getLlmTaskConfig`, `listLlmTaskConfigs`, `deleteLlmTaskConfig`.
   - Acceptance:
     - Provider credentials stay in `api_keys`; task rows only route to provider/model.

10. **Refactor LLM client for task routing**
    - File: `src/onboarding/llm-client.ts`
    - Changes:
      - Add `LlmTask` type and `PROFILE_TASKS_REQUIRE_EXPLICIT = new Set(['profile_generation', 'profile_revision'])`.
      - Add `getLlmConfigForTask(task, options?)`:
        - If task config exists, resolve provider credentials via `api_keys` and task model/base override.
        - If missing and `allowFallback` true, return existing generic `getLlmConfig()`.
        - If missing and task is profile generation/revision, return `null` or throw a specific `MissingLlmTaskConfigError`.
      - Add `callLlmForTask(task, prompt, systemPrompt, options?)` that uses task config and preserves Ollama serialization.
      - Keep `getLlmConfig()`/`callLlm()` temporarily for legacy callers, but mark as generic fallback.
    - Acceptance:
      - Profile tasks fail closed without explicit `llm_task_configs` rows.
      - Product name consolidation can fall back to generic config/LCS.

11. **Update current LLM callers to task routing**
    - Files:
      - `src/onboarding/profile-generator.ts`
      - `src/onboarding/llm-client.ts`
      - `src/onboarding/product-curator.ts`
      - `src/classification/stages/evidence-extraction.ts`
      - `src/classification/stages/primary-product-type.ts`
      - `src/onboarding/page-extractor.ts`
    - Changes:
      - `generateExtractorProfile()` uses `callLlmForTask('profile_generation', ..., { allowFallback: false })`.
      - New profile revision function uses `callLlmForTask('profile_revision', ..., { allowFallback: false })`.
      - `consolidateProductName()` uses `product_name_consolidation` with fallback allowed.
      - Curation/classification callers use their task keys with fallback allowed initially unless product later decides fail-closed.
      - `page-extractor.ts` audit metadata uses `getLlmConfigForTask('profile_generation', { allowFallback: false })`.
    - Acceptance:
      - No production profile-generation path calls generic `getLlmConfig()`.
      - Missing profile task config creates a failed/proposed audit row and does not call a fallback model.

12. **Add LLM task routing tests**
    - New File: `src/tests/unit/llm-task-config-repo.test.ts`
    - Modify: `src/tests/unit/profile-generator.test.ts`, `src/tests/unit/deterministic-json.test.ts` or new `src/tests/unit/llm-client-task-routing.test.ts`
    - Changes:
      - Test task config CRUD.
      - Test profile generation fails closed without explicit task config.
      - Test consolidation falls back to generic config/LCS.
      - Mock fetch for `callLlmForTask`.
    - Acceptance:
      - Tests prove DeepSeek can be configured for profile generation while Ollama can be configured for consolidation.

### Phase 3 — Domain profile governance service and API

13. **Build governance service layer**
    - New File: `src/onboarding/profile-governance-service.ts`
    - Changes:
      - `listDomainProfileGovernance(domain)` returns active profile, generations, revisions, latest decisions, validation samples count.
      - `createInitialRevisionForGeneration(generationId)` backfills revision 1 from existing `profile_generations.selectors_json` for compatibility.
      - `reviseProfileFromStructuredFeedback(input)`:
        - Accepts field-level feedback such as expected text, image include/exclude URLs, notes, previous revision ID.
        - Calls `profile_revision` task config, not `profile_generation`.
        - Creates a new revision with parent link and validation summary.
      - `validateRevisionAcrossConfirmedSamples(revisionId, domain)`:
        - Uses selected/confirmed samples only.
        - Fetches HTML with `HTTP_EXTRACTION_HEADERS`.
        - Stores per-field/per-sample validation results and image previews.
      - `approveRevisionFields(input)`:
        - Enforces per-field gates.
        - Text fields: allow 1 sample with warning; prefer 2+.
        - Images: require 2+ passing same-domain samples, previews, and explicit reviewed-image checkbox.
        - Price: warning when missing or brand/manufacturer page has no price.
      - `rejectRevisionFields(input)` records field decision rows without writing active profile.
      - `rollbackProfileField(input)` delegates to rollback logic.
    - Acceptance:
      - Business rules are centralized outside route/UI code.

14. **Fix validation sample selection policy**
    - File: `src/db/repositories/onboarding-source-repo.ts`
    - Changes:
      - Change `listValidationSamplesByDomain()` to selected/confirmed sources only: `s.is_selected = 1` or exact item `source_url` that matches source URL.
      - Use exact normalized domain or suffix match (`domain = ? OR domain LIKE '%.domain'`) instead of `%domain%`.
      - Deduplicate URLs.
      - Include `item_id`, `expected_name` preference if available, `name` fallback, and `brand_hint`.
    - Acceptance:
      - Random discovered/high-confidence but unselected URLs are excluded.
      - `notmywoof.com` cannot match `mywoof.com`.

15. **Add governance API routes**
    - File: `src/server/routes/onboarding-routes.ts`
    - Changes:
      - LLM task config routes:
        - `GET /onboarding/settings/llm-task-configs`
        - `PUT /onboarding/settings/llm-task-configs/:task`
        - `DELETE /onboarding/settings/llm-task-configs/:task`
      - Domain profile governance routes:
        - `GET /onboarding/settings/profile-governance/:domain`
        - `GET /onboarding/settings/profile-generations?domain=&status=`
        - `GET /onboarding/settings/profile-generations/:id`
        - `POST /onboarding/settings/profile-generations/:id/revisions`
        - `POST /onboarding/settings/profile-generations/:id/revisions/:revisionId/validate`
        - `POST /onboarding/settings/profile-generations/:id/revisions/:revisionId/decisions`
        - `POST /onboarding/settings/profile-field-decisions/:decisionId/rollback`
      - Validate request bodies with Zod schemas from shared onboarding schemas.
    - Acceptance:
      - No UI calls DB directly; routes expose all governance actions.

16. **Update client API layer**
    - File: `src/client/onboarding-api.ts`
    - Changes:
      - Add TypeScript interfaces for task configs, revisions, validation results, field decisions, structured feedback, and domain governance responses.
      - Add functions for all new routes.
    - Acceptance:
      - UI components can be typed without duplicating server response shapes.

17. **Add shared schemas/types**
    - File: `src/shared/schemas/onboarding.ts`
    - Changes:
      - Add `LlmTaskEnum`, `LlmTaskConfigSchema`.
      - Add `SelectorFieldEnum` for the five selector fields.
      - Add schemas for profile generation revision, validation result, field decision, structured feedback, approval request, rollback request.
      - Keep `ExtractorProfileSchema` unchanged as the active trusted profile shape.
    - Acceptance:
      - Server/client share the governance API contract.

18. **Add API/service tests**
    - New/Modified Tests:
      - `src/tests/unit/profile-governance-service.test.ts`
      - `src/tests/unit/onboarding-repos.test.ts`
      - optional route tests if existing route test harness exists.
    - Changes:
      - Cover selected-sample policy, image gating, text one-sample warning, approvals, rejections, rollback, and revision creation.
    - Acceptance:
      - Backend rules are tested without requiring UI.

### Phase 4 — Domain settings UI for generated profile governance

19. **Add task-specific model settings UI**
    - Files:
      - `src/client/components/OnboardingSettings.tsx`
      - New: `src/client/components/LlmTaskConfigPanel.tsx`
    - Changes:
      - Show provider credential cards separately from task routing.
      - Add task rows for `product_name_consolidation`, `profile_generation`, `profile_revision`, `product_curation`, `category_classification`.
      - For profile generation/revision, show “Required” and validation error if missing.
      - Allow product consolidation to choose Ollama and profile generation/revision to choose DeepSeek.
    - Acceptance:
      - Store manager can configure model routing without duplicating API keys.

20. **Add generated profile queue in domain settings**
    - Files:
      - `src/client/components/OnboardingSettings.tsx`
      - New: `src/client/components/GeneratedProfilesPanel.tsx`
      - New: `src/client/components/ProfileGenerationReview.tsx`
    - Changes:
      - Add a domain-scoped “Generated Profiles” section next to active profiles.
      - List proposals grouped by domain and status.
      - Show active `extractor_profiles` values and latest generated revisions.
      - Do not place approval controls in product drawers; optionally future product UI can link to this domain settings page.
    - Acceptance:
      - Profiles are managed by domain, not product item.

21. **Build per-field validation table**
    - New Files:
      - `src/client/components/ProfileFieldValidationTable.tsx`
      - `src/client/components/ImagePreviewGrid.tsx`
    - Changes:
      - For each selector field show: current selector, proposed selector, sample URL, expected/check, extracted value, warnings, pass/fail.
      - For images show thumbnails per sample, repeated-identical-image warnings, carousel/recommendation warnings, and an explicit “I reviewed image previews” checkbox.
      - Disable image approval until 2+ validated samples and preview checkbox are satisfied.
      - Text fields show warning if only one sample exists.
    - Acceptance:
      - UI enforces decisions 3, 7, 8, 9.

22. **Add structured feedback revision UI**
    - New File: `src/client/components/ProfileRevisionFeedbackForm.tsx`
    - Changes:
      - Field-specific controls:
        - Text: “This value should be ___”, “This extracted value is correct”, notes.
        - Images: mark correct/exclude per thumbnail, “find product-only images”, notes.
        - Price: “ignore price for this domain” or expected price note.
      - Advanced CSS editor hidden behind “Advanced: edit selector manually.”
      - Submit creates a new revision, never overwrites old revision.
    - Acceptance:
      - Store manager can correct AI without understanding CSS.

23. **Add per-field approval/rejection/rollback UI**
    - Files:
      - `src/client/components/ProfileGenerationReview.tsx`
      - `src/client/components/GeneratedProfilesPanel.tsx`
    - Changes:
      - Approval checkboxes/buttons per selector field.
      - Reject with reason per field.
      - Show previous selector, proposed selector, and diff.
      - Add rollback buttons for latest approved field decisions.
      - Confirmation copy should state approved fields write into active `extractor_profiles`.
    - Acceptance:
      - Approving title does not approve images.
      - Rollback restores prior field only.

24. **Update active profile UI**
    - File: `src/client/components/OnboardingSettings.tsx`
    - Changes:
      - Keep manual active profile table.
      - Add provenance/history links per field if decision rows exist.
      - Surface “pending proposal” counts per domain.
    - Acceptance:
      - Store manager can see which selectors are trusted active config vs pending AI proposal.

### Phase 5 — Cleanup, docs, and validation

25. **Rename or remove selector-application helper**
    - File: `src/onboarding/profile-generator.ts`
    - Changes:
      - If used by governance service, rename `applyGeneratedProfileToCheerio()` to `extractFieldsWithSelectorProfile()` and document it as validation-only.
      - If no longer used, remove export and tests.
    - Acceptance:
      - No implication that generated selectors are applied by extraction before approval.

26. **Remove stale auto-promotion terminology**
    - Files:
      - `src/onboarding/profile-generator.ts`
      - `src/tests/unit/profile-generator.test.ts`
      - docs/comments as needed.
    - Changes:
      - Remove `canPromote`/`canAutoPromote` names.
      - Use `readyForReview`, `fieldReadyForApproval`, or `hasSufficientEvidence`.
    - Acceptance:
      - Grep finds no misleading production names.

27. **Document governance workflow**
    - New File: `docs/generated-profile-governance.md`
    - Changes:
      - Document domain-level profiles, approval-required invariant, per-field approval, image validation rules, task-specific model routing, revision history, rollback.
    - Acceptance:
      - Future developers understand why auto-promotion and in-memory generated selector application are forbidden.

28. **Run validation commands**
    - Commands:
      - `bun run typecheck`
      - `bun run test`
      - `bunx vitest run src/tests/unit/profile-generator.test.ts src/tests/unit/page-extractor-images.test.ts src/tests/unit/page-extractor-variant-inference.test.ts`
      - `bun test src/tests/unit/profile-promoter.test.ts src/tests/unit/profile-generation-revision-repo.test.ts src/tests/unit/profile-generation-field-decision-repo.test.ts src/tests/unit/llm-task-config-repo.test.ts`
      - `bun run lint` if the environment supports the current lint setup.
    - Acceptance:
      - TypeScript and test suite pass.
      - Any lint failures are fixed or documented.

## Files to Modify
- `src/db/migrations.ts` - add `llm_task_configs`, profile revision, validation result, and field decision tables.
- `src/db/repositories/onboarding-source-repo.ts` - enforce selected/confirmed sample policy and safer domain matching.
- `src/db/repositories/profile-generation-repo.ts` - optionally add helpers to link/list latest revisions and expose proposal status summaries.
- `src/onboarding/llm-client.ts` - add task-specific routing and task-aware completion calls.
- `src/onboarding/profile-generator.ts` - use profile task config, remove promotion terminology, add revision prompt helpers or move to service.
- `src/onboarding/profile-promoter.ts` - switch approval/rollback auditing to normalized field decisions and enforce field gates.
- `src/onboarding/page-extractor.ts` - finish proposal-only refactor and use task-specific profile generation config for audit/generation.
- `src/onboarding/product-curator.ts` - route curation/name/title calls through task configs where appropriate.
- `src/classification/stages/evidence-extraction.ts` - route classification evidence LLM through task config.
- `src/classification/stages/primary-product-type.ts` - route classification LLM through task config.
- `src/server/routes/onboarding-routes.ts` - add LLM task config and generated-profile governance endpoints.
- `src/client/onboarding-api.ts` - add client functions/types for new endpoints.
- `src/client/components/OnboardingSettings.tsx` - integrate generated-profile queue and task model settings panels.
- `src/shared/schemas/onboarding.ts` - add shared governance and LLM task schemas.
- `package.json` - add new DB-dependent tests to explicit `bun test` list.
- `vitest.config.ts` - exclude new DB-dependent tests from vitest when they import `bun:sqlite` transitively.

## New Files
- `src/db/repositories/llm-task-config-repo.ts` - workspace-specific LLM task routing repository.
- `src/db/repositories/profile-generation-revision-repo.ts` - revision and validation-result persistence.
- `src/db/repositories/profile-generation-field-decision-repo.ts` - per-field approval/rejection/rollback persistence.
- `src/onboarding/profile-governance-service.ts` - central domain profile governance business rules.
- `src/client/components/LlmTaskConfigPanel.tsx` - UI for per-task model routing.
- `src/client/components/GeneratedProfilesPanel.tsx` - domain-level generated profile queue/history.
- `src/client/components/ProfileGenerationReview.tsx` - proposal/revision review screen.
- `src/client/components/ProfileFieldValidationTable.tsx` - per-field sample validation table.
- `src/client/components/ImagePreviewGrid.tsx` - image sample previews and warnings.
- `src/client/components/ProfileRevisionFeedbackForm.tsx` - structured feedback UI.
- `src/tests/unit/llm-task-config-repo.test.ts` - DB tests for task configs.
- `src/tests/unit/llm-client-task-routing.test.ts` - mocked routing tests.
- `src/tests/unit/profile-generation-revision-repo.test.ts` - DB tests for revisions/results.
- `src/tests/unit/profile-generation-field-decision-repo.test.ts` - DB tests for field decisions/rollback data.
- `src/tests/unit/profile-governance-service.test.ts` - service-rule tests.
- `src/tests/unit/page-extractor-profile-generation.test.ts` - decision 20 regression test.
- `docs/generated-profile-governance.md` - workflow and invariant documentation.

## Dependencies
- Phase 0 should land before UI/API work so the extractor cannot use unapproved selectors.
- Phase 1 repositories are required before Phase 3 API and Phase 4 UI can persist revisions/decisions.
- Phase 2 task routing is required before profile generation/revision APIs are exposed to operators.
- Phase 3 service/API should be completed before Phase 4 UI to avoid embedding business rules in React components.
- Phase 4 UI depends on typed client API functions and shared schemas from Phase 3.

## Risks
- **Scope size:** This is now a full governance workflow, not a small extractor patch. Implement serially by phase with tests after each phase.
- **Schema compatibility:** Existing `profile_generations` rows will not have revisions. Add backfill-on-read or migration-safe `createInitialRevisionForGeneration()`.
- **Terminology drift:** Leaving `canPromote`/`canAutoPromote` names risks future accidental auto-promotion. Remove/rename production references.
- **Image validation quality:** Detecting recommendation/carousel pollution is heuristic. UI previews and explicit human review remain mandatory.
- **LLM task config failures:** Profile generation/revision should fail closed, but existing product curation/classification should not break unexpectedly; allow fallback there unless explicitly changed.
- **Rollback semantics:** Rolling back to `null` should explicitly clear a selector via `upsertProfile(domain, { field: null })`; omitting field would preserve it.
- **UI complexity:** `OnboardingSettings.tsx` is already large. Prefer extracted components to avoid an unmaintainable monolith.

## Review Findings
- high: `src/onboarding/profile-generator.ts` uses generic LLM config for profile generation; must be task-specific and fail closed.
- high: `src/db/repositories/onboarding-source-repo.ts` sample selection permits unselected sources and broad domain matches; violates selected/confirmed sample policy.
- high: `src/onboarding/page-extractor.ts` proposal-only direct edit needs cleanup/test coverage; helper names/comments still describe retry behavior.
- medium: `src/onboarding/profile-promoter.ts` stores approval attempts in JSON and marks row-level `promoted`; normalized field decisions are needed for partial approvals and rollback.
- medium: `src/client/components/OnboardingSettings.tsx` has active profile CRUD only; no generated-profile governance UI exists.
- low: `src/onboarding/profile-generator.ts` exposes `applyGeneratedProfileToCheerio()` only for tests after extractor no longer uses it; rename/reuse for validation or remove.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read current code in src/db/migrations.ts, src/onboarding/llm-client.ts, src/onboarding/profile-generator.ts, src/onboarding/profile-promoter.ts, src/onboarding/page-extractor.ts, src/db/repositories/profile-generation-repo.ts, src/db/repositories/onboarding-source-repo.ts, src/server/routes/onboarding-routes.ts, src/client/onboarding-api.ts, src/client/components/OnboardingSettings.tsx, and related tests/config. Returned concrete findings with file paths and severity plus a phased implementation plan."
    }
  ],
  "changedFiles": [
    "/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "functions.read / functions.grep code inspection",
      "result": "passed",
      "summary": "Inspected current schema, repositories, LLM client, generator, promoter, extractor integration, routes, client API, settings UI, and tests. No validation commands were run because this was a planning-only task."
    }
  ],
  "validationOutput": [
    "Plan written to the authoritative output path.",
    "No source-code implementation changes were made by this planning subagent."
  ],
  "residualRisks": [
    "Plan is based on static inspection only; implementation workers must run typecheck/tests after edits.",
    "Existing uncommitted worktree state was not inspected with git status because this planning subagent did not have shell access."
  ],
  "noStagedFiles": true,
  "diffSummary": "Created planning artifact only; no project source files modified by this planning subagent.",
  "reviewFindings": [
    "high: src/onboarding/profile-generator.ts - profile generation still uses generic getLlmConfig/callLlm instead of explicit profile_generation task config.",
    "high: src/db/repositories/onboarding-source-repo.ts - validation samples currently include non-selected sources and use broad domain LIKE matching.",
    "high: src/onboarding/page-extractor.ts - proposal-only edit should be renamed/tested so generated selectors can never affect extraction output.",
    "medium: src/onboarding/profile-promoter.ts - approval history remains JSON-based and row-level; normalized per-field decisions are required for rollback/governance.",
    "medium: src/client/components/OnboardingSettings.tsx - generated-profile review/revision UI is missing.",
    "low: src/onboarding/profile-generator.ts - applyGeneratedProfileToCheerio should be renamed/reused for validation or removed if unused."
  ],
  "manualNotes": "UI work should be separated into a later worker after backend schema, LLM routing, service, and API phases are complete."
}
```