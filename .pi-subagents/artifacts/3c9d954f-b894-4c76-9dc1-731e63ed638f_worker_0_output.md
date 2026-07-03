# Sitemap DB Layer + Extractor Profiles Extension — Implementation Handoff

## Summary

Implemented the sitemap database layer and extended the `extractor_profiles` table with the `sitemap_product_url_pattern` column, following the existing repository and migration patterns in the codebase. All work is contained to small, focused changes; no behavior outside the requested scope was changed.

## What was implemented

### 1. `sitemap_cache` table — `src/db/migrations.ts`

Added a `try` block (mirroring the `serper_cache` and `extractor_profiles` blocks) that:

- Creates the `sitemap_cache` table if it does not exist:
  - `domain TEXT PRIMARY KEY`
  - `urls_json TEXT NOT NULL`
  - `fetched_at TEXT NOT NULL`
  - `expires_at TEXT NOT NULL`
  - `source_url TEXT`
- Creates `idx_sitemap_cache_domain` on `domain` (the column used in the cache lookup `WHERE` clause).

### 2. `sitemap-cache-repo.ts` — new file at `src/db/repositories/sitemap-cache-repo.ts`

- Exports `SITEMAP_CACHE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000` (24h).
- Normalizes the domain (`lowercase` + strip `www.`) to match `domain-status-repo.ts` and `extractor-profile-repo.ts`.
- `getCachedSitemapUrls(domain)`:
  - Returns `null` when there is no row.
  - Returns `null` and deletes the row when the row has expired (`expires_at <= now`) or has an invalid `expires_at` — mirrors the cleanup-on-access behavior of `getDomainStatus`.
  - Returns `null` if `urls_json` is not an array.
  - Otherwise returns the parsed array of URL strings (filtered through a string-type guard).
- `insertSitemapCache(domain, urls, sourceUrl, ttlMs?)`:
  - Computes `fetched_at = now` and `expires_at = now + ttlMs` (default 24h).
  - Uses `INSERT OR REPLACE` so re-fetching the same domain overwrites the row.
- `clearSitemapCache()` deletes all rows.

### 3. `extractor_profiles.sitemap_product_url_pattern` — `src/db/migrations.ts`

- Added the column to the `CREATE TABLE IF NOT EXISTS` so fresh databases get it on first migration.
- Added a separate `try` block that runs `PRAGMA table_info(extractor_profiles)` and `ALTER TABLE … ADD COLUMN` if the column is missing — same pattern used for `product_index` (`parent_sku`, `description`, `search_keywords`, `custom_fields`) and `onboarding_items` (`curation_data_json`, `expected_name`).

### 4. `extractor-profile-repo.ts` updates

- `ExtractorProfile` interface: added `sitemapProductUrlPattern: string | null`.
- `DbProfile` interface: added `sitemap_product_url_pattern: string | null`.
- `mapToProfile`: maps the new column.
- `upsertProfile`:
  - The `selectors` argument now accepts `sitemapProductUrlPattern?: string | null`.
  - The same `undefined` = preserve / `null` = clear / `string` = update merge semantics already used by the existing selectors are applied to the new field.
  - Both the `UPDATE` and `INSERT` SQL now include the `sitemap_product_url_pattern` column.
  - The returned `ExtractorProfile` includes the resolved value.

## Validation

- `bun run typecheck` → clean.
- `bun test` for the relevant suites: 36 pass / 0 fail across 4 files.
- `bun test` for the full project test list: 216 pass / 0 fail.
- `bun run lint` → 107 pre-existing errors remain; **0 new errors** in any changed file.
- No staged files (`git diff --cached` is empty); all changes are unstaged.

## Files changed

