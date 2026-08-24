# ADR 0029: Evals, v1/v2 Shadow, Rollout Gates and Legacy Migration (#60)

**Status update (2026-08): SUPERSEDED operationally by ADR-0030 (Agent Lab decommission); paths below are deleted/historical.**

- Status: Accepted
- Date: 2026-08-20
- Issue: #60 (epic #47, tail of #48–#59)

## Context

The Agent Lab v2 specialist core (#48–#56) is complete and wired into onboarding
handoff (#58) and the investigation workspace UI (#59). Before v2 becomes the
default execution path, we must (a) prove it is safe on measured evidence rather
than model self-reported confidence, (b) give operators a kill switch that always
returns every workspace to the deterministic legacy pipeline, and (c) retain the
shared PI runtime/governance while the monolithic legacy executor remains in the
codebase, marked deprecated but never deleted, until default-on stabilization.

This ADR governs the e03s02 mechanics: per-specialist versioned evals (#28
benchmark tables, content-addressed datasets, deterministic splits), v1/v2 shadow
on identical seeds, rollout thresholds over measured metrics, the global kill
switch, and the legacy-retention guard.

## Decision

1. **Measured-metric rollout gates (never confidence).** Staged enablement
   `shadow_only → manual_agent_lab → reviewed_import → optional_onboarding →
   automatic`. `evaluateRolloutGate(stage, report)` compares only measured rates
   from `PiAggregateReport` (quality/provenance/cost/latency/human-correction
   deltas) against documented per-stage thresholds, with a minimum sample size.
   Model-reported confidence is never read. Advancement beyond the current
   configured stage is denied. Thresholds are persisted with `documentedBy` /
   `updatedAt` audit so a stage cannot be enabled with undocumented thresholds.

2. **Global kill switch (PI-9).** `BAYSTATE_CMS_PI_KILL_SWITCH` / `flags.killSwitch`
   forces the legacy executor everywhere via `execution-router` and blocks
   onboarding imports (`onboarding-import` throws when `isPiKillSwitchEnabled()`).
   This is the single override that dominates all feature flags. Feature flags
   `productIntelligence.*` remain default-disabled with in-memory overrides for
   tests.

3. **v1/v2 shadow, never mutating.** `shadow.ts` runs v1 (single-agent) and v2
   (specialist) on identical frozen seeds and writes only to `shadow_comparisons`;
   it never mutates catalog, onboarding, or Git state. Where ground truth is
   non-deterministic, comparison is marked `needs_reviewer` for durable
   adjudication. Reports cover quality/provenance/cost/latency/human-correction.

4. **Safety metrics gate.** Wrong-product / wrong-variant / false-pass rates must
   not regress versus the v1 baseline; retrieval success is distinguished from
   correct-product extraction (HTTP 200 with the wrong size is a failed task);
   provider recommendation is safety-qualified (extraction rate, cost,
   traceability coverage, safety passed).

5. **Legacy retention guard (ADR 0029 rule).** The monolithic `legacy-executor.ts`
   is marked `@deprecated` and retained at every stage. It is removable only when
   `isLegacyRemovalAllowed(report)` is true — i.e. kill switch off, stage
   `automatic`, and the automatic gate passing on measured metrics. Until then it
   stays, and the shared PI runtime/policy/budget/governance layer is preserved
   regardless of rollout stage.

6. **Historical readability.** Additive tables/migrations keep historical
   single-agent runs queryable; no breaking read-path change.

7. **Process gates.** CI treats lint as advisory (skips lint on purpose) while
   `typecheck` and `tests` are hard gates. Every changed file carries `// story:
   e03s02` traceability; each pushed commit receives a `gpt_chat` PASS review.

## Consequences

- v2 can be defaulted only when measured thresholds are met under documented
  config and the kill switch is off.
- Operators can halt all v2 paths instantly via the kill switch without a redeploy.
- No parallel publication or second orchestration framework is introduced.
- The legacy executor remains a fail-closed fallback until proven stabilization.
- `metrics.ts` / `extraction-benchmark.ts` exceed the 300-line guideline but are
  pre-existing and out of e03s02 scope; this story adds only additive helpers.
