# Introduce a Product Intelligence execution boundary with a Pi adapter

**Status update (2026-08): SUPERSEDED operationally by ADR-0030 (Agent Lab decommission); paths below are deleted/historical.**

Product Intelligence (the Agent Lab program, epic #28) will run inside a provider-neutral execution boundary rather than being hard-wired to any agent runtime. The CMS workflow depends only on the `ProductIntelligenceExecutor` interface (`src/product-intelligence/executor.ts`): the agent researches and proposes, while deterministic CMS code validates, reviews, promotes, and publishes. The first adapter behind that boundary is the Pi SDK (`src/product-intelligence/pi/`), which is imported lazily so that onboarding, classification, review, and promotion never load Pi code unless a Product Intelligence run actually starts.

Agent output only becomes a candidate result through a terminal structured submission tool (`submit_product_research`) whose payload must validate against the durable Zod contract `StructuredSubmissionSchema` (with a mirror TypeBox schema as the runtime gate). Ordinary assistant prose is never authoritative. Runs execute under an immutable policy (tool allowlist, network and data-sharing policy, model route, budgets, hard deadline) and fail closed: sessions ending without a valid submission fail with `missing_submission`, unknown allowlisted tools are denied, an absent or uncredentialed model route refuses to start, caller `AbortSignal`s and hard deadlines are enforced, and sessions are always disposed. Pi sessions are in-memory, load approved extensions only (no project/global extensions, skills, or context files), and record exact Pi and extension versions. Feature flags (`productIntelligence.*`) are disabled by default and can be toggled at runtime without a redeploy; with every flag disabled, normal onboarding behaves exactly as before.

**Status**: accepted

**Context**: the existing onboarding system already ships production infrastructure for staged discovery, extraction, curation, review, promotion, evidence persistence, human proposal decisions, Git-backed catalog drafts, and ShopSite change sets (see issue #28). The missing layer is adaptive, evidence-backed product research. The audit-tracked governance program (issue #17) requires that any agent intelligence layer keep review and promotion fail-closed, treat model confidence as informational only, ground every claim in stored source evidence, and never invent taxonomy, Category Page, attribute, Product Type, or ProductField identifiers.

**Decision drivers**:

- The agent must be addable, shadowable, disableable, or replaceable without rewriting onboarding, classification, review, or promotion.
- Model self-reported confidence must never grant acceptance; deterministic CMS policy decides eligibility.
- Every factual output must cite stored source evidence; identity (exact GTIN and exact variant) is assessed separately from field quality.
- Images may only be proposed with rights and identity-match provenance; unknown-rights or unknown-match images are blocked.
- Runs must be reproducible from one immutable configuration, and Pi/extension versions must be recorded with the run.

**Consequences**:

- New agent runtimes implement `ProductIntelligenceExecutor` and plug in via `execution-router.ts`; no workflow code changes.
- The `submit_product_research` terminal contract is the only gateway for agent output into review; proposals remain subject to the existing human review and promotion gates.
- The TypeBox and Zod submission schemas are maintained in lockstep, guarded by schema-equivalence tests (`src/tests/unit/product-intelligence/schema-equivalence.test.ts`).
- Feature flags default everything off; Pi execution additionally requires a configured model route with valid credentials (fail-fast at session creation).
- PI-2 run/event/evidence persistence, PI-3 bounded research tools, and later phases build on this boundary; until then, the deterministic legacy executor returns `unavailable` rather than performing research.

**Considered options**:

- Provider-neutral executor interface with a Pi adapter (chosen) — matches the epic's "Pi must be addable, shadowable, disableable, or replaceable" requirement.
- Direct Pi invocation from onboarding code — rejected: couples the workflow to the runtime, blocks shadowing/comparison, and risks onboarding availability on Pi failures.
- Agent writes approved files directly — rejected outright by the program's product principle: deterministic CMS code validates, reviews, promotes, and publishes.

## Revised requirement: in-process execution boundary (P1-5)

Issue #22 originally scoped PI-5 sandboxing as a disposable container / micro-VM with no production DB credentials and no workspace write access. The implemented boundary is deliberately different, and this section formally revises the requirement for the **local single-operator deployment**:

- Pi sessions run **in the server process** behind the provider-neutral executor (`src/product-intelligence/executor.ts`) with the Pi SDK imported lazily (no Pi code loads unless a run starts).
- Rendered-browser work delegates to the **extraction worker** process (`src/extraction-worker/`), which enforces private/link-local destination floors on navigation and network capture.
- The resource loader refuses auto-discovered extensions, skills, templates, and project/global context files (approved-extension-only).
- The **PolicyGateway is the enforced network boundary** (P0-1): every external side effect reachable transitively from a PI tool — HTTP, search providers, OCR/model providers, browser navigation/network capture, managed providers — passes the server-authoritative policy (SSRF/private-IP rejection, per-hop redirect re-validation, size/type caps, data-sharing gates, audit rows) before execution. No raw `fetch()` bypasses the gateway in PI-reachable code.

### Risk register (accepted residual risks)

| ID | Risk | Mitigation in place |
| --- | --- | --- |
| R1 | **Supply-chain exposure** — the Pi SDK and model-provider clients run in the server process | Pinned dependency versions (`bun.lock` frozen install), npm/bun audit in the CI gate, minimal provider surface (only the routed model's client is loaded), lazy import so non-PI deployments never load Pi code |
| R2 | **Process secrets** — server env vars (API tokens, provider keys) are technically reachable from in-process Pi tool code | Least-privilege tool design (25 bounded research tools, no tool reads environment variables), code review gate on all tool adapters, policy deny-lists enforced before dispatch |
| R3 | **Database availability** — PI tool code shares the in-process `bun:sqlite` database | Repository pattern only (no raw SQL from tools); deterministic verification/evidence code reads through repositories; budget/retention enforcement is DB-backed and fail-closed |
| R4 | **Deployment assumption** — single-operator local server; **not multi-tenant** | Documented here as a hard constraint: enabling PI in a multi-tenant deployment first requires the micro-VM / process isolation from issue #22; the policy gateway and resource-loader hardening are not a substitute for tenant isolation |

**Acceptance line:** Accepted as residual risk pending product-owner sign-off — [DATE]

## Provider scope: benchmark-first integration (P2-3)

`pi-web-access` extension factories and real managed-provider adapters are **out of scope until benchmarked**. The benchmark-first enforcement point is extraction layer 7 / the managed fallback (`src/product-intelligence/extraction/managed-fallback.ts` + `evaluation/extraction-benchmark.ts`): interfaces, provider registries, and honest skip-row semantics are the integration contract, and a provider is only adopted after measured retrieval/extraction/cost results justify it. This is a deliberate scope decision recorded for issues #28/#29, not an unimplemented feature.
