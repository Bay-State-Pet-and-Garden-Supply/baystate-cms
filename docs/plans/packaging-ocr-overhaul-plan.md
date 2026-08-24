# Packaging-OCR Stage Overhaul — Implementation Plan

**Target repo:** `/Users/nickborrello/Desktop/Projects/shopsite-cms`
**Status:** Approved 2026-08-24. Produced by the `planner` agent from a three-angle research pass (external model landscape, local codebase recon, tradeoff analysis); every citation re-verified against the repo.
**Governing docs:** ADR 0004 (compose-from-replaceable-stages), ADR 0026 (Curator specialist), ADR 0027 (Verifier), ADR 0028 (Orchestrator), ADR 0029 (evals/shadow/rollout gates), AGENTS.md, `src/classification/flags.ts` (flag pattern).

---

## 0. Verified ground truth

| # | Symptom | Verified location | Severity |
|---|---------|-------------------|----------|
| 1 | Fail-silent OCR: every failure class returns `null`, console.warn only | `src/onboarding/packaging-ocr.ts:399-586` (docstring :392-397; null returns at :459, :476, :527, :540, :551, :561) | High |
| 2 | Stale hardcoded model `'gemma-4-26b-a4b-qat'` as fallback when route modelId empty | `src/onboarding/vlm-client.ts:42` | High |
| 3 | Hardcoded `'qwen2.5vl:latest'` defaults (config-only swaps silently revert to these literals) | `vlm-client.ts:62`; `provider-connection-repo.ts:155,:275,:422,:461`; `shared/schemas/classification.ts:226,:297`; `client/components/AiComputePanel.tsx:56`; `server/routes/onboarding-routes.ts:3053` | High |
| 4 | Split-brain settings surface: AI Compute `visionOcr` route vs legacy `api_keys.ollama_vlm` fallback; silent catch swallows routing errors | `vlm-client.ts:30-72` (catch at :50-52); display special-case `onboarding-routes.ts:2977-2982` | Medium |
| 5 | Frozen-hash gating discards valid stored OCR when digest changed; no re-run trigger | `src/classification/stages/evidence-extraction.ts:189-220`; digest fn `runtime-snapshot.ts:649-671`; settled check treats any terminal status as done (`cohort-curator.ts:236-244`, `curation-cohort-service.ts:300-305`) | High |
| 6 | Resilience gaps: single attempt, `AbortSignal.timeout(120_000)` (`vlm-client.ts:186`), serial per-image max 2 (`product-evidence-extractor.ts:713-720`), global `acquireLocalSlot('ollama')` semaphore with unbounded queue (`local-runtime-coordinator.ts:29-41`), no circuit breaker | confirmed | Medium |
| 7 | Swallowed errors in `getVlmConfig`, curator refresh, promoter fire-and-forget | `vlm-client.ts:50-52`; `product-curator.ts:783-791`; `draft-promoter.ts:609-631` | Low/Medium |
| 8 | Mirrored conversion logic + repository violations | `classification/cohort-product-type-resolver.ts:100-137+` ("mirror" doc); inline `getDb().query` at `product-curator.ts:767,:818` and `stages/evidence-extraction.ts:267,:495` | Low |

**Pinned contracts that constrain the design** (verified):
- `PackagingOcrDataSchema` (`src/shared/schemas/onboarding.ts:51-99`) — frozen-hash materialization depends on stable shape.
- `OcrAttemptOutcomeSchema` (`onboarding.ts:141-154`) already has optional `error`/`reason` fields — additive extension is safe.
- Source needles in `tests/unit/pi-network-boundary.test.ts:138-144`: `fetchFn?: NetworkFetch` on `extractPackagingOcr` params; exact string `callVlm(PACKAGING_OCR_PROMPT, base64Image, vlmConfig, modelFetchFn ?? fetchFn)` asserted at :594-597; `fetchFn: NetworkFetch = fetch` needle on `callVlm` (:142).
- Frozen-plan authority: run-bound calls must never read mutable `ollama_vlm` mid-run (`packaging-ocr.ts:365-367,418-420`; `runtime-snapshot.ts:324-325`; `model-operation-registry.ts:150-152`).
- `isAiComputeConfigured()` pristine-detection compares literal seed values (`provider-connection-repo.ts:422`) — changing default *values* later must update this atomically.
- Workspace versioned config artifacts (`classification/config-seeds/bay-state-pet-garden-v1.ts:755`, `snapshots/*/model-policies.json`) hardcode `qwen2.5vl:latest` but are content-addressed — editing them shifts `bundleHash`/OCR execution digests. **Deliberately out of scope.**

---

## 1. Phase-by-phase work breakdown

### PHASE 1 — Fix brokenness + make model data-driven (A + B-lite)

#### P1-T1 · Structured OCR attempt result & failure-reason taxonomy — **Size L**
**Files touched:** `src/shared/schemas/onboarding.ts`, `src/onboarding/packaging-ocr.ts`
**Files created:** `src/onboarding/ocr-failure-reasons.ts`