| File | Change |
| --- | --- |
| `src/db/migrations.ts` | Added `sitemap_cache` table + index, and `sitemap_product_url_pattern` column on `extractor_profiles` (CREATE + ALTER migration). |
| `src/db/repositories/sitemap-cache-repo.ts` | **New file.** Repository for `sitemap_cache` with `getCachedSitemapUrls`, `insertSitemapCache`, `clearSitemapCache`, and `SITEMAP_CACHE_DEFAULT_TTL_MS`. |
| `src/db/repositories/extractor-profile-repo.ts` | Added `sitemapProductUrlPattern` to `ExtractorProfile`, `DbProfile`, `mapToProfile`, and the `upsertProfile` selectors. |
| `src/tests/unit/sitemap-cache-repo.test.ts` | **New file.** 9 unit tests covering the repository contract. |
| `src/tests/unit/extractor-profiles.test.ts` | Added 4 tests for the new field. |
| `src/tests/unit/db-migration.test.ts` | Added 3 migration tests; extended the "all core tables" list to include `sitemap_cache`. |
| `src/tests/unit/page-extractor-images.test.ts` | Added the new `sitemapProductUrlPattern: null` field to the inline `ExtractorProfile` literal (was required after the interface change for `typecheck` to pass). |
| `package.json` | Added `src/tests/unit/sitemap-cache-repo.test.ts` to the `bun test` list. |

## Risks / open questions

