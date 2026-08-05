# Introduce a Product Intelligence execution boundary with a Pi adapter

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
