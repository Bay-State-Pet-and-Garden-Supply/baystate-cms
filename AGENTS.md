# AI Agent Guidelines (AGENTS.md)

Welcome! This document provides the necessary context and rules for AI agents working on the **Baystate CMS** project.

## Project Context
Baystate CMS is a standalone local content management system for ShopSite 15 stores.
- **Backend:** Bun + Hono API (`src/server`).
- **Frontend:** React + Vite SPA (`src/client`).
- **Local State:** SQLite via `bun:sqlite` (`src/db`).
- **Canonical Storage:** Git CLI manages the approved catalog state in a "workspace" directory.
- **Integration:** Adapter-based sync with ShopSite CGI endpoints (`db_xml.cgi`, `dbupload.cgi`, etc.).

## Security Mandates
1. **No Hardcoded Credentials:** NEVER hardcode ShopSite merchant IDs, passwords, or API tokens.
2. **Environment Variables:** Use `process.env.BAYSTATE_CMS_API_TOKEN` for server-side mutating request authentication.
3. **Sensitive Files:** Ensure files like `.baystate-cms-dev-token`, `.env`, and database files containing secrets are ignored by Git.
4. **Log Redaction:** When logging or displaying ShopSite communication, always redact passwords and sensitive identifiers using `src/shopsite/multipart-upload.ts` or similar sanitization patterns.

## Architectural Guidelines
1. **Database Interactions:** Use the repository pattern located in `src/db/repositories`. Avoid direct SQL queries outside of these repositories.
2. **ShopSite XML:** Use `src/shopsite/xml-builder.ts` for generating XML and `src/shopsite/product-parser.ts` for parsing. Preserving unknown fields is a core requirement—always use the established normalizer/denormalizer patterns.
3. **Git Workspaces:** The system treats a Git repository as the source of truth for the catalog. All approved changes must be committed to Git.
4. **Shared Schemas:** Use Zod schemas in `src/shared/schemas` for data validation across both frontend and backend.

## Development & Testing Commands
- `bun run dev`: Starts the API server and Vite dev server.
- `bun run test`: Runs the Vitest suite.
- `bun run typecheck`: Runs TypeScript compiler checks.
- `bun run lint`: Runs ESLint for code style enforcement.

## Working with ShopSite
ShopSite's XML schema is complex and often undocumented. When adding support for new fields:
1. Identify the field name from a `db_xml.cgi` export.
2. Update the Zod schemas in `src/shared/schemas/product.ts`.
3. Update `src/shopsite/product-normalizer.ts` and `src/shopsite/product-denormalizer.ts`.
4. Add unit tests in `src/tests/unit/shopsite-normalizer.test.ts`.

## Onboarding Pipeline & Curation Stage
The onboarding pipeline processes bulk spreadsheet uploads through six key stages (Sourcing → Discovery → Extraction → Curation → Review → Promotion). See `CONTEXT.md` for the authoritative domain model with precise terminology.

