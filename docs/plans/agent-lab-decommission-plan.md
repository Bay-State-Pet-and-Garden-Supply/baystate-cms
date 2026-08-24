# Agent Lab / Product Intelligence Decommission Plan

**Status:** Approved strategy (oracle consultation 2026-08-24). This document is the implementation-ready decomposition.
**Scope:** Remove the Agent Lab / Product Intelligence (PI) program (`src/product-intelligence/**`, Agent Lab UI, PI API surface) and refocus the repo on the Onboarding Pipeline + Classification subsystems.
**Strategy:** Staged hard delete with salvage-first relocation. No dormancy. ~80% hard delete / ~15% relocate-to-neutral-home / ~5% defer-port.
**Execution model:** One sequential writer per phase series; phases strictly ordered **relocate → UI → server → data** (Oracle ruling B). Each phase is independently revertible.

---

## 0. Verified repo facts (audit of 2026-08-24 — supersedes earlier line-number estimates)

Every reference below was verified against the working tree. Corrections to prior estimates are marked **(drift)**.

### 0.1 PI source tree (`src/product-intelligence/`)
```
assets/{schema,rights,image-hash,contract,verification,discovery,index}.ts   # schema pure zod (182 ln); verification 916 ln
batch-context.ts budgets.ts contracts.ts executor.ts execution-router.ts
evaluation/{metrics,gold,runner,shadow,rollout,extraction-benchmark,search-benchmark,
            fixture-dataset,safety-gates,agent-promotion-gate,per-specialist-metrics,
            evaluation-orchestrator}.ts
extraction/{ladder(945),platforms(451),browser,evidence,evidence-runner,llm,
            managed-fallback,wiring}.ts
flags.ts index.ts legacy-executor.ts preflight.ts product-seed.ts
pi/{pi-executor,pi-session-factory,pi-tool-registry,pi-resource-loader,
    pi-prompt-builder,compiled-prompt-builder}.ts
policy/{policy-gateway(701),index}.ts
retention.ts review-gate.ts run-service.ts specialist-workflow-import.ts
specialists/{curator,discovery,profile-engineer,resolver,verifier,registry,
             contracts,policies,artifacts,index}.ts
tools/{registry,contract,discovery-tools,extraction-tools,identity-tools,
       image-tools,taxonomy-tools,verification-tools,index}.ts
workflow/{orchestrator,bundle,bundle-validator,terminal-tools,workflow-prompt,index}.ts
onboarding-import.ts
```

### 0.2 External (non-test) consumers of `src/product-intelligence/**` — the complete salvage surface
| Consumer | Imports | Disposition |
|---|---|---|
| `src/server/services/store-manager-image-repair.ts:37` | `classifyIp` (defined `policy/policy-gateway.ts:104`) | re-point to new `src/shared/ssrf.ts` |
| `src/extraction-worker/routes/extract.ts:36` | `classifyIp` | re-point |
| `src/shared/schemas/extraction-worker.ts:5` | `NetworkCaptureArtifactSchema` (`assets/schema.ts:176`) | inline schema into shared module |
| `src/extraction-worker/routes/snapshot.ts:24` | type `NetworkCaptureArtifact` | re-point to shared schema |
| `src/shared/schemas/agent-training.ts:9` | `PiDifficultyTagSchema` (`evaluation/gold.ts`) | inline schema into agent-training.ts |
| `src/onboarding/distributor-imagery.ts:25–31` | `PolicyGateway`, `ProductIntelligencePolicySchema`, `verifyImageCandidate`, asset schema/contract types, `insertOnboardingPiAsset`, `listPiAssetsByOnboardingItem`, `buildReuseGrantResolver`, `upsertReusePolicy` | full relocation cutover (Phase 1) |
| `src/db/repositories/pi-reuse-policy-repo.ts:12` | type `ReuseGrantRecord` (`assets/verification.ts:463`) | relocates with image-verification effort |
| `src/db/repositories/specialist-workflow-repo.ts` | `workflow/orchestrator` types | repo deleted (Phase 3) |
| `src/onboarding/ocr-eval/metrics.ts:22` | `wilsonInterval` (`evaluation/metrics.ts:496`) | relocate to `src/onboarding/ocr-eval/stats.ts` |
| `src/onboarding/draft-promoter.ts:12` | `verifyImportedResultGate` (`onboarding-import.ts:403`) | survives P0–P3 unchanged (ruling F); removed only in Phase 4 |
| `src/server/app.ts:25,101` | route mount | deleted (Phase 3) |
| `src/server/services/migration-service.ts` | lazy `run-service` + `pi-approved-policy-repo` in `seedDefaultApprovedPolicyForWorkspace` (def 130–137, call at 165) | hook removed (Phase 3) |

**Critical catch #1:** `insertOnboardingPiAsset` / `listPiAssetsByOnboardingItem` live inside `src/db/repositories/product-intelligence-repo.ts` but are the **live write path** for `product_intelligence_assets` from the distributor-imagery onboarding flow. They must be relocated to a slim repo **before** the big repo is deleted.
**Critical catch #2:** `pi_reuse_policies` receives **live writes** (`upsertReusePolicy`) from distributor imagery. The table must be **kept** (naming preserved per ruling C spirit) and `pi-reuse-policy-repo.ts` relocated (file rename OK, table name kept).
**Critical catch #3:** `verifyImportedResultGate` transitively drags `review-gate.ts`, `flags.ts`, `evaluation/rollout.ts`, and run-query functions of `product-intelligence-repo.ts`. To delete the rest of PI in Phase 3 without touching gate behavior, relocate the gate early (Phase 1) into a neutral standalone module with identical logic.