1. New shared taxonomy module `src/onboarding/ocr-failure-reasons.ts`: a zod enum + const map of reason codes:
   `not_configured | policy_denied | plan_incompatible | no_image | image_fetch_failed | image_http_error | image_too_small | image_svg_unsupported | timeout | http_error | transport_error | empty_response | unparseable_json | schema_coercion_failed | circuit_open | audit_terminal_write_failed`.
   Each code maps to a stable human-readable template (redaction-safe: no URL/host interpolation beyond existing `redactImageUrl`).
2. Extend `OcrAttemptOutcomeSchema` (`onboarding.ts:144-153`) additively: optional `localFailureReason?: OcrFailureReason | null`, `cloudFailureReason?: ...`, `attempts?: number`. All optional → zero breakage for persisted rows or consumers.
3. In `packaging-ocr.ts`, introduce new core entry point `runPackagingOcr(params): Promise<PackagingOcrAttempt>` returning `{ ok: true, data } | { ok: false, reasonCode, redactedMessage, httpStatus?, callId? }`. Keep `extractPackagingOcr` exported as a thin adapter so all current callers compile unchanged.
4. **Preserve pinned needles exactly**: keep param `fetchFn?: NetworkFetch`; keep the literal transport line `callVlm(PACKAGING_OCR_PROMPT, base64Image, vlmConfig, modelFetchFn ?? fetchFn)` inside the non-dispatcher branch.
5. Bounded retry (inside `runPackagingOcr`, around transport only): max 2 attempts total for transient classes only (`timeout`, `http_error` with 429/5xx, `transport_error` connection-refused). Per-attempt timeout env `BAYSTATE_CMS_OCR_TIMEOUT_MS` (default `120000`). No retry on parse/coercion failures.

**Behavioral contract / fail-closed invariant:** a failure result NEVER throws across the pipeline boundary; every terminal path emits exactly one reason code; run-bound calls still write `insertModelCallStart` before any transport and a terminal audit row on every path.

#### P1-T2 · Circuit breaker at the orchestration layer — **Size M**
**Files created:** `src/onboarding/vlm-circuit-breaker.ts`
**Files touched:** `src/onboarding/packaging-ocr.ts` (invocation site), `src/ai/local-runtime-coordinator.ts` (expose breaker stats alongside `getLocalConcurrencyStats`)
1. Module-level breaker keyed by `${baseUrl}|${model}`: states `closed → open → half-open`; trip after N consecutive transport-class failures (default 3), cooldown (default 60s, env-tunable `BAYSTATE_CMS_VLM_BREAKER_COOLDOWN_MS`), single probe in half-open. Success resets.
2. Placement: checked in `runPackagingOcr` **before** `insertModelCallStart`. NOT inside `callVlm` — that transport stays a raw, test-pinned primitive. Dispatcher path gets its own breaker instance keyed identically.
3. Breaker state is in-memory per process; reset hooks exported for tests.

#### P1-T3 · Digest-staleness re-run trigger — **Size M**
**Files touched:** `src/onboarding/cohort-curator.ts` (freeze finalization, `isOcrSettled` :236-244), `src/onboarding/curation-cohort-service.ts`, `src/classification/stages/evidence-extraction.ts` (metadata only)
1. At freeze, when a member has stored `packagingOcrData` but digest mismatches, treat OCR as **not settled**: invalidate stored data (`localFailureReason:'plan_incompatible'`, marker `ocrStale:true`), then run the existing freeze pull-forward OCR path under the *new* authority so fresh data+digest bind atomically.
2. Same rule in legacy/non-cohort readiness where a snapshot is available.
3. Stampede guard: per-freeze re-run cap (env `BAYSTATE_CMS_FREEZE_OCR_RERUN_CAP`, default 12 members per cohort pass) + existing slot serialization + P1-T2 breaker.

#### P1-T4 · Surface swallowed errors — **Size S**
**Files touched:** `src/onboarding/vlm-client.ts:50-52`, `src/onboarding/product-curator.ts:783-791`, `src/onboarding/draft-promoter.ts:609-631`
Replace bare catches with warn-level structured logs carrying reason codes/redacted messages (behavior-preserving).

#### P1-T5 · Single-source vision-model defaults (B-lite) — **Size M**
**Files created:** `src/ai/vision-model-defaults.ts` exporting `DEFAULT_LOCAL_VISION_MODEL = 'qwen2.5vl:latest'`, `LEGACY_ROUTE_FALLBACK_VISION_MODEL = 'qwen2.5vl:latest'` (replacing the stale `'gemma-4-26b-a4b-qat'`), and `FALLBACK_MODEL_SUGGESTIONS`.
**Files touched (literal → constant import):** `vlm-client.ts:42,:62`; `provider-connection-repo.ts:155,:275,:422,:461`; `shared/schemas/classification.ts:226,:297`; `client/components/AiComputePanel.tsx:56`; `server/routes/onboarding-routes.ts:3053`.
**Critical constraints:** values stay byte-identical today except the :42 fallback (explicit behavior fix); **do NOT touch** `classification/config-seeds/*` or `classification/snapshots/*`.

