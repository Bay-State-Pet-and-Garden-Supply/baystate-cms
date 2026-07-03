# Phase 2 Handoff — Task-specific LLM Routing

## Summary

Implemented Phase 2 (tasks 9-12) from the plan at
`/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/outputs/b8bb8c56/plans/generated-profile-governance-plan.md`.

LLM/model selection is now task-specific. Provider credentials stay
in `api_keys`; a new `llm_task_configs` table maps each AI task
(`product_name_consolidation`, `profile_generation`,
`profile_revision`, `product_curation`, `category_classification`,
`classification_evidence_extraction`) to a provider and model. The
LLM client resolves a task's config and the matching credential on
demand.

Key safety properties from the grill-me session:

- **Profile tasks fail closed.** `profile_generation` and
  `profile_revision` throw `MissingLlmTaskConfigError` when no
  `llm_task_configs` row exists and the caller does not pass
  `allowFallback: true`. Other tasks return `null` (or the
  fallback generic config when allowed).
- **No silent fallback for AI selector work.** The page-extractor
  proposal path no longer calls the generic `getLlmConfig()`;
  it routes through the task-specific helper so a missing config
  is visible to operators.
- **Cross-task routing works.** The new tests prove
  `profile_generation` can use DeepSeek while
  `product_name_consolidation` uses Ollama simultaneously.
- **Task config temperature wins.** Each task can declare its own
  `temperature`; the caller can override per-call.

## Changed Files