### 0.3 Frontend surface
- `src/client/components/agent-lab/` — **29 .tsx files** (AgentLab, AgentRunList/Inspector/Timeline/Launcher/Comparison/StepDetails, AgentWorkbench, AgentConfigStudio, AgentLabPolicies, AgentPolicySummary, AgentMetrics, TeachModal, SeedPanel, CurriculumExplorer, EvaluationMatrix, VersionLineage, ConflictReviewPanel, ResolverConflictPanel, CuratorProvenancePanel, VerifierVerdictPanel, SpecialistStagePanel, PolicySnapshotPanel, EvidenceInspector, EvidenceSourceCard, ImageEvidencePanel, ProductFieldEvidence, ProductListingPreview).
- `src/client/agent-lab/` — `logic.ts`, `specialist-workspace-logic.ts`, `specialist-workspace-policy.ts`, `specialist-workspace-provenance.ts`.
- `src/client/hooks/useProductIntelligenceEvents.ts`, `useProductIntelligenceRun.ts`; `src/client/product-intelligence-api.ts` (683 ln; consumed **only** by the above — safe to delete together).
- `src/client/App.tsx`: import line 14; `View` union line 19 (`'agentlab'` member); nav pill button lines **358–377** (rendered unconditionally, includes EXP pill); main-layout branch line **430** (`|| view === 'agentlab'`); render branch line **470**. **(drift)** Deep-link handling is NOT at 173–190: initial URL view resolution is lines ~221–227 (`const urlView = params.get('view') as View | null; ... setView(urlView)` — **no allowlist**, so stale `?view=agentlab` currently renders an empty main pane) and popstate handler lines ~246–254. There is **no `run=` param handling** anywhere in App.tsx (run id in `/?view=agentlab&run=…` was consumed inside AgentLab only).
- `src/client/components/PipelineBoard.tsx`: badge + “Open in Agent Lab →” block lines **984–999** (drift from 978–995): condition `item.extractionData?.productIntelligenceEvidence?.length > 0`, deep link `/?view=agentlab[&run=<id>]`.
- `src/client/components/onboarding/review/ReviewWarningsPanel.tsx:29` renders a display-only provenance line (“Product Intelligence imports: N”) — **keep** (historical items carry the field; schema field `productIntelligenceEvidence` in `src/shared/schemas/onboarding.ts:345` stays).

### 0.4 Server surface
- `src/server/routes/product-intelligence-routes.ts` — 1400 ln, **46 endpoints**, mounts at `app.route('/api', …)` (app.ts:101). Includes SSE stream, runs CRUD/replay/retention/budgets, policy snapshots, evaluation/benchmark/rollout endpoints, specialist workflow persistence + `importSpecialistWorkflowToOnboarding`.
- Benchmark pre-gate CONFIRMED: `src/server/routes/benchmark-routes.ts` is owned by Classification #14 (imports `db/repositories/benchmark-repo`, `classification/benchmark-*`). `benchmark_*` tables are created in the classification migration section (~migrations.ts:2020+). PI only *references* datasets (`pi_evaluation_runs.dataset_id`). **Never drop `benchmark_*` tables or benchmark-repo.**