### PHASE 2 — Modularize packaging OCR as an ADR-0004 classification stage (flag-gated, dual-run)

- **P2-T1 (S):** Shared pure OCR→evidence converter `src/classification/ocr-evidence.ts`; delete mirrored copy in `cohort-product-type-resolver.ts`.
- **P2-T2 (L):** New `packaging_ocr` stage (`src/classification/stages/packaging-ocr-stage.ts`) registered before `evidence_extraction`; skip-not-fail for distributor/null-image items; run-bound discipline identical to today's freeze pull-forward.
- **P2-T3 (S):** Flags `src/classification/ocr-stage-flags.ts` cloning the `flags.ts` pattern.
- **P2-T4 (M):** Dual-run shadow harness — additive `packaging_ocr_shadow_comparisons` table + repo; shadow writes never mutate live keys.
- **P2-T5 (S):** Repository-pattern cleanup within touched code.
- **P2-T6 (M):** Consumer migration (ordered; §6). PI tool boundary and cloud VLM client retained unchanged.

### PHASE 3 — Golden-set evaluation harness + measured default flip

- **P3-T1 (L):** `src/onboarding/ocr-eval/{golden-dataset,runner,metrics}.ts`; operator-curated images content-addressed by SHA-256; candidates evaluated via injected `fetchFn`; metrics: field-level normalized match, hallucination rate, empty-rate, JSON-parse success, latency p50/p95.
- **P3-T2 (M):** temperature=0 greedy pass; repetition-tail detection → one bounded retry with `frequency_penalty≈0.3` (flagged).
- **P3-T3 (S):** Runbook `docs/runbooks/packaging-ocr-model-rollout.md` with pre-registered thresholds (UPC accuracy ≥ baseline − ε, hallucination ≤ baseline, p95 ≤ 2× baseline on ≥N samples).

## 2. Task ordering & dependencies

```
P1-T1 ──► P1-T2 ──► P2-T2 ──► P2-T4
  │          └──────────────► P2-T4
  └──► P1-T3
P1-T4 (independent)
P1-T5 (independent; prerequisite for P3-T3 flip)
P2-T1 (independent; prerequisite for P2-T2)
P2-T3 (independent; needed by P2-T2/T4)
P3-T1 ──► P3-T2 ──► P3-T3
```

Ship order within P1: T5 → T4 → T1 → T2 → T3.

## 3. Flag strategy

| Flag | Env var | Default |
|---|---|---|
| `packagingOcrStageEnabled` | `BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED` | `false` |
| `packagingOcrStageShadowOnly` | `BAYSTATE_CMS_PACKAGING_OCR_STAGE_SHADOW_ONLY` | `true` |
| `packagingOcrDualRunCompare` | `BAYSTATE_CMS_PACKAGING_OCR_DUAL_RUN` | `false` |
| `packagingOcrRetriesEnabled` | `BAYSTATE_CMS_OCR_RETRIES_ENABLED` | `false` |

Kill switch dominance: PI kill switch forces legacy everywhere. Unparseable env values fall back to defaults.

## 4–6. Test strategy, observability, migration/rollback

See sections 4–6 of the approved planning session (test plans per phase, taxonomy persistence via additive `OcrAttemptOutcomeSchema` fields, breaker stats exposure, dual-run comparison rows, ordered consumer migration with flag-off rollback).

> **Post-review deviation note (§6):** (1) Dual-run comparison rows require a
> stored legacy baseline — the stage only writes a comparison row when a
> legacy inline result (`ocrOutcome` / `packagingOcrData`) already exists in
> `extraction_data_json`, so fresh items that have never run legacy OCR write
> none. (2) Freeze delegation additionally respects shadow-only: the cohort
> freeze delegates its OCR moment to the packaging_ocr stage only when the
> master flag is ON **and** shadow-only is OFF; under master ON + shadow ON
> (the defaults) the freeze stays on the legacy pull-forward while the
> pipeline-level stage still runs in shadow.

## 8. Definition of done per phase (measurable)

- **P1:** zero `return null` branches in the OCR core lacking a reason code; every persisted failed `ocrOutcome` carries a failure reason; forced digest mismatch demonstrably re-runs OCR at freeze within cap; `grep -r "qwen2.5vl:latest" src` shows literals only in `vision-model-defaults.ts` (excluding versioned seeds/snapshots/tests); typecheck + vitest + `test:db` green; pi-network-boundary needles intact.
- **P2:** flag OFF ⇒ byte-identical legacy outputs on a fixture cohort; dual-run comparison rows for 100% of attempted items; live keys untouched in shadow mode; resolver mirror deleted with equivalence test passing.
- **P3:** deterministic scores on frozen ≥30-image labeled set across ≥2 candidates; gate report with sample sizes + intervals; flip executed only via documented runbook with pre-registered thresholds.
