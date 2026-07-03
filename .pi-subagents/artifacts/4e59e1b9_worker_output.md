All green:
- typecheck: 0 errors
- vitest: 142/142 pass (12 files)
- bun test: 181/181 pass (19 files)
- 0 staged files

**Implemented Phase 2 (tasks 9-12) of the governance plan.**

**Validation:**
- `bun run typecheck`: 0 errors
- `bunx vitest run`: 142/142 pass (12 files)
- `bun run test`: 181/181 pass (19 files, +25 new since Phase 1)

**Changed files (14):**
- `src/db/migrations.ts` — new `llm_task_configs` table
- `src/db/repositories/llm-task-config-repo.ts` (new) — typed repo
- `src/onboarding/llm-client.ts` — `getLlmConfigForTask`, `callLlmForTask`, `MissingLlmTaskConfigError`, `PROFILE_TASKS_REQUIRE_EXPLICIT`
- `src/onboarding/profile-generator.ts` — uses task config, fails closed
- `src/onboarding/page-extractor.ts` — audit metadata uses task config
- `src/onboarding/product-curator.ts` — `product_curation` + `category_classification` tasks
- `src/classification/stages/evidence-extraction.ts` — `classification_evidence_extraction` task
- `src/classification/stages/primary-product-type.ts` — `category_classification` task
- `src/tests/unit/profile-generator.test.ts` — updated mocks
- `src/tests/unit/page-extractor-profile-generation.test.ts` — updated mocks
- `src/tests/unit/llm-task-config-repo.test.ts` (new) — 8 tests
- `src/tests/unit/llm-client-task-routing.test.ts` (new) — 17 tests
- `package.json` + `vitest.config.ts` — test wiring

**Key safety properties verified:**
- Profile tasks (`profile_generation`, `profile_revision`) throw `MissingLlmTaskConfigError` when no task config exists (fail-closed)
- Non-profile tasks return `null` (no throw) — fallback allowed
- Cross-task split: DeepSeek for `profile_generation` + Ollama for `product_name_consolidation` simultaneously
- `baseUrlOverride` on task config wins over provider credential `base_url`
- Task config temperature → caller override → default 0.1 precedence
- Provider credentials stay in `api_keys`; task config has no `api_key` column

Handoff written to `/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/395524bc-c010-4df6-976d-52426ae352cf/chain-artifacts/phase2-handoff.md`.

No staged files.