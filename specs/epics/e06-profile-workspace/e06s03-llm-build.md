# e06s03 — LLM-assisted build + deterministic validation — Generate/Suggest/Explain/Revise task buttons with per-field governance

> story: e06s03
> epic: e06 — Brand Domain Profile Workspace + Guided Setup
> status: planned
> bcps: 5
> risk: P1
> type: feat

<!-- story: e06s03 -->

## 1. Business narrative

Operators building an extractor profile for a domain currently have a single one-shot `Generate selectors` action fed by one snapshot and a Save path that bypasses governance (`SaveBar`/`useProfileBuilderController` allow save on domain+dirty; `onboarding-routes:2636` upserts). There is no per-field task tooling, no explain/revise loop, and no visible provenance of which model/prompt touched merchant HTML. This story introduces bounded task buttons inside the domain Profile Workspace that keep deterministic discovery and validation authoritative while letting the LLM only propose schema-validated alternatives.

## 2. User / actor

Internal admin / power-user operating the Profile Workspace at `/settings/domains/:domain/profile` with 3 confirmed representative products already selected. No external merchant actor.

## 3. Requirements

#### ADDED: Task-button LLM tooling — Generate / Suggest / Explain / Revise
Four bounded buttons in the workspace Build canvas: **Generate draft from samples**, **Suggest alternatives for this field**, **Explain this validation failure**, **Revise from structured feedback**. Deterministic discovery (JSON-LD, Shopify/WooCommerce embedded state, `inspectSnapshot`) runs first; only sanitized HTML/snapshots of the 3 confirmed products are sent to the LLM. The LLM returns `LlmGenerationResult` schema-validated candidates (selector + evidence, warnings) which are normalized via `validateAndRankSelectors` / `customFieldNormalizer`.

#### ADDED: Deterministic validation before display
Every LLM candidate is ranked through syntax / domain / match-count / visibility / cross-sample / identity / variant checks via the existing profile runner (`profile-runner-client` / `selectorValidator`). Invalid candidates are shown as warnings, never as active values.

#### ADDED: Provenance + disclosure
Every proposal records `provider / model / promptHash / configId / whether HTML left machine` and surfaces a disclosure badge (cloud permitted by default). Same provenance fields are persisted with the revision so History can show actor/model/config and artifact hashes.

#### MODIFIED: Per-field governance in build canvas
**Before:** Build canvas showed draft values with a single Save that could activate without per-field decisions; validation failures were warnings only.
**After:** Build canvas groups fields (Identity / Description / Media / Commerce / Nutrition / Variants) and for each field shows active vs draft vs LLM alternatives + stability/cardinality warnings + extracted previews; human must accept/reject/revise per field (`profile-governance-service` / `profile-generation-field-decision-repo`); unsupported-for-domain is explicit; LLM output never directly saves or activates; Save path is blocked unless governance allows it.

#### ADDED: LLM unavailability fails clearly
When no model route / `LlmTaskConfig` is configured, Generate/Suggest/Revise enter an actionable error state (no silent success, no mutation). Deterministic validation and evidence rail still work without the LLM.

## 4. Solution

Reuse `generateSelectorsService` orchestration (resolve artifact → sanitize HTML → preflight → resolve LLM config via `llm-task-config-repo` → build prompt → call LLM → parse `LlmGenerationResultSchema` → validateAndRank → normalize). Extend the service/route to accept the **3 confirmed samples as the source set** (resolved via `brand_url_index` + `onboarding-source-repo.listValidationSamplesByDomain` / new confirmed-suite accessor) instead of a single artifact, and expose three new route affordances that reuse the same pipeline: single-field `suggest`, `explain` passthrough, and `revise` with structured feedback. Client hook `useProfileBuilderController` gains `suggestAlternatives(field)`, `explainFailure(field)`, `reviseFromFeedback(feedback)` that dispatch reducer actions with provenance payloads. Build canvas components render the per-field governance surface and the disclosure badge. Save/Activate guards call `profile-governance-service` gates (`imagesSelector` multi-product rule, per-field decisions) before any `extractor_profiles` mutation; the legacy direct upsert at `onboarding-routes:2636` is put behind the governance check.

## 5. Zoom-out

