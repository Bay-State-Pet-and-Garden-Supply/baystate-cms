# e09s03 — Validation & Controlled Rollout

> Implements Phase C of `docs/plans/family-title-category-page-requirements-plan.md` §13. Deterministic validation only; replay/affected-batch validation runs against a **backup clone first**. No live re-run without approval and a verified SQLite backup. New revisions only — no automatic backfill of completed cohorts.

## Validation status (2026-08-24 run)

| Gate | Result |
|---|---|
| `bun run typecheck` | ✅ pass |
| Phase C vitest battery (10 files; 8 vitest-collected) | ✅ 202 tests pass |
| DB-backed remainder under `bun test` (cohort-title-coordinator, product-line-grouper, sitemap-sync-service) | ✅ 81 tests pass |
| `bunx eslint` on all e09-touched source + test files | ✅ clean |
| Repo-wide `bun run lint` | ⚠️ ~2.8k pre-existing errors repo-wide; **zero** in e09 scope (verified by targeted eslint) |
| Gold-set determinism (`family-title-page-goldset.test.ts`, 12 tests) | ✅ pass — by-family split, synthetic block isolated (3 examples, never production families), stable Page IDs |
| `bash scripts/validate-specs-yaml.sh` | ❌ script does not exist in-repo (referenced by plan §13 but never authored) — tracked as gap below |

## Required assertions — verified

- Valid variants differ only in approved slots of skeleton `Brand → Line → Form → Flavor → Size`; slot-order/brand/missing-token/leakage/invention cases fail (title-lint + family-title-consistency suites).
- Existing-ID-wrong-category, same-species wrong-category, generic-over-specific, wrong brand primary, missing primary, stale import all fail (category-page-correctness + promotion-gate suites).
- Legitimate sibling Page differences and evidenced dual-species co-primary remain valid.
- No title/Page outcome depends on model confidence (P8/T8 asserted in suites).
- BetterBone / SZ / MINI / JUMBO / LGHARVEST grouping regressions green (`product-line-grouper.test.ts` 78-test bun run incl. family-grouping-accuracy).

## Rollout protocol

1. **Shadow/replay on backup clone:** re-run completed-cohort validation against a verified SQLite backup clone; confirm same frozen run replays without new model calls and produces the same canonical artifact.
2. **New cohorts only:** harmonization applies to future cohort revisions via the updated authority hash; existing `completed` cohorts stay historical truth.
3. **Live re-run:** requires explicit user approval + verified backup. Not performed in this story.

## Known gaps

- `scripts/validate-specs-yaml.sh` referenced by Plan §13 does not exist — either author it or drop the reference from the plan's validation commands.
- Live replay against a real backup clone is pending approval (task e09s03t03).
