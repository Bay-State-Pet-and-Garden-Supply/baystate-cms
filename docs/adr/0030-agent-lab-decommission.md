# ADR 0030: Agent Lab (Product Intelligence) Decommission

- **Status:** Accepted (2026-08). **Phase 4 executed 2026-08-24** — PI-only tables dropped (assets rebuilt FK-free first, row counts preserved), imported-result gate removed from promotion. `BAYSTATE_CMS_PI_KILL_SWITCH` alias retained until the next release cycle.
- **Supersedes (operationally):** ADR 0010 (PI execution boundary), ADR 0026–0028 (specialists), ADR 0029 (shadow rollout); those records remain as historical context.
- **Rollback tag:** `pre-agent-lab-decommission` (phase 0 baseline, commit `14c5121`).
- **Plan:** `docs/plans/agent-lab-decommission-plan.md`

## Decision

The Agent Lab / Product Intelligence program (`src/product-intelligence/**`, its routes, frontend, and Agent Lab UI) is **hard-deleted** in favor of investing exclusively in the deterministic Onboarding Pipeline. Rationale: onboarding work proved overwhelmingly deterministic (CSS-selector extraction, distributor materialization, packaging OCR with fixed schemas); the agent runtime, specialists, and shadow-rollout machinery never reached production value while costing ~29k LOC backend + ~7k LOC frontend plus per-run policy/budget overhead.

Execution is **staged**: salvage-first relocation → frontend removal → server deletion → data retirement. Flags-off was already a supported steady state (ADR 0010), so deletion carries no behavior change for the onboarding pipeline beyond the deltas listed below.

## Salvage map (what moved where)

| Old home (`src/product-intelligence/…`) | New home | Notes |
|---|---|---|
| `policy/ip-classifier.ts` (`classifyIp`, `isPrivateOrLinkLocal`) | `src/shared/ssrf.ts` | Also used by extraction-worker + image-repair |
| `evaluation/metrics.ts` (`wilsonInterval`) | `src/onboarding/ocr-eval/stats.ts` |
| `assets/*` (verification, rights, discovery, image-hash, schema, network gate) | `src/onboarding/image-verification/*` | Live-written by onboarding `distributor-imagery.ts`; re-export shims existed until Phase 3 |
| `onboarding-import.ts` (`verifyImportedResultGate`) | `src/onboarding/imported-result-gate.ts` | Narrow inline SQL; deleted in Phase 4 together with the pi_* tables |
| Big PI repos (assets/reuse rows) | `src/db/repositories/onboarding-pi-asset-repo.ts`, `image-reuse-policy-repo.ts` | Table names unchanged |
| `extraction/` ladder layers 1–4 (+ platforms) | `src/onboarding/extraction-ladder/` | Unwired salvage: layers 1–3 deterministic + layer-4 profile seam implemented but NOT production-wired (follow-up integration into `page-extractor.ts`); layers 5–8 (browser/managed/LLM) discarded |

## Deleted

- `src/server/routes/product-intelligence-routes.ts` (~35 endpoints) and its mount.
- The entire `src/product-intelligence/**` tree (pi SDK adapter, 25 tools, specialists + workflow orchestrator v2, evaluation, policy gateway runtime, run service, flags, budgets, retention, preflight, seed, batch context, review gate).
- Agent Lab frontend (`src/client/components/agent-lab/`, `src/client/agent-lab/`, hooks, API client, nav/deep-links). Stale `?view=agentlab&run=<id>` deep links resolve to the dashboard view.
- Orphaned repositories: `product-intelligence-repo`, `pi-ops-repo`, `pi-approved-policy-repo`, `pi-review-decision-repo`, `agent-version-repo`, `agent-evaluation-repo`, `pi-reuse-policy-repo` shim, `specialist-workflow-repo`.
- `src/shared/schemas/agent-training.ts` and `src/shared/schemas/product-intelligence.ts` (no surviving consumers).
- The workspace bootstrap hook that seeded a default approved PI policy (`migration-service.ts`).
- The `@earendil-works/pi-coding-agent` dependency (zero remaining importers).

## Observable behavior deltas (sanctioned)

1. **Onboarding imagery fetches no longer write `product_intelligence_policy_decisions` audit rows** — the PolicyGateway runtime is gone; the deterministic network gate enforces the same SSRF/protocol/size rules without recording decisions.
2. No new Agent Lab runs/imports/policies can be created. Existing run/import/policy rows are read-only but import rows remain **promotion-authoritative** until Phase 4 removes the `verifyImportedResultGate` call from `draft-promoter.ts`; after that they are fully inert.
3. Workspace bootstrap no longer seeds a default approved PI policy row.

## Data dispositions

| Table | Disposition |
|---|---|
| `product_intelligence_assets` | **KEPT** — live-written by onboarding distributor imagery; name retained deliberately (naming footnote in CONTEXT.md) |
| `pi_reuse_policies` | **KEPT** — live-written reuse grants |
| `benchmark_*` | **SHARED with classification (#14)** — untouched; `benchmark-routes.ts` verified 100% classification-owned |
| runs / results / imports / policies / versions / evaluations / teaching / corrections / specialist workflows | Dropped or pending Phase 4 drop (dev DB); JSON archives in gitignored `archive/pi-decommission-20260824/` (28 dumps). The drop set includes `agent_corrections` and `agent_teaching_events`. **Ordering constraint:** `product_intelligence_assets.run_id` carries `ON DELETE CASCADE` toward `product_intelligence_runs` (migrations.ts), so Phase 4 FIRST rebuilds `product_intelligence_assets` without the FK (row-preserving copy) BEFORE dropping the runs family — all asset rows must survive with unchanged counts |

## Kill switch alias window

`BAYSTATE_CMS_OCR_KILL_SWITCH` is now the primary OCR kill-switch env var. `BAYSTATE_CMS_PI_KILL_SWITCH` remains honored as a documented deprecated alias during the alias window (either explicitly truthy ⇒ armed); it is retained through Phase 4 and scheduled for removal at the next release cycle.

## Residual risks

- Shim/new-home divergence window closed at Phase 3 (shims deleted with the tree).
- Stale docs referencing PI paths outside this ADR's fix list should be treated as historical.
- Re-enabling an agent pipeline would require reverting to the rollback tag; no forward-compat scaffolding is kept.