* **Purpose of modified modules:** `generateSelectorsService` — one-shot LLM selector generation; `profile-governance-service` — enforces proposal-only, per-field approval, image multi-product rule, versioning; `useProfileBuilderController` + `profileBuilderReducer` — orchestrate builder UI workflows; `extractor-profile-repo` / `profile-generation-*` repos — persist profiles, generations, revisions, field decisions.
* **Callers:** `onboarding-routes.ts` (Hono routes: `generateSelectors`, `validateProfile`, `snapshotPage`), `ProfileBuilder.tsx` / `ProfileBuilderWorkspace.tsx`, `OnboardingSettings.tsx` / `Onboarding.tsx` (embed points being consolidated), future Test Matrix (e06s04) which consumes validated selectors.
* **Contracts preserved:** AI-generated profiles are proposals only; approval is per field; image approval requires ≥2 same-domain passed samples + preview attestation; validation samples are confirmed-only (`is_selected=1` + domain match); revisions are versioned; field decisions carry `previous_selector` for rollback; no ShopSite credential echo; HTML sanitization before LLM call; deterministic runner remains the authority.

## 6. Constraints

From `SCOPE_LATEST.yaml` + `planning-context.yaml`: domain-scoped profiles; `brand_url_index` is the source (not `product_pages`); 3 confirmed minimum (waiver handled in e06s02, consumed here); immutable revisions + active-version pointer (e06s04); human per-field approval mandatory; cloud LLM permitted by default with disclosure and recorded `provider/model/prompt/config`; parse via `GenerateSelectorsResponseSchema` / `LlmGenerationResultSchema`; server-side SSRF/policy checks if HTML leaves machine (reuse PI `PolicyGateway` pattern where applicable); no open-ended chatbot; no auto-activate.

## 7. Implementation Steps

**type:** feat
**risk:** P1
**context:** domain

1. Extend `generateSelectorsService` + Hono routes to accept the 3-confirmed-suite snapshot set, run deterministic discovery first, validate LLM candidates via `validateAndRankSelectors`, and record provenance (provider/model/configId/promptHash/htmlLeftMachine) → verify: `bun run typecheck && bunx vitest run src/tests/unit/generate-selectors-schemas.test.ts src/tests/unit/selectorValidator.test.ts 2>&1 | tail -n 40`
2. Add `suggest / explain / revise` affordances reusing the same sanitize→LLM→parse→validate pipeline (single-field suggest, explain passthrough, structured-feedback revise) with disclosure badge data → verify: `bun run typecheck && bunx vitest run src/tests/unit/profile-llm-propose.test.ts 2>&1 | tail -n 40`
3. Build workspace Build canvas per-field governance UI (grouped fields, active vs draft vs LLM alternatives, stability/cardinality warnings, extracted previews, accept/reject/revise, explicit unsupported-for-domain, pending decisions prevent Save/Activate) and wire `useProfileBuilderController` task buttons + provenance dispatch → verify: `bun run typecheck && bunx vitest run src/tests/unit/profile-governance.test.ts src/tests/unit/profile-build-canvas.test.ts 2>&1 | tail -n 40`
4. Guard the save/activate path: route `onboarding-routes:2636` + reducer `SaveBar` checks call `profile-governance-service` gates (per-field decisions, `MIN_IMAGE_APPROVAL_SAMPLES`, single-sample warning) before any `extractor_profiles` write; LLM output can never activate directly → verify: `bun run typecheck && bunx vitest run src/tests/unit/profile-governance.test.ts src/tests/unit/savebar-governance.test.ts 2>&1 | tail -n 40`
5. Implement LLM-unavailable fail-clearly: when `getLlmTaskConfig` returns null / provider route missing, buttons render actionable error, no mutation, deterministic evidence rail still works → verify: `bun run typecheck && bunx vitest run src/tests/unit/profile-llm-unavailable.test.ts 2>&1 | tail -n 40`

## 8. Verification Script (Step-by-Step)

1. Ensure 3 confirmed products exist for a domain (via e06s02 suite).
2. Open `/settings/domains/example.com/profile`.
3. Click **Generate draft from samples** → observe disclosure badge ("HTML sent to <provider/model>" or "local only") and LLM alternatives per field with provenance.
4. For a field with a failing selector, click **Explain** → see per-field expanded reason (expected vs actual, provenance, artifact) derived from runner validation.
5. Click **Suggest alternatives for this field** → see schema-validated candidates with evidence/warnings; accept one vs reject vs unsupported-for-domain.
6. Try Save/Activate before accepting required fields → mutation blocked.
7. Accept required per-field decisions, then Save → revision created with field decisions + provenance visible in History.
8. Remove `llm_task_config` / disable model route → Generate/Suggest/Revise show actionable error, no save; deterministic previews still render.

## 9. Out of scope

- Full-width Test Matrix rows/cols, activation gate, immutable version history and domain task parking — e06s04
- Guided brand→domain→index→confirm suite UI and waiver persistence — e06s02
- Workspace shell / route / header / readiness rail / navigation — e06s01
- Open-ended chatbot UX, multi-domain batch generation, Sourcing/Discovery heuristic changes, `product_pages` or Category Page assignment changes

