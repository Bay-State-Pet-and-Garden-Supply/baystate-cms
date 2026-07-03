# Phase 2 — COMPLETE

## Result
All Phase 2 tasks (9-12) complete. typecheck 0 errors. vitest 142/142. bun test 181/181.

## Files changed
- src/db/migrations.ts — new `llm_task_configs` table with `task` UNIQUE constraint and index
- src/db/repositories/llm-task-config-repo.ts (new) — typed LlmTask/LlmProvider union, CRUD with `upsertLlmTaskConfig`/`getLlmTaskConfig`/`listLlmTaskConfigs`/`deleteLlmTaskConfig`
- src/onboarding/llm-client.ts — new `getLlmConfigForTask()` / `callLlmForTask()` helpers + `MissingLlmTaskConfigError` + `PROFILE_TASKS_REQUIRE_EXPLICIT` set. Legacy `getLlmConfig()`/`callLlm()` kept as generic fallback. Default base URLs / models per provider extracted to constants. `consolidateProductName()` now routes through `product_name_consolidation` with fallback allowed.
- src/onboarding/profile-generator.ts — `generateExtractorProfile` now uses `getLlmConfigForTask('profile_generation', { allowFallback: false })` and `callLlmForTask(...)` so it fails closed when the operator has not configured a profile AI model.
- src/onboarding/page-extractor.ts — audit metadata lookup uses task-specific config.
- src/onboarding/product-curator.ts — `finalizeTitle` and `classifyProduct` now use task-specific configs (`product_curation`, `category_classification`) with fallback allowed.
- src/classification/stages/evidence-extraction.ts — uses `classification_evidence_extraction` task.
- src/classification/stages/primary-product-type.ts — uses `category_classification` task.
- src/tests/unit/profile-generator.test.ts — mock includes new `getLlmConfigForTask`/`callLlmForTask`/`MissingLlmTaskConfigError`/`PROFILE_TASKS_REQUIRE_EXPLICIT` exports. All call sites updated to mock the task-specific helpers.
- src/tests/unit/page-extractor-profile-generation.test.ts — same mock update.
- src/tests/unit/llm-task-config-repo.test.ts (new) — 8 tests: insert/read, upsert-in-place, LLM_TASKS constant, list ordering, delete + null, missing-task null, credential separation.
- src/tests/unit/llm-client-task-routing.test.ts (new) — 17 tests: PROFILE_TASKS_REQUIRE_EXPLICIT set, profile_generation throws on missing config, profile_generation uses explicit config, profile_generation fallback path, consolidation fallback, consolidation null when no fallback, task config base URL override, fetch URL hits DeepSeek, task config temperature, default 0.1, caller temperature override, non-profile null behavior, profile throw on call, generic getLlmConfig preserved, **cross-task split: DeepSeek for profile_generation + Ollama for consolidation**.
- package.json — added new tests to the explicit `bun test` list.
- vitest.config.ts — added new tests to the vitest exclude list (they use `bun:sqlite`).

## Hand-off written
- /Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/395524bc-c010-4df6-976d-52426ae352cf/chain-artifacts/phase2-handoff.md

## Next
Phase 3 (governance service + API + repository changes) per the plan at .pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md.
