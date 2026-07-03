# Sitemap Layer — Domain Diagnostics Spec

**Status:** Review-only. Spec only — no code changes.
**Date:** 2026-07-02
**Scope:** Read + clear-by-domain extensions for `sitemap_cache`; new settings routes and client API surface for the Domain Diagnostics panel.

---

## 1. Repo Layer — `src/db/repositories/sitemap-cache-repo.ts`

### 1a. NEW read-only function: `listAllSitemapCaches()`

**Why:** `getCachedSitemapUrls()` is a single-domain read that **deletes expired rows on access** (`src/db/repositories/sitemap-cache-repo.ts:46`). The diagnostics panel needs to inspect *every* cached row — including ones that have just expired — without mutating the table. There is currently no listing helper.

**Signature (proposed):**
```ts
export interface SitemapCacheRow {
  domain: string;          // already normalized (lowercase, no www.)
  urls: string[];          // parsed urls_json, filtered to strings
  sitemapUrlsCount: number; // pre-computed for the panel
  sitemapFetchedAt: string; // ISO
  sitemapExpiresAt: string; // ISO
  sitemapSourceUrl: string | null;
}

export function listAllSitemapCaches(): SitemapCacheRow[];
```

**Implementation notes (grounded in the existing repo):**
- `src/db/repositories/sitemap-cache-repo.ts:10` — `SITEMAP_CACHE_DEFAULT_TTL_MS = 24h` (reuse the constant for the consumer to compute staleness, not for the SQL).
- `src/db/repositories/sitemap-cache-repo.ts:24` — `normalizeDomain()` is *not* needed here; the table only stores already-normalized rows, and the existing schema (`src/db/migrations.ts:308`) uses `domain TEXT PRIMARY KEY`.
- Do **not** call `getCachedSitemapUrls()` in a loop — that triggers the expiry side-effect at `src/db/repositories/sitemap-cache-repo.ts:46`. Issue a single `SELECT domain, urls_json, fetched_at, expires_at, source_url FROM sitemap_cache ORDER BY domain`.
- Reuse the exact same `JSON.parse` + `Array.isArray` + `typeof === 'string'` filter pattern from `src/db/repositories/sitemap-cache-repo.ts:56-66`. If parsing fails, log via `console.error` (mirroring line 60) and return `[]` for that row — never throw, because the diagnostics panel is read-only.
- `urls.length` is the source for `sitemapUrlsCount`; compute it during the map step so the route handler does not need a second pass.

### 1b. NEW clear-by-domain function: `clearSitemapCacheForDomain(domain)`

**Why:** `clearSitemapCache()` (`src/db/repositories/sitemap-cache-repo.ts:91-95`) wipes the whole table. The diagnostics panel needs a single-domain invalidation so the operator can force a re-fetch for one site without nuking every other cache row.

**Signature (proposed):**
```ts
export function clearSitemapCacheForDomain(domain: string): boolean;
```

**Implementation notes:**
- Normalize the input through the existing helper at `src/db/repositories/sitemap-cache-repo.ts:24` (the same one `insertSitemapCache` uses) so `example.com` and `www.example.com` route to the same row.
- Use the same `DELETE FROM sitemap_cache WHERE domain = ?` pattern already used at `src/db/repositories/sitemap-cache-repo.ts:46` (the expiry cleanup), but return `result.changes > 0` so the route can answer 404 vs 200 honestly. `bun:sqlite` exposes `changes` on the run result — confirm the codebase pattern in `src/db/repositories/api-key-repo.ts:62` (which returns `boolean` from a delete). Match that style: return `result.changes > 0`.
- **No workspace scoping.** `sitemap_cache` is not workspace-scoped (compare to `listBatches(workspaceId, ...)` at `src/db/repositories/onboarding-batch-repo.ts:74`). The new function should also not take a workspace arg.

---

## 2. Server Route Layer — `src/server/routes/onboarding-routes.ts`

### 2a. NEW route: `GET /api/onboarding/settings/domain-diagnostics`