0. **Sourcing:** First-stage distributor evidence (ADR 0014 + Amendments A and B). The capability is **DEFAULT ON** — missing `BAYSTATE_CMS_SOURCING_ENABLED` means enabled (mode `automatic`); explicit `false|0|no` is the kill switch; empty/whitespace/malformed values fail closed disabled. `BAYSTATE_CMS_SOURCING_MODE` selects `observe|manual|automatic`. Imports derive entry stage from the effective capability and write `sourcing_entry_policy_version = 1`; marker-v0 rows (incl. the 148 legacy rows) are never claimed/observed/backfilled and stay on **Continue to Official Site Discovery**. When active, the worker runs the provider-neutral engine (`src/onboarding/sourcing/`) with exact UPC/GTIN lookups (brand advisory only), generation-scoped immutable evidence, durable hard-conflict resolution, and a deterministic projection qualification authority. Routes: coherent evidence → `evidence_to_discovery`; no-evidence/provider errors → audited fallbacks; **qualified distributor record → `distributor_record_to_extraction` (SKIPS Discovery → `extraction/pending`, source_type `distributor_record`, null URL)**; hard conflicts → `needs_input_conflict`. Sourcing never routes to Curation (`bundle_to_curation` unactionable everywhere). Modes: observe writes only generations+attempts; manual holds at needs_input with a server-derived qualification view + Use-distributor-record / Continue actions; automatic applies the full route table (conflicts always manual). Distributor materialization is merchandising-depth (Amendment B), URL-null, zero fetch/profile/OCR/model/image, with provenance revalidated at promotion. Distributor images are display-only until PI-6 rights verification. Distributor Scraper connectors (`html_scraper`): `bradley`, `central_pet`, `orgill`, `pet_food_experts`, `phillips_storefront` — recovered selectors as typed code constants, authenticated sessions memory-only, selectors/origins never stored in connection config. Rollout/rollback: `docs/runbooks/sourcing-engine-rollout.md`.
1. **Discovery:** Finds the official product page URL on brand sites.
2. **Extraction:** Scrapes raw product details from confirmed URLs. For **official_page** sources, the source domain requires an **extractor profile** (CSS selectors) for extraction to proceed — the **Profile Builder** (see below) provides a visual click-to-select workflow for building profiles. **Distributor-record sources are profile-free**: `distributor_record_to_extraction` items materialize merchandising-depth structured data (URL-null, zero fetch/profile/OCR/model/image) and never require a domain profile.
3. **Curation:** Synthesizes final clean store-ready titles (integrating spreadsheet hints, web scraped details, and local packaging OCR), and classifies products into internal product types and existing category pages.
4. **Review:** Surfaces curated drafts in a user review drawer for approval.
5. **Promotion:** Creates CMS product drafts and links them to page directories.

### Extractor Profiles (Profile Builder)
- Official-page extraction requires an **extractor profile** per domain (CSS selectors for title, description, images). Distributor-record materialization (Amendment B) is profile-free: merchandising-depth, URL-null, zero fetch/profile/OCR/model/image — a profile is never required for `distributor_record` sources.
- **Build tab** (default): Enter a product URL, load the page, then use 🖱️ **Visually Select** buttons to click on elements in a live browser — the system generates stable CSS selectors automatically.
- **Review tab**: See proposed selectors, preview extraction results, approve/reject per field.
- **Advanced tab**: Contains the deprecated AI-generated proposal feature (unreliable for complex pages).
- Access from: **Settings → Profiles tab → Domain Configuration → "Open Profile Builder"**, or via the **"⚠ Profile required" badge** on items in the Pipeline Board extraction stage.

### Vision-Language Models (VLM OCR)
- Local VLMs (e.g. `qwen2.5vl:latest`) are used to run text OCR on the product's primary package image.
- Configure local VLM settings in the `api_keys` table under the service name `'ollama_vlm'`.
- The native Ollama `/api/chat` API is invoked via `src/onboarding/vlm-client.ts`.

### Curation Architecture
- **Curator Orchestrator:** `src/onboarding/product-curator.ts` coordinates OCR title extraction, text name consolidation, and category classification. This is the current implementation; per ADR 0004, modular classification stages (`src/classification/stages/`) are being phased in to replace the monolithic curator.
- **Worker Queue:** `src/onboarding/job-queue.ts` automatically polls items in status `needs_review` and transitions batches into the `curating` phase.
- **Draft Promoter:** `src/onboarding/draft-promoter.ts` reads the item's curation data to set product draft names and assign `product_pages` db rows.

### Reference
- See `CONTEXT.md` for the authoritative domain model and precise terminology for all pipeline stages, entities, and classification concepts.
- See `docs/adr/` for architectural decision records that document design decisions for the classification system and extraction worker.

## Product Intelligence (Agent Lab, PI-1)

