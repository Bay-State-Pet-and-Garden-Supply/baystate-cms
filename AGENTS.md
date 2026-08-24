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

0. **Sourcing:** First-stage distributor evidence (ADR 0014 + Amendments A and B). The capability is **DEFAULT ON** — missing `BAYSTATE_CMS_SOURCING_ENABLED` means enabled (mode `automatic`); explicit `false|0|no` is the kill switch; empty/whitespace/malformed values fail closed disabled. `BAYSTATE_CMS_SOURCING_MODE` selects `observe|manual|automatic`. Imports derive entry stage from the effective capability and write `sourcing_entry_policy_version = 1`; marker-v0 rows (incl. the 148 legacy rows) are never claimed/observed/backfilled and stay on **Continue to Official Site Discovery**. When active, the worker runs the provider-neutral engine (`src/onboarding/sourcing/`) with exact UPC/GTIN lookups (brand advisory only), generation-scoped immutable evidence, durable hard-conflict resolution, and a deterministic projection qualification authority. Routes: coherent evidence → `evidence_to_discovery`; no-evidence/provider errors → audited fallbacks; **qualified distributor record → `distributor_record_to_extraction` (SKIPS Discovery → `extraction/pending`, source_type `distributor_record`, null URL)**; hard conflicts → `needs_input_conflict`. Sourcing never routes to Curation (`bundle_to_curation` unactionable everywhere). Modes: observe writes only generations+attempts; manual holds at needs_input with a server-derived qualification view + Use-distributor-record / Continue actions; automatic applies the full route table (conflicts always manual). Distributor materialization is merchandising-depth (Amendment B), URL-null, zero fetch/profile/OCR/model/image, with provenance revalidated at promotion. Distributor images are display-only until rights verification via `src/onboarding/image-verification/` (ADR 0030). Distributor Scraper connectors (`html_scraper`): `bradley`, `central_pet`, `orgill`, `pet_food_experts`, `phillips_storefront` — recovered selectors as typed code constants, authenticated sessions memory-only, selectors/origins never stored in connection config. Rollout/rollback: `docs/runbooks/sourcing-engine-rollout.md`.
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

## Image Verification & Rights Provenance (relocated)

The deterministic image-verification pipeline formerly known as "PI-6" lives at `src/onboarding/image-verification/` (ADR 0030): `verifyImageCandidate` quarantines downloads behind a deterministic network gate (`DeterministicNetworkGate` — http/https only, ports 80/443, private/link-local DNS denial, hop-by-hop redirect revalidation, content-type and size limits), decodes with sharp (corrupt/non-image → `invalid`, never thrown), computes raw-bytes SHA-256 + perceptual dHash, compares observed vs expected brand/GTIN/variant/net-content/pack-count/flavor/formula (`classifyAssetIdentity`), resolves rights from the declared source tier (`resolveRights`), detects exact + perceptual duplicates, and computes `commerceApproved`. Verified records persist to `product_intelligence_assets` via `src/db/repositories/onboarding-pi-asset-repo.ts` (table name kept for row-history continuity; see CONTEXT.md naming footnote). Reuse grants live in `pi_reuse_policies` via `image-reuse-policy-repo.ts`.

## Agent Lab Decommissioned (ADR 0030)

The Product Intelligence / Agent Lab program (former epic #28) has been **removed**. The agent runtime, specialists, policy gateway runtime, evaluation/rollout machinery, routes, and frontend were deleted in favor of the deterministic Onboarding Pipeline. Salvaged capabilities were relocated (see the salvage map): SSRF classification → `src/shared/ssrf.ts`, Wilson interval → `src/onboarding/ocr-eval/stats.ts`, image verification → `src/onboarding/image-verification/`, extraction ladder layers 1–4 (profile seam implemented but production-unwired) → `src/onboarding/extraction-ladder/`; the ladder is now wired into `page-extractor.ts` as additive enrichment + identity classification — see **ADR 0031**). Historical decisions: ADR 0010/0026–0029 remain as records; the decommission decision and data dispositions are in **ADR 0030**. Rollback tag: `pre-agent-lab-decommission`.
