# Implementation Plan

## Goal
Add a read-only Domain Diagnostics MVP inside the existing Onboarding Pipeline Settings page that aggregates domain health, sitemap cache, extractor profile, brand-site, and generated-profile signals without triggering cache eviction, profile generation, network fetches, or status writes.

## Tasks

1. **Add shared diagnostics schemas and types**
   - File: `src/shared/schemas/onboarding.ts`
   - Changes:
     - Add a new `// ─── Domain Diagnostics ───` block after the existing `BrandSiteSchema`/`BrandSite` export so `ProfileGenerationStatusEnum` is already available.
     - Add:
       - `DomainHealthStatusEnum = z.enum(['ok', 'blocked', 'offline', 'mismatch', 'unknown'])`
       - `DomainDiagnosticsBrandAssociationSchema`
       - `DomainDiagnosticsEntrySchema`
       - `DomainDiagnosticsResponseSchema`
       - matching `z.infer` types.
     - Do not rename or replace the existing repo-local `DomainStatus` interface in `src/db/repositories/domain-status-repo.ts`.
   - Acceptance:
     - Client and server can import `DomainDiagnosticsEntry` and `DomainDiagnosticsResponse` from `../shared/schemas/onboarding` / `../../shared/schemas/onboarding`.
     - `bun run typecheck` sees no missing type exports.

2. **Add a read-only domain status listing function**
   - File: `src/db/repositories/domain-status-repo.ts`
   - Changes:
     - Export `listAllDomainStatuses(): DomainStatus[]`.
     - Implement with a plain `SELECT domain, status, checked_at, reason FROM domain_status ORDER BY domain ASC`.
     - Map rows to the existing `DomainStatus` interface.
     - Do not call `getDomainStatus()`; that function deletes rows older than 7 days.
     - Do not delete, update, normalize returned domains, or apply expiration logic.
   - Acceptance:
     - Expired/stale `domain_status` rows remain in the table after calling `listAllDomainStatuses()`.
     - Existing `getDomainStatus`, `recordDomainStatus`, and `clearDomainStatus` behavior remains unchanged.

3. **Add a read-only sitemap cache listing function**
   - File: `src/db/repositories/sitemap-cache-repo.ts`
   - Changes:
     - Export an internal diagnostics row type, e.g.:
       - `domain: string`
       - `urls: string[]`
       - `sitemapUrlsCount: number`
       - `sitemapFetchedAt: string`
       - `sitemapExpiresAt: string`
       - `sitemapSourceUrl: string | null`
     - Export `listAllSitemapCaches(): SitemapCacheRow[]`.
     - Implement with a single read-only query: `SELECT domain, urls_json, fetched_at, expires_at, source_url FROM sitemap_cache ORDER BY domain ASC`.
     - Parse `urls_json` using the same safe JSON/array/string-filter pattern as `getCachedSitemapUrls()`.
     - On malformed JSON, log and return that row with `urls: []` and `sitemapUrlsCount: 0`; do not throw.
     - Do not call `getCachedSitemapUrls()`; it deletes expired rows on access.
     - Do not add per-domain clear/delete in the MVP. Keep destructive cache controls out of this read-only pass.
   - Acceptance:
     - Fresh and expired sitemap cache rows both appear in diagnostics.
     - Calling `listAllSitemapCaches()` never deletes expired or invalid rows.

4. **Add an unbounded profile-generation domain summary function**
   - File: `src/db/repositories/profile-generation-repo.ts`
   - Changes:
     - Export `ProfileGenerationDomainSummary`:
       - `domain: string`
       - `generationCount: number`
       - `latestGenerationStatus: ProfileGenerationStatus | null`
       - `latestGenerationAt: string | null`
     - Export `listProfileGenerationDomainSummaries(): ProfileGenerationDomainSummary[]`.
     - Implement in the repository layer with SQL grouped by `domain` and latest row selected by `created_at DESC, rowid DESC`.
     - Do not use `listAllProfileGenerations({ limit })` for the aggregate because its default and explicit limits can undercount domains with many generations.
   - Acceptance:
     - A domain with multiple generation rows reports the full count and the latest status/timestamp without loading/parsing selector JSON.

5. **Create the read-only aggregation service**
   - New File: `src/onboarding/domain-diagnostics-service.ts`
   - Changes:
     - Export `buildDomainDiagnostics(now: Date = new Date()): DomainDiagnosticsEntry[]`.
     - Export `getDomainDiagnosticsResponse(now: Date = new Date()): DomainDiagnosticsResponse` returning `{ entries, generatedAt: now.toISOString() }`.
     - Read only through repositories:
       - `listAllProfiles()` from `extractor-profile-repo.ts`
       - `listAllBrandSites()` from `brand-site-repo.ts`
       - `listAllDomainStatuses()` from `domain-status-repo.ts`
       - `listAllSitemapCaches()` from `sitemap-cache-repo.ts`
       - `listProfileGenerationDomainSummaries()` from `profile-generation-repo.ts`
     - Build the domain universe as the union of domains from all five sources.
     - Sort entries by `domain` ascending.
     - Derive `sitemapStale` from `sitemapExpiresAt` using `Date.parse(expiresAt) <= now.getTime()`; invalid dates count as stale. Missing cache row means `sitemapStale: false` and all sitemap fields `null`/`0`.
     - Derive `healthStale` without calling `getDomainStatus()`. Mirror the existing 7-day intent: rows with invalid `checkedAt` or more than 7 days old are stale. Missing health row means `healthStatus: 'unknown'`, `healthCheckedAt: null`, `healthReason: null`, `healthStale: false`.
     - Do not call network fetchers, source discovery, page extraction, sitemap fetching, profile generation, profile validation, or any function that writes status/cache rows.
   - Acceptance:
     - Service output has one entry per known domain, including domains present in only one table.
     - Stale status/cache rows are visible and remain persisted after service execution.

6. **Expose a single read-only diagnostics API route**
   - File: `src/server/routes/onboarding-routes.ts`
   - Changes:
     - Import `getDomainDiagnosticsResponse` from `../../onboarding/domain-diagnostics-service`.
     - Add `GET /onboarding/settings/domain-diagnostics` near the other settings endpoints, after the extractor-profile CRUD routes and before `POST /onboarding/extractor-profiles/test`.
     - Handler should be synchronous and return `c.json(getDomainDiagnosticsResponse())`.
     - Do not add `POST`, `DELETE`, refresh, clear, or generate routes for the MVP.
     - Do not add workspace gating; surrounding settings GET endpoints do not require it.
   - Acceptance:
     - `GET /api/onboarding/settings/domain-diagnostics` returns `{ entries: DomainDiagnosticsEntry[], generatedAt: string }`.
     - A GET request causes no database writes and no network calls.

7. **Add the client API wrapper**
   - File: `src/client/onboarding-api.ts`
   - Changes:
     - Import `DomainDiagnosticsResponse` in the existing shared-type import block.
     - Add `getDomainDiagnostics(): Promise<DomainDiagnosticsResponse>` in the Settings APIs area, near `getExtractorProfiles()` / `getBrandSites()`.
     - Use the existing `request<T>()` helper with path `'/settings/domain-diagnostics'`.
     - Do not add client action helpers for clearing, refreshing, generating, approving, or deleting diagnostics rows.
   - Acceptance:
     - `OnboardingSettings.tsx` can import and call `getDomainDiagnostics()`.
     - Typecheck confirms the response shape.