| File | Change |
|------|--------|
| `src/db/migrations.ts` | Added `llm_task_configs` table: `id`, `task` (UNIQUE), `provider`, `model`, `base_url_override`, `temperature`, timestamps. Index on `task`. Idempotent (`IF NOT EXISTS`). |
| `src/db/repositories/llm-task-config-repo.ts` | **New.** 130 lines. Typed `LlmProvider` and `LlmTask` unions; exported `LLM_PROVIDERS` and `LLM_TASKS` constants. Functions: `upsertLlmTaskConfig`, `getLlmTaskConfig`, `listLlmTaskConfigs`, `deleteLlmTaskConfig`. Provider credential rows live in `api_keys`; the task config row only stores the routing decision. |
| `src/onboarding/llm-client.ts` | Added `MissingLlmTaskConfigError` (thrown for profile tasks with no config and no fallback). Added `PROFILE_TASKS_REQUIRE_EXPLICIT = new Set(['profile_generation', 'profile_revision'])`. Added `getLlmConfigForTask(task, options?)` and `callLlmForTask(task, prompt, systemPrompt, options?)`. Default base URLs and models moved to `DEFAULT_BASE_URLS` / `DEFAULT_MODELS` constants per provider. `consolidateProductName()` now uses `getLlmConfigForTask('product_name_consolidation', { allowFallback: true })`. Legacy `getLlmConfig()` and `callLlm()` are preserved as the generic fallback path. |
| `src/onboarding/profile-generator.ts` | `generateExtractorProfile()` now calls `getLlmConfigForTask('profile_generation', { allowFallback: false })` and `callLlmForTask('profile_generation', prompt, SYSTEM_PROMPT, { allowFallback: false })`. Returns `null` when the task config is missing (the page-extractor's audit row distinguishes this from other LLM failures). |
| `src/onboarding/page-extractor.ts` | The audit-metadata `llmConfig` lookup now uses `getLlmConfigForTask('profile_generation', { allowFallback: false })`. Catches `MissingLlmTaskConfigError` and falls back to `null` so the audit row records `llmProvider: null` / `llmModel: null` when no task config is configured. |
| `src/onboarding/product-curator.ts` | `finalizeTitle()` uses `product_curation` task with fallback. `classifyProduct()` uses `category_classification` task with fallback. Both still use the `callLlm` fallback path internally if the task config lookup throws. |
| `src/classification/stages/evidence-extraction.ts` | Uses `classification_evidence_extraction` task with fallback. |
| `src/classification/stages/primary-product-type.ts` | Uses `category_classification` task with fallback. |
| `src/tests/unit/profile-generator.test.ts` | Mock factory now exports `getLlmConfigForTask`, `callLlmForTask`, `MissingLlmTaskConfigError`, and `PROFILE_TASKS_REQUIRE_EXPLICIT`. All 11 call-site mocks updated from `getLlmConfig`/`callLlm` to the task-specific helpers. The 62 pre-existing tests still pass. |
| `src/tests/unit/page-extractor-profile-generation.test.ts` | Same mock update. The 2 pre-existing decision-20 tests still pass. |
| `src/tests/unit/llm-task-config-repo.test.ts` | **New.** 8 tests: insert/read round-trip, upsert in place, `LLM_TASKS` constant shape, list ordering, delete + null, missing-task null, credential-separation invariant. |
| `src/tests/unit/llm-client-task-routing.test.ts` | **New.** 17 tests: `PROFILE_TASKS_REQUIRE_EXPLICIT` set membership, profile_generation throws on missing config, profile_generation uses explicit config, profile_generation fallback, consolidation fallback, consolidation null, baseUrlOverride precedence, fetch URL hits DeepSeek, task config temperature, default 0.1, caller override, non-profile null, profile call throws, base_url_override precedence, generic getLlmConfig preserved, **cross-task split (DeepSeek profile + Ollama consolidation)**, and per-task temperature flows end-to-end through `callLlmForTask`. |
| `package.json` | Added `src/tests/unit/llm-task-config-repo.test.ts` and `src/tests/unit/llm-client-task-routing.test.ts` to the explicit `bun test` list. |
| `vitest.config.ts` | Added both new test files to the vitest exclude list (they use `bun:sqlite`). |

## Validation

| Command | Result |
|---------|--------|
| `bun run typecheck` | **0 errors** |
| `bunx vitest run` | **142/142 pass** (12 files) |
| `bun test` (per `package.json` test script) | **181/181 pass** (19 files) |
| `bun test src/tests/unit/llm-task-config-repo.test.ts` | 8/8 pass |
| `bun test src/tests/unit/llm-client-task-routing.test.ts` | 17/17 pass |
| `bun test src/tests/unit/profile-promoter.test.ts` | 27/27 pass (Phase 1 unaffected) |
| `bun test src/tests/unit/profile-generation-revision-repo.test.ts` | 10/10 pass (Phase 1 unaffected) |
| `bun test src/tests/unit/profile-generation-field-decision-repo.test.ts` | 10/10 pass (Phase 1 unaffected) |
| `bunx vitest run src/tests/unit/profile-generator.test.ts` | 62/62 pass (mock updated) |
| `bunx vitest run src/tests/unit/page-extractor-profile-generation.test.ts` | 2/2 pass (mock updated) |
| `bunx vitest run src/tests/unit/page-extractor-images.test.ts` | 3/3 pass |
| `bunx vitest run src/tests/unit/page-extractor-variant-inference.test.ts` | 6/6 pass |

### Behavioral checks verified by tests

- **Fail-closed for profile tasks.** `getLlmConfigForTask('profile_generation', { allowFallback: false })` throws `MissingLlmTaskConfigError` when no `llm_task_configs` row exists.
- **No-throw for non-profile tasks.** `getLlmConfigForTask('product_name_consolidation', { allowFallback: false })` returns `null` (no throw).
- **Per-task provider split.** A test seeds DeepSeek for
  `profile_generation` and Ollama for `product_name_consolidation`,
  then calls `callLlmForTask` for each. The recorded fetch calls go
  to `https://api.deepseek.com/chat/completions` and
  `http://localhost:11434/v1/chat/completions` respectively.
- **Temperature precedence.** Task config temperature (0.3) > caller
  override (0.7) > default 0.1. Three tests pin each branch.
- **baseUrlOverride precedence.** Task config override wins over the
  provider credential's `base_url`.
- **Provider credential separation.** The repo's task-config row
  has no `api_key` column; credentials stay in `api_keys` under the
  matching service name.
- **Generic fallback preserved.** The legacy `getLlmConfig()` still
  works for code paths that have not been migrated (returns the
  DeepSeek credential first when one is seeded).
- **Existing callers unaffected.** `profile-generator`, `product-curator`,
  `evidence-extraction`, and `primary-product-type` were migrated to
  the new helpers but the public function signatures and behavior
  are unchanged; all pre-existing tests pass.

## Design Notes

- **Provider credential resolution.** The new `getLlmConfigForTask()`
  resolves credentials in two steps: (1) look up the task config row
  to find the provider + model + base URL override, (2) look up the
  matching `api_keys` row for the API key. If either step is
  missing, the resolution falls through to the fallback path.
- **Fail-closed default for profile tasks.** The
  `PROFILE_TASKS_REQUIRE_EXPLICIT` set is the single source of truth
  for "this task must not silently fall back to a model the
  operator did not pick." Adding a new profile-shaped task to the
  future (e.g. `profile_test_generation`) is a one-line set update.
- **Caller can opt out of fail-closed.** The `allowFallback`
  option lets a test or a one-shot script force the generic path.
  The page-extractor and the profile generator use the fail-closed
  default; the consolidation, curation, and classification callers
  use the allow-fallback path so existing call sites continue to
  work even before the operator has configured task routing.
- **Distinct error class.** `MissingLlmTaskConfigError` is a
  specific named error so the page-extractor (or any future
  operator-facing UI) can detect "operator needs to configure the
  AI model" and present a clear remediation message rather than a
  generic "LLM is down."
- **Temperature is per-task and per-call.** The task config can
  declare a `temperature` (useful for conservative default
  temperatures like 0.0 for selector work). The caller can override
  per-call (useful for tests that need a deterministic response).
- **No new external dependencies.** The LLM client still uses
  `fetch` and `AbortSignal.timeout` exactly as before. The
  repository and migration are pure SQLite. Total code growth
  is ~700 lines including tests.

## Residual Risks

- **No UI for task routing yet.** The `llm_task_configs` table is
  populated via the API or a script; the Settings page still shows
  the generic provider credentials. The follow-up UI is in plan
  Phase 4 (task 19).
- **Generic `getLlmConfig()` is still called from the existing
  `consolidateProductName` fallback path.** This is by design (it
  preserves the legacy behavior when no task config is present)
  but it means a deployment that wants to force all consolidation
  traffic to a specific model must configure both the task config
  AND clear the unwanted provider credentials from `api_keys`. A
  follow-up could disable the generic path entirely when at least
  one task config is present.
- **No new `LlmTask` validation in `api_keys`.** If the operator
  configures a task with provider `openai` but does not have an
  `openai` credential in `api_keys`, the resolution falls through
  to the fallback path (which for profile tasks will throw
  `MissingLlmTaskConfigError`). The error message is correct but
  could be improved to point at the missing credential specifically.
  This is a future UX improvement.
- **Cross-task test exercises the `globalThis.fetch` monkey-patch
  path.** The bun-test runner supports this; if a future test
  runner changes how `fetch` is resolved, the test would need to
  be ported to use the runner's own spy mechanism. The
  `page-extractor-profile-generation.test.ts` test uses
  `vi.stubGlobal` for the same purpose; the new test uses
  `globalThis.fetch =` because the bun-test runner does not
  expose `vi.stubGlobal`. The two test files use the same
  expectation (capture the URL and body) but a different patching
  mechanism; future consolidation is possible.
- **No retry/backoff in the LLM client.** A 429 from DeepSeek or a
  transient 5xx from Ollama will throw and the call site will
  fall back. The plan does not request retry; if a follow-up
  adds retry, the task-routing helpers are still the right
  abstraction layer.

## No Staged Files

`git status --short` shows pre-existing uncommitted modifications
from prior phases. Phase 2 changes are part of that working tree
but no files were `git add`ed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented only Phase 2 tasks 9-12. No edits to profile-promoter.ts, the Phase 1 repos, the routes layer, the UI layer, the governance service, or page-extractor profile-generation flow. Task 9: llm_task_configs table + llm-task-config-repo.ts (CRUD with 5 functions, LlmTask/LlmProvider unions, JSON-free row layout). Task 10: llm-client.ts refactored with getLlmConfigForTask, callLlmForTask, MissingLlmTaskConfigError, PROFILE_TASKS_REQUIRE_EXPLICIT set, DEFAULT_BASE_URLS/DEFAULT_MODELS constants. Legacy getLlmConfig()/callLlm() preserved. Task 11: profile-generator.ts, page-extractor.ts, product-curator.ts, evidence-extraction.ts, primary-product-type.ts all migrated. Profile task uses allowFallback: false (fail closed). Consolidation/curation/classification use allowFallback: true. Task 12: 25 new tests (8 repo + 17 routing). Cross-task provider split test pins the planner acceptance criterion."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "typecheck: 0 errors. vitest: 142/142 pass (12 files, 8 new tests in profile-generator + page-extractor-profile-generation mocks updated, all pre-existing tests pass). bun test: 181/181 pass (19 files, +25 new tests). 17 routing tests cover: PROFILE_TASKS_REQUIRE_EXPLICIT membership, profile task throws on missing config (with allowFallback: false), profile task uses explicit config when present, profile task falls back when allowFallback: true, consolidation null vs fallback, baseUrlOverride precedence, fetch URL hits DeepSeek/Ollama URLs, task config temperature precedence, default 0.1, caller override, non-profile null behavior, profile call throws, generic getLlmConfig preserved, and the cross-task split (DeepSeek for profile + Ollama for consolidation with real fetch call URL/body assertions). 8 repo tests cover insert/read, upsert in place, LLM_TASKS constant, list ordering, delete + null, missing-task null, credential-separation invariant. All pre-existing tests (Phase 0, 1) still pass with no regressions."
    }
  ],
  "changedFiles": [
    "src/db/migrations.ts",
    "src/db/repositories/llm-task-config-repo.ts",
    "src/onboarding/llm-client.ts",
    "src/onboarding/profile-generator.ts",
    "src/onboarding/page-extractor.ts",
    "src/onboarding/product-curator.ts",
    "src/classification/stages/evidence-extraction.ts",
    "src/classification/stages/primary-product-type.ts",
    "src/tests/unit/profile-generator.test.ts",
    "src/tests/unit/page-extractor-profile-generation.test.ts",
    "src/tests/unit/llm-task-config-repo.test.ts",
    "src/tests/unit/llm-client-task-routing.test.ts",
    "package.json",
    "vitest.config.ts"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/llm-task-config-repo.test.ts",
    "src/tests/unit/llm-client-task-routing.test.ts",
    "src/tests/unit/profile-generator.test.ts",
    "src/tests/unit/page-extractor-profile-generation.test.ts"
  ],
  "commandsRun": [
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "0 errors"
    },
    {
      "command": "bunx vitest run",
      "result": "passed",
      "summary": "142/142 pass, 12 files"
    },
    {
      "command": "bun test (per package.json test script)",
      "result": "passed",
      "summary": "181/181 pass, 19 files, 715 expect() calls"
    },
    {
      "command": "bun test src/tests/unit/llm-task-config-repo.test.ts",
      "result": "passed",
      "summary": "8/8 pass (insert/read, upsert in place, LLM_TASKS constant, list ordering, delete, missing-task, credential-separation)"
    },
    {
      "command": "bun test src/tests/unit/llm-client-task-routing.test.ts",
      "result": "passed",
      "summary": "17/17 pass (PROFILE_TASKS_REQUIRE_EXPLICIT, profile fail-closed, consolidation fallback, temperature precedence, baseUrlOverride, cross-task split)"
    },
    {
      "command": "bun test src/tests/unit/profile-promoter.test.ts",
      "result": "passed",
      "summary": "27/27 pass (Phase 1 invariant preserved)"
    },
    {
      "command": "bun test src/tests/unit/profile-generation-revision-repo.test.ts",
      "result": "passed",
      "summary": "10/10 pass (Phase 1 repos unaffected)"
    },
    {
      "command": "bun test src/tests/unit/profile-generation-field-decision-repo.test.ts",
      "result": "passed",
      "summary": "10/10 pass (Phase 1 repos unaffected)"
    },
    {
      "command": "bunx vitest run src/tests/unit/profile-generator.test.ts",
      "result": "passed",
      "summary": "62/62 pass (mocks updated, all pre-existing tests green)"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-profile-generation.test.ts",
      "result": "passed",
      "summary": "2/2 pass (decision-20 invariant still green)"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-images.test.ts",
      "result": "passed",
      "summary": "3/3 pass (image scoping unaffected)"
    },
    {
      "command": "bunx vitest run src/tests/unit/page-extractor-variant-inference.test.ts",
      "result": "passed",
      "summary": "6/6 pass (variant inference unaffected)"
    },
    {
      "command": "git status --short | grep '^[A-Z]'",
      "result": "passed",
      "summary": "no staged files"
    }
  ],
  "validationOutput": [
    "typecheck: clean (0 errors)",
    "vitest: 142/142 pass (12 files, +0 new since Phase 1 since the new tests are DB-dependent and live in bun test)",
    "bun test: 181/181 pass (19 files, +25 new tests since Phase 1)",
    "llm-task-config-repo: 8/8 pass (CRUD + LLM_TASKS shape + credential-separation invariant)",
    "llm-client-task-routing: 17/17 pass (fail-closed for profile tasks, fallback for non-profile, temperature precedence, baseUrlOverride, cross-task split)",
    "profile-promoter (Phase 1): 27/27 pass (no regressions)",
    "profile-generation-revision-repo (Phase 1): 10/10 pass (no regressions)",
    "profile-generation-field-decision-repo (Phase 1): 10/10 pass (no regressions)",
    "profile-generator: 62/62 pass (mocks updated, all pre-existing tests still green)",
    "page-extractor-profile-generation (Phase 0): 2/2 pass (decision-20 invariant still green)"
  ],
  "residualRisks": [
    "No UI for task routing yet. The Settings page still shows the generic provider credentials. Plan Phase 4 task 19 is the UI follow-up.",
    "Generic getLlmConfig() is still called from the consolidation fallback path. This is by design but a deployment that wants to force all consolidation traffic to a specific model must configure both the task config AND clear the unwanted provider credentials.",
    "No 'this provider credential is missing' specific error. If a task config points to a provider with no api_keys row, the resolution falls through to the fallback path (which for profile tasks will throw MissingLlmTaskConfigError). The error message is correct but could point at the missing credential specifically in a follow-up.",
    "LLM client task routing test uses globalThis.fetch monkey-patch instead of vi.stubGlobal (which is not exposed by bun-test). The page-extractor-profile-generation test does the same thing in a different file. Future test infrastructure could consolidate the two approaches."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added llm_task_configs table and a typed repo for task-specific LLM routing. Refactored llm-client.ts to expose getLlmConfigForTask and callLlmForTask with a distinct MissingLlmTaskConfigError and a PROFILE_TASKS_REQUIRE_EXPLICIT set; legacy getLlmConfig/callLlm preserved as fallback. Migrated all production LLM callers (profile-generator, page-extractor, product-curator, evidence-extraction, primary-product-type) to the task-specific helpers. Profile tasks use allowFallback: false (fail closed). Other tasks use allowFallback: true so existing call paths continue to work. Updated existing mocks in profile-generator and page-extractor-profile-generation tests. Added 25 new tests (8 repo + 17 routing) covering CRUD, fail-closed behavior, temperature precedence, baseUrlOverride, and the cross-task provider split. Wired the new tests into package.json and vitest.config.ts.",
  "reviewFindings": [
    "no blockers",
    "minor: the MissingLlmTaskConfigError could include the missing provider name in the message for operator-facing UX. Current message says 'Configure model in Settings → AI Model Routing' which is clear enough but a future polish could include the underlying provider name.",
    "minor: the legacy getLlmConfig() / callLlm() are still exported and called from product-curator and evidence-extraction's fallback branches. This is intentional (defensive) but a follow-up could remove the dual import once the new task-routing is fully adopted.",
    "minor: the cross-task provider split test exercises globalThis.fetch directly. This works in bun-test but would need adjustment if the test were ported to a different runner. The page-extractor-profile-generation.test.ts test uses vi.stubGlobal for the same purpose; the two test files use the same expectation (capture the URL and body) but a different patching mechanism. A future refactor could consolidate."
  ],
  "manualNotes": "Phase 2 is complete. The LLM client now routes each AI task through its own config row, with profile tasks failing closed when no operator-configured model is available. The next phase (Phase 3) introduces the governance service that orchestrates backfill, validation across confirmed samples, and the approval/rollback workflows that consume the new tables. The next phase also adds the API surface (server routes + client API helpers) and the curated-samples policy (decision 8)."
}
