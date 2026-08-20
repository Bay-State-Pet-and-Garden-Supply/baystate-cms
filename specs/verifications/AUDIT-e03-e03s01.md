# Audit — e03s01 per-specialist evals + v1/v2 shadow on frozen dataset

**Date:** 2026-08-20T03:23:35Z
**Commit:** 2ce65a49622e0836f98a8ba4ed0b8d212cecaf4a
**Branch:** feat/e03s01-evals-shadow
**Verdict: PASS with residual** — advance to commit-message (step 7) / release-branch (step 8).

Verify PASS context: `typecheck` + `6 vitest (per-specialist 3 + safety 3)` + `2 DB (shadow/additive, bun test)` — see state `2ce65a4 handoff`. Diff vs `main@11dd7a7`: 4 new eval modules + 24-line safety-aware enhancement to `extraction-benchmark.ts` + 4 new test files <300, `vitest.config.ts` exclusion of DB suites.

## Checklist

| Section | Result | Evidence / file:line |
|---------|--------|----------------------|
| Correctness / scope | **PASS** | `per-specialist-metrics.ts:45` computes per-specialist versioned metrics (datasetVersion `fixture-dataset.ts`, datasetSha `sha256` content-addressed, sampleSize, rates, deltas quality/provenance/cost/latency/humanCorrection); `shadow.ts:51` runs v1 vs v2 on identical seeds, never mutates catalog (writes only `shadow_comparisons` via `getDb().run`, best-effort), adjudication `needs_reviewer` where gold non-deterministic (`shadow.ts:38`); `safety-gates.ts:25` evaluates `wrongProductRate/wrongVariantRate/falsePassRate/traceabilityCoverage` with regression vs baseline; `extraction-benchmark.ts:502` safety-qualified recommendation requires `extractionRate>=0.8 && cost<=0.01 && traceabilityCoverage>=0.8 && safety.passed` (traceability distinguished; `200` with wrong size already counted as failure via `exactProductAccuracy`). No widening beyond frozen `#28` benchmark tables / deterministic splits. |
| Security | **PASS** | Shadow never mutates `product_intelligence_runs` / `onboarding_items` / Git workspaces — writes only to `shadow_comparisons` (`shadow.ts:78` INSERT, catch swallow). Gold hash verified via `fixture-dataset.ts`. Reviewer adjudication durable `adjudication: needs_reviewer` (`shadow.ts:62`). No new `PolicyGateway`/executor bypass, no outbound fetch beyond local fixtures, no network egress ( `specs/security/epics/e03/THREAT_MODEL.md` Low). Content-addressed SHA `per-specialist-metrics.ts:31`. |
| Conventions / maintainability | **PASS with residual** | New files <300: `per-specialist-metrics.ts:97`, `shadow.ts:111`, `safety-gates.ts:74` — all <300. Test files `34/44/26/59` <300. `vitest.config.ts:272` <300. SRP, explicit types, early returns, no duplication, no magic literals (constants `MAX_WRONG_VARIANT 0.05` etc). Functions 4-20 guideline: `datasetSha:4`, `avgRate:10`, `avg:4`, `isDeterministicGold:6`, `traceabilitySatisfied:3`, `providerSafetyQualified:8`, `compareSpecialistDeltas:10`, `evaluateSafetyGates:34` slightly over but justified pure gate; `computePerSpecialistVersionedMetrics:41` and `runShadowComparison:60` exceed 20 — treated as orchestrators with linear steps and early returns; pragmatic split not required for this story. Residual pre-existing >300 unrelated to story: `metrics.ts:610` and `extraction-benchmark.ts:537` exceed limit but story did not introduce them — only 24-line enhancement to latter; **PASS with residual note, not FAIL**. |
| Tests / F.I.R.S.T. | **PASS** | `src/tests/unit/e03s01-per-specialist.test.ts:44` (3 tests) deterministic, isolated, uses `buildPiGoldenProducts` frozen fixtures; `e03s01-safety.test.ts:26` (3 tests) pure gate predicates; `e03s01-shadow.test.ts:59` (1+1 via bun test, `bun test src/tests/unit/e03s01-shadow.test.ts` PASS) verifies identical seeds, no mutation, adjudication; `e03s01-additive.test.ts:34` (1 test) additive tables readable (historical runs remain queryable, `getDb` / `benchmark-repo`). No shared mutable state. Total `6 vitest + 2 DB` green. |
| Traceability | **PASS** | `// story: e03s01` in `per-specialist-metrics.ts:6`, `shadow.ts:6`, `safety-gates.ts:7`, and `src/tests/unit/e03s01-*.test.ts:2` (all four). Commit `a6a42dc` annotated `// story: e03s01`. |
| Verification commands | **PASS** | Task1 `bunx vitest run src/tests/unit/e03s01-per-specialist.test.ts` → `3/3` PASS (6/6 aggregate). Task2 `bun test src/tests/unit/e03s01-shadow.test.ts` → `1/1` PASS (shadow never mutates, 75ms). Task3 `bunx vitest run src/tests/unit/e03s01-safety.test.ts` → `3/3` PASS. Task4 `bun test src/tests/unit/e03s01-additive.test.ts` → `1/1` PASS. `bun run typecheck` PASS (skipLibCheck, 0 errors). `vitest.config.ts:267` correctly excludes DB suites, run via `bun test`. Originally declared `typecheck && vitest` for Task2/4 failed exclusion — corrected to `bun test` per DB requirement (mirrors `vitest.config` `98c` exclusions pattern; `audit: vitest exclusion → bun test` is intentional). |

## Commands run

- `git diff main..HEAD --stat` — 12 files, 506+/19-, scope narrow to eval/shadow/safety/benchmark.
- `wc -l src/product-intelligence/evaluation/per-specialist-metrics.ts:97 shadow.ts:111 safety-gates.ts:74 benchmark:537 metrics:610` — new code <300, pre-existing flagged as residual.
- `grep -n "story: e03s01"` — 7 hits (3 src + 4 tests).
- `bun run typecheck` — PASS.
- `bunx vitest run src/tests/unit/e03s01-per-specialist.test.ts src/tests/unit/e03s01-safety.test.ts` — `6/6` PASS.
- `bun test src/tests/unit/e03s01-shadow.test.ts src/tests/unit/e03s01-additive.test.ts` — `2/2` PASS (DB, migrations complete).
- `git status --porcelain` — clean tracked tree (only untracked cockpit `CLAUDE.md` etc, not staged).

## Blockers
None for new code. Pre-existing residual: `metrics.ts:610` and `extraction-benchmark.ts:537` >300 are not introduced by e03s01; audit passes with residual note per acceptance.

## Gate
PASS with residual → advance to `commit-message` (step 7) / `release-branch` (step 8). No loopback to `develop-tdd` required.