8. **Add the Domain Diagnostics section to Settings**
   - File: `src/client/components/OnboardingSettings.tsx`
   - Changes:
     - Import `getDomainDiagnostics` from `../onboarding-api`.
     - Import `DomainDiagnosticsEntry` from `../../shared/schemas/onboarding`.
     - Add state:
       - `domainDiagnostics: DomainDiagnosticsEntry[]`
       - `domainDiagnosticsGeneratedAt: string | null`
       - `domainDiagnosticsLoading: boolean`
     - Add a `loadDomainDiagnostics()` helper that only calls `getDomainDiagnostics()`, updates local diagnostics state, and writes failures to the existing `error` banner.
     - Extend `fetchData()` to include `getDomainDiagnostics()` in the existing settings load; existing `handleDeleteBrand`, `handleSaveProfile`, and `handleDeleteProfile` call `fetchData()`, so diagnostics refreshes after existing management actions.
     - Add small helper functions near the component helpers:
       - `domainHealthBadgeStyle(status)` for `ok`, `blocked`, `offline`, `mismatch`, `unknown`.
       - `formatOptionalIsoDate(iso)` returning `YYYY-MM-DD` or `—`.
       - `truncateText(value, max = 80)` for health reasons.
     - Add stable anchors/ids to existing sections:
       - `id="cached-brand-sites"`
       - `id="domain-extractor-profiles"`
       - `id="generated-profile-governance"`
     - Insert a new read-only `Domain Diagnostics` section between `Domain Extractor Profiles` and `Generated Profile Governance`.
     - Render a table with columns:
       - Domain
       - Profile (`Active` / `No profile`, profile updated date)
       - Sitemap (`N URLs`, fetched date, stale/valid/never cached, source URL in title or small text)
       - Health (colored pill, checked date, stale marker, truncated reason)
       - Brands (brand names and counts, or `—`)
       - Generated profiles (count, latest status/date, or `—`)
       - Links (anchors to existing Brand Sites, Domain Extractor Profiles, and Generated Profile Governance sections)
     - Add a section-level `Refresh` button that calls `loadDomainDiagnostics()`; this is a read-only re-fetch, not a sitemap refresh.
     - Do not add inline profile approval, generated-profile approval, brand delete, profile edit, sitemap clear, health clear, sitemap refresh, profile generation, or extraction actions inside the diagnostics table.
   - Acceptance:
     - Settings page keeps the existing top-level navigation and simply grows a new in-place section.
     - Diagnostics links point to existing management/governance sections instead of merging those workflows into the diagnostics table.
     - Empty state reads clearly, e.g. `No domain diagnostics yet. Rows appear after discovery, extraction, sitemap lookup, profile setup, brand mapping, or profile generation creates a domain signal.`

9. **Add/update repo and service tests**
   - Files:
     - `src/tests/unit/extraction-remedies.test.ts`
     - `src/tests/unit/sitemap-cache-repo.test.ts`
     - `src/tests/unit/profile-generation-repo.test.ts`
     - New file: `src/tests/unit/domain-diagnostics-service.test.ts`
   - Changes:
     - `extraction-remedies.test.ts`: import `listAllDomainStatuses` and add tests that it returns rows in domain order and returns a manually-aged >7-day row without deleting it.
     - `sitemap-cache-repo.test.ts`: import `listAllSitemapCaches` and add tests that it returns expired rows without deleting them and handles malformed `urls_json` with count `0`.
     - `profile-generation-repo.test.ts`: import `listProfileGenerationDomainSummaries` and add a test for full count plus latest status/timestamp.
     - `domain-diagnostics-service.test.ts`: set up a fresh test DB and cover:
       - empty database returns `[]`.
       - union includes domains that exist only in one source table.
       - one domain with profile + sitemap + health + brand + generation populates all fields.
       - stale sitemap and stale health rows are marked stale and remain in the DB after `buildDomainDiagnostics()`.
   - Acceptance:
     - Tests prove the MVP uses read-only diagnostics paths rather than side-effecting cache getters.

10. **Run validation**
    - Files: none beyond previous tasks.
    - Commands:
      - `bun run typecheck`
      - `bun run test src/tests/unit/extraction-remedies.test.ts src/tests/unit/sitemap-cache-repo.test.ts src/tests/unit/profile-generation-repo.test.ts src/tests/unit/domain-diagnostics-service.test.ts`
      - `bun run test`
      - `bun run lint`
    - Manual smoke:
      - Run dev server and load `GET /api/onboarding/settings/domain-diagnostics`; confirm response shape.
      - Open Onboarding Pipeline Settings and confirm the read-only section renders, refreshes, and links to existing sections.
    - Acceptance:
      - All commands pass, or failures are documented as pre-existing with exact output.

## Files to Modify