## 10. Risks

- Reusing `generateSelectorsService` as a single-sample one-shot without wiring the 3-sample set could regress coverage — mitigate by resolving the confirmed suite explicitly and validating all samples cross-sample.
- Bypassing `profile-governance-service` via the legacy upsert would silently reintroduce activation without approval — mitigate by putting every save path behind the governance gate and adding a regression test for the bypass.
- Sending unsanitized HTML or forgetting the disclosure badge breaks the cloud-permitted-by-default contract — mitigate by keeping `sanitizeSnapshotHtml` + provenance flag in the pipeline and rendering the badge from the route response.
- Treating unconfirmed `brand_url_index` rows as ground truth inflates false failures — mitigation is in e06s02; this story consumes only confirmed rows.

## 11. Acceptance Criteria ( §17 Gherkin )

- **Given** a domain with 3 confirmed products, **when** the operator clicks Generate draft, **then** deterministic discovery runs first, sanitized snapshots are sent to the LLM, schema-validated candidates with evidence/warnings are returned, ranked by the determinant validator, and shown per field with provenance + disclosure.
- **Given** LLM alternatives for a field, **when** the operator has not accepted/rejected per field, **then** Save and Activate are blocked and unsupported-for-domain is an explicit option; LLM output alone never mutates `extractor_profiles`.
- **Given** a failing field, **when** the operator clicks Explain or Suggest, **then** the failure reason (expected vs actual, provenance, artifact, variant signal) is surfaced and a revise-from-feedback loop reuses the same validate pipeline.
- **Given** no LLM task config / model route, **when** the operator invokes Generate/Suggest/Revise, **then** an actionable error is shown, no profile mutation occurs, and deterministic validation + evidence rail remain usable.

## 12. Traceability

`story: e06s03` — LLM-assisted build + deterministic validation. Tasks in `e06s03-tasks.yaml` map 1:1 to the Implementation Steps above. Verifies via `bun run typecheck && bunx vitest run …` commands listed per task.

## 13. Dependencies

Requires e06s02 confirmed suite (3 products + waiver model) and e06s01 workspace shell. Produces validated draft revisions consumed by e06s04 Test Matrix + activation gate. Reuses `generateSelectorsService`, `selectorValidator`, `profile-governance-service`, `profile-generation-*` repos, `llm-task-config-repo`.

## 14. Security

No new auth boundary; workspace ownership (404 cross-workspace) already enforced for profile routes. HTML sanitization before any LLM call remains mandatory; no credential echo. Content-size and image checks stay in the runner.

## 15. Performance

Bound the runner fan-out: `MAX_VALIDATION_SAMPLES = 10`, `MIN_IMAGE_APPROVAL_SAMPLES = 2`; LLM timeouts 45s (cloud) / 120s (ollama) as today. No new heavy dependencies.

## 16. Observability

Record `provider / model / promptHash / configId / htmlLeftMachine` on every proposal; surface in header disclosure + History row. Existing `generateSelectors` logging path (`requestId`, `userId`) continues.

## 17. Rollback

Reverting this story restores the single one-shot Generate path and the legacy Save bypass; governance gates re-default to warning-only. No data migration to reverse (revisions already versioned) — future revisions would simply stop recording the new per-field provenance.

## 18. Alternatives considered

Task buttons vs open-ended chatbot — task buttons chosen to preserve proposal-only governance + auditable per-field decisions. Multi-sample generation vs single anchor page — multi-sample chosen because oracle found sitemap rows can be mislabeled and one-page selectors often overfit templates.

## 19. Open questions

None — cloud-permitted-by-default, 3-sample requirement, and no-grandfathering are locked in `planning-context.yaml` and `SCOPE_LATEST.yaml`.

## 20. References

- `specs/product/SCOPE_LATEST.yaml` (e06s03), `specs/planning-context.yaml` (bounded workspace seam), `specs/tech-architecture/tech-stack.md` (Hono, Bun 1.3.5, PI execution boundary)
- `src/server/services/profile-builder/generateSelectorsService.ts`, `src/server/routes/onboarding-routes.ts:2636`, `src/onboarding/profile-governance-service.ts`, `src/client/components/profile-builder/hooks/useProfileBuilderController.ts`, `src/db/repositories/profile-generation-*.ts`, `src/shared/schemas/selector-generation.ts` (`GenerateSelectorsResponseSchema`, `LlmGenerationResultSchema`)
- AGENTS.md § Onboarding Pipeline + Profile Builder; CONTEXT.md (Category Page, Product Type, etc.)
