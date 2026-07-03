# Domain Diagnostics — Integration Plan

Unify sitemap cache + domain status + extractor profiles + brand sites + profile generations into a single, operator‑visible **Domain Diagnostics** section in `OnboardingSettings.tsx`. The goal is one row per known domain that exposes every per‑domain signal that currently lives in five separate, mostly‑invisible SQLite tables.

---

## 1. Unified `DomainDiagnosticsEntry` Type

The shape returned by the new aggregate endpoint. Designed so a single GET produces everything a single row in the diagnostics table needs, plus a `details` block for the expanded view.

```ts
// Place: src/shared/schemas/onboarding.ts (next to BrandSite / ExtractorProfile)

export type DomainHealthStatus = 'ok' | 'blocked' | 'offline' | 'mismatch' | 'unknown';

/**
 * One row of the unified Domain Diagnostics table. Aggregated server‑side
 * from: extractor_profiles, sitemap_cache, domain_status, brand_sites,
 * profile_generations. All fields are read‑only; mutations go through the
 * existing /settings/extractor-profiles, /settings/brand-sites, and a new
 * pair of /settings/domain-diagnostics action endpoints.
 */
export interface DomainDiagnosticsEntry {
  domain: string;                       // normalized (lowercased, www. stripped)

  // Extractor profile (Layer 0) ─────────────────────────────────────────
  hasActiveProfile: boolean;            // true ⇔ row exists in extractor_profiles
  activeProfileId: string | null;       // null when no profile
  profileUpdatedAt: string | null;      // mirror of extractor_profiles.updated_at

  // Sitemap cache ──────────────────────────────────────────────────────
  sitemapUrlsCount: number;             // 0 when no cache row, or expired/missing
  sitemapFetchedAt: string | null;      // ISO 8601 from sitemap_cache.fetched_at
  sitemapExpiresAt: string | null;      // ISO 8601 from sitemap_cache.expires_at
  sitemapSourceUrl: string | null;      // sitemap_cache.source_url (the URL actually fetched)
  sitemapStale: boolean;                // true when expires_at <= now

  // Domain health ──────────────────────────────────────────────────────
  healthStatus: DomainHealthStatus;     // 'unknown' when no row in domain_status
  healthCheckedAt: string | null;       // ISO 8601 from domain_status.checked_at
  healthReason: string | null;          // domain_status.reason (free‑text, may be null)
  healthStale: boolean;                 // true when checked_at > 7d ago (per repo logic)

  // Brand associations (many brand_sites rows can target one domain) ───
  brandAssociations: Array<{
    id: string;
    brandName: string;
    successCount: number;
    lastUsedAt: string | null;
  }>;

  // Generated profile proposals ────────────────────────────────────────
  generationCount: number;              // total profile_generations rows for this domain
  latestGenerationStatus:               // null when generationCount === 0
    | 'proposed'
    | 'validated'
    | 'rejected'
    | 'promoted'
    | 'failed'
    | null;
  latestGenerationAt: string | null;    // created_at of the most recent generation
}

export const DomainDiagnosticsEntrySchema = z.object({ /* mirror of above */ });

export interface DomainDiagnosticsResponse {
  entries: DomainDiagnosticsEntry[];     // sorted by domain asc
  generatedAt: string;                  // server time ISO 8601
}
```

### Field derivation rules (all server‑side)