1. `src/shared/schemas/onboarding.ts` - add Domain Diagnostics Zod schemas/types.
2. `src/db/repositories/domain-status-repo.ts` - add `listAllDomainStatuses()` read-only list function.
3. `src/db/repositories/sitemap-cache-repo.ts` - add `SitemapCacheRow`/equivalent type and `listAllSitemapCaches()` read-only list function.
4. `src/db/repositories/profile-generation-repo.ts` - add profile-generation domain summary type/function.
5. `src/server/routes/onboarding-routes.ts` - import diagnostics service and add the single read-only GET route.
6. `src/client/onboarding-api.ts` - add `getDomainDiagnostics()` client wrapper and type import.
7. `src/client/components/OnboardingSettings.tsx` - add state/loaders/helpers, anchors, and the new read-only diagnostics section.
8. `src/tests/unit/extraction-remedies.test.ts` - add tests for read-only domain status listing.
9. `src/tests/unit/sitemap-cache-repo.test.ts` - add tests for read-only sitemap listing.
10. `src/tests/unit/profile-generation-repo.test.ts` - add tests for profile-generation domain summaries.

## New Files

- `src/onboarding/domain-diagnostics-service.ts` - read-only aggregate builder for the diagnostics endpoint.
- `src/tests/unit/domain-diagnostics-service.test.ts` - unit coverage for aggregation, stale flags, union behavior, and no mutation.

## New Types/Schemas

Add these to `src/shared/schemas/onboarding.ts`:

- `DomainHealthStatusEnum` / `DomainHealthStatus`
  - Values: `'ok' | 'blocked' | 'offline' | 'mismatch' | 'unknown'`.
- `DomainDiagnosticsBrandAssociationSchema` / `DomainDiagnosticsBrandAssociation`
  - Fields: `id`, `brandName`, `successCount`, `lastUsedAt`.
- `DomainDiagnosticsEntrySchema` / `DomainDiagnosticsEntry`
  - Fields:
    - `domain: string`
    - `hasActiveProfile: boolean`
    - `activeProfileId: string | null`
    - `profileUpdatedAt: string | null`
    - `sitemapUrlsCount: number`
    - `sitemapFetchedAt: string | null`
    - `sitemapExpiresAt: string | null`
    - `sitemapSourceUrl: string | null`
    - `sitemapStale: boolean`
    - `healthStatus: DomainHealthStatus`
    - `healthCheckedAt: string | null`
    - `healthReason: string | null`
    - `healthStale: boolean`
    - `brandAssociations: DomainDiagnosticsBrandAssociation[]`
    - `generationCount: number`
    - `latestGenerationStatus: ProfileGenerationStatus | null`
    - `latestGenerationAt: string | null`
- `DomainDiagnosticsResponseSchema` / `DomainDiagnosticsResponse`
  - Fields: `entries: DomainDiagnosticsEntry[]`, `generatedAt: string`.

## New Repo Functions

- `src/db/repositories/domain-status-repo.ts`
  - `listAllDomainStatuses(): DomainStatus[]`
  - Plain read, sorted by domain, no expiration/deletion side effects.

- `src/db/repositories/sitemap-cache-repo.ts`
  - `SitemapCacheRow` or equivalent exported interface.
  - `listAllSitemapCaches(): SitemapCacheRow[]`
  - Plain read, sorted by domain, parses URL JSON for count, includes expired rows, no deletion.

- `src/db/repositories/profile-generation-repo.ts`
  - `ProfileGenerationDomainSummary` exported interface.
  - `listProfileGenerationDomainSummaries(): ProfileGenerationDomainSummary[]`
  - Grouped domain summary with full counts and latest generation metadata; no arbitrary limit.

## New API Routes

- `GET /api/onboarding/settings/domain-diagnostics`
  - Implemented in `src/server/routes/onboarding-routes.ts` as `route.get('/onboarding/settings/domain-diagnostics', ...)`.
  - Response: `DomainDiagnosticsResponse`.
  - No request body.
  - No workspace gate, matching nearby settings GET routes.
  - No writes, deletes, network calls, profile generation, status recording, or cache eviction.

Out of scope for this MVP:
- `POST /clear-sitemap-cache`
- `DELETE /domain-diagnostics/:domain/sitemap`
- `DELETE /domain-diagnostics/:domain/health`
- `POST /domain-diagnostics/:domain/sitemap/refresh`
- Any route that invokes page extraction, source discovery, sitemap fetching, profile generation, validation, or governance approval.

## New Client API Functions

- `src/client/onboarding-api.ts`
  - `getDomainDiagnostics(): Promise<DomainDiagnosticsResponse>`
  - Uses `request<DomainDiagnosticsResponse>('/settings/domain-diagnostics')`.

No client mutation/action helper is added in the MVP.

## UI Changes in `OnboardingSettings.tsx`

- Add the Domain Diagnostics section in place, between the current Domain Extractor Profiles section and Generated Profile Governance section.
- Reuse existing `styles.section`, `styles.sectionTitle`, `styles.hint`, `styles.table`, `styles.th`, `styles.td`, `styles.empty`, `styles.providerBadge`, and `styles.secondaryBtn`.
- Add a read-only Refresh button for reloading the diagnostics GET endpoint.
- Use status colors:
  - `ok`: green `#16a34a`
  - `blocked`: red `#dc2626`
  - `offline`: gray `#6b7280`
  - `mismatch`: amber `#f59e0b`
  - `unknown`: light gray/outline styling
- Add anchor ids to the existing management sections and link to them from diagnostics rows.
- Do not embed manual profile editing, brand deletion, generated proposal approval, or profile governance review controls in the diagnostics table.

## Validation Contract

Required automated validation after implementation:

1. `bun run typecheck`
2. `bun run test src/tests/unit/extraction-remedies.test.ts src/tests/unit/sitemap-cache-repo.test.ts src/tests/unit/profile-generation-repo.test.ts src/tests/unit/domain-diagnostics-service.test.ts`
3. `bun run test`
4. `bun run lint`

Required manual validation:

- `GET /api/onboarding/settings/domain-diagnostics` returns `{ entries, generatedAt }`.
- Expired `sitemap_cache` and stale `domain_status` rows appear in the response and are not deleted by the GET.
- Onboarding Settings renders the new section without adding new top-level navigation.
- Diagnostics links scroll/navigate to existing Brand Sites, Domain Extractor Profiles, and Generated Profile Governance sections.
- Refresh button only re-fetches diagnostics; it does not fetch remote sitemaps or generate profiles.

## Dependencies

- Task 5 depends on Tasks 1-4.
- Task 6 depends on Task 5.
- Task 7 depends on Task 1 and Task 6.
- Task 8 depends on Task 7 and uses the schemas from Task 1.
- Task 9 depends on Tasks 2-5.
- Task 10 runs after all implementation and tests are added.

## Risks

- `getDomainStatus()` and `getCachedSitemapUrls()` intentionally delete stale rows. The implementation must not call them from diagnostics; tests should catch regressions.
- Parsing `urls_json` for every sitemap cache row may be expensive for very large caches. Accept for MVP; a future migration could add a stored URL count.
- The diagnostics section intentionally shows stale rows that the pipeline may delete on the next real discovery/extraction/cache read. Explain this in the section hint.
- `profile_generations` rows can share identical timestamps; use `rowid DESC` as a latest-row tiebreaker in the repo summary query.
- Anchor links are intentionally simple and do not pre-open a specific generated governance row. That avoids merging approval flows into diagnostics.
- There is no existing route-test pattern for `onboarding-routes.ts`; rely on service/repo tests plus manual API smoke unless a reviewer asks for Hono route coverage.

## Implementation-Ready Meta-Prompt for Worker

```text
GOAL
Implement the Domain Diagnostics MVP as a read-only section in the existing Onboarding Pipeline Settings page. Aggregate domains from extractor_profiles, sitemap_cache, domain_status, brand_sites, and profile_generations. The endpoint and UI must not trigger cache eviction, profile generation, network fetches, status writes, or destructive actions.

HARD CONSTRAINTS
- Evolve OnboardingSettings.tsx in place. Do not add a new top-level nav item or route.
- Diagnostics is read-only for this MVP. Do not add clear, delete, refresh-sitemap, generate-profile, approve, reject, promote, rollback, or extraction actions.
- Do not call getCachedSitemapUrls() from diagnostics; it deletes expired sitemap rows. Add/use listAllSitemapCaches() instead.
- Do not call getDomainStatus() from diagnostics; it deletes stale health rows. Add/use listAllDomainStatuses() instead.
- Do not merge generated profile governance, brand management, or manual extractor profile management into diagnostics. The diagnostics table may link to existing sections only.
- Do not add a schema migration.
- Keep direct SQL inside repository files. The new aggregation service must read through repo functions.

IMPLEMENTATION STEPS
1. In src/shared/schemas/onboarding.ts, add DomainHealthStatusEnum, DomainDiagnosticsBrandAssociationSchema, DomainDiagnosticsEntrySchema, and DomainDiagnosticsResponseSchema with matching type exports.
2. In src/db/repositories/domain-status-repo.ts, add listAllDomainStatuses(): DomainStatus[] as a plain ORDER BY domain read. Do not apply 7-day eviction.
3. In src/db/repositories/sitemap-cache-repo.ts, add listAllSitemapCaches(): SitemapCacheRow[] as a plain ORDER BY domain read. Parse urls_json safely and compute sitemapUrlsCount. Do not call getCachedSitemapUrls().
4. In src/db/repositories/profile-generation-repo.ts, add listProfileGenerationDomainSummaries(): ProfileGenerationDomainSummary[] with COUNT(*) per domain and latest status/createdAt by created_at DESC, rowid DESC.
5. Create src/onboarding/domain-diagnostics-service.ts. Export buildDomainDiagnostics(now = new Date()) and getDomainDiagnosticsResponse(now = new Date()). Use only listAllProfiles, listAllBrandSites, listAllDomainStatuses, listAllSitemapCaches, and listProfileGenerationDomainSummaries. Return one sorted entry per domain union.
6. In src/server/routes/onboarding-routes.ts, add GET /onboarding/settings/domain-diagnostics near the settings extractor-profile routes. Return getDomainDiagnosticsResponse(). Do not add mutation routes.
7. In src/client/onboarding-api.ts, add getDomainDiagnostics(): Promise<DomainDiagnosticsResponse> using request('/settings/domain-diagnostics').
8. In src/client/components/OnboardingSettings.tsx, add diagnostics state, a read-only loader, fetchData integration, helper formatting functions, anchors on existing Brand Sites / Domain Extractor Profiles / Generated Profile Governance sections, and the new read-only diagnostics table between extractor profiles and generated governance.
9. Add tests in extraction-remedies.test.ts, sitemap-cache-repo.test.ts, profile-generation-repo.test.ts, and a new domain-diagnostics-service.test.ts to prove stale rows are visible and not deleted.
10. Run bun run typecheck, targeted tests, bun run test, and bun run lint. Document any pre-existing failures with exact output.

SUCCESS CRITERIA
- GET /api/onboarding/settings/domain-diagnostics returns one row per known domain from the union of all five source tables.
- Expired sitemap rows and stale domain_status rows are visible and remain in the DB after the GET.
- The Settings UI shows Domain Diagnostics with profile, sitemap, health, brand, and generation columns plus links to existing sections.
- No destructive or side-effecting diagnostics actions exist in the MVP.
```

## Acceptance Report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Plan limits scope to a read-only Domain Diagnostics MVP: one GET route, read-only repo variants, one Settings section, no destructive action routes, no network refresh, no profile generation, and no merged approval flows."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Plan names exact files, new schemas, repo functions, API route, client function, UI changes, tests, validation commands, risks, dependencies, and an implementation-ready worker prompt."
    }
  ],
  "changedFiles": [
    ".pi-subagents/artifacts/outputs/c28d82b9-b534-4ef1-a6d6-803fe1b7c253/plan.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Planning-only run. No source code or tests were modified, so typecheck/test/lint were not run. The required validation commands are listed in the plan."
  ],
  "residualRisks": [
    "Implementation must avoid getCachedSitemapUrls() and getDomainStatus() in diagnostics because they delete stale rows.",
    "Large sitemap caches may make read-only URL parsing expensive; accepted for MVP.",
    "Manual route smoke is required unless a route-test harness is added."
  ],
  "noStagedFiles": true,
  "diffSummary": "Created the required planning artifact only; no application source files were changed.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "The plan intentionally rejects the mutation-heavy integration-plan suggestions where they conflict with the oracle's read-only-first and no-side-effects constraints."
}
```