**Where to place it:** In the "API KEYS AND CACHED BRAND SITES SETTINGS" block, immediately after the extractor-profile routes (around `src/server/routes/onboarding-routes.ts:1045`, before the `POST /onboarding/extractor-profiles/test` route). This keeps it next to the other read-only settings endpoints and before the assets catch-all at `src/server/routes/onboarding-routes.ts:1138` (Hono's `*` route would shadow anything added below it).

**Request:** none. Workspace gate is optional — the existing settings endpoints at `src/server/routes/onboarding-routes.ts:782, 962, 1016, 1182, 1237, 1250` do **not** require `findWorkspace()`, so the new GET should follow the same pattern and not require an active workspace.

**Response shape (per spec, the sitemap-only fields this layer owns):**
```ts
{
  caches: Array<{
    domain: string;             // normalized
    sitemapUrlsCount: number;
    sitemapFetchedAt: string;   // ISO
    sitemapExpiresAt: string;   // ISO
    sitemapSourceUrl: string | null;
  }>
}
```

**Implementation notes:**
- Add to the import block at the top of the file: `import { listAllSitemapCaches } from '../../db/repositories/sitemap-cache-repo';` (the existing import is *not* present — the file currently does not reference the sitemap repo at all).
- Per-row staleness flag (e.g. `isStale: expiresAt <= Date.now()`) is a nice-to-have for the panel but is **out of scope** for the *sitemap layer*; the integration layer (context-builder #2) will own aggregation. The route should hand back exactly the five fields in the spec and let the panel derive "expired" client-side from `sitemapExpiresAt`.
- The route should be sync (no `async`): the existing `listAllBrandSites()` style at `src/server/routes/onboarding-routes.ts:962` is the closest mirror.

### 2b. NEW route: `POST /api/onboarding/settings/clear-sitemap-cache`

**Where to place it:** Adjacent to the GET above, after the diagnostics GET. Use a body with `{ domain: string }`. The user's spec calls it "POST clear-sitemap-cache"; the existing conventions are:
- `POST /onboarding/settings/brand-sites/resolve` (`src/server/routes/onboarding-routes.ts:989`) — takes a JSON body.
- `DELETE /onboarding/settings/brand-sites/:id` (`src/server/routes/onboarding-routes.ts:1010`) — takes the id from the path.
- The user explicitly asked for POST, so honor that: `POST /onboarding/settings/clear-sitemap-cache` with `{ "domain": "example.com" }`.

**Request body:**
```ts
{ domain: string }
```

**Response:**
- `200 { success: true, cleared: true }` — row existed and was removed.
- `200 { success: true, cleared: false }` — no row matched (return 200, not 404; this matches the `deleteApiKey` style at `src/server/routes/onboarding-routes.ts:956` which always returns `{ success: true }`).
- `400 { error: 'domain is required' }` — mirror the `domain is required` check used at `src/server/routes/onboarding-routes.ts:1024`.

**Implementation notes:**
- Add `clearSitemapCacheForDomain` to the same import as 2a.
- No auth gate. None of the settings routes under `/onboarding/settings/*` enforce `SHOPSITE_CMS_API_TOKEN`; the per-request token is only enforced at the global middleware level (if at all). Match the surrounding pattern.

---

## 3. Client API Layer — `src/client/onboarding-api.ts`

### 3a. NEW function: `getDomainDiagnostics()`

**Why:** The client needs a typed wrapper for the GET endpoint. Pattern mirror: `getBrandSites()` at `src/client/onboarding-api.ts` (search hit `getBrandSites` — it returns `{ brandSites: BrandSite[]; catalogBrands?: string[] }`).

**Signature (proposed):**
```ts
export interface SitemapCacheEntry {
  domain: string;
  sitemapUrlsCount: number;
  sitemapFetchedAt: string;   // ISO
  sitemapExpiresAt: string;   // ISO
  sitemapSourceUrl: string | null;
}

export interface DomainDiagnosticsResponse {
  caches: SitemapCacheEntry[];
}

export async function getDomainDiagnostics(): Promise<DomainDiagnosticsResponse> {
  return request<DomainDiagnosticsResponse>('/settings/domain-diagnostics');
}
```

### 3b. NEW function: `clearSitemapCache(domain)`

**Signature (proposed):**
```ts
export async function clearSitemapCache(domain: string): Promise<{ success: boolean; cleared: boolean }> {
  return request<{ success: boolean; cleared: boolean }>('/settings/clear-sitemap-cache', {
    method: 'POST',
    body: JSON.stringify({ domain }),
  });
}
```

**Implementation notes:**
- The module-level `request<T>(...)` helper at the top of `src/client/onboarding-api.ts` (right under the imports) already serializes JSON and throws on `!res.ok` — no new helper needed.
- Naming: `clearSitemapCache` is the natural name and matches the *repo* function name, but be aware the client file already exports `getApiKeys`, `deleteApiKey`, `deleteBrandSite`, `deleteExtractorProfile`, `deleteLlmTaskConfig`, `rollbackProfileField` — all of which follow the pattern `<verb><Entity>` (no "API" or "Service" suffix). Stick to that.
- Place the new exports at the end of the file, in a new section comment "Domain Diagnostics" — same convention used for "Profile Governance API (Phase 3)" at the bottom.

---

## 4. Data Shape Per Domain (Authoritative)

Exactly five fields per cache row, in this order:

| Field | Type | Source column | Notes |
|---|---|---|---|
| `domain` | `string` | `sitemap_cache.domain` | Already normalized in storage (lowercase, no `www.`). |
| `sitemapUrlsCount` | `number` | derived from `urls_json` | Computed during the repo map step; client should not re-parse. |
| `sitemapFetchedAt` | `string` (ISO) | `sitemap_cache.fetched_at` | Set to `now.toISOString()` at insert time (`src/db/repositories/sitemap-cache-repo.ts:81`). |
| `sitemapExpiresAt` | `string` (ISO) | `sitemap_cache.expires_at` | `now + ttlMs` (default 24h per `src/db/repositories/sitemap-cache-repo.ts:10`). |
| `sitemapSourceUrl` | `string \| null` | `sitemap_cache.source_url` | Nullable per the migration at `src/db/migrations.ts:308` (legacy rows from before the column was added may be `null` — see `src/tests/unit/db-migration.test.ts:431-444` which exercises the `null` case). |

Out of scope for *this* layer: `activeProfile`, `healthStatus`, `healthCheckedAt`, `healthReason`, `brandAssociations`, `generationCount`. Those are aggregated by the integration-layer step (context-builder #2) from `extractor_profiles`, `domain_status`, `brand_sites`, and `profile_generations`.

---

## 5. Existing Patterns to Match

| Pattern | Reference |
|---|---|
| Settings GET without workspace gate | `src/server/routes/onboarding-routes.ts:1016` (`GET /onboarding/settings/extractor-profiles`) |
| Settings POST that takes `{ domain }` | `src/server/routes/onboarding-routes.ts:1021` (`POST /onboarding/settings/extractor-profiles`) |
| Settings POST that takes a body and returns 200 even on no-op | `src/server/routes/onboarding-routes.ts:956` (`DELETE /onboarding/settings/api-keys/:service`) |
| Repo "list all" returning a typed array | `src/db/repositories/brand-site-repo.ts:83` (`listAllBrandSites`) |
| Repo "delete by id" returning `boolean` | `src/db/repositories/api-key-repo.ts:62` |
| Client typed `request<T>` helper | top of `src/client/onboarding-api.ts` |
| Client function naming | `deleteBrandSite`, `deleteApiKey`, `deleteLlmTaskConfig` — verb-first, no "Service" suffix |
| Test DB lifecycle | `src/tests/unit/sitemap-cache-repo.test.ts:13-22` — `initDb` → `runMigrations` → `unlinkSync` in `afterAll` |

---

## 6. Risks & Caveats

1. **No workspace scoping for `sitemap_cache`.** Confirmed by reading the migration at `src/db/migrations.ts:303-322` and the repo: the table has no `workspace_id` column. If multi-workspace support is added later, the new `listAllSitemapCaches` and `clearSitemapCacheForDomain` will both need a workspace filter. The current call is fine for the single-workspace model this project uses today.
2. **Route shadow risk.** The catch-all at `src/server/routes/onboarding-routes.ts:1138` (`route.get('/onboarding/products/*', ...)`) could in principle shadow `/onboarding/settings/domain-diagnostics`, but Hono routes are matched by specificity and `/onboarding/settings/*` paths are *before* the catch-all in the file. As long as the new GET is added above line 1138 it is safe.
3. **`clearSitemapCacheForDomain` semantics.** Returning `cleared: false` is the correct UX for "there was nothing to clear" — but it is *not* an error. Do not throw or return 4xx.
4. **`urls_json` parse failures.** The existing `getCachedSitemapUrls` logs and returns `null` for malformed JSON (`src/db/repositories/sitemap-cache-repo.ts:62-66`). The new `listAllSitemapCaches` should follow the same behavior at row level (log + skip with empty `urls`/`sitemapUrlsCount: 0`) — never let one bad row poison the whole listing.
5. **No automated test files for routes/client API in this repo.** Searched `src/tests` for `onboarding-routes` and `onboarding-api` — neither exists (`find` returned no matches). New code should be exercised by repo-level unit tests only (extending `src/tests/unit/sitemap-cache-repo.test.ts`); route/client layers will be covered by manual smoke tests and the existing per-feature acceptance runs.
6. **Schema drift risk for `source_url`.** The column was added in a migration; legacy rows may have `NULL` (`src/tests/unit/db-migration.test.ts:431-444` proves this is exercised). The route and client must both type it as `string | null`, not `string`.

---

## 7. Implementation-Ready Meta-Prompt

**Goal:** Extend the sitemap cache repo, server routes, and client API with read-all and clear-by-domain operations so the Domain Diagnostics panel can list every cached sitemap and let an operator force a re-fetch for a single domain.

**Context / Evidence:**
- `src/db/repositories/sitemap-cache-repo.ts:10` — `SITEMAP_CACHE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000` (reuse, do not redefine).
- `src/db/repositories/sitemap-cache-repo.ts:24` — `normalizeDomain()` (lowercase + strip `www.`); use for input normalization in the new clear-by-domain function.
- `src/db/repositories/sitemap-cache-repo.ts:46` — existing `DELETE FROM sitemap_cache WHERE domain = ?` pattern.
- `src/db/repositories/sitemap-cache-repo.ts:81` — `fetchedAt` / `expiresAt` are stored as ISO strings.
- `src/db/migrations.ts:303-322` — table schema: `domain TEXT PRIMARY KEY, urls_json TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL, source_url TEXT`.
- `src/server/routes/onboarding-routes.ts:1016-1045` — mirror style for the new GET (sync handler, no workspace gate, no `async`).
- `src/server/routes/onboarding-routes.ts:1021-1039` — mirror style for the new POST (body parse, `domain is required` check).
- `src/client/onboarding-api.ts` — module-level `request<T>(path, options)` helper handles JSON, headers, error throws; no new helper needed.

**Required changes (exact):**

1. **`src/db/repositories/sitemap-cache-repo.ts`** — add at the end of the file (do not modify existing exports):
   ```ts
   export interface SitemapCacheRow {
     domain: string;
     urls: string[];
     sitemapUrlsCount: number;
     sitemapFetchedAt: string;
     sitemapExpiresAt: string;
     sitemapSourceUrl: string | null;
   }

   export function listAllSitemapCaches(): SitemapCacheRow[] {
     const db = getDb();
     const rows = db.query(
       `SELECT domain, urls_json, fetched_at, expires_at, source_url
        FROM sitemap_cache
        ORDER BY domain`
     ).all() as Array<{
       domain: string;
       urls_json: string;
       fetched_at: string;
       expires_at: string;
       source_url: string | null;
     }>;
     return rows.map((r) => {
       let urls: string[] = [];
       try {
         const parsed = JSON.parse(r.urls_json);
         if (Array.isArray(parsed)) {
           urls = parsed.filter((u): u is string => typeof u === 'string');
         }
       } catch (err) {
         console.error(`Failed to parse cached sitemap urls for domain "${r.domain}":`, err);
       }
       return {
         domain: r.domain,
         urls,
         sitemapUrlsCount: urls.length,
         sitemapFetchedAt: r.fetched_at,
         sitemapExpiresAt: r.expires_at,
         sitemapSourceUrl: r.source_url,
       };
     });
   }

   export function clearSitemapCacheForDomain(domain: string): boolean {
     const db = getDb();
     const normDomain = normalizeDomain(domain);
     const result = db.query('DELETE FROM sitemap_cache WHERE domain = ?').run(normDomain);
     return (result as { changes: number }).changes > 0;
   }
   ```

2. **`src/server/routes/onboarding-routes.ts`** — add to the existing import block (alongside other repo imports) and add two new routes *between* the `extractor-profiles` block (ends ~line 1045) and the `POST /onboarding/extractor-profiles/test` route (line 1047). Do not place them after the `/onboarding/products/*` catch-all.

3. **`src/client/onboarding-api.ts`** — append at the end of the file inside a new `// ─── Domain Diagnostics API ───` section.

**Success criteria:**
- `listAllSitemapCaches()` returns one row per `sitemap_cache` row, including expired ones, with `sitemapUrlsCount` matching `urls.length`.
- `clearSitemapCacheForDomain('example.com')` removes the row keyed by `example.com` (or `www.example.com` — same row) and returns `true`; returns `false` for an unknown domain.
- `GET /api/onboarding/settings/domain-diagnostics` returns `{ caches: [...] }` with exactly the five fields per row.
- `POST /api/onboarding/settings/clear-sitemap-cache` with `{ "domain": "..." }` returns `{ success: true, cleared: boolean }` and a missing domain returns 400.
- `getDomainDiagnostics()` and `clearSitemapCache(domain)` are exported from the client module and use the existing `request<T>` helper.
- New unit tests added to `src/tests/unit/sitemap-cache-repo.test.ts` cover: (a) `listAllSitemapCaches` returns rows for both fresh and expired entries; (b) `listAllSitemapCaches` skips rows with malformed `urls_json` instead of throwing; (c) `clearSitemapCacheForDomain` normalizes `www.`, returns `true` for an existing row, and returns `false` for an unknown row.

**Hard constraints:**
- No edits to existing function bodies in `sitemap-cache-repo.ts`. Only append.
- Do not introduce a new `normalizeDomain` — reuse the existing one.
- Do not add workspace gating to the new routes (the file's existing settings routes are not workspace-gated).
- Do not change the `sitemap_cache` table schema.
- Do not add a `null`-check on `expires_at` parsing — the existing repo doesn't either; the column is `NOT NULL` in the migration.

**Suggested approach:**
1. Append the two new exports to `sitemap-cache-repo.ts`.
2. Extend `src/tests/unit/sitemap-cache-repo.test.ts` with 3 new `it` blocks; run `bun test src/tests/unit/sitemap-cache-repo.test.ts` and confirm green.
3. Add the import line and the two routes to `onboarding-routes.ts`. Run `bun run typecheck`.
4. Append the two client functions to `onboarding-api.ts`. Run `bun run typecheck` again.
5. Smoke-test by running `bun run dev`, then `curl http://localhost:PORT/api/onboarding/settings/domain-diagnostics` (expect `{ caches: [] }` if empty), insert a row via a small node script or by hitting a discovery path, then curl again to confirm shape.

**Validation:**
- `bun run typecheck` after each step — should be zero new errors.
- `bun test src/tests/unit/sitemap-cache-repo.test.ts` — should pass with the 3 new cases.
- Manual `curl` against the running dev server:
  - `GET /api/onboarding/settings/domain-diagnostics` → `{ "caches": [...] }`.
  - `POST /api/onboarding/settings/clear-sitemap-cache` with `{ "domain": "x.com" }` → `{ "success": true, "cleared": false }` if absent, `true` if present.
- Negative path: send a malformed `urls_json` row directly via `db.query` in a one-off script, confirm `listAllSitemapCaches` returns an entry with `sitemapUrlsCount: 0` and an empty `urls` array (visible in JSON as `[]`) and logs the error.

**Stop / escalation rules:**
- Stop and ask via `contact_supervisor` if the supervisor wants this layer to *also* own aggregation (active profile, health status, brand associations) — that is context-builder #2's job, not this layer's.
- Stop and ask if the route should require an active workspace (it currently does not, matching the surrounding settings routes).
- Do not add a per-domain `expired` flag to the response — `sitemapExpiresAt` already carries the information; the panel can compute staleness.
- Do not introduce new tests for the route or the client API — neither has precedent in this repo (verified via `find` for `**/onboarding-routes*` and `**/onboarding-api*` under `src/tests`).

**Resolved questions / assumptions:**
- Naming: `clearSitemapCache` on the *client* matches the *repo* name and is the most natural fit; no risk of collision because the client file does not currently export that name.
- The GET response wrapper is `caches` (matches the existing `brandSites`, `extractorProfiles`, `taskConfigs` pattern).
- The POST response uses `cleared: boolean` to distinguish "no row matched" from success; this is friendlier to the UI than 404 and matches the spirit of `DELETE /onboarding/settings/api-keys/:service` returning `{ success: true }` unconditionally.
- The route path is `clear-sitemap-cache` (not `clear-sitemap-cache-by-domain`) — the body disambiguates; the `domain` field in the body is the natural disambiguator.
