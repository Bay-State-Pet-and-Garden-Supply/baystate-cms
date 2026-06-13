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
