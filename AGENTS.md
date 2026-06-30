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
The onboarding pipeline processes bulk spreadsheet uploads through five key stages:
1. **Discovery:** Finds the official product page URL on brand sites.
2. **Extraction:** Scrapes raw product details (titles, descriptions, images, prices) from confirmed URLs.
3. **Curation:** Synthesizes final clean store-ready titles (integrating spreadsheet hints, web scraped details, and local packaging OCR), and classifies products into internal product types and existing category pages.
4. **Review:** Surfaces curated drafts in a user review drawer for approval.
5. **Promotion:** Creates CMS product drafts and links them to page directories.

### Vision-Language Models (VLM OCR)
- Local VLMs (e.g. `qwen2.5vl:latest`) are used to run text OCR on the product's primary package image.
- Configure local VLM settings in the `api_keys` table under the service name `'ollama_vlm'`.
- The native Ollama `/api/chat` API is invoked via `src/onboarding/vlm-client.ts`.

### Curation Architecture
- **Curator Orchestrator:** `src/onboarding/product-curator.ts` coordinates OCR title extraction, text name consolidation, and category classification.
- **Worker Queue:** `src/onboarding/job-queue.ts` automatically polls items in status `needs_review` and transitions batches into the `curating` phase.
- **Draft Promoter:** `src/onboarding/draft-promoter.ts` reads the item's curation data to set product draft names and assign `product_pages` db rows.

