# AI Agent Guidelines (AGENTS.md)

Welcome! This document provides the necessary context and rules for AI agents working on the **ShopSite CMS** project.

## Project Context
ShopSite CMS is a standalone local content management system for ShopSite 15 stores.
- **Backend:** Bun + Hono API (`src/server`).
- **Frontend:** React + Vite SPA (`src/client`).
- **Local State:** SQLite via `bun:sqlite` (`src/db`).
- **Canonical Storage:** Git CLI manages the approved catalog state in a "workspace" directory.
- **Integration:** Adapter-based sync with ShopSite CGI endpoints (`db_xml.cgi`, `dbupload.cgi`, etc.).

## Security Mandates
1. **No Hardcoded Credentials:** NEVER hardcode ShopSite merchant IDs, passwords, or API tokens.
2. **Environment Variables:** Use `process.env.SHOPSITE_CMS_API_TOKEN` for server-side mutating request authentication.
3. **Sensitive Files:** Ensure files like `.shopsite-cms-dev-token`, `.env`, and database files containing secrets are ignored by Git.
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
The onboarding pipeline processes bulk spreadsheet uploads through five key stages. See `CONTEXT.md` for the authoritative domain model with precise terminology.

1. **Discovery:** Finds the official product page URL on brand sites.
2. **Extraction:** Scrapes raw product details from confirmed URLs. Domains require an **extractor profile** (CSS selectors) for extraction to proceed. The **Profile Builder** (see below) provides a visual click-to-select workflow for building profiles.
3. **Curation:** Synthesizes final clean store-ready titles (integrating spreadsheet hints, web scraped details, and local packaging OCR), and classifies products into internal product types and existing category pages.
4. **Review:** Surfaces curated drafts in a user review drawer for approval.
5. **Promotion:** Creates CMS product drafts and links them to page directories.

### Extractor Profiles (Profile Builder)
- Extraction requires an **extractor profile** per domain (CSS selectors for title, description, images).
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
- **Agent Lab frontend (PI-7):** `src/client/components/agent-lab/` + `src/client/agent-lab/logic.ts` (pure derivation: run-launch validation, timeline event presentation with strict no-chain-of-thought allowlisting, field-status derivation, metrics, comparison formatting) + `src/client/hooks/useProductIntelligenceEvents.ts` (cursor-based SSE reconnect with capped backoff, terminal stop, stale-run guards) + `src/client/product-intelligence-api.ts`. Top-level `?view=agentlab` tab (Experimental pill) gated by the product-intelligence flags; subviews Runs (launcher → live inspector with Progress/Listing/Review/Evidence panels), Policies (feature flags + per-run immutable policy snapshots, read-only), Metrics (completion/failure/abstention rates, tool-enforcement rates, honest seams for labeled data). No publish action exists anywhere in Agent Lab; run-level read routes require workspace ownership (404 cross-workspace).
- **Image verification & rights provenance (PI-6):** `src/product-intelligence/assets/` — a deterministic pipeline (`verifyImageCandidate`) quarantines downloads through the policy gateway, decodes with sharp (corrupt/non-image → `invalid`, never thrown), computes a raw-bytes SHA-256 plus a perceptual dHash, compares observed vs expected brand/GTIN/variant/net-content/pack-count/flavor/formula (`classifyAssetIdentity`), resolves rights from the declared source tier (`resolveRights`: supplier/manufacturer need basis + evidence reference, retailer needs an explicit approved basis, network-discovered URLs inherit no rights, generated imagery is never authoritative), detects exact + perceptual duplicates, and computes `commerceApproved` via the shared `computeCommerceApproved` formula the bundle validator recomputes (an agent cannot assert approval the fields do not support). Discovery parsers (`discover_image_candidates`) normalize JSON-LD, Shopify/WooCommerce variant-image mappings, and #29-style network captures with full provenance (source page, source path, artifact id, extraction method, variant reference). Verified records persist to `product_intelligence_assets` (rights/license refs also on the source row); the bundle validator blocks unknown-rights, parent-product-only, conflicting-evidence, and basis-less primaries. `comparison`-role images can support identity checks without ever becoming commerce assets.
- **Policy enforcement (PI-5):** `src/product-intelligence/policy/` — every model, network, and budget decision passes the `PolicyGateway` (recorded with reason codes in `product_intelligence_policy_decisions`): `local_only` denies every remote model call and fallback, `cloud_models_only` allows only the routed model, SSRF protections block private/link-local destinations (DNS-resolved), protocols/ports are validated, redirects are re-validated hop-by-hop, response-size and content-type limits apply, and fallback models are never selected silently. Run policies are immutable snapshots (`configId` = SHA-256 of the policy; tampered snapshots refuse to start) with the prompt hash captured per run; the default policy grants no host-file tools (worker isolation) and model calls stay denied until a route is configured. Model cost is enforced server-side from session usage against `maxCostUsd`.
- **Bounded research tools (PI-3):** `src/product-intelligence/tools/` wraps deterministic CMS capabilities (GTIN/catalog/onboarding lookups, web + sitemap discovery, page verification, variant resolution, deterministic page extraction behind the provider-neutral `PageExtractionContract`, packaging OCR, image inspection, taxonomy candidates) as 25 agent-facing tools with TypeBox schemas, stable versions, evidence ids, and explicit no-result/policy-denied outcomes. The `PiToolRegistry` enforces run+workspace ownership, the policy `researchTools` allowlist, per-run tool-call budgets, timeout, and cancellation before every dispatch; adapters never write approved catalog/ShopSite state and never return raw HTML or credentials. `extract_product_page` delegates to the extraction contract — PI-11 replaces the HTTP adapter with the deterministic ladder later.