| Field | Source |
|---|---|
| `domain` | Normalized: `domain.toLowerCase().replace(/^www\./,'').trim()` — same rule used by `extractor-profile-repo`, `domain-status-repo`, `sitemap-cache-repo`, `brand-site-repo`, and `profile-generation-repo` (all five repos already share this exact normalize function — do **not** re‑implement it; reuse each repo's per‑domain getter). |
| `hasActiveProfile` | `extractor_profiles.domain = ?` row exists. |
| `sitemapUrlsCount` | Parse `sitemap_cache.urls_json` (already a string[] after `getCachedSitemapUrls`); return 0 on miss / parse error / expiry. The repo self‑deletes expired rows — count after that. |
| `sitemapStale` | `sitemapExpiresAt && new Date(expiresAt).getTime() <= Date.now()` (or `null`). |
| `healthStatus` | `'unknown'` when no `domain_status` row; else the row's `status` cast to `DomainHealthStatus`. |
| `healthStale` | `now − checked_at > 7d` (mirroring `getDomainStatus` expiry). |
| `brandAssociations` | All `brand_sites` rows where `domain = ?`, projected to `{id, brandName, successCount, lastUsedAt}`. |
| `generationCount` | `COUNT(*)` from `profile_generations` for the domain. |
| `latestGenerationStatus` | `status` of the row with the highest `created_at` (tiebreak by `rowid DESC`). `null` when 0 rows. |

### Domain universe (the row set)

Rows are the **union** of domains present in any of the five tables, deduped. This guarantees that a domain is visible the moment any signal exists for it, even if it has no profile yet.

```
domains = distinct(union(
  extractor_profiles.domain,
  sitemap_cache.domain,
  domain_status.domain,
  brand_sites.domain,
  profile_generations.domain
))
```

The aggregate must do this with one query per repo (each repo's `listAll*` already returns the full table; for the very large `sitemap_cache.urls_json` column, parse in Node, not in SQL — `JSON_ARRAY_LENGTH` exists in SQLite ≥ 3.38 but Bun's bundled SQLite is older; the parser is already proven in `sitemap-cache-repo.ts`).

---

## 2. New Server Endpoint — `GET /api/onboarding/settings/domain-diagnostics`

**Location:** `src/server/routes/onboarding-routes.ts` — add a new `route.get(...)` block **after** the existing `/onboarding/settings/extractor-profiles` group (line ~1044) and **before** the `Domain profile governance` group (line ~1230). Pattern matches the existing route style exactly.

### Imports to add at the top of the file

```ts
import {
  listAllProfiles,
  // ...existing
} from '../../db/repositories/extractor-profile-repo';
import {
  getDomainStatus,                 // already normalized + 7‑day expiry aware
} from '../../db/repositories/domain-status-repo';
import {
  getCachedSitemapUrls,            // returns string[]|null, self‑deletes expired rows
  insertSitemapCache,              // for "refresh sitemap" action
  clearSitemapCache,               // for "clear sitemap" action
} from '../../db/repositories/sitemap-cache-repo';
import {
  listAllBrandSites,               // already returns all rows
} from '../../db/repositories/brand-site-repo';
import {
  listAllProfileGenerations,       // for the per‑domain count + latest
} from '../../db/repositories/profile-generation-repo';
import { fetchAndParseSitemap } from '../../onboarding/sitemap-fetcher';
import { getDb } from '../../db/connection';
```

### GET handler

```ts
/**
 * GET /api/onboarding/settings/domain-diagnostics
 *
 * Returns one entry per known domain (union of extractor_profiles,
 * sitemap_cache, domain_status, brand_sites, profile_generations) with
 * sitemap, health, brand, and generation signals rolled up.
 *
 * Read‑only. Mutations live on /settings/domain-diagnostics/:action endpoints.
 */
route.get('/onboarding/settings/domain-diagnostics', (c) => {
  const entries = buildDomainDiagnostics();
  return c.json({
    entries,
    generatedAt: new Date().toISOString(),
  } satisfies DomainDiagnosticsResponse);
});
```

### Implementation (suggested new helper file)

To keep `onboarding-routes.ts` slim, put the aggregator in a new file. It is a pure function over the existing repos and is unit‑testable in isolation.

```ts
// NEW: src/onboarding/domain-diagnostics-service.ts
import { getDb } from '../db/connection';
import { listAllProfiles } from '../db/repositories/extractor-profile-repo';
import { getDomainStatus } from '../db/repositories/domain-status-repo';
import { getCachedSitemapUrls } from '../db/repositories/sitemap-cache-repo';
import { listAllBrandSites } from '../db/repositories/brand-site-repo';
import { listAllProfileGenerations } from '../db/repositories/profile-generation-repo';
import type { DomainDiagnosticsEntry, DomainHealthStatus } from '../shared/schemas/onboarding';

function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, '').trim();
}

const STALE_HEALTH_DAYS = 7;
const SITEMAP_STALE_TOLERANCE_MS = 0; // sitemap_cache repo already treats expiry as stale

function healthStale(checkedAt: string | null): boolean {
  if (!checkedAt) return true;
  const diffDays =
    (Date.now() - new Date(checkedAt).getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > STALE_HEALTH_DAYS;
}

export function buildDomainDiagnostics(): DomainDiagnosticsEntry[] {
  const db = getDb();

  // 1. Read all five tables (or per‑domain getters for the time‑sensitive ones).
  const profiles = listAllProfiles();
  const brandSites = listAllBrandSites();
  const generations = listAllProfileGenerations({ limit: 10000 }); // generous; one row per probe
  const domainRows = db
    .query('SELECT domain, fetched_at, expires_at, source_url FROM sitemap_cache')
    .all() as Array<{
      domain: string;
      fetched_at: string;
      expires_at: string;
      source_url: string | null;
    }>;

  // 2. Collect the union of domains.
  const domainSet = new Set<string>();
  for (const p of profiles) domainSet.add(p.domain);
  for (const b of brandSites) domainSet.add(b.domain);
  for (const g of generations) domainSet.add(g.domain);
  for (const s of domainRows) domainSet.add(s.domain);
  // domain_status probed per‑domain below (it self‑deletes stale rows in the same call)
  // — but for row union we need to scan it once too:
  const statusDomainRows = db
    .query('SELECT domain FROM domain_status')
    .all() as Array<{ domain: string }>;
  for (const s of statusDomainRows) domainSet.add(s.domain);

  // 3. Index the four large sources by domain.
  const profileByDomain = new Map(profiles.map(p => [p.domain, p]));
  const brandByDomain = new Map<string, typeof brandSites>();
  for (const b of brandSites) {
    const arr = brandByDomain.get(b.domain) ?? [];
    arr.push(b);
    brandByDomain.set(b.domain, arr);
  }
  const generationsByDomain = new Map<string, typeof generations>();
  for (const g of generations) {
    const arr = generationsByDomain.get(g.domain) ?? [];
    arr.push(g);
    generationsByDomain.set(g.domain, arr);
  }
  const sitemapByDomain = new Map(
    domainRows.map(s => [normalizeDomain(s.domain), s]),
  );

  // 4. Build one entry per domain. Per‑domain getters (getDomainStatus,
  //    getCachedSitemapUrls) re‑probe so we honour self‑deletion of stale rows.
  const out: DomainDiagnosticsEntry[] = [];
  for (const domain of Array.from(domainSet).sort()) {
    const profile = profileByDomain.get(domain) ?? null;
    const sitemapRow = sitemapByDomain.get(domain) ?? null;

    // Use the repos' own getters to benefit from their self‑deletion semantics.
    const cachedUrls = getCachedSitemapUrls(domain);   // []‑safe: null ⇒ 0
    const status = getDomainStatus(domain);            // null ⇒ 'unknown'

    const brands = (brandByDomain.get(domain) ?? []).map(b => ({
      id: b.id,
      brandName: b.brandName,
      successCount: b.successCount,
      lastUsedAt: b.lastUsedAt,
    }));

    const gens = generationsByDomain.get(domain) ?? [];
    gens.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = gens[0] ?? null;

    out.push({
      domain,
      hasActiveProfile: !!profile,
      activeProfileId: profile?.id ?? null,
      profileUpdatedAt: profile?.updatedAt ?? null,
      sitemapUrlsCount: cachedUrls?.length ?? 0,
      sitemapFetchedAt: sitemapRow?.fetched_at ?? null,
      sitemapExpiresAt: sitemapRow?.expires_at ?? null,
      sitemapSourceUrl: sitemapRow?.source_url ?? null,
      sitemapStale: sitemapRow
        ? new Date(sitemapRow.expires_at).getTime() <= Date.now()
        : false,
      healthStatus: (status?.status ?? 'unknown') as DomainHealthStatus,
      healthCheckedAt: status?.checkedAt ?? null,
      healthReason: status?.reason ?? null,
      healthStale: healthStale(status?.checkedAt ?? null),
      brandAssociations: brands,
      generationCount: gens.length,
      latestGenerationStatus: latest?.status ?? null,
      latestGenerationAt: latest?.createdAt ?? null,
    });
  }
  return out;
}
```

### Three new mutation endpoints (action buttons)

These keep cache invalidation explicit and bypass the need for a custom SQL delete on the client.

```ts
// DELETE /api/onboarding/settings/domain-diagnostics/:domain/sitemap
route.delete('/onboarding/settings/domain-diagnostics/:domain/sitemap', (c) => {
  const domain = c.req.param('domain');
  const db = getDb();
  const result = db
    .query('DELETE FROM sitemap_cache WHERE domain = ?')
    .run(normalizeDomain(domain));
  return c.json({ success: true, deleted: result.changes });
});

// DELETE /api/onboarding/settings/domain-diagnostics/:domain/health
route.delete('/onboarding/settings/domain-diagnostics/:domain/health', (c) => {
  const domain = c.req.param('domain');
  const cleared = clearDomainStatus(domain);
  return c.json({ success: true, cleared });
});

// POST /api/onboarding/settings/domain-diagnostics/:domain/sitemap/refresh
//   Bypasses the cache, runs fetchAndParseSitemap, writes a fresh row.
route.post('/onboarding/settings/domain-diagnostics/:domain/sitemap/refresh', async (c) => {
  const domain = c.req.param('domain');
  const norm = normalizeDomain(domain);
  try {
    const profile = findProfileByDomain(norm);
    const result = await fetchAndParseSitemap(norm, profile?.sitemapProductUrlPattern ?? null);
    if (result.urls.length > 0 && result.sourceUrl) {
      insertSitemapCache(norm, result.urls, result.sourceUrl);
    }
    return c.json({ success: true, urlCount: result.urls.length, sourceUrl: result.sourceUrl });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
```

> All three sit next to the GET handler. `clearSitemapCache` (whole‑table) is **not** exposed — the UI only deletes one domain at a time so we don't accidentally wipe a healthy cache.

---

## 3. Client API Function Signature

Add to `src/client/onboarding-api.ts` (in the **Settings APIs** block, after `getOllamaModels`).

```ts
// src/client/onboarding-api.ts

import type {
  // ...existing imports
  DomainDiagnosticsEntry,
  DomainDiagnosticsResponse,
} from '../shared/schemas/onboarding';

/**
 * Fetch the unified Domain Diagnostics snapshot. One entry per known
 * domain, regardless of which underlying table first produced it.
 */
export async function getDomainDiagnostics(): Promise<DomainDiagnosticsResponse> {
  return request<DomainDiagnosticsResponse>('/settings/domain-diagnostics');
}

/**
 * Action helpers — exposed as a small bag so the UI can call them without
 * re‑typing the URL pattern.
 */
export const domainDiagnosticsActions = {
  async clearSitemap(domain: string): Promise<{ success: boolean; deleted: number }> {
    return request<{ success: boolean; deleted: number }>(
      `/settings/domain-diagnostics/${encodeURIComponent(domain)}/sitemap`,
      { method: 'DELETE' },
    );
  },
  async clearHealth(domain: string): Promise<{ success: boolean; cleared: boolean }> {
    return request<{ success: boolean; cleared: boolean }>(
      `/settings/domain-diagnostics/${encodeURIComponent(domain)}/health`,
      { method: 'DELETE' },
    );
  },
  async refreshSitemap(
    domain: string,
  ): Promise<{ success: boolean; urlCount: number; sourceUrl: string }> {
    return request<{ success: boolean; urlCount: number; sourceUrl: string }>(
      `/settings/domain-diagnostics/${encodeURIComponent(domain)}/sitemap/refresh`,
      { method: 'POST' },
    );
  },
};
```

---

## 4. UI Section Design — `DomainDiagnosticsSection`

### Placement

Insert the new section **between** the current "Domain Extractor Profiles" `<div style={styles.section}>` (ends around line 843 in the current file) and the "Generated Profile Governance" section (starts around line 846). The recommendation is correct — diagnostics belongs *after* profiles (so the per‑domain selector editor is right next to the per‑domain diagnostic view) and *before* the governance panel (so the generated‑proposal queue, which already keys on domain, can be read as a continuation).

### State machine (component‑local)

```ts
const [diagnostics, setDiagnostics] = useState<DomainDiagnosticsEntry[]>([]);
const [diagLoading, setDiagLoading] = useState(false);
const [diagError, setDiagError] = useState('');
const [expandedDomain, setExpandedDomain] = useState<string | null>(null);
const [actionPending, setActionPending] = useState<string | null>(null); // domain being acted on

const loadDiagnostics = useCallback(async () => {
  setDiagLoading(true); setDiagError('');
  try {
    const res = await getDomainDiagnostics();
    setDiagnostics(res.entries);
  } catch (err) {
    setDiagError(err instanceof Error ? err.message : String(err));
  } finally { setDiagLoading(false); }
}, []);

useEffect(() => { loadDiagnostics(); }, [loadDiagnostics]);
```

### Summary table layout (always visible)

```
┌────────────────────────┬──────┬───────────┬─────────┬──────────┬─────┬──────┐
│ Domain                 │ Prof │ Sitemap   │ Health  │ Brands   │ Gens│ ▸    │
├────────────────────────┼──────┼───────────┼─────────┼──────────┼─────┼──────┤
│ mywoof.com             │  ✓   │ 1.2k • 4h │ ok      │ MyWoof   │   3 │  ▾   │
│ suspectbrand.io        │  ✗   │ stale     │ blocked │ (none)   │   0 │  ▸   │
│   ↳ reason: 403 from C │      │           │ 6d ago  │          │     │      │
└────────────────────────┴──────┴───────────┴─────────┴──────────┴─────┴──────┘
```

Columns:

1. **Domain** — bold, monospaced. Clickable chevron to expand.
2. **Prof** — `✓` (green) / `✗` (gray) badge. Tooltip: `Updated YYYY‑MM‑DD` or `No active profile`.
3. **Sitemap** — two‑line cell. Top: `1,234 URLs`. Bottom: relative freshness — `4h ago`, `stale (2d overdue)`, `never cached`. Right‑aligned `↻` icon (refresh) that triggers `refreshSitemap(domain)`.
4. **Health** — colored pill (`ok` green, `blocked` red, `offline` gray, `mismatch` amber, `unknown` outline). On a second line: `checked 3d ago` / `stale 8d ago` / `—` and the truncated `reason` in a `<span title=…>` for hover.
5. **Brands** — comma‑separated brand names; `+N` overflow if >3. Empty → `—`.
6. **Gens** — `generationCount` (links to the `Generated Profile Governance` row for that domain if non‑zero; one line below: `latest: validated` in the same color scheme as `GeneratedProfilesPanel.STATUS_COLORS`).
7. **▸/▾** — toggle inline expansion.

### Expanded row (inline, colspan = 7)

Rendered only when `expandedDomain === row.domain`:

```tsx
<tr>
  <td colSpan={7} style={{ background: '#f9fafb', padding: 16 }}>
    <DomainDiagnosticsDetail
      entry={row}
      onClearSitemap={async () => { … }}
      onClearHealth={async () => { … }}
      onRefreshSitemap={async () => { … }}
      pending={actionPending === row.domain}
    />
  </td>
</tr>
```

The detail block shows:

- **Profile block** (when `hasActiveProfile`): six `<code>` snippets (title / price / description / brand / images / sitemap pattern) + `Updated at` + a "Edit" link that closes the expansion and calls `startEditProfile(profile)`. When **no** profile, show a "+ Create profile" button that closes the expansion and calls `startNewProfile` with `domain` pre‑filled.
- **Sitemap block**: `sourceUrl` (monospaced, clickable), `fetchedAt` + `expiresAt` + computed `stale in Xh`/`expired Yh ago`, `urlsCount`. Three buttons:
  - **Refresh sitemap** → `POST /:domain/sitemap/refresh`. Spinner on the row while in flight.
  - **Clear sitemap** → `DELETE /:domain/sitemap`. Confirm dialog ("Clear cached sitemap for X? Next discovery run will re‑fetch.").
  - **View first 25 URLs** → collapsible `<ul>` rendering the first 25 cached URLs (we already have them client‑side from the response — no extra fetch).
- **Health block**: status pill, `checkedAt`, full `reason` (not truncated). Button: **Clear health** → `DELETE /:domain/health`. Confirm dialog ("Forget the cached health for X? Next extraction will re‑check.").
- **Brand associations block**: table of `brandName / successCount / lastUsedAt` with a "Delete" link per row that calls `deleteBrandSite(id)` (existing handler, no new API).
- **Generations block**: badge summary (counts by status) + a "Open in Governance" button that scrolls to / expands the row in `GeneratedProfilesPanel` for that domain. (Implementation: a shared `requestedDomain` string in the parent component, and a `useEffect` in `GeneratedProfilesPanel` that auto‑opens matching rows — or simply a `window.scrollTo` + `openDomain` callback passed via a small ref/event; keep the coupling minimal.)

### Button states and confirmations

Reuse the same confirm pattern as the existing profile/brand‑site delete (`window.confirm`). Use the existing `primaryBtn` / `secondaryBtn` / `deleteBtn` style objects from `OnboardingSettings.tsx` so the new section is visually consistent.

### Reload strategy

`loadDiagnostics` is called on:
- Initial mount of `OnboardingSettings` (the same `fetchData` lifecycle — merge into the existing `fetchData` Promise.all or call it after).
- Click of the section's **Refresh** button.
- After every successful action button (clear/refresh) — refresh the diagnostics table in place.

---

## 5. Concrete File Changes

| File | Action |
|---|---|
| `src/shared/schemas/onboarding.ts` | Add `DomainHealthStatus`, `DomainDiagnosticsEntry`, `DomainDiagnosticsEntrySchema`, `DomainDiagnosticsResponse`. |
| `src/onboarding/domain-diagnostics-service.ts` | **NEW.** `buildDomainDiagnostics()` plus any helpers (`normalizeDomain`, `healthStale`). |
| `src/server/routes/onboarding-routes.ts` | Import the new service, `getDomainStatus`, `getCachedSitemapUrls`, `insertSitemapCache`, `clearDomainStatus`, `fetchAndParseSitemap`, `findProfileByDomain`. Add 4 routes (1 GET + 3 actions) inside the existing `route = new Hono()` instance. |
| `src/client/onboarding-api.ts` | Add `getDomainDiagnostics()` and `domainDiagnosticsActions`. |
| `src/client/components/OnboardingSettings.tsx` | Import new types + functions; add `DomainDiagnosticsSection` (or inline JSX). Place between the extractor profiles and generated governance sections. Wire `loadDiagnostics` into the existing `fetchData` lifecycle. |
| `src/tests/unit/domain-diagnostics-service.test.ts` | **NEW.** Unit tests for `buildDomainDiagnostics()` — covering: empty universe, single domain with profile only, sitemap expiry self‑deletion, health staleness, brand union across multiple brand_sites rows, generation count + latest status. |
| `src/tests/unit/onboarding-routes-domain-diagnostics.test.ts` | **NEW.** Route integration test: GET returns the union, action endpoints mutate the right rows, refresh endpoint writes a fresh `sitemap_cache` row. |
| `src/tests/unit/db-migration.test.ts` | No schema change required (we are *only* reading existing tables), so no migration test edits. |

---

## 6. Validation Strategy

1. **Unit tests** (`bun run test src/tests/unit/domain-diagnostics-service.test.ts`):
   - Build diagnostics from a fixture with one row in each table → all 12 fields populated, `hasActiveProfile=true`, `sitemapUrlsCount > 0`, `healthStatus !== 'unknown'`, `brandAssociations.length === 1`, `generationCount === N`.
   - Insert a `sitemap_cache` row with `expires_at` in the past → `getCachedSitemapUrls` self‑deletes; `sitemapUrlsCount === 0`, `sitemapStale === true`.
   - Insert a `domain_status` row with `checked_at` 8 days ago → `getDomainStatus` self‑deletes; `healthStatus === 'unknown'`, `healthStale === true`.
   - No rows in any table → empty array (never throws).
2. **Route tests** (`bun run test src/tests/unit/onboarding-routes-domain-diagnostics.test.ts`):
   - `GET /settings/domain-diagnostics` returns `{ entries, generatedAt }`.
   - `DELETE /settings/domain-diagnostics/:d/sitemap` removes the row only for that domain.
   - `DELETE /settings/domain-diagnostics/:d/health` calls `clearDomainStatus`.
   - `POST /settings/domain-diagnostics/:d/sitemap/refresh` with a fixture that points at a local mock HTTP server returns `{ success: true, urlCount, sourceUrl }` and writes a new `sitemap_cache` row.
3. **Type checks**: `bun run typecheck` — the new schema must be exported and consumed by both server and client.
4. **Manual smoke** (in the running app):
   - Open Settings → Domain Extractor Profiles → click "Edit" on one row → confirm the profile data shows up in the new diagnostics row's expanded view.
   - Force a stale sitemap (set `expires_at` in the past via a SQLite shell) → confirm the row shows `stale` + the Clear button works.
   - Click **Refresh sitemap** on a known domain → confirm the row's `fetchedAt` updates and `sitemapUrlsCount` matches a manual `curl` of the sitemap.

---

## 7. Residual Risks

- **Read amplification on large sitemaps.** `getCachedSitemapUrls` parses the entire `urls_json` blob on every call. With ~hundreds of domains, building diagnostics becomes O(N · mean_url_array). Mitigation: add a `sitemap_url_count INTEGER` column to `sitemap_cache` in a follow‑up migration so the GET can avoid parsing; for v1 we accept the cost because the typical operator will have tens of domains, not thousands.
- **Sitemap refresh hits the network.** The `POST .../refresh` endpoint performs a live `fetch()`. It can hang or fail on slow upstreams. The handler should set a per‑request timeout (~15s) and bubble the error into the JSON response with a non‑2xx status so the UI can show a non‑destructive error toast. (Not strictly required for v1 but worth flagging.)
- **`listAllProfileGenerations` cap.** The current repo defaults to `limit: 100` (see `safeListOrder`); we pass an explicit larger limit for the aggregator, but the UI may still see undercounted `generationCount` on domains with >100 probes. For diagnostics the union is fine, but be aware that the count is bounded.
- **Self‑deletion side effects.** Both `getDomainStatus` and `getCachedSitemapUrls` delete stale rows on access. A `GET /settings/domain-diagnostics` call from an operator will silently prune stale data. This is consistent with the rest of the system, but the section should show a one‑line hint: *"Diagnostics reads may auto‑purge expired cache rows."* — not a blocker.
- **No row in `domain_status` ≠ "unknown forever".** The endpoint returns `'unknown'` for any domain with no `domain_status` row. This is the same as the rest of the codebase (e.g. `source-discovery.ts` treats missing as "not blocked"); the UI should make this clear (use a hollow/outline pill).

---

## 8. Meta‑Prompt (Implementation Contract for the Builder)

> **Goal:** Add a unified Domain Diagnostics section to `OnboardingSettings.tsx` by reading the five per‑domain SQLite tables in a single new aggregate endpoint, and surface the result as an expandable table with clear/refresh actions.

**Context & evidence**
- The five per‑domain signals already exist in the DB; today they are invisible to the operator (sitemap_cache and domain_status have no UI at all).
- The `Domain Extractor Profiles` section in `OnboardingSettings.tsx` (lines 696‑843) was just refactored to use a `ProfileForm` subcomponent and the existing `startNewProfile` / `startEditProfile` handlers. Reuse these instead of duplicating the form.
- `src/db/repositories/sitemap-cache-repo.ts` already has `getCachedSitemapUrls` (self‑deletes expired rows) and `clearSitemapCache` (whole‑table only — do not expose).
- `src/db/repositories/domain-status-repo.ts` already has `getDomainStatus` (self‑deletes after 7 days) and `clearDomainStatus` (per‑domain).
- `src/db/repositories/brand-site-repo.ts` already has `listAllBrandSites`.
- `src/db/repositories/extractor-profile-repo.ts` already has `listAllProfiles` and `findProfileByDomain`.
- `src/db/repositories/profile-generation-repo.ts` already has `listAllProfileGenerations({ limit })` and `listProfileGenerationsByDomain`.
- All five repos normalize domains identically: `domain.toLowerCase().replace(/^www\./,'').trim()`. The aggregator's `normalizeDomain` helper is therefore a no‑op safety net, not the source of truth — the per‑repo getters already do the work.
- API route style: `route.get('/onboarding/settings/<name>', (c) => c.json({ ... }))`. Client style: `request<T>('/settings/<name>')`. Follow the existing patterns exactly; do not introduce a new request wrapper.

**Success criteria**
1. `bun run typecheck` passes with the new types exported from `src/shared/schemas/onboarding.ts`.
2. `bun run test` passes with the two new test files.
3. In the running app, **Settings → Onboarding Pipeline Settings** shows a new section "Domain Diagnostics" between "Domain Extractor Profiles" and "Generated Profile Governance", with one row per known domain. Each row shows: profile ✓/✗, sitemap URL count + freshness, health status pill + reason, brand names, generation count + latest status.
4. Each row expands to show profile selectors, sitemap source URL, full reason, brand associations, and an "Open in Governance" link.
5. Per‑row action buttons **Clear sitemap**, **Clear health**, and **Refresh sitemap** each call the matching new route and the row updates in place.
6. No new migration: only existing tables are read.

**Hard constraints**
- Read‑only aggregator: do **not** add a new SQL migration in this change. The new types and service are pure functions over the existing repos.
- Never expose a whole‑table cache clear (`clearSitemapCache`); only per‑domain deletes via the new `DELETE` route.
- Keep `OnboardingSettings.tsx` readable: extract the new section into a `DomainDiagnosticsSection` component in the same file (matches the existing `ProfileForm` pattern) rather than inlining hundreds of lines into the parent.
- The diagnostic row's `domain` is the source of truth for the row; do not let the UI invent a new normalized form.
- Do not break the existing tests in `src/tests/unit/db-migration.test.ts` — the "all core tables" assertion must still list the same tables.

**Suggested approach**
1. Add types to `src/shared/schemas/onboarding.ts`.
2. Create `src/onboarding/domain-diagnostics-service.ts` with `buildDomainDiagnostics()`.
3. Add the GET + 3 action routes to `src/server/routes/onboarding-routes.ts`.
4. Add `getDomainDiagnostics()` and `domainDiagnosticsActions` to `src/client/onboarding-api.ts`.
5. Add the `DomainDiagnosticsSection` component to `OnboardingSettings.tsx` and place its `<div style={styles.section}>` block between the existing two sections.
6. Write `src/tests/unit/domain-diagnostics-service.test.ts` and `src/tests/unit/onboarding-routes-domain-diagnostics.test.ts`.
7. Run `bun run typecheck` and `bun run test` to validate.

**Validation**
- `bun run typecheck` — must pass.
- `bun run test src/tests/unit/domain-diagnostics-service.test.ts` — must pass.
- `bun run test src/tests/unit/onboarding-routes-domain-diagnostics.test.ts` — must pass.
- Manual: open Settings, expand a row with a known profile, confirm the profile's selectors render, click Refresh Sitemap, confirm the row's `fetchedAt` updates.

**Stop / escalation rules**
- If the `listAllProfileGenerations` limit cap changes the design (e.g. you need unbounded counts): stop and ask; do not silently change the limit in the existing repo.
- If the placement recommendation conflicts with another in‑flight UI change, stop and confirm rather than duplicating sections.
- If `clearSitemapCache` (whole‑table) turns out to be needed for the operator, escalate before exposing it — the whole‑table delete was deliberately omitted in this plan.

**Resolved questions / assumptions**
- Domain set is the **union** of all five tables; rows with only a sitemap cache entry (no profile) must be visible. ✅
- `sitemapStale` and `healthStale` are derived booleans on the server, not separate columns. ✅
- The UI shows one inline expand at a time (a single `expandedDomain` state) — matches the `GeneratedProfilesPanel` pattern, keeps the DOM small when there are many domains. ✅
- The "Open in Governance" link scrolls to the existing `GeneratedProfilesPanel`; no new review UI is introduced. ✅
- `refreshSitemap` re‑uses `fetchAndParseSitemap` (in `src/onboarding/sitemap-fetcher.ts`) which already honours `extractor_profiles.sitemap_product_url_pattern`. No new fetch logic. ✅

---

## Acceptance Report

The body of this plan satisfies the contract:
- `criterion-1`: Every claim is anchored to a file and line range (OnboardingSettings.tsx 696‑843, 846+; the five repos with their public APIs; the route file with the exact insertion point; the client API file with the exact insertion point). Severity is implicit via the explicit "Residual Risks" section (read amplification = low, network timeout on refresh = low, `listAllProfileGenerations` limit = low, self‑deletion side effect = informational).

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete file paths and line ranges: OnboardingSettings.tsx (Domain Extractor Profiles at lines 696-843, Generated Profile Governance at lines 846+, ProfileForm subcomponent at the bottom of the same file); src/db/repositories/extractor-profile-repo.ts (listAllProfiles, findProfileByDomain, upsertProfile merge semantics); src/db/repositories/brand-site-repo.ts (listAllBrandSites, mapRowToBrandSite); src/db/repositories/sitemap-cache-repo.ts (getCachedSitemapUrls self-deletes expired rows, insertSitemapCache, clearSitemapCache whole-table); src/db/repositories/domain-status-repo.ts (getDomainStatus self-deletes after 7d, clearDomainStatus per-domain); src/db/repositories/profile-generation-repo.ts (listAllProfileGenerations with default limit 100, listProfileGenerationsByDomain, status values). New endpoint design placed in src/server/routes/onboarding-routes.ts after the existing extractor-profiles group (line ~1044) and before the Domain profile governance group (line ~1230). New shared types in src/shared/schemas/onboarding.ts next to BrandSite. New client functions in src/client/onboarding-api.ts in the Settings APIs block."
    }
  ],
  "changedFiles": [
    ".pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/context-build/integration-plan.md"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/domain-diagnostics-service.test.ts (planned)",
    "src/tests/unit/onboarding-routes-domain-diagnostics.test.ts (planned)"
  ],
  "commandsRun": [
    {
      "command": "ls .pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/context-build/",
      "result": "passed",
      "summary": "Verified output directory exists / was created."
    }
  ],
  "validationOutput": [
    "No code was modified in this run — this is a context-build / integration-plan deliverable. Validation will run during the implementation phase using the commands listed in section 6 and the meta-prompt's Validation block."
  ],
  "residualRisks": [
    "low: getCachedSitemapUrls parses the entire urls_json per GET — acceptable at tens of domains, may need a sitemap_url_count column at hundreds.",
    "low: POST /:domain/sitemap/refresh performs a live fetch() with no per-request timeout in the proposed handler — recommend a ~15s timeout in the implementation phase.",
    "low: listAllProfileGenerations defaults to limit 100 — the diagnostics page passes an explicit larger limit, but operators with >100 probes per domain may still see undercounted generationCount.",
    "informational: domain_status and sitemap_cache rows are auto-deleted on read when stale, so opening this section will silently prune expired cache. UI should surface a one-line hint."
  ],
  "noStagedFiles": true,
  "diffSummary": "No code changes. Produced a single new planning artifact at .pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/context-build/integration-plan.md containing: (1) the DomainDiagnosticsEntry type spec, (2) the GET /api/onboarding/settings/domain-diagnostics route design plus 3 action endpoints, (3) the getDomainDiagnostics client signature, (4) the DomainDiagnosticsSection UI design (table + inline expand + 3 actions), (5) placement recommendation between the existing Domain Extractor Profiles and Generated Profile Governance sections, (6) residual risks, and (7) an implementation-ready meta-prompt.",
  "reviewFindings": [
    "no blockers",
    "info: extractor-profile-repo.ts listAllProfiles returns all rows — the aggregator uses it as the profile source. Confirmed no per-domain getter needed.",
    "info: brand-site-repo.ts has no per-domain getter; the aggregator builds a Map<domain, BrandSite[]> from listAllBrandSites() in memory — O(N) one-time, fine for v1.",
    "info: sitemap-cache-repo.ts exposes only whole-table clearSitemapCache(); the per-domain delete must use a direct DELETE FROM sitemap_cache WHERE domain = ? in the new route handler, which is the existing pattern in getCachedSitemapUrls.",
    "info: domain-status-repo.ts already exposes clearDomainStatus(domain) — reuse it directly, do not duplicate SQL in the route."
  ],
  "manualNotes": "This run is a context-build deliverable; no source files were touched. The plan is intentionally a contract for the next agent (builder) and lists exact insertion points, exact function signatures, and exact repos to reuse so the next agent does not have to rediscover the union-of-domains rule or the per-repo self-deletion semantics."
}
```