The Product Intelligence program (epic #28) introduces Pi as a **bounded research worker** behind the existing CMS. The principle: *the agent researches and proposes; deterministic CMS code validates, reviews, promotes, and publishes.*

- **Execution boundary:** `src/product-intelligence/` — provider-neutral contracts (`contracts.ts`), executor interface + event sink (`executor.ts`), feature flags (`flags.ts`), executor routing (`execution-router.ts`), deterministic fail-closed fallback (`legacy-executor.ts`), and the Pi SDK adapter under `src/product-intelligence/pi/`.
- **Terminal contract:** agent output only becomes a candidate result via the `submit_product_research` tool, whose payload must validate against `StructuredSubmissionSchema` (zod) and the mirror TypeBox schema (`pi/pi-tool-registry.ts`). Ordinary prose is never authoritative.
- **Sandboxing:** Pi sessions use `SessionManager.inMemory()`, an approved-extension-only resource loader (no project/global extensions, skills, or context files), an explicit tool allowlist from the immutable policy, and the Pi SDK is imported lazily — onboarding never loads Pi code unless a run starts.
- **Fail-closed rules:** sessions ending without a valid submission fail with `missing_submission`; unknown allowlisted tools raise `policy_denied`; missing model route raises `model_unavailable`; hard deadlines and caller `AbortSignal`s are enforced; sessions are always disposed.
- **Feature flags:** `productIntelligence.*` — env `BAYSTATE_CMS_PRODUCT_INTELLIGENCE_ENABLED`, `BAYSTATE_CMS_PI_ENABLED`, `BAYSTATE_CMS_PI_SHADOW_ONLY`, `BAYSTATE_CMS_PI_ALLOW_ONBOARDING_IMPORT`, `BAYSTATE_CMS_PI_ALLOW_BATCH_RUNS` (all default disabled) plus in-memory overrides via `overrideProductIntelligenceFlags()`.
- **Governance:** model self-reported confidence is recorded but never grants acceptance; taxonomy/Category Page/attribute/ProductField identifiers are never invented by the agent (null/abstain instead); image proposals must carry rights and identity-match provenance. Alignment with governance epic #17 is required before Agent Lab results may enter normal onboarding.
- **Evaluation & rollout (PI-9):** `src/product-intelligence/evaluation/` — shadow-mode metrics on a versioned golden dataset (reuses the #14 benchmark tables: frozen content-addressed datasets, deterministic train/test/holdout splits, paired bootstrap). `metrics.ts` classifies every run into a 9-outcome taxonomy (submitted/abstained/parent_product_only/wrong_variant/failed/policy_denied/not_configured/cancelled/unavailable), compares predictions to gold per field with Wilson-interval confidence and sample-size warnings. `runner.ts` evaluates completed runs against gold (default 'test' split — held-out products never evaluated). `extraction-benchmark.ts` scores extraction providers with retrieval success ALWAYS distinguished from correct product extraction (an HTML 200 with the wrong size is a failed task), plus traceability (method/source-path/artifact), latency median/p95, cost per correct product, and a provider recommendation. `rollout.ts` defines staged enablement (shadow_only → manual_agent_lab → reviewed_import → optional_onboarding → automatic) with DOCUMENTED thresholds over measured metrics only (never model confidence); the global kill switch (`BAYSTATE_CMS_PI_KILL_SWITCH` / flags.killSwitch) forces the legacy pipeline everywhere and blocks imports. API: fixture dataset seed, evaluation run/reports, benchmark, rollout state.
- **Onboarding import (PI-8):** `src/product-intelligence/onboarding-import.ts` — a reviewed Agent Lab run can create an onboarding item (dedicated batch + item at the default pipeline stage) or augment an existing one, atomically inside one transaction with an import record (`product_intelligence_imports`: run id, result hash, mode, user, field selection, excluded/overridden values, source/evidence/image IDs). Merge policy never overwrites differing manual values (they are recorded as excluded with both sides); identical values dedupe; evidence materializes into `extraction_data_json.productIntelligenceEvidence` as an ARRAY (one entry per imported run — a newer run never silently replaces an earlier import); only commerce-approved images are imported. The draft promoter verifies every imported origin at promotion time (`verifyImportedResultGate`: run exists, result hash matches, import record active — else fail-closed skip); deleting a run (single or retention) marks its imports stale. Import never creates classification decisions. Gated by `allowOnboardingImport` + `!shadowOnly`; UI: "Send to Onboarding review" in the Agent Lab inspector, "🤖 Agent result available" badge + "Open in Agent Lab →" on onboarding cards, `?view=agentlab&run=<id>` deep link.
- **Agent Lab frontend (PI-7):** `src/client/components/agent-lab/` + `src/client/agent-lab/logic.ts` (pure derivation: run-launch validation, timeline event presentation with strict no-chain-of-thought allowlisting, field-status derivation, metrics, comparison formatting) + `src/client/hooks/useProductIntelligenceEvents.ts` (cursor-based SSE reconnect with capped backoff, terminal stop, stale-run guards) + `src/client/product-intelligence-api.ts`. Top-level `?view=agentlab` tab (Experimental pill) gated by the product-intelligence flags; subviews Runs (launcher → live inspector with Progress/Listing/Review/Evidence panels), Policies (feature flags + per-run immutable policy snapshots, read-only), Metrics (completion/failure/abstention rates, tool-enforcement rates, honest seams for labeled data). No publish action exists anywhere in Agent Lab; run-level read routes require workspace ownership (404 cross-workspace).
- **Image verification & rights provenance (PI-6):** `src/product-intelligence/assets/` — a deterministic pipeline (`verifyImageCandidate`) quarantines downloads through the policy gateway, decodes with sharp (corrupt/non-image → `invalid`, never thrown), computes a raw-bytes SHA-256 plus a perceptual dHash, compares observed vs expected brand/GTIN/variant/net-content/pack-count/flavor/formula (`classifyAssetIdentity`), resolves rights from the declared source tier (`resolveRights`: supplier/manufacturer need basis + evidence reference, retailer needs an explicit approved basis, network-discovered URLs inherit no rights, generated imagery is never authoritative), detects exact + perceptual duplicates, and computes `commerceApproved` via the shared `computeCommerceApproved` formula the bundle validator recomputes (an agent cannot assert approval the fields do not support). Discovery parsers (`discover_image_candidates`) normalize JSON-LD, Shopify/WooCommerce variant-image mappings, and #29-style network captures with full provenance (source page, source path, artifact id, extraction method, variant reference). Verified records persist to `product_intelligence_assets` (rights/license refs also on the source row); the bundle validator blocks unknown-rights, parent-product-only, conflicting-evidence, and basis-less primaries. `comparison`-role images can support identity checks without ever becoming commerce assets.
- **Policy enforcement (PI-5):** `src/product-intelligence/policy/` — every model, network, and budget decision passes the `PolicyGateway` (recorded with reason codes in `product_intelligence_policy_decisions`): `local_only` denies every remote model call and fallback, `cloud_models_only` allows only the routed model, SSRF protections block private/link-local destinations (DNS-resolved), protocols/ports are validated, redirects are re-validated hop-by-hop, response-size and content-type limits apply, and fallback models are never selected silently. Run policies are immutable snapshots (`configId` = SHA-256 of the policy; tampered snapshots refuse to start) with the prompt hash captured per run; the default policy grants no host-file tools (worker isolation) and model calls stay denied until a route is configured. Model cost is enforced server-side from session usage against `maxCostUsd`.
- **Bounded research tools (PI-3):** `src/product-intelligence/tools/` wraps deterministic CMS capabilities (GTIN/catalog/onboarding lookups, web + sitemap discovery, page verification, variant resolution, deterministic page extraction behind the provider-neutral `PageExtractionContract`, packaging OCR, image inspection, taxonomy candidates) as 25 agent-facing tools with TypeBox schemas, stable versions, evidence ids, and explicit no-result/policy-denied outcomes. The `PiToolRegistry` enforces run+workspace ownership, the policy `researchTools` allowlist, per-run tool-call budgets, timeout, and cancellation before every dispatch; adapters never write approved catalog/ShopSite state and never return raw HTML or credentials. `extract_product_page` delegates to the extraction contract — PI-11 replaces the HTTP adapter with the deterministic ladder later.

