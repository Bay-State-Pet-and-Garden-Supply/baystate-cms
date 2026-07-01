# Implementation Plan

## Goal
Add Phase 1 classification data schemas and idempotent SQLite migrations for classification runs, evidence, proposals, decisions, history, config snapshots, and refresh queue state.

## Tasks
1. **Add shared classification schemas**: Extend onboarding-side Zod types while preserving legacy `CurationData` compatibility.
   - File: `src/shared/schemas/onboarding.ts`
   - Changes: Add enums/schemas for `ClassificationStage`, `ClassificationEvidence`, `ClassificationProposal`, `ClassificationProposalDecision`, `ClassificationHistoryEvent`, and `ClassificationConfigSnapshotRef`; extend `CurationDataSchema` with defaulted `classificationRunId`, `classificationEvidence`, `classificationProposals`, `classificationDecisions`, and `classificationHistory` fields without removing existing title/page/type fields.
   - Acceptance: Legacy curation JSON still parses with defaults; sample Phase 1 classification payload parses successfully.

2. **Create the classification migration SQL**: Add durable operational tables without changing ShopSite export behavior.
   - File: `src/db/classification-migration.sql`
   - Changes: Create `classification_config_snapshots`, `classification_runs`, `classification_evidence`, `classification_proposals`, `classification_proposal_evidence`, `classification_proposal_decisions`, `classification_history_events`, `classification_refresh_queue`, and optionally `classification_refresh_deferrals` if refresh deferral needs a separate audit record. Include foreign keys to `workspace`, `onboarding_items`, and run/proposal/evidence tables where safe; keep `product_sku` as text because onboarding rows may not yet exist in `product_index`.
   - Acceptance: SQL runs on an empty database after current core/onboarding migrations and can be run repeatedly with `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS` semantics.

3. **Add practical indexes and version metadata**: Make the new schema queryable for review and refresh flows.
   - File: `src/db/classification-migration.sql`
   - Changes: Add indexes for run lookup by workspace/product/status, proposal lookup by product/status/kind/config snapshot, evidence lookup by run/stage/product, decisions by proposal, history by product/run, and refresh queue by workspace/status. Insert `app_meta('classification_schema_version', '1')` or leave it to the runner after successful execution.
   - Acceptance: Migration test can confirm table/index existence and `classification_schema_version = '1'`.

4. **Wire the migration runner**: Execute the classification migration once after onboarding tables exist.
   - File: `src/db/migrations.ts`
   - Changes: Add `CLASSIFICATION_MIGRATION_PATH`; after the onboarding migration block, read `app_meta.classification_schema_version`; if missing, execute `classification-migration.sql` in a transaction and set version `1`. Keep existing ad-hoc compatibility blocks unchanged.
   - Acceptance: `runMigrations()` creates classification tables on fresh databases and does not fail when called a second time.

5. **Update database migration tests**: Cover fresh install, idempotence, and a minimal classification workflow.
   - File: `src/tests/unit/db-migration.test.ts`
   - Changes: Add classification tables to existence checks; add assertions for `classification_schema_version`; call `runMigrations()` twice; insert a workspace, onboarding batch/item, config snapshot, run, evidence, proposal, proposal/evidence link, decision, and history event to validate foreign keys and JSON text columns.
   - Acceptance: `bun test src/tests/unit/db-migration.test.ts` passes.

6. **Add schema compatibility tests**: Validate TypeScript/Zod defaults independently from SQLite.
   - File: `src/tests/unit/classification-schema.test.ts`
   - Changes: Add tests that parse old `CurationData` objects and new sample classification objects; assert arrays default to `[]` and decision/proposal status enums reject unknown values.
   - Acceptance: `bun test src/tests/unit/classification-schema.test.ts` passes and `bun run typecheck` succeeds.

7. **Keep Phase 1 scope narrow**: Avoid pipeline, UI, repository, and draft promotion behavior changes in this pass.
   - File: `src/onboarding/product-curator.ts`, `src/onboarding/draft-promoter.ts`, server route files
   - Changes: No changes in Phase 1 unless type imports require harmless compile fixes.
   - Acceptance: Existing onboarding curation and draft promotion tests still pass; no new runtime classification behavior is introduced before later phases.

## Files to Modify
- `src/shared/schemas/onboarding.ts` - add classification Zod/domain schemas and backward-compatible `CurationDataSchema` extensions.
- `src/db/migrations.ts` - register and gate the new classification migration with `classification_schema_version`.
- `src/tests/unit/db-migration.test.ts` - assert new tables, metadata, idempotence, and minimal insert flow.

## New Files
- `src/db/classification-migration.sql` - Phase 1 SQLite tables, indexes, and metadata for classification operational state.
- `src/tests/unit/classification-schema.test.ts` - Zod compatibility tests for legacy and new classification curation data.

## Dependencies
- Task 2 depends on the current onboarding migration because classification rows may reference `onboarding_items`.
- Task 4 depends on Tasks 2 and 3.
- Tasks 5 and 6 depend on Tasks 1 through 4.
- Later implementation phases should depend on this schema but should not be bundled into Phase 1.

## Risks
- Classification Configuration files under `store/classification/` are versioned in workspace Git; Phase 1 should store only SQLite snapshot metadata/content needed for reproducible runs, not implement full configuration authoring.
- SQLite JSON columns cannot enforce payload shape; Zod schemas and repository-level validation will be needed in later phases.
- Overly strict `CHECK` constraints on stages/kinds may slow future stage additions; prefer shared enums plus limited database constraints for status fields.
- Product identity is not always available during onboarding, so schema should use nullable `product_id` and stable `product_sku` text rather than requiring `product_index` rows.
- `product_types` and `product_type_fields` are legacy field-map tables; do not repurpose them as the new Product Attribute model in Phase 1.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Created only the requested Phase 1 implementation plan at /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md after reading classification-design.md and relevant schema/migration files; no source implementation changes were made."
    }
  ],
  "changedFiles": [
    "/Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "functions.read /Users/nickborrello/Desktop/Projects/shopsite-cms/classification-design.md",
      "result": "passed",
      "summary": "Read the classification design summary."
    },
    {
      "command": "functions.read/find project schema and migration files",
      "result": "passed",
      "summary": "Reviewed existing SQLite schema, migration runner, onboarding migration, migration tests, and onboarding schemas."
    },
    {
      "command": "functions.write /Users/nickborrello/Desktop/Projects/shopsite-cms/plan.md",
      "result": "passed",
      "summary": "Wrote the requested implementation plan."
    }
  ],
  "validationOutput": [
    "Plan file was written to the authoritative output path."
  ],
  "residualRisks": [
    "Git staging state could not be independently checked because no shell/git status tool is available in this subagent; no staging operations were performed."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added/overwrote plan.md with a concrete Phase 1 schema and migration implementation plan only.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "This was a planning-only task; implementation, tests, and migrations remain pending for execution agents."
}
```