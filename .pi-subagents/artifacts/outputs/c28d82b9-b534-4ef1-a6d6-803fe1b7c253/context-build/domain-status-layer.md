# Domain Diagnostics Panel — Context Handoff

This document is a **read-only, implementation-ready context pack** for adding a "Domain Diagnostics" section to the Onboarding Pipeline Settings page. The goal is to surface the existing `domain_status` table (currently only consumed internally during source discovery, page extraction, and sitemap fetching) to the operator as a read-only health board.

---

## 1. Existing Codebase Map

### 1.1 `src/db/repositories/domain-status-repo.ts` (the source of truth)

**File:** `src/db/repositories/domain-status-repo.ts` (97 lines)

Already exports three functions and one public interface:

- **`DomainStatus` interface** (lines 3–8) — the canonical row shape:
  ```ts
  export interface DomainStatus {
    domain: string;                          // normalized (lowercased, no www.)
    status: 'ok' | 'blocked' | 'offline' | 'mismatch';
    checkedAt: string;                       // ISO timestamp
    reason: string | null;
  }
  ```
- **`getDomainStatus(domain)`** (lines 29–59) — returns a single row. **Side effect: deletes the row and returns `null` if `checked_at` is older than 7 days** (stale eviction). Do **NOT** call this from the new diagnostic list view — that would silently wipe the data the operator is trying to inspect.
- **`recordDomainStatus(domain, status, reason?)`** (lines 64–90) — upsert (INSERT … ON CONFLICT DO UPDATE).
- **`clearDomainStatus(domain)`** (lines 93–98) — delete a single row, returns `boolean` indicating whether anything was deleted.
- **`normalizeDomain(domain)`** (lines 18–20) — private helper, lowercases + strips `www.` prefix. Reuse this normalization for the new list function so the view matches the keys actually stored.

**Migration** (in `src/db/migrations.ts:91–106`): `domain_status` table is created with `(domain TEXT PRIMARY KEY, status TEXT NOT NULL, checked_at TEXT NOT NULL, reason TEXT)` plus `idx_domain_status_status`. The table already exists in the production DB — no schema change is needed for this work.

**Existing internal callers (do not break these):**
- `src/onboarding/source-discovery.ts:37, 108, 204` — uses `getDomainStatus` to short-circuit discovery when domain is known blocked/offline.
- `src/onboarding/page-extractor.ts:13, 207, 385, 400` — uses `recordDomainStatus` to mark `ok`, `offline`, or validation results.
- `src/onboarding/sitemap-fetcher.ts:58, 155, 173, 187, 490` — uses `recordDomainStatus` with `ok` after a successful fetch.
- `src/tests/unit/extraction-remedies.test.ts:5` — unit tests round-tripping the three existing functions.
- `src/tests/unit/{sitemap-fetcher, page-extractor-images, page-extractor-profile-generation, page-extractor-variant-inference}.test.ts` — mock the repo (no real DB calls).

**Risk:** Anything we add must keep `getDomainStatus`'s side-effect contract intact. The new list function must use a **plain read** (no deletion) so the diagnostics panel does not interact with the cache eviction path.

---

### 1.2 `src/client/components/OnboardingSettings.tsx` (the host component)

**File:** `src/client/components/OnboardingSettings.tsx` (~700 lines)

**Component shape:**
- Default export is `OnboardingSettings({ onBack }: { onBack: () => void })` — no `react-router` prop, no internal route. The parent (likely `App.tsx`) owns navigation and just passes `onBack`.
- All state lives in one component (no Context, no Redux). Section-level sub-panels are either inline JSX or extracted into a sibling component (e.g. `LlmTaskConfigPanel`, `GeneratedProfilesPanel`, `ProfileForm`).
- `fetchData()` (around line 150) is a single multi-purpose loader called from `useEffect(() => { fetchData(); }, [])`. New data fetches should normally be added here so the operator gets one refresh on mount. If the new section has its own refresh button, factor its loader out so it can be called from both the master `fetchData` and the local refresh.

**Section composition pattern (the canonical model to copy):**

```tsx
{/* ─── CACHED BRAND SITES ─── */}
<div style={styles.section}>
  <h2 style={styles.sectionTitle}>Cached Brand Sites ({brandSites.length})</h2>
  <p style={styles.hint}>…descriptive copy…</p>
  {brandSites.length === 0 ? (
    <p style={styles.empty}>No cached domains yet.</p>
  ) : (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Brand Name</th>
          …
        </tr>
      </thead>
      <tbody>
        {brandSites.map((site) => (
          <tr key={site.id}>
            <td style={styles.td}>…</td>
            …
            <td style={styles.td}>
              <button
                style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 600, fontSize: 12, padding: 0 }}
                onClick={() => handleDeleteBrand(site.id)}
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
</div>
```

**`styles` object (lines ~370–395)** — every section reuses these named styles. Do **not** invent new ad-hoc style values when an entry already covers the case. Relevant entries:

| Key | Value (abridged) | Use for |
|---|---|---|
| `section` | `background:#fff; border:1px solid #e5e7eb; border-radius:8; padding:24; margin-bottom:24` | The white card wrapper for every section. |
| `sectionTitle` | `font-size:18; font-weight:600; margin:0 0 16px 0; color:#111827` | `<h2>` inside a section. |
| `hint` | `font-size:13; color:#6b7280; margin:0 0 16px` | Explanatory paragraph under the title. |
| `table`, `th`, `td` | `width:100%; border-collapse:collapse; font-size:14` / `border-bottom:2px solid #e5e7eb; text-align:left; padding:8px 12px; color:#4b5563; font-weight:600` / `border-bottom:1px solid #e5e7eb; padding:8px 12px` | The standard list view. |
| `empty` | `font-size:14; color:#9ca3af; font-style:italic` | "No items" placeholder. |
| `error` | `color:#dc2626; padding:12; background:#fef2f2; border-radius:6; margin-bottom:20; font-size:14` | Top-of-page error banner. Reuse the existing `error` state — do not add a separate error. |
| `primaryBtn`, `secondaryBtn`, `deleteBtn` | `background:#2563eb; color:#fff; …` / `background:none; border:1px solid #d1d5db; …` / `background:none; border:1px solid #dc2626; color:#dc2626; …` | Action buttons. |
| `buttonRow` | `display:flex; gap:12; margin-top:12` | Wrap a row of buttons. |
| `subsection` | `border:1px solid #e5e7eb; border-radius:6; padding:16; margin-bottom:12` | For nested cards (e.g. per-provider blocks). |
| `providerBadge` | small uppercase pill (`textTransform: 'uppercase'`, `padding: '2px 8px'`, `borderRadius: 3`) | Reuse for status pills by passing a color per status. |

**Per-row inline button pattern** (used for Delete links inside tables, see `handleDeleteBrand` row): use the `background: 'none', border: 'none', color: '#dc2626' (or '#2563eb' for edit), cursor: 'pointer', fontWeight: 600, fontSize: 12, padding: 0` style inline — this is the consistent "link button" idiom throughout the file.

**State pattern (one component, many `useState` calls):** the file currently declares ~25 separate `useState` hooks at the top of `OnboardingSettings`. The new section should add:
- `[domainStatuses, setDomainStatuses] = useState<DomainHealth[]>([])` — the data.
- `[domainDiagnosticsLoading, setDomainDiagnosticsLoading] = useState(false)` — local loading flag for the optional manual-refresh button. (Top-level `loading` is already taken by `fetchData` and is wired to the "••••" disabled state for the API-key inputs; do not stomp on it.)

**Loading and error handling:** every fetch in the file is wrapped in `try/catch/finally`, errors are stored to the shared `error` state via `setError(err instanceof Error ? err.message : String(err))`, and the master `loading` flag is flipped during `fetchData`. The new section should follow the exact same `try/catch/finally` shape so the existing `{error && <div style={styles.error}>{error}</div>}` banner surfaces failures uniformly.

---

### 1.3 `src/shared/schemas/onboarding.ts` (the shared schema module)

**File:** `src/shared/schemas/onboarding.ts`

This file uses **Zod** and exports both `z.object` schemas and `z.infer<…>` types. The file is shared between the server (`src/server`) and the client (`src/client`). There is **no existing Zod schema for `DomainStatus`** today. Two options to add one:

- **Option A (recommended, minimal):** define a new schema near the bottom of the file in its own `─── Domain Status ───` block, then import the type into both the new repo function and the new client API. Keeps the type-source-of-truth in `src/shared/schemas`.
- **Option B (cheapest):** the repo's existing `DomainStatus` interface (lines 3–8) is the de-facto contract. The new client API can type the response as the **inferred** shape from the route's return value (`{ domainStatuses: DomainStatus[] }`) and skip a Zod schema. Only adopt this if the planner wants to defer a schema until a later iteration.

Either option is consistent with the codebase. The repo interface is the *runtime* contract; the Zod schema is the *validation* contract. The current onboarding.ts file has Zod schemas for every persisted model that the UI lists, so adding one here is the more consistent choice.

The schema additions should be:
```ts
// ─── Domain Status ─────────────────────────────────────────────────────────────

export const DomainHealthStatusEnum = z.enum(['ok', 'blocked', 'offline', 'mismatch']);
export type DomainHealthStatus = z.infer<typeof DomainHealthStatusEnum>;

export const DomainStatusSchema = z.object({
  domain: z.string(),
  status: DomainHealthStatusEnum,
  checkedAt: z.string(),
  reason: z.string().nullable().default(null),
});
export type DomainStatus = z.infer<typeof DomainStatusSchema>;

export const DomainStatusListResponseSchema = z.object({
  domainStatuses: z.array(DomainStatusSchema),
});
export type DomainStatusListResponse = z.infer<typeof DomainStatusListResponseSchema>;
```

**Note on field naming:** the spec requested names `healthStatus`, `healthCheckedAt`, `healthReason` (prefixed). The existing repo interface uses unprefixed `status`, `checkedAt`, `reason` (matching the SQL columns `status`, `checked_at`, `reason`). Either is fine, but the **existing repo interface is the convention used everywhere else in this file** (see `BrandSite.brandName`, `ExtractorProfile.titleSelector`, etc. — they all map directly to the underlying row). Recommended: **keep the unprefixed names** and surface them to the UI as-is, to match the rest of `onboarding.ts`. If the prefixed names are required for the diagnostics panel's UX, add the alias in the client API as a thin transform — do not rename the repo or schema.

---

## 2. Implementation Spec

### 2.1 NEW repository function — `listAllDomainStatuses()`

**File:** `src/db/repositories/domain-status-repo.ts`

**Signature:**
```ts
export function listAllDomainStatuses(): DomainStatus[]
```

**Semantics:**
- Plain `SELECT` of every row. **Do not delete or mutate.**
- **Do not apply the 7-day expiration check** — that is `getDomainStatus`'s side effect and is only correct for the write-through cache path. The diagnostics panel is a read-only view; stale rows are exactly the data the operator wants to see (so they know to re-run discovery or extraction for that domain).
- Order by `domain` ASC for a stable, alphabetical display.
- Reuse the existing `DomainStatus` interface and the existing `DbDomainStatus` row type.
- Do not call `normalizeDomain` on the returned `domain` — values in the DB are already normalized (the `recordDomainStatus` upsert path normalizes before insert). Trust the data.

**Suggested implementation:**
```ts
/**
 * List every cached domain status. Read-only — does NOT apply the
 * 7-day expiration check, so the operator can see stale rows and
 * decide manually whether to re-run discovery.
 */
export function listAllDomainStatuses(): DomainStatus[] {
  const db = getDb();
  const rows = db.query(
    'SELECT domain, status, checked_at, reason FROM domain_status ORDER BY domain ASC'
  ).all() as DbDomainStatus[];
  return rows.map((row) => ({
    domain: row.domain,
    status: row.status as DomainStatus['status'],
    checkedAt: row.checked_at,
    reason: row.reason,
  }));
}
```

**No test changes required to existing tests.** The new function is additive; the three existing tests at `src/tests/unit/extraction-remedies.test.ts:26–53` continue to pass unchanged.

---

### 2.2 NEW server route — `GET /api/onboarding/settings/domain-statuses`

**File:** `src/server/routes/onboarding-routes.ts`

**Insertion point:** in the `// ─── API KEYS AND CACHED BRAND SITES SETTINGS ───` section, after the existing `/onboarding/settings/brand-sites` block (around line 720, before the `deleteBrandSite` and `/onboarding/settings/extractor-profiles` blocks). It belongs next to the brand-sites and extractor-profiles endpoints because it is a settings-related read.

**Route:**
```ts
/**
 * GET /api/onboarding/settings/domain-statuses
 * Read-only list of every cached domain health row. Does NOT
 * delete stale rows — the operator can see them and decide
 * whether to re-run discovery or extraction for that domain.
 */
route.get('/onboarding/settings/domain-statuses', (c) => {
  const statuses = listAllDomainStatuses();
  return c.json({ domainStatuses: statuses });
});
```

**No new imports required** beyond `listAllDomainStatuses` from `'../../db/repositories/domain-status-repo'` (the file already imports `getDomainStatus` indirectly via the three callers listed in §1.1; the existing import is not present in onboarding-routes.ts today, so the planner must add it).

**Auth:** `GET` is exempt from the `SHOPSITE_CMS_API_TOKEN` middleware (see `src/server/app.ts:30` — `if (c.req.method === 'GET' || c.req.method === 'HEAD')` skip the token check). No additional auth work.

**No new route file needed.** The onboarding-routes file is already mounted at `/api` via `app.route('/api', onboardingRoutes)` in `src/server/app.ts`. The new path resolves to `GET /api/onboarding/settings/domain-statuses`, which matches the existing convention (`/api/onboarding/settings/brand-sites`, `/api/onboarding/settings/extractor-profiles`, etc.).

**No schema validation needed in the route handler** — the response shape is fixed (array of `DomainStatus` rows), there is no request body, and the existing routes in this file (e.g. `route.get('/onboarding/settings/brand-sites', …)`) do not validate responses either. If §1.3 Option A is chosen, the schema can be used as a documentation anchor only.

---

### 2.3 NEW client API function — `getDomainStatuses()`

**File:** `src/client/onboarding-api.ts`

**Insertion point:** in the "Settings APIs" block, after `deleteBrandSite` (around line 290) and before `getOpenaiModels` / `getDeepseekModels` — i.e. grouped with other domain-level read endpoints.

**Suggested code:**
```ts
export async function getDomainStatuses(): Promise<{ domainStatuses: DomainStatus[] }> {
  return request<{ domainStatuses: DomainStatus[] }>('/settings/domain-statuses');
}
```

**Import to add** (top of the file, in the existing type import block):
```ts
import type {
  …
  DomainStatus,           // add
} from '../shared/schemas/onboarding';
```

**Behavior:** thin wrapper around the existing `request<T>(path, options?)` helper (defined at line 24). No new fetch logic. No new error handling — the `request` helper already throws on non-2xx with the server's `error` field in the message.

---

### 2.4 Data shape per domain row

Each row in `domainStatuses[]` is:

| Field | Type | Source | Notes |
|---|---|---|---|
| `domain` | `string` | `domain_status.domain` (PRIMARY KEY) | Already normalized (lowercase, no `www.`). Display verbatim. |
| `status` | `'ok' \| 'blocked' \| 'offline' \| 'mismatch'` | `domain_status.status` | Use a per-status color when rendering. Suggested mapping: `ok` → `#16a34a` (green), `blocked` → `#dc2626` (red), `offline` → `#6b7280` (gray), `mismatch` → `#f59e0b` (amber). |
| `checkedAt` | `string` (ISO) | `domain_status.checked_at` | Show as `checkedAt.slice(0, 10)` (YYYY-MM-DD) to match the "Last Used" column in the brand-sites table. Optionally show time on hover via `<span title={checkedAt}>…</span>`. |
| `reason` | `string \| null` | `domain_status.reason` | Often populated by `recordDomainStatus` in `page-extractor.ts` (e.g. `"Failed to render or connect via HTTP and Playwright"`, `"Matches WAF block"`, validation results). Render with a sensible truncation (e.g. first 80 chars + ellipsis) inside a fixed-width cell, or as the `title` attribute with the full string. |

**Optional derived field for the panel:** each row could also include an `isStale: boolean` derived in the client (e.g. `Date.now() - new Date(checkedAt).getTime() > 7 * 86400_000`) to highlight rows that the next discovery/extraction run would treat as expired. This is a **client-side only** derivation — do not add it to the repo or the API response.

---

### 2.5 Integration into `OnboardingSettings.tsx`

**Where to insert the new section:**

Place it **after the "Domain Extractor Profiles" section** and **before the "Generated Profile Governance" section** (currently lines ~635–685 in `OnboardingSettings.tsx`). Rationale: domain diagnostics is the most "operational" / health-oriented panel, so it reads naturally between the per-domain configuration (extractor profiles) and the AI-generation governance that depends on those profiles being healthy. If the planner prefers a different slot, the next-best options are (a) directly after "Cached Brand Sites" (groups it with the other domain-listing panels), or (b) at the very end (last so it does not push existing sections down).

**What to add to the imports / state / fetchData:**

1. **Imports** at the top of the file, alongside the existing `onboarding-api` imports:
   ```ts
   import {
     …
     getDomainStatuses,
     …
   } from '../onboarding-api';
   import type {
     …
     DomainStatus,
     …
   } from '../../shared/schemas/onboarding';
   ```

2. **New state** (after the `editingProfileId` declaration, ~line 80):
   ```ts
   const [domainStatuses, setDomainStatuses] = useState<DomainStatus[]>([]);
   const [domainDiagnosticsLoading, setDomainDiagnosticsLoading] = useState(false);
   ```

3. **Extend `fetchData()`** to load the new list in parallel with the existing keys/brand-sites/profiles calls. Pattern (mirror the existing `try/finally`):
   ```ts
   const [keysRes, brandSitesRes, extractorRes, domainStatusRes] = await Promise.all([
     getApiKeys(),
     getBrandSites(),
     getExtractorProfiles(),
     getDomainStatuses(),
   ]);
   setKeys(keysRes.keys);
   setBrandSites(brandSitesRes.brandSites);
   setExtractorProfiles(extractorRes.extractorProfiles);
   setDomainStatuses(domainStatusRes.domainStatuses);
   ```
   Or, if the planner prefers a smaller diff, add a sequential call after the existing three: `const domainStatusRes = await getDomainStatuses(); setDomainStatuses(domainStatusRes.domainStatuses);`. Both match the file's style.

4. **Optional manual refresh button.** If the planner wants a "Refresh diagnostics" button inside the section header (recommended — the table reflects the live state of the cache and operators will want to re-poll after running discovery), add:
   ```ts
   const loadDomainStatuses = async () => {
     setDomainDiagnosticsLoading(true);
     try {
       const res = await getDomainStatuses();
       setDomainStatuses(res.domainStatuses);
     } catch (err) {
       setError(err instanceof Error ? err.message : String(err));
     } finally {
       setDomainDiagnosticsLoading(false);
     }
   };
   ```
   And reuse the existing `styles.secondaryBtn` and `styles.buttonRow` for the button.

**Section JSX — copy the existing Cached Brand Sites pattern verbatim:**

```tsx
{/* ─── DOMAIN DIAGNOSTICS ─── */}
<div style={styles.section}>
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
    <h2 style={{ ...styles.sectionTitle, margin: 0 }}>
      Domain Diagnostics ({domainStatuses.length})
    </h2>
    <button
      type="button"
      style={styles.secondaryBtn}
      onClick={loadDomainStatuses}
      disabled={domainDiagnosticsLoading}
    >
      {domainDiagnosticsLoading ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
  <p style={styles.hint}>
    Health snapshot of every domain the onboarding pipeline has recently contacted.
    Stale rows (older than 7 days) are kept here so you can decide whether to re-run
    discovery or extraction manually; the pipeline will treat them as expired and
    re-check on the next run.
  </p>

  {domainStatuses.length === 0 ? (
    <p style={styles.empty}>No domain health data yet — diagnostics will appear after the first discovery or extraction run.</p>
  ) : (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Domain</th>
          <th style={styles.th}>Status</th>
          <th style={styles.th}>Last Checked</th>
          <th style={styles.th}>Reason</th>
        </tr>
      </thead>
      <tbody>
        {domainStatuses.map((d) => (
          <tr key={d.domain}>
            <td style={styles.td}><strong>{d.domain}</strong></td>
            <td style={styles.td}>
              <span style={{ ...styles.providerBadge, background: statusColor(d.status) }}>
                {d.status}
              </span>
            </td>
            <td style={styles.td} title={d.checkedAt}>{d.checkedAt.slice(0, 10)}</td>
            <td style={styles.td}>
              <span style={{ color: '#6b7280', fontSize: 13 }} title={d.reason ?? ''}>
                {d.reason ? (d.reason.length > 80 ? `${d.reason.slice(0, 80)}…` : d.reason) : '—'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
</div>
```

**Helper for the status color** — add this small helper above the component return (next to the other top-level helpers like `savedKey`):
```ts
function statusColor(status: DomainStatus['status']): string {
  switch (status) {
    case 'ok':       return '#16a34a';
    case 'blocked':  return '#dc2626';
    case 'offline':  return '#6b7280';
    case 'mismatch': return '#f59e0b';
  }
}
```

**Style discipline — do not introduce new colors, paddings, or font sizes** beyond the per-status color literal above. The section header uses `display: 'flex'; justifyContent: 'space-between'; alignItems: 'center'; marginBottom: 12` — the same idiom used by the "Domain Extractor Profiles" section header (line ~600) to align a title with a right-aligned button. Reuse the `styles.providerBadge` (already used for DeepSeek/OpenAI/Ollama badges) — its small uppercase shape works perfectly for status pills.

---

## 3. Validation Targets

- **Typecheck:** `bun run typecheck` — must pass with the new types.
- **Unit tests:** `bun run test` — the existing `src/tests/unit/extraction-remedies.test.ts` continues to pass (no changes to `getDomainStatus` / `recordDomainStatus` / `clearDomainStatus` contracts). New tests are optional but recommended:
  - Add a test for `listAllDomainStatuses()` covering: (a) empty DB returns `[]`; (b) rows are returned in `domain` ASC order; (c) rows older than 7 days are **still** returned (i.e. the eviction side effect is NOT applied).
- **Lint:** `bun run lint`.
- **Manual smoke:** load `/api/onboarding/settings/domain-statuses` in a running dev server (`bun run dev`); confirm the response shape `{ domainStatuses: [{ domain, status, checkedAt, reason }, ...] }`. Open the Onboarding Settings page in the UI, confirm the new "Domain Diagnostics" section renders the count and the rows, and confirm the Refresh button works.

---

## 4. Out of Scope

- No schema migration. The `domain_status` table already exists.
- No write/delete/mutate routes. The diagnostics panel is **read-only** by design — operators should not be able to hand-clear status rows from the UI; the cache path is owned by the worker. (If a "Clear" affordance is later desired, reuse the existing `clearDomainStatus` repo function and add a `DELETE /api/onboarding/settings/domain-statuses/:domain` route in a follow-up.)
- No new tests for the route handler (the codebase does not unit-test Hono routes; routes are tested via the existing `bun run dev` smoke flow).
- No rename of the existing `DomainStatus` interface. The new schema import in `onboarding.ts` (if Option A is chosen) re-uses the same field names as the existing repo interface so there is no migration churn.

---

## 5. Residual Risks

- **Stale-while-debugging:** the diagnostics panel intentionally surfaces rows older than 7 days. The operator must understand that those rows will be deleted on the next `getDomainStatus` call (i.e. the next discovery/extraction run). Document this in the `hint` copy (already done in §2.5). Severity: low — the copy is in the panel itself.
- **Naming mismatch with the requested spec:** the spec asked for `healthStatus` / `healthCheckedAt` / `healthReason` (prefixed). The existing repo interface and every other schema in `onboarding.ts` use unprefixed names that match the underlying SQL columns. Recommended: keep unprefixed names for consistency. If the planner insists on prefixed names, add them as a client-side alias only — do not rename the repo, the schema, or the existing `page-extractor` / `sitemap-fetcher` / `source-discovery` callers (that would touch 4 files for purely cosmetic value). Severity: cosmetic.
- **No row count cap:** if the cache grows into the hundreds of domains the table will be fine (SQLite handles it easily), but consider whether to add pagination or a `?status=` filter in a later iteration. Severity: low for now; medium if the cache ever exceeds a few hundred rows.
- **No automatic refresh:** the panel only refreshes on mount (via `fetchData`) and via the explicit Refresh button. SSE updates from `onboardingEvents` are not wired into the panel. Severity: low — the Refresh button is the workaround and matches the file's "explicit reload" idiom. If the planner wants live updates, they would need a new SSE event type in `src/onboarding/sse-emitter.ts` and a subscription in the component. Out of scope for this iteration.
- **No tests for the new list function in `extraction-remedies.test.ts`:** the existing test file is the natural home. The planner should add the three tests listed in §3, otherwise a future refactor could accidentally reintroduce the 7-day eviction into the new function. Severity: low — covered by code review, but a regression vector.
- **No Zod schema guard on the route response:** if a future contributor adds a new status value (e.g. `'rate_limited'`) in the worker but forgets to update `DomainHealthStatusEnum`, the route will pass it through as-is and the client will render an unknown status. Severity: low — the Zod enum would only catch it if the route is wrapped in `safeParse`, which the existing routes in this file do not do. If safety matters, switch the route to validate the response with `DomainStatusListResponseSchema.parse(...)` and log a warning instead of throwing.

---

## 6. Implementation-Ready Meta-Prompt

```text
GOAL
Add a read-only "Domain Diagnostics" panel to OnboardingSettings.tsx that
lists every row in the existing `domain_status` table so operators can
see which domains the pipeline has recently contacted and whether each
one is healthy. The panel must be additive — no schema migration, no
changes to existing repo contracts, no new write paths.

CONTEXT / EVIDENCE
- Domain cache lives in src/db/repositories/domain-status-repo.ts.
  The table is created in src/db/migrations.ts:91-106.
  Existing internal callers of getDomainStatus/recordDomainStatus must
  keep working: src/onboarding/source-discovery.ts:37,
  src/onboarding/page-extractor.ts:13, src/onboarding/sitemap-fetcher.ts:58.
- The repo already has 3 functions:
    getDomainStatus(domain)   — has a 7-day eviction side effect
    recordDomainStatus(...)
    clearDomainStatus(domain)
  The new list function must NOT replicate the 7-day eviction; the
  operator must be able to see stale rows.
- OnboardingSettings.tsx is a single-component page (~700 lines) with
  ~25 useState hooks, one master fetchData() loader, and a styles
  object containing the canonical styles.section / sectionTitle /
  table / th / td / empty / hint / providerBadge / secondaryBtn entries.
  Section JSX follows a strict pattern: <div style={styles.section}>
  with title, optional hint, empty state, then a <table>.
- Cached Brand Sites (around line 600) is the closest analogue and
  should be used as the visual template.
- onboarding-api.ts uses a request<T>() helper at line 24. New client
  function is a 1-line wrapper around it.
- onboarding-routes.ts is mounted at /api in app.ts. The new GET route
  goes alongside /onboarding/settings/brand-sites in the
  "API KEYS AND CACHED BRAND SITES SETTINGS" block.
- src/shared/schemas/onboarding.ts is the single source of truth for
  shared Zod types. Add DomainHealthStatusEnum + DomainStatusSchema
  + DomainStatusListResponseSchema (optional but recommended).

DELIVERABLES
1. New repo function listAllDomainStatuses() in
   src/db/repositories/domain-status-repo.ts.
   - Plain SELECT, ORDER BY domain ASC.
   - No delete. No expiration check.
   - Returns DomainStatus[] (existing interface).
2. New GET route in src/server/routes/onboarding-routes.ts:
   GET /api/onboarding/settings/domain-statuses
   - Imports listAllDomainStatuses from the repo.
   - Returns { domainStatuses: DomainStatus[] }.
   - Sits next to the brand-sites block.
3. New client API function getDomainStatuses() in
   src/client/onboarding-api.ts.
   - Wraps request<{ domainStatuses: DomainStatus[] }>('/settings/domain-statuses').
   - Imports DomainStatus from shared/schemas/onboarding.
4. (Optional, recommended) Add DomainHealthStatusEnum, DomainStatusSchema,
   DomainStatusListResponseSchema to src/shared/schemas/onboarding.ts.
5. New "Domain Diagnostics" section in OnboardingSettings.tsx:
   - Inserted after "Domain Extractor Profiles" and before
     "Generated Profile Governance".
   - State: domainStatuses (DomainStatus[]) + domainDiagnosticsLoading
     (boolean).
   - Extended fetchData() loads it in parallel with keys/brandSites/profiles.
   - Section uses styles.section / styles.sectionTitle / styles.hint /
     styles.table / styles.th / styles.td / styles.empty / styles.secondaryBtn
     / styles.providerBadge. No new ad-hoc colors, paddings, or font sizes.
   - Status pill: reuse styles.providerBadge with a per-status color
     helper (ok #16a34a, blocked #dc2626, offline #6b7280, mismatch #f59e0b).
   - Last-checked column shows checkedAt.slice(0, 10) with the full
     ISO string in the title attribute (matches the "Last Used" idiom
     used in Cached Brand Sites).
   - Reason column truncates to 80 chars + "…" with the full string
     in the title attribute.
   - Optional "Refresh" button calls loadDomainStatuses() (local
     loader, setDomainDiagnosticsLoading try/finally).
   - Empty state copy: "No domain health data yet — diagnostics will
     appear after the first discovery or extraction run."

SUCCESS CRITERIA
- bun run typecheck passes.
- bun run test passes (existing tests in extraction-remedies.test.ts
  unchanged, no regressions in sitemap-fetcher, page-extractor, etc.).
- bun run lint passes.
- GET /api/onboarding/settings/domain-statuses returns
  { domainStatuses: [{ domain, status, checkedAt, reason }, ...] }
  in alphabetical order, including rows older than 7 days.
- The Onboarding Settings page renders the new "Domain Diagnostics"
  section with a status pill per row, a Last Checked date column,
  a Reason column, and a Refresh button. The existing
  fetchData() refresh also populates it.
- getDomainStatus's 7-day eviction side effect is unchanged.
- No direct SQL outside src/db/repositories per AGENTS.md
  Architectural Guidelines.

HARD CONSTRAINTS
- Review-only / spec-only is fine — implement after the planner signs off.
- Do not add new columns to the domain_status table.
- Do not change the field names of the existing DomainStatus interface.
- Do not introduce a write or delete affordance in the panel.
- Do not introduce a schema migration.

SUGGESTED APPROACH
1. Add the new listAllDomainStatuses() function to the repo file
   (5-7 lines), with a JSDoc comment noting the read-only
   contract and the no-eviction rule.
2. Add the new GET route in onboarding-routes.ts in the brand-sites
   neighborhood (3-5 lines plus the import).
3. Add DomainHealthStatusEnum + DomainStatusSchema to
   shared/schemas/onboarding.ts (optional but recommended).
4. Add getDomainStatuses() to client/onboarding-api.ts (1 line plus
   the type import).
5. In OnboardingSettings.tsx:
   a. Add the two new useState hooks.
   b. Extend fetchData() to fetch + set domainStatuses.
   c. Add a loadDomainStatuses() helper for the Refresh button.
   d. Add a statusColor() helper.
   e. Insert the new section JSX in the position described above.
6. (Optional) Add a small describe block in
   src/tests/unit/extraction-remedies.test.ts that covers
   listAllDomainStatuses().

VALIDATION
- Run `bun run typecheck`, `bun run test`, `bun run lint`.
- If a dev server is available: `curl http://localhost:3031/api/onboarding/settings/domain-statuses`
  and verify the response shape. (Replace host/port as needed.)
- Manual UI smoke: open Onboarding Settings, confirm the panel
  appears, the rows render, the status pills show colors, the
  Refresh button works, and the existing sections still render.

STOP / ESCALATION
- If a decision is needed about the prefixed vs unprefixed field
  names (healthStatus vs status), stop and ask via contact_supervisor
  with reason "need_decision".
- If a write or delete affordance is later requested, this is a
  scope expansion — escalate before implementing.
- If the existing getDomainStatus eviction logic needs to be
  changed, escalate — it is consumed by source-discovery and
  page-extractor and a behavior change there is not a one-file fix.

RESOLVED QUESTIONS / ASSUMPTIONS
- Field names: assumed unprefixed (status, checkedAt, reason) to
  match every other schema in onboarding.ts and the existing
  DomainStatus interface in the repo. The repo's existing
  interface is the source of truth.
- Section position: assumed after Extractor Profiles, before
  Generated Profile Governance. Reasonable alternatives are
  after Cached Brand Sites or at the end.
- "Read-only" means: no Clear, no Recheck, no edit. Operators
  work the cache by running discovery/extraction, not by
  clicking buttons in this panel.
- Schema: assumed we add a Zod schema in onboarding.ts for
  consistency with the rest of the file, but the route handler
  does not have to use it for response validation (existing
  routes in this file do not validate responses).
- Test coverage: assumed we add 3 small tests to
  extraction-remedies.test.ts, but this is optional. The
  existing tests do not block the work.
```

---

## 7. Summary of Changes by File

| File | Change | Approx. lines |
|---|---|---|
| `src/db/repositories/domain-status-repo.ts` | Add `listAllDomainStatuses()` (export) | +12 |
| `src/server/routes/onboarding-routes.ts` | Add import + 1 GET route | +10 |
| `src/client/onboarding-api.ts` | Add import + 1 function | +5 |
| `src/shared/schemas/onboarding.ts` | Add enum + 2 schemas + 2 type exports (optional) | +15 |
| `src/client/components/OnboardingSettings.tsx` | Add 2 useState + extend fetchData + add 2 helpers + new section JSX | +70 |
| `src/tests/unit/extraction-remedies.test.ts` | Add 3 tests for the new function (optional) | +25 |

Total: **~140 lines added, 0 lines removed** across at most 6 files. No schema migration. No new dependencies. No change to the public `DomainStatus` interface.