### 0.5 Database surface (`src/db/migrations.ts`, 5156 ln; sections keyed by `app_meta` version strings)
PI-created tables (creation sections ~2670–3425, ~4088–4200, ~4511):
- Runs family: `product_intelligence_runs/_events/_steps/_tool_calls/_sources/_evidence/_conflicts/_results/_comparisons/_policy_decisions/_imports/_specialist_workflows`
- `pi_approved_policies`, `pi_budget_policies`, `pi_retention_policies`, `pi_evaluation_runs`, `pi_review_decisions`, `pi_source_authorities`, `pi_page_artifacts`
- `pi_image_candidates`
- Training: `agent_version_snapshots`, `agent_version_states`, `agent_evaluation_snapshots`, `agent_evaluation_cases`, `profile_engineer_domain_workflows`
- **KEEP:** `product_intelligence_assets` (+ rebuild shadow `product_intelligence_assets_new` — keep, document), `pi_reuse_policies` (live writes — catch #2), ALL `benchmark_*` tables, `cohort_shadow_observations`.

`app_meta` keys introduced by PI sections (~20): `product_intelligence_schema_version`, `product_intelligence_policy_schema_version`, `product_intelligence_assets_schema_version`, `product_intelligence_imports_schema_version`, `pi_evaluation_schema_version`, `product_intelligence_ops_schema_version`, `product_intelligence_approved_policies_schema_version`, `pi_review_remediation_schema_version`, `product_intelligence_policy_lineage_schema_version`, `pi_tools_capture_schema_version`, `pi_assets_verified_against_schema_version`, `pi_image_candidates_schema_version`, `pi_image_candidates_entity_schema_version`, `pi_source_authorities_schema_version`, `pi_artifact_driven_discovery_schema_version`, `pi_round10_authority_schema_version`, `pi_round11_authority_schema_version`, `pi_round12_brand_evidence_schema_version`, `product_intelligence_seed_schema_version`, `agent_training_snapshots_schema_version`. Migrations are **append-only history**: past sections are never edited; retirement happens via a NEW appended destructive section (Phase 4).

### 0.6 Kill switch
`src/classification/ocr-stage-flags.ts:73` `PI_KILL_SWITCH_ENV = 'BAYSTATE_CMS_PI_KILL_SWITCH'`; dominance applied in `loadOcrStageFlags()` and `getOcrStageFlags()`. Other refs: `src/product-intelligence/flags.ts`, `evaluation/rollout.ts`, `execution-router.ts` (all deleted P3); tests `packaging-ocr-consumer-wiring.test.ts`, `classification-ocr-stage-flags.test.ts` (**updated, not deleted**).
⚠ **Operational warning:** setting the PI kill switch today ALSO disables the `packaging_ocr` classification stage. During decommission transition, do NOT set any kill switch to "freeze" PI; rely on default-off feature flags + route removal.

### 0.7 Tests
- **63 exclusive PI test files**: 43 top-level (`pi-*.test.ts` ×24, `product-intelligence-*.test.ts` ×10, `agent-lab-*.test.*` ×6, `agent-version-repo`, `compiled-prompt-builder`, `evaluation-orchestrator`, `profile-engineer-workflow-repo`, `specialist-workflow-import`, `specialist-workflow-repo`) + 20 in `src/tests/unit/product-intelligence/`. Plus ~22 orphan `.db-shm`/`.db-wal` artifacts in `src/tests/unit/`.
- `vitest.config.ts` exclude list contains **30 PI entries** (lines ~102–127).
- `package.json` `test:db` script references **~20 PI test paths** (plus `evaluation-orchestrator.test.ts`, `specialist-workflow-import.test.ts`, `specialist-workflow-repo.test.ts`, `profile-engineer-workflow-repo.test.ts`, `agent-version-repo.test.ts`, `product-intelligence/*` suite, trailing `orchestrator.test.ts`).
- Tests to **update, not delete**: `distributor-imagery.test.ts` (import paths), `store-manager-image-repair.test.ts` (verify pass-through unaffected), `packaging-ocr-consumer-wiring.test.ts` + `classification-ocr-stage-flags.test.ts` (rename alias), `ocr-eval-metrics-gate.test.ts`/`ocr-eval-harness.test.ts` (wilsonInterval path), `draft-promoter.test.ts` (Phase 4 only), `db-migration.test.ts` (Phase 4).

### 0.8 Worktree & docs constraints
- Worktree is **dirty (107 modified/untracked files)** including `src/client/App.tsx` (+3/−2). Never reset/stash/stage unrelated changes; baseline tag on HEAD commit (`53ce292`), not a stash or commit.
- Docs to update: project `AGENTS.md` ("Product Intelligence (Agent Lab, PI-1)" section + PI mentions in Onboarding sections); `CONTEXT.md` (line 605 sourcing entry cites "PI-6 rights verification" → re-point to relocated home + naming footnote); ADRs 0010, 0018, 0020–0029 (superseded banners), 0014 amendments (PI-6 references); runbook `docs/runbooks/taxonomy-v4-activation.md` (line 40 mentions "PI taxonomy tools"); `docs/pi-review-remediation.md`, `docs/pi-smoke-findings.md`, `docs/governance-17-alignment.md`, `docs/handoff-issue17-chatgpt-review.md`, `docs/plans/agent-lab-training-interface-spec.md` (historical banners).

---

## Phase 0 — Freeze + audit (no code behavior change)

**Goal:** Prove PI is inert, snapshot every durable record, pin the revert point.

**PR 0.1 — Audit + archive tooling (new files only)**
1. Create `scripts/pi-decommission-audit.sql` (read-only queries):
   - `SELECT COUNT(*) FROM product_intelligence_runs;`
   - import census: total / active rows in `product_intelligence_imports`;
   - items pending promotion with PI evidence: count of `onboarding_item` rows whose `extraction_data_json` contains non-empty `productIntelligenceEvidence`;
   - `SELECT origin, COUNT(*) FROM product_intelligence_assets GROUP BY origin;` (by declared source tier);
   - policy decisions, events, tool_calls, sources, evidence counts;
   - `benchmark_*` row counts (proves shared tables untouched by later phases).
2. Create `scripts/export-pi-archive.ts` (bun script): dumps each PI-exclusive table to newline-delimited JSON under `archive/pi-decommission-YYYYMMDD/`; adds that directory to `.gitignore` (DB dumps never enter git; redact any credential-shaped fields using existing sanitization patterns before write). Output a checksum manifest.
3. Run both; store the printed counts in the PR description (acceptance evidence).

**PR 0.2 — Baseline tags**
1. `git tag pre-agent-lab-decommission` on current HEAD (`53ce292`). Tags are metadata — dirty tree untouched, nothing staged.
2. Document in `docs/plans/agent-lab-decommission-plan.md` §Rollback (this file) the tag name.

**Flag confirmation (manual, recorded in PR description):**
- Verify env has none of `BAYSTATE_CMS_PRODUCT_INTELLIGENCE_ENABLED`, `BAYSTATE_CMS_PI_ENABLED`, `BAYSTATE_CMS_PI_SHADOW_ONLY`, `BAYSTATE_CMS_PI_ALLOW_ONBOARDING_IMPORT`, `BAYSTATE_CMS_PI_ALLOW_BATCH_RUNS` set truthy (all default disabled).
- Do **not** set `BAYSTATE_CMS_PI_KILL_SWITCH` (it would disable the packaging-OCR stage — §0.6 warning).

**Validation gates:** audit script runs read-only (`sqlite3 file:...?mode=ro` or bun with read-only connection); `bun run typecheck` (no code touched — sanity only).
**Rollback point:** tag `pre-agent-lab-decommission` (created on `d185261`, 2026-08-24 — verified in Phase 0 execution).
**Touch count:** ≤4 new files + `.gitignore` + 1 tag.

### Phase 0 execution record (2026-08-24)
- Audit: `archive/pi-decommission-audit.md` — headline: **0 imports, 0 non-empty PI evidence**, 16 runs, 207 assets, 71 policy decisions; benchmark_* tamper counts recorded.
- Archive: `archive/pi-decommission-20260824/` — 27 NDJSON dumps + SHA256SUMS manifest, all checksums verified OK; directory gitignored.
- ⚠️ Deviation: `.env` has `BAYSTATE_CMS_PI_ENABLED=true`, `..._ALLOW_ONBOARDING_IMPORT=true`, `..._ALLOW_BATCH_RUNS=true` (plan assumed defaults-off). Flip false at Phase 3 start at the latest.

---

## Phase 1 — Relocate load-bearing code (additive-first, zero behavior change)

**Goal:** Every piece of PI code that surviving subsystems depend on gets a neutral home with its own tests, wired over only when green. Nothing user-visible changes.

**PR 1.1 — `classifyIp` → `src/shared/ssrf.ts`**
- New `src/shared/ssrf.ts`: move the pure classifier verbatim from `src/product-intelligence/policy/policy-gateway.ts:104` (private/link-local/public/unknown, `::ffff:` mapping). `policy-gateway.ts` imports it internally (keeps compiling; module dies in P3).
- Re-point consumers: `src/server/services/store-manager-image-repair.ts:37`, `src/extraction-worker/routes/extract.ts:36`. Behavior byte-identical (pure move); update the doc-comment at store-manager-image-repair.ts:29.
- New test `src/tests/unit/shared-ssrf.test.ts`: loopback, RFC1918, link-local 169.254/fe80::, `::ffff:` mapped IPv4, public, garbage→unknown. (Replaces coverage currently living in `product-intelligence-policy.test.ts`, which dies in P3.)
- Gate: `bun run test -- shared-ssrf`, `bun run test:db` extraction-worker guard tests (`extract-network-guard.test.ts`) still green.

**PR 1.2 — `wilsonInterval` → `src/onboarding/ocr-eval/stats.ts`**
- New module exporting `wilsonInterval` verbatim from `src/product-intelligence/evaluation/metrics.ts:496`. Re-point `src/onboarding/ocr-eval/metrics.ts:22`.
- New test `src/tests/unit/ocr-eval-stats.test.ts`: known proportion/n bounds (e.g. p̂=0.5,n=20 lower≈0.272 upper≈0.728), degenerate n=1, monotonic narrowing.

**PR 1.3 — Inline shared-schema dependencies**
- Move `NetworkCaptureArtifactSchema` definition (assets/schema.ts:176–182) INTO `src/shared/schemas/extraction-worker.ts`; delete the cross-layer import there (line 5); re-point `src/product-intelligence/assets/schema.ts` and `src/extraction-worker/routes/snapshot.ts:24` to import from shared. Single source of truth lives in shared forever after.
- Inline `PiDifficultyTagSchema` definition (from `evaluation/gold.ts`) into `src/shared/schemas/agent-training.ts` (replacing import at line 9). gold.ts keeps compiling until P3 (it may import back or define locally — prefer: shared exports it, gold.ts imports from shared).

**PR 1.4 — Relocate distributor-image verification → `src/onboarding/image-verification/`**
New modules (ported, not re-exported):
- `schema.ts` ← `assets/schema.ts` (minus NetworkCaptureArtifactSchema, imported from `shared/schemas/extraction-worker`).
- `rights.ts` ← `assets/rights.ts` (`computeCommerceApproved`).
- `image-hash.ts` ← `assets/image-hash.ts` (SHA-256 + dHash).
- `contract.ts` ← `assets/contract.ts` (sharp decode adapter).
- `verification.ts` ← `assets/verification.ts` with the **PolicyGateway dependency reduced to deterministic checks**: replace `deps.gateway.gatewayFetch(...)` (only network entry, verification.ts:503) with an injected bounded fetch implementing exactly the frozen policy semantics already encoded by `ONBOARDING_IMAGERY_POLICY` in distributor-imagery.ts (https protocol, DNS-resolve + `classifyIp` from `src/shared/ssrf.ts` private/link-local block, redirect hop re-validation, `Accept: image/*`, content-type `image/*`, max bytes min(policy,10MB)). Narrow the deps type: drop full `ProductIntelligencePolicy`; accept explicit `maxResponseBytes` etc. All fail-record outcomes and error strings preserved so downstream summaries are unchanged.
- `reuse-grants.ts`: port `buildReuseGrantResolver`/`upsertReusePolicy` bodies out of `src/db/repositories/pi-reuse-policy-repo.ts` into `src/db/repositories/image-reuse-grant-repo.ts` — **same SQL, same `pi_reuse_policies` table name** (catch #2; naming history documented in ADR).
- Slim asset-row repo: create `src/db/repositories/onboarding-image-asset-repo.ts` containing `insertOnboardingPiAsset` + `listPiAssetsByOnboardingItem` ported from `product-intelligence-repo.ts:1194/1286` — same `product_intelligence_assets` table, same row shape (catch #1).
- `index.ts` barrel.
Tests: port every `verifyImageCandidate` / `computeCommerceApproved` / `classifyAssetIdentity` / `findDuplicateAssets` case from `product-intelligence-assets.test.ts` into new `src/tests/unit/distributor-image-verification.test.ts` targeting the NEW modules, including the bounded-fetch SSRF/size/content-type failure records. Old tests remain green (old code untouched).
Cutover (same PR, last step): re-point `src/onboarding/distributor-imagery.ts` imports (lines 25–31) to the new homes; `distributor-imagery.test.ts` must pass **unchanged** (same outcomes asserted). If any outcome differs → fix the port, do not relax the test.
After cutover, remaining external consumers of old `assets/*` are PI-internal only (workflow/bundle-validator, tools/image-tools) — they die in P3.

**PR 1.5 — Relocate `verifyImportedResultGate` → `src/onboarding/imported-result-gate.ts`** (enables clean P3 while honoring ruling F)
- Port the function (onboarding-import.ts:403+) and its minimal lookups (run existence + result hash match + active import record) into a standalone module reading the same tables through small local SQL helpers following the repository pattern (or a slim `imported-result-intake-repo.ts`). Logic and error strings identical.
- Re-point `src/onboarding/draft-promoter.ts:12`. `draft-promoter.test.ts` passes unchanged.
- Gate behavior is enforced identically through Phase 4.

**PR 1.6 — Relocate extraction ladder layers 1–3 UNWIRED (defer-port bucket)**
- Copy (trimming browser/LLM escalation) into new unwired module set `src/onboarding/extraction-ladder/`: `ladder-core.ts` (HTTP fetch layer, structured-data/JSON-LD layer, platform-API layer incl. Shopify/Next.js/Nuxt/WooCommerce probes via `platforms.ts`, identity promotion, `classifyPageIdentity`, ladder result shape), `platforms.ts` (verbatim), `evidence-shapes.ts` (provenance result shape from `evidence.ts`: bundle/result/materialize signatures minus PI persistence adapters). No imports from page-extractor.ts, worker, or routes — **unwired** (ruling E; wiring into page-extractor.ts is explicitly OUT OF SCOPE).
- New test `src/tests/unit/extraction-ladder-core.test.ts`: port deterministic cases from `pi-extraction-ladder.test.ts` (layer selection, GTIN exact-match short-circuit, structured-data corroboration, platform probe ordering, profile-selector passthrough stubbed) + `classifyPageIdentity` cases. Marked header comment: “Unwired salvage from PI decommission — wiring deferred.”

**Phase 1 validation gates**
- `bun run typecheck && bun run lint && bun run test && bun run test:db` all green.
- Grep sweep: `grep -rn "from '.*product-intelligence/" src --include='*.ts*' | grep -v "^src/product-intelligence\|^src/tests"` returns exactly: `app.ts` (route), `migration-service.ts` (hook), `draft-promoter.ts` → now `imported-result-gate` (gone), i.e. only the two sanctioned P3 deletions remain.
- Manual smoke: distributor imagery verification on one dev item produces identical asset rows (compare counts/hashes pre/post cutover via audit queries).

**Rollback point:** tag `pre-agent-lab-decommission-p2`; per-PR `git revert` (each PR is self-contained; cutover edits isolated).
**Risk mitigations:** divergence between duplicated assets code during P2–P3 window (mitigated: freeze on PI feature work; old copy deleted in P3); sharp stays a dependency (used by relocated contract.ts); no network calls added (bounded fetch tested offline with injected fetch).
**Touch count:** ~14 new source files, ~6 new test files, ~10 edited files ≈ **30 paths**.

---

## Phase 2 — Frontend removal

**PR 2.1 — Delete Agent Lab client surface**
Delete (38 files):
- `src/client/components/agent-lab/**` (29 files)
- `src/client/agent-lab/**` (4 files)
- `src/client/hooks/useProductIntelligenceEvents.ts`, `src/client/hooks/useProductIntelligenceRun.ts`
- `src/client/product-intelligence-api.ts`
- Tests: `src/tests/unit/agent-lab-{components,events,logic,specialist-workspace-policy,specialist-workspace,training-ui}.test.*` (6)

**PR 2.2 — Strip App.tsx wiring + graceful unknown-view fallback**
Edits in `src/client/App.tsx`:
1. Remove import line 14; remove `'agentlab'` from `View` union (line 19).
2. Delete nav button block lines 358–377.
3. Line 430: remove `|| view === 'agentlab'` from the wide-layout branch.
4. Line 470: delete `{view === 'agentlab' && <AgentLab />}`.
5. **Unknown-view fallback (required):** introduce tiny pure helper `src/client/view-routing.ts` exporting `VALID_VIEWS` and `resolveViewParam(raw: string | null): View` — returns the view if valid, else `'dashboard'`. Use it at BOTH deep-link sites: initial load (~lines 221–227) and popstate (~249). Stale `?view=agentlab(&run=…)` links degrade to dashboard instead of an empty pane; optionally strip the invalid `view` param via `history.replaceState`.
6. `PipelineBoard.tsx`: delete badge/link block lines 984–999. Keep the ReviewWarningsPanel provenance line (historical data display).
Test: new `src/tests/unit/view-routing.test.ts` — every valid View round-trips; `'agentlab'`, `''`, null, garbage → `'dashboard'`.

**Phase 2 validation gates**
- `bun run typecheck && bun run lint && bun run test` green.
- Grep sweeps (must be zero hits):
  - `grep -rn "agentlab\|Agent Lab\|agent-lab" src/client --include='*.tsx' --include='*.ts'`
  - `grep -rn "product-intelligence-api\|useProductIntelligence" src/client`
- Manual smoke: `bun run dev` → app boots, nav renders without Agent Lab, `/?view=agentlab` lands on Dashboard, PipelineBoard renders, onboarding review drawer intact.

**Rollback point:** tag `pre-agent-lab-decommission-p3` (also single-PR revert).
**Touch count:** 44 deletions, 3 edited, 2 new ≈ **49 paths**.

---

## Phase 3 — Server deletion

Ordering honors ruling A: specialists/workflow v2 die first within the phase. Pre-gate re-checked at PR start: confirm no `benchmark_*` DROP statements anywhere in the diff.

**PR 3.1 — Specialists/workflow v2 + routes + mounts (one atomic server cut-over)**
Delete:
- `src/product-intelligence/specialists/**`, `src/product-intelligence/workflow/**`, `src/product-intelligence/specialist-workflow-import.ts`
- `src/server/routes/product-intelligence-routes.ts` (all 46 endpoints incl. SSE)
- Repos: `src/db/repositories/specialist-workflow-repo.ts`, `src/db/repositories/profile-engineer-workflow-repo.ts`, `src/db/repositories/pi-approved-policy-repo.ts`, `src/db/repositories/pi-ops-repo.ts`, `src/db/repositories/pi-review-decision-repo.ts`
Edit:
- `src/server/app.ts`: remove import (line 25) + mount (line 101).
- `src/server/services/migration-service.ts`: remove `seedDefaultApprovedPolicyForWorkspace` (definition 113–137 + call at 165) and the docblock; workspace creation no longer seeds PI policies.
- `src/db/repositories/product-intelligence-repo.ts`: strip specialist/run/event/tool-call/source/evidence/conflict/result/comparison/policy-decision functions; retain ONLY what `imported-result-gate.ts` needs — actually preferred: gate uses its own slim repo from PR 1.5, so **delete the entire big repo here**, along with `src/shared/schemas/product-intelligence.ts` (wire types; sole consumers were the repo + deleted client api).
Rationale for one PR: routes file, specialists, and workflow are mutually entangled (routes import orchestrator + persistence + importer); splitting would break compile mid-phase.

**PR 3.2 — Remaining PI core deletion**
Delete from `src/product-intelligence/`: `index.ts, contracts.ts, executor.ts, execution-router.ts, legacy-executor.ts, flags.ts, preflight.ts, budgets.ts, retention.ts, review-gate.ts, run-service.ts, onboarding-import.ts (gate already relocated in PR 1.5), product-seed.ts, batch-context.ts, pi/**, tools/**, evaluation/** (except nothing retained — wilsonInterval already moved), policy/** (gateway dies — classifyIp already moved), assets/** originals (relocated copies live in src/onboarding/image-verification/), extraction/browser.ts, llm.ts, managed-fallback.ts, wiring.ts, evidence-runner.ts, evidence.ts, ladder.ts, platforms.ts originals (copies live in src/onboarding/extraction-ladder/)`. Result: **directory removed entirely**.
Delete exclusive repos/tests:
- `src/db/repositories/agent-version-repo.ts`, `agent-evaluation-repo.ts`
- All **63 exclusive test files** (§0.7 list) + `rm src/tests/unit/*.db-shm src/tests/unit/*.db-wal` artifacts.
Edit:
- `vitest.config.ts`: remove the 30 PI exclude entries.
- `package.json` `test:db`: remove all PI test paths (~20 references across the chained `bun test` invocations).

**PR 3.3 — Kill-switch rename with alias window (ruling D)**
`src/classification/ocr-stage-flags.ts`:
- Rename constant: `OCR_KILL_SWITCH_ENV = 'BAYSTATE_CMS_OCR_KILL_SWITCH'`.
- Effective kill switch: `parseBooleanEnv(env[OCR_KILL_SWITCH_ENV], false) || parseBooleanEnv(env['BAYSTATE_CMS_PI_KILL_SWITCH'], false)` — **old name still honored** during the alias window; consumer (dominance in `loadOcrStageFlags`/`getOcrStageFlags`) updated in the same commit, never deleted before consumer update.
- Rewrite module docblock precedence section; add `@deprecation` note with removal milestone.
Update tests `classification-ocr-stage-flags.test.ts` (new name sets dominance; legacy name STILL sets dominance; both unset clears) and `packaging-ocr-consumer-wiring.test.ts`.

**PR 3.4 — Documentation**
- New `docs/adr/0030-agent-lab-decommission.md`: decision, scope split (deleted/relocated/deferred), rulings A–F, data retirement policy, `product_intelligence_assets` + `pi_reuse_policies` naming-history footnote (ruling C), alias-window removal date.
- Add `Status: Superseded by ADR-0030` headers to ADRs 0010, 0018, 0020, 0021, 0022, 0023, 0024, 0025, 0026, 0027, 0028, 0029 (0014 amended, not superseded: edit PI-6 references to point at `src/onboarding/image-verification/`).
- Project `AGENTS.md`: replace the "Product Intelligence (Agent Lab, PI-1)" section with a short decommission note pointing to ADR-0030; scrub PI bullets from Onboarding sections (PI-8/PI-9 mentions).
- `CONTEXT.md`: re-point "PI-6 rights verification" (line 605) to the relocated home; add naming footnote for `product_intelligence_assets`/`pi_reuse_policies`.
- Runbooks/docs banners: `taxonomy-v4-activation.md` (reword "PI taxonomy tools"), `docs/pi-review-remediation.md`, `docs/pi-smoke-findings.md`, `docs/governance-17-alignment.md`, `docs/handoff-issue17-chatgpt-review.md`, `docs/plans/agent-lab-training-interface-spec.md` → historical banner, content preserved.

**Phase 3 validation gates**
- `bun run typecheck && bun run lint && bun run test && bun run test:db` green.
- Grep sweeps (zero hits unless noted):
  - `grep -rn "product-intelligence" src --include='*.ts*'` → only `image-verification`/`extraction-ladder` internal comments referencing history; no imports.
  - `grep -rn "SessionManager\|pi-tool-registry\|submit_product_research" src` → 0.
  - `grep -rn "BAYSTATE_CMS_PI_" src` → only the alias literal in ocr-stage-flags.ts (+ its two tests).
  - `grep -rn "seedDefaultApprovedPolicy" src` → 0.
  - `grep -c "DROP TABLE" src/db/migrations.ts` → unchanged (0 drops until Phase 4).
  - `git grep -n "benchmark" src/server/routes/benchmark-routes.ts` intact; benchmark tests green.
- Runtime smoke: `bun run dev` → health check, onboarding board, distributor imagery verify endpoint, packaging-OCR stage flag load (kill-switch dominance off by default), store-manager image repair path.

**Rollback point:** tag `pre-agent-lab-decommission-p4`; PR-level `git revert` (3.1 is the largest — revert restores full server surface since DB writes were additive-only and tables still exist).
**Risk mitigations:** hidden importers (mitigation: grep sweep + typecheck are blocking gates); SSE consumers other than Agent Lab (verified: PipelineBoard uses `/api/onboarding/batches/:id/events`, independent); `sharp` dependency retained (used by relocated contract.ts).
**Touch count:** ~110 deletions (63 tests + ~45 sources + repos) + ~15 edits + ~16 doc touches ≈ **140 paths**.

---

## Phase 4 — Data retirement (audit-gated; may lag Phase 3 by one or more releases)

**GATE (fail-closed, human-approved):** run `scripts/pi-decommission-audit.sql` again and require ALL of:
1. `product_intelligence_imports` total count = **0** (conservative: not merely active = 0);
2. zero onboarding items carrying non-empty `productIntelligenceEvidence`;
3. archived dumps from Phase 0 verified against current tables (checksum manifest matches — nothing written since archive);
4. **verified SQLite backup taken and validated with the existing backup-verifier tooling** BEFORE any destructive step (project constraint: verified backups first).

**PR 4.1 — Remove import gate (ruling F satisfied: first change to gate since inception)**
- `src/onboarding/draft-promoter.ts`: remove import (line 12), update boundary comment (~651), delete gate invocation block (lines ~776–786: `const importGate = verifyImportedResultGate(item); if (!importGate.ok) {…continue;}`).
- Delete `src/onboarding/imported-result-gate.ts` (+ slim intake repo) and its tests.
- Update `draft-promoter.test.ts`: convert imported-result gate cases to assert promotion proceeds when legacy PI evidence is absent; keep historical-data tolerance assertions.

**PR 4.2 — Destructive cleanup migration (dev/local DBs)**
Append a NEW section to `src/db/migrations.ts` (past sections untouched — append-only history):
- Key: `app_meta.decommission_pi_schema_version`.
- Inside one transaction: `DROP TABLE IF EXISTS` for the PI-exclusive set (§0.5 runs family + specialists workflows + `pi_approved_policies`, `pi_budget_policies`, `pi_retention_policies`, `pi_evaluation_runs`, `pi_review_decisions`, `pi_source_authorities`, `pi_page_artifacts`, `pi_image_candidates`, `agent_version_snapshots`, `agent_version_states`, `agent_evaluation_snapshots`, `agent_evaluation_cases`, `profile_engineer_domain_workflows`) + their `idx_pi_*`/`idx_agent_*` indexes + `DELETE FROM app_meta WHERE key IN (<20 PI version keys>)`.
- **Explicitly NOT dropped:** `product_intelligence_assets`, `product_intelligence_assets_new`, `pi_reuse_policies` (all live-written by the onboarding distributor-imagery flow; names preserved per ruling C — history documented in ADR-0030), all `benchmark_*` tables, `cohort_shadow_observations`.
Fresh dev DBs execute create-sections then the drop section — net-empty but historically consistent (accepted; migrations are append-only).

**PR 4.3 — Migration test + docs closeout**
- Update `src/tests/unit/db-migration.test.ts`: assert PI-exclusive tables absent post-migration; assert `product_intelligence_assets`, `pi_reuse_policies`, `benchmark_datasets` still present; assert PI `app_meta` keys removed.
- Final grep sweep repo-wide: `grep -rn "verifyImportedResultGate\|product-intelligence" src` → 0 source hits (table-name string literals in repos/migrations and docs remain intentionally).
- Alias-window removal checklist appended to ADR-0030 (remove `BAYSTATE_CMS_PI_KILL_SWITCH` fallback in a later release once operators confirmed migrated).

**Validation gates:** `test:db` (includes db-migration suite) green; backup restore drill on a scratch copy before running migration against the real dev DB; post-migration audit queries show kept tables intact with row counts unchanged.
**Rollback:** destructive migration is NOT auto-revertible — rollback = restore the verified backup + `git revert` PR 4.1. This is why the gate requires zero imports and fresh archives first.
**Touch count:** ~6 files edited/deleted + migrations.ts append (~90 lines) ≈ **8 paths**.

---

## Dependency graph & worker slicing

```
P0.1 → P0.2
P0.* → P1.1 → P1.2 → P1.3 → P1.4 → P1.5 → P1.6        (sequential; 1.4 depends on 1.1+1.3)
P1.* → P2.1 → P2.2                                     (frontend; independent of P3 code-wise but ordered per ruling B)
P2.* → P3.1 → P3.2 → P3.3 → P3.4                      (server; 3.3 independent of 3.2 but sequenced for review clarity)
P3.* → (operator gate) → P4.1 → P4.2 → P4.3           (data; may lag releases)
```
One worker per phase series, sequential phases. Within a phase, PR order above is mandatory where noted (compile-coupled pairs: 3.1 atomic; 1.4 cutover last step).

## Estimated totals
| Phase | New files | Edited | Deleted | Total paths |
|---|---|---|---|---|
| 0 | 3 | 1 (.gitignore) | 0 | 4 |
| 1 | 20 | 10 | 0 | 30 |
| 2 | 2 | 3 | 44 | 49 |
| 3 | 1 (ADR) | 15 | ~125 | ~141 |
| 4 | 0 | 5 | 3 | 8 |
| **Σ** | **26** | **34** | **~172** | **~232** |

## Residual risks
1. **Dirty worktree (107 files, App.tsx included):** merge friction if parallel work lands mid-effort. Mitigation: sequential workers, per-PR rebase discipline, never stage others' hunks.
2. **Divergence window** between duplicated assets/ladder code (P1 copies vs originals until P3). Mitigated by feature freeze; worst case is wasted cleanup.
3. **Hidden runtime consumers** not caught by static grep (e.g., operator scripts hitting PI REST endpoints). Mitigation: routes return 404 after P3 — acceptable fail-closed; announce endpoint removal in release notes.
4. **Destructive migration irreversibility.** Mitigated by conservative gate (total imports = 0), checksummed archives, verified backup + restore drill before executing.
5. **Kill-switch alias confusion:** operators may keep setting the old var post-window. Mitigation: deprecation log line when legacy var observed, removal checklist in ADR-0030.
6. **`getOcrStageFlags()` override path:** verify the rename covers BOTH `loadOcrStageFlags(env)` and `getOcrStageFlags()` dominance re-application (tests in PR 3.3 cover both).
7. **Sourcing engine coupling:** CONTEXT.md/ADR-0014 reference "PI-6 rights verification"; relocated home must be referenced everywhere or future agents will hunt deleted paths.

## Open questions requiring human decision before implementation
1. **`src/shared/schemas/agent-training.ts` fate after PR 1.3:** keep (decoupled, ready for a future training effort) or delete in P3 (its remaining consumers are all deleted)? Default plan: delete in P3 unless the training program is being preserved.
2. **Archive location:** `archive/` gitignored in-repo (plan default) vs external storage volume. Affects PR 0.1.
3. **Phase 4 timing:** run destructive dev-DB cleanup immediately after P3 sign-off, or defer one release alongside alias removal?
4. **Alias window length:** confirm what "one release" means concretely for this project (calendar/tag-based).
5. **`specs/**` references** (release-plan.yaml, verifications, tech-stack mention PI): update as living documents, or freeze as historical audit artifacts? Plan default: leave untouched except a pointer note, pending owner preference.
6. **ReviewWarningsPanel PI-evidence line:** keep until P4 completes (plan default), then drop in P4.3?