- `vite + vitest` cannot load `bun:sqlite`, so vitest does not run any of the bun-style DB tests in this project. Validation was done with `bun test` (the project's existing convention for DB tests). The page-extractor-images tests, which use vi globals, can only run via vitest — they were not run here, but the only change there was adding one extra field to a literal, which is type-checked.
- The pre-existing lint errors (107) are unchanged; they exist across many files and are not introduced by this work.
- `getCachedSitemapUrls` cleans up expired rows on access. If a future caller needs to enumerate cached sitemaps (e.g., an admin UI), they should add a separate `listSitemapCache()` helper rather than relying on the read path.

## Acceptance

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented the requested sitemap_cache table + repository and the sitemap_product_url_pattern column extension on extractor_profiles with no scope creep. All changes are minimal and follow existing patterns (serper_cache, domain_status, extractor_profiles). The package.json test list was updated only to register the new test file."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Typecheck passes; 216/216 bun tests pass including 9 new sitemap-cache-repo tests, 4 new extractor-profile tests, and 3 new db-migration tests. Lint was run and no new errors were introduced (107 pre-existing errors in unrelated files). git diff --cached is empty so no files are staged."
    }
  ],
  "changedFiles": [
    "src/db/migrations.ts",
    "src/db/repositories/sitemap-cache-repo.ts",
    "src/db/repositories/extractor-profile-repo.ts",
    "src/tests/unit/sitemap-cache-repo.test.ts",
    "src/tests/unit/extractor-profiles.test.ts",
    "src/tests/unit/db-migration.test.ts",
    "src/tests/unit/page-extractor-images.test.ts",
    "package.json"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/sitemap-cache-repo.test.ts",
    "src/tests/unit/extractor-profiles.test.ts",
    "src/tests/unit/db-migration.test.ts"
  ],
  "commandsRun": [
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "tsc --noEmit --skipLibCheck reported no errors."
    },
    {
      "command": "bun test src/tests/unit/sitemap-cache-repo.test.ts",
      "result": "passed",
      "summary": "9/9 sitemap cache tests pass."
    },
    {
      "command": "bun test src/tests/unit/extractor-profiles.test.ts",
      "result": "passed",
      "summary": "9/9 extractor-profiles tests pass (5 existing + 4 new for sitemapProductUrlPattern)."
    },
    {
      "command": "bun test src/tests/unit/db-migration.test.ts src/tests/unit/sitemap-cache-repo.test.ts src/tests/unit/extractor-profiles.test.ts src/tests/unit/serper-cache-repo.test.ts",
      "result": "passed",
      "summary": "36/36 tests pass across the 4 affected files."
    },
    {
      "command": "bun test <full bun test list including new sitemap-cache-repo.test.ts>",
      "result": "passed",
      "summary": "216/216 tests pass across 21 files."
    },
    {
      "command": "bun run lint",
      "result": "passed (unchanged baseline)",
      "summary": "107 pre-existing lint errors remain; 0 new errors introduced by these changes."
    },
    {
      "command": "git diff --cached",
      "result": "passed",
      "summary": "Empty — no staged files."
    }
  ],
  "validationOutput": [
    "Typecheck: clean.",
    "216/216 bun tests pass.",
    "Lint: 0 new errors; 107 pre-existing errors unchanged."
  ],
  "residualRisks": [
    "Pre-existing lint errors (107) remain; not introduced by this change.",
    "Vitest cannot run the bun-style DB tests (bun:sqlite is unavailable in the vite runtime) so all DB validation was via bun test, which is the project's existing convention."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added sitemap_cache table + idx_sitemap_cache_domain in migrations.ts; added sitemap_product_url_pattern column to extractor_profiles in both CREATE TABLE and ALTER TABLE migration. New sitemap-cache-repo with get/insert/clear and 24h default TTL. Extended extractor-profile-repo with sitemapProductUrlPattern following the same null/undefined/string merge semantics. Added 16 tests (9 sitemap + 4 extractor-profile + 3 db-migration) and registered the new test in package.json. Fixed the page-extractor-images test fixture to include the new field.",
  "reviewFindings": [
    "no blockers; no major findings",
    "minor: src/db/migrations.ts places the sitemap_product_url_pattern column between images_selector and created_at, while the existing repo orders it at the end of the selector fields — consistent with extractor-profiles.test.ts fixture.",
    "minor: getCachedSitemapUrls deletes expired rows on access; acceptable for a cache but callers needing enumeration should add a list helper later."
  ],
  "manualNotes": "All work is unstaged. The reviewer can `git diff` to see only the changes from this task; other modified files in `git status` are from prior subagent sessions, not this one. The page-extractor-images.test.ts change is a single-line addition of `sitemapProductUrlPattern: null` to satisfy the stricter interface."
}
```

Implemented the sitemap DB layer and the `sitemap_product_url_pattern` column extension on `extractor_profiles`.

Changed files:
- `src/db/migrations.ts` — added `sitemap_cache` table + index, added `sitemap_product_url_pattern` column to `extractor_profiles` (CREATE + ALTER migration).
- `src/db/repositories/sitemap-cache-repo.ts` (new) — `getCachedSitemapUrls`, `insertSitemapCache` (INSERT OR REPLACE, 24h default TTL), `clearSitemapCache`.
- `src/db/repositories/extractor-profile-repo.ts` — added `sitemapProductUrlPattern` to the `ExtractorProfile` / `DbProfile` interfaces, `mapToProfile`, and `upsertProfile` selectors (null = clear, undefined = preserve, string = update).
- `src/tests/unit/sitemap-cache-repo.test.ts` (new) — 9 unit tests.
- `src/tests/unit/extractor-profiles.test.ts` — 4 new tests for the new field.
- `src/tests/unit/db-migration.test.ts` — 3 new migration tests + extended the core-tables list to include `sitemap_cache`.
- `src/tests/unit/page-extractor-images.test.ts` — added `sitemapProductUrlPattern: null` to the inline `ExtractorProfile` literal so `typecheck` passes.
- `package.json` — registered `src/tests/unit/sitemap-cache-repo.test.ts` in the `bun test` list.

Validation:
- `bun run typecheck` → clean.
- `bun test` (full project list) → 216 pass / 0 fail.
- `bun run lint` → no new errors introduced (107 pre-existing errors remain in unrelated files).
- `git diff --cached` → empty (no staged files).

Open risks / questions:
- Pre-existing lint baseline (107 errors) is unchanged; not in scope.
- Vitest cannot load `bun:sqlite`, so DB tests run via `bun test` per project convention.

Recommended next step:
- Use the new repository from the sitemap discovery code path (e.g., a `SitemapFetcher` in `src/discovery/` or `src/onboarding/`) and read `extractor_profile.sitemapProductUrlPattern` to filter URLs down to product pages before populating the cache via `insertSitemapCache(...)`.
