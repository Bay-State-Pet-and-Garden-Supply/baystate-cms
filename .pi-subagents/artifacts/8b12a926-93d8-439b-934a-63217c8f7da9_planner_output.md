# Implementation Plan — Extraction Profile System UI

## Goal

Build the remaining frontend UI for the domain-first extraction profile system: a Profile Builder Workspace, pipeline board extraction-status badges, domain diagnostics enhancements, a profile retry preview, and a restructured Onboarding Settings tab layout — backed by the existing extraction worker and the Bun API server.

---

## Critical findings / scope boundaries (read before executing)

These were discovered by reading the code and materially affect the plan. Several requested UI features depend on backend work that does **not** exist yet. The plan flags each as a prerequisite (PREREQ) so the UI tasks can be sequenced correctly. The plan focuses on UI but explicitly calls out the minimal backend touch-points required for each UI surface to function.

1. **F1 — No worker proxy routes for snapshot/propose/validate.** The Bun server only exposes `GET /api/onboarding/settings/extraction-worker/health` to the frontend (`src/server/routes/onboarding-routes.ts:1092`). The worker client functions (`snapshotPage`, `proposeProfile`, `validateProfile`, `trustedExtract` in `src/server/extraction-worker-client.ts`) exist but have no HTTP routes wrapping them. The browser cannot call the worker directly (it binds to `127.0.0.1` and requires a bearer token). → **Profile Builder Workspace needs new Bun proxy routes** (Task A).

2. **F2 — The worker's `/profile-tooling/propose` route is NOT implemented.** `src/extraction-worker/server.ts` only mounts `health`, `snapshot`, `validate`, `extract`. The `proposeProfile` client function exists but calling it will 404 against the worker. → The "Generate profile proposal" button (Task 1) must either (a) call the *existing* Bun-side `generateProfileForDomain` LLM path (`/settings/domain-diagnostics/:domain/generate-profile`) which already works, or (b) wait for worker Phase 6. **Recommendation: use the existing Bun-side generate endpoint** and label the snapshot/validate calls as worker-powered. Flag worker `propose` as a P2 future swap-in.

3. **F3 — No "Profile Health" field exists in `DomainDiagnosticsEntry`.** `DomainDiagnosticsEntry` has `hasActiveProfile`, `activeProfileId`, `healthStatus` (domain reachability health: ok/blocked/offline/mismatch/unknown), and `latestGenerationStatus`. Profile Health is a distinct reviewed-readiness concept (CONTEXT.md). There is no per-profile health value, no confirmed-sample count beyond `validationSampleCount` in `DomainProfileGovernance`, and no match count. → The "Profile Health column" (Task 3) must derive a display value from existing fields (`hasActiveProfile` + `latestGenerationStatus`) OR extend `DomainDiagnosticsEntry`. **Recommendation: derive initially, flag schema extension as P1.**

4. **F4 — No structured extraction failure reason.** `OnboardingItem` has `errorMessage` (free text) and `stageStatus`. There is no enum like `extractionFailReason: 'no_profile' | 'ambiguous_match' | ...`. The current extraction pipeline sets `errorMessage` strings. → The "Profile required" / "Ambiguous match" badges (Task 2) must either (a) pattern-match `errorMessage` heuristically, or (b) require a backend field. **Recommendation: heuristic match on `errorMessage` for v0 (P0), structured field as P1 backend follow-up.** Flag as risk.

5. **F5 — No "Profile-Blocked Item" or "Profile Retry Preview" backend.** Nothing queries "items blocked in Extraction due to profile absence" or "items retryable now that profile X is healthy." → The Profile Retry Preview (Task 4) needs a new backend query endpoint. This is the largest backend dependency. The UI component can be built against a defined contract, but it will not function until the backend query exists.

6. **F6 — `OnboardingSettings` is a single long page, not tabbed.** It renders sections sequentially (Source Discovery, LLM Providers, AI Model Routing, Curation Targets, Domain Configuration). Restructuring into tabs (Task 5) is a UI-only change to a large (~1536-line) file. `GeneratedProfilesPanel` is currently **not rendered anywhere** (it imports are unused by `OnboardingSettings`), so moving it into a tab is additive.

7. **F7 — `ProfileProposalDrawer` is item-attached and invoked from `OnboardingSettings`'s `DomainDetailPanel`.** The domain-first Profile Builder Workspace (Task 1) replaces this drawer's role as the primary profile-building surface, but `ProfileProposalDrawer` is also tightly coupled to `ProfileGenerationReview` field-level approval. The existing `ProfileGenerationReview` + `ProfileFieldValidationTable` are reusable and should be embedded into the new workspace rather than rewritten.

---

## Tasks

### Task A (PREREQ, P0) — Bun proxy routes for worker snapshot/validate

The UI cannot reach the worker. Add thin Bun routes that call the existing `extraction-worker-client.ts` functions and return results to the frontend. No new business logic; the Bun server remains the trust boundary.

- **File:** `src/server/routes/onboarding-routes.ts`
  - **Changes:**
    - `POST /api/onboarding/settings/profile-tooling/snapshot` — body `{ url, runtime?, captureScreenshot?, captureNetwork? }` → calls `snapshotPage()` → returns `{ ok, data } | { ok: false, error }`. Validate body with `SnapshotRequestSchema`.
    - `POST /api/onboarding/settings/profile-tooling/validate` — body `ValidateRequest` (`{ profileDraft, samples }`) → calls `validateProfile()` → returns `{ ok, data } | { ok: false, error }`. Validate with `ValidateRequestSchema`.
    - Do **not** add a propose proxy (F2). Proposal generation continues to use the existing `/settings/domain-diagnostics/:domain/generate-profile` LLM route.
  - **Acceptance:** `bun run typecheck` passes; routes return `ok:false` with a clear "worker unavailable" message when the worker is down (mirrors the existing health route's null handling).

- **File:** `src/client/onboarding-api.ts`
  - **Changes:** Add typed client functions mirroring the new routes:
    - `getExtractionWorkerHealth(): Promise<WorkerHealthResponse>` (already has a route, just no client fn) → `GET /settings/extraction-worker/health`
    - `snapshotPageForBuilder(req: SnapshotRequest): Promise<{ ok: boolean; data?: SnapshotResponse; error?: string }>` → `POST /settings/profile-tooling/snapshot`
    - `validateProfileDraft(req: ValidateRequest): Promise<{ ok: boolean; data?: ValidateResponse; error?: string }>` → `POST /settings/profile-tooling/validate`
  - **Acceptance:** Functions are typed against `src/shared/schemas/extraction-worker.ts` types; import paths added.

- **Complexity:** Low–Medium. Mechanical proxy work; client functions already exist server-side.

---

### Task 1 (P0) — Profile Builder Workspace (domain-first)

The flagship change. A new full-page (not drawer) domain-first surface. Replaces `ProfileProposalDrawer` as the primary profile-building entry point, but reuses `ProfileGenerationReview` + `ProfileFieldValidationTable` for field-level approval.

- **New File:** `src/client/components/ProfileBuilderWorkspace.tsx`
  - **Props contract:**
    ```ts
    interface ProfileBuilderWorkspaceProps {
      domain: string;
      onClose: () => void;
      /** Optional seed sample URL when deep-linked from a blocked Extraction item. */
      seedSampleUrl?: string | null;
      /** Optional seed item context (expectedName/upc/brandHint) for proposal generation. */
      seedItem?: { expectedName?: string | null; upc?: string | null; brandHint?: string | null } | null;
    }
    ```
  - **Internal state shape:**
    - `governance: DomainProfileGovernance | null` (from `getDomainProfileGovernance(domain)`)
    - `diagnostics: DomainDiagnosticsEntry | null` (filtered from `getDomainDiagnostics()` by domain, or a new single-domain fetch)
    - `workerHealth: WorkerHealthResponse | null` (from `getExtractionWorkerHealth()`)
    - `snapshot: SnapshotResponse | null`, `snapshotBusy: boolean`, `snapshotError: string`
    - `validation: ValidateResponse | null`, `validationBusy: boolean`, `validationError: string`
    - `selectedGenerationId: string | null` (drives the embedded `ProfileGenerationReview`)
    - `proposalGenerating: boolean`
  - **API calls:**
    - On mount: `getDomainProfileGovernance(domain)`, `getExtractionWorkerHealth()`, plus a single-domain diagnostics fetch (use existing `getDomainDiagnostics()` and filter, or add a route — see Task 3).
    - "Generate profile proposal" button → `generateProfileForDomain(domain, seedSampleUrl)` (existing endpoint, per F2). On success, set `selectedGenerationId` and reload governance.
    - "Snapshot page" button → `snapshotPageForBuilder({ url, runtime: 'rendered' })`. Render `jsonLd`, `imageCandidates`, `pageStructureSignals`, screenshot ref (as `<img>` if `screenshotRef` resolves to a servable path — note: artifact refs are file paths, not URLs; see Risk R-A1).
    - "Validate across samples" button → `validateProfileDraft({ profileDraft, samples })` where `profileDraft` is built from the selected generation's latest revision selectors and `samples` from governance confirmed samples. Render the `ValidateResponse.summary` and per-sample `results` in a table; reuse the sample-row rendering pattern from `ProfileFieldValidationTable`.
  - **Layout sections:**
    1. **Domain header** — domain name, `healthStatus` badge (reuse `domainHealthBadgeStyle` from `OnboardingSettings`), worker health dot (green/red + version from `workerHealth`), confirmed-sample count.
    2. **Existing profiles list** — for each profile in `governance.activeProfile` (currently one; future: multiple): scope (`sitemapProductUrlPattern` + a page-structure signal placeholder), health badge (derived per F3), selectors table (reuse `SELECTOR_FIELDS`), validation result summary.
    3. **Snapshot tooling** — URL input (pre-filled from `seedSampleUrl`), runtime toggle (static/rendered), "Snapshot" button, results panel (JSON-LD count, image candidates thumbnails, page-structure signals, screenshot).
    4. **Proposal review** — embed `<ProfileGenerationReview generationId={selectedGenerationId} governance={governance} onChange={reload} onClose={...} />` when a generation is selected; otherwise show a list of generations (reuse `DomainDetail` generation list pattern from `GeneratedProfilesPanel`).
    5. **Validation samples table** — confirmed + unconfirmed samples from governance; per-sample pass/warning/fail status from `validation.results`.
    6. **Image previews** — reuse `<ImagePreviewGrid>` for image selector validation samples.
    7. **"Promote to healthy" gate** — a banner/checkbox that checks: ≥2 confirmed samples passing, image previews reviewed, no failing title samples. Disabled until met. Calls the existing `approveRevisionFields` (which already gates image approval) — the "promote to healthy" is the existing approval flow reframed.
  - **Acceptance:** Workspace renders for any domain present in diagnostics; snapshot button shows worker-unavailable error when worker down; generation review embed works; closing returns to caller.

- **New File:** `src/client/components/DomainProfileSummary.tsx` (extracted subcomponent)
  - **Purpose:** Renders the domain header + existing-profiles list (sections 1–2 above) as a reusable presentational component, also used by Task 3's diagnostics row expansion.
  - **Props:** `{ domain: string; governance: DomainProfileGovernance | null; diagnostics: DomainDiagnosticsEntry | null; workerHealth: WorkerHealthResponse | null; onOpenWorkspace: () => void }`
  - **Complexity:** Medium.

- **Complexity (Task 1 overall):** High. Largest single change; coordinates multiple API calls and embeds existing review components.

---

### Task 2 (P0) — Pipeline Board extraction status badges

Surface profile-related extraction failures on item cards in the Extraction column.

- **File:** `src/client/components/PipelineBoard.tsx`
  - **Changes (in `renderCard`):**
    - After the existing `errorMessage` block, when `item.stage === 'extraction'` and `item.stageStatus === 'failed'`, derive a `profileFailReason` via a helper:
      ```ts
      function deriveProfileFailReason(item: OnboardingItem): 'no_profile' | 'ambiguous_match' | 'structure_mismatch' | null
      ```
      Heuristic (per F4): match `errorMessage` against patterns like `/no (healthy )?profile/i`, `/ambiguous/i`, `/structure (signal )?mismatch/i`. Return `null` for unmatched.
    - Render badges:
      - `no_profile` → amber "Profile required" pill with a clickable link "Open Profile Builder →" that opens the workspace (needs an `onOpenProfileBuilder(domain, item)` callback prop on `PipelineBoard`).
      - `ambiguous_match` → orange "Ambiguous match" pill.
      - `structure_mismatch` → red "Structure mismatch" pill.
      - Unmatched → keep existing `errorMessage` red text.
    - Extract the item's domain from `item.sourceUrl` (or `item.brandDomain` if `sourceUrl` null) for the deep-link target.
  - **Props change:** Add `onOpenProfileBuilder?: (domain: string, item: OnboardingItem) => void` to `PipelineBoardProps`.
  - **Acceptance:** A failed extraction item with a profile-related `errorMessage` shows the correct badge; clicking "Open Profile Builder" opens the workspace for that domain.

- **File:** `src/client/components/Onboarding.tsx`
  - **Changes:** Add `profileBuilderDomain` state; render `<ProfileBuilderWorkspace>` overlay when set; pass `onOpenProfileBuilder` to `PipelineBoard` that sets the domain + seed item from the clicked item.
  - **Complexity:** Low–Medium.

---

### Task 3 (P1) — Domain Diagnostics enhancements

Add worker health indicator, profile health column, and "Open Profile Builder" button to the existing Domain Configuration table in `OnboardingSettings`.

- **File:** `src/server/routes/onboarding-routes.ts`
  - **Changes (PREREQ for single-domain fetch):** Add `GET /api/onboarding/settings/domain-diagnostics/:domain` returning a single `DomainDiagnosticsEntry` (filter the existing `getDomainDiagnosticsResponse()` by domain, or 404). Avoids fetching all domains when the workspace opens.
  - **Acceptance:** Route returns the entry for a known domain; 404 for unknown.

- **File:** `src/client/onboarding-api.ts`
  - **Changes:** Add `getDomainDiagnosticsForDomain(domain: string): Promise<DomainDiagnosticsEntry>`.

- **File:** `src/client/components/OnboardingSettings.tsx`
  - **Changes:**
    - Add a worker-health row at the top of the Domain Configuration section: a green/red dot + version text, fetched via `getExtractionWorkerHealth()` on mount and on "Refresh".
    - Add a "Profile Health" column to the domain table. Derived display (per F3): if `hasActiveProfile` and `latestGenerationStatus !== 'rejected'` → "Healthy"; if `hasActiveProfile` and `latestGenerationStatus === 'rejected'` → "Needs review"; if `!hasActiveProfile` and `generationCount > 0` → "Proposed"; else "None". Render as a colored badge.
    - Add "Open Profile Builder" button per domain row (in a new "Actions" column or appended to the existing row). Clicking sets `workspaceDomain` state.
    - Render `<ProfileBuilderWorkspace domain={workspaceDomain} onClose={...} />` when set.
    - Keep the existing `DomainDetailPanel` accordion for brand/sitemap/selector editing (it is not removed; the workspace is the *profile-building* surface, the accordion is the *domain-config* surface).
  - **Acceptance:** Worker health dot reflects worker up/down; Profile Health column shows derived status; "Open Profile Builder" opens the workspace.
  - **Complexity:** Medium.

---

### Task 4 (P1) — Profile Retry Preview

A preview of Profile-Blocked Items retryable after a profile becomes healthy.

- **Backend dependency (PREREQ, flagged):** No backend query exists for "items blocked in Extraction due to profile absence for domain X" or "items retryable now." This task's UI can be built against a defined contract but will be non-functional until the backend query lands. **Recommendation: build the UI component + client function against the contract below; mark the backend endpoint as a required follow-up.** Surface this in Risks.

- **New File:** `src/client/components/ProfileRetryPreview.tsx`
  - **Props contract:**
    ```ts
    interface ProfileRetryPreviewProps {
      domain: string;
      onClose: () => void;
    }
    ```
  - **Internal state:**
    - `items: ProfileBlockedItem[]` (see schema below), `loading`, `error`
    - `selectedIds: Set<string>`
    - `retryStatus: Record<itemId, 'pending' | 'retrying' | 'succeeded' | 'failed'>`
  - **API calls (contract — backend may not exist yet):**
    - `GET /api/onboarding/settings/profile-retry-preview/:domain` → `{ items: ProfileBlockedItem[] }`
    - `POST /api/onboarding/settings/profile-retry-preview/:domain/retry` body `{ itemIds: string[] }` → `{ accepted: number }` (re-queues items into Extraction `pending`).
  - **Proposed schema addition** (in `src/shared/schemas/onboarding.ts`):
    ```ts
    export const ProfileBlockedItemSchema = z.object({
      itemId: z.string(),
      upc: z.string(),
      name: z.string(),
      expectedName: z.string().nullable(),
      brandHint: z.string().nullable(),
      sourceUrl: z.string().nullable(),
      errorMessage: z.string().nullable(),
      blockedAt: z.string(),
    });
    export type ProfileBlockedItem = z.infer<typeof ProfileBlockedItemSchema>;
    ```
  - **Layout:** domain header, table of blocked items (checkbox, UPC, name, source URL, blocked reason), "Retry selected" button, per-item status pill after retry.
  - **Acceptance:** Component renders loading/empty states gracefully even if the backend endpoint 404s (catch error, show "Retry preview unavailable — backend query not yet implemented"). This makes the UI shippable without blocking on the backend.
  - **Complexity:** Medium (UI); backend is a separate, larger effort not scoped here.
  - **Entry point:** Shown as a section inside `ProfileBuilderWorkspace` when the domain has a healthy profile (i.e., after "promote to healthy" succeeds), and/or as a button in `OnboardingSettings` domain row.

---

### Task 5 (P1) — Onboarding Settings tab restructure

Convert the single-page `OnboardingSettings` into a tabbed layout with a dedicated "Extractor Profiles" tab.

- **File:** `src/client/components/OnboardingSettings.tsx`
  - **Changes:**
    - Add a `settingsTab` state: `'general' | 'llm' | 'curation' | 'profiles'`.
    - Add a tab bar at the top (below the header/back button).
    - **General tab:** Source Discovery (Serper).
    - **LLM tab:** LLM Providers + AI Model Routing (Model Routing stays with providers since it depends on them).
    - **Curation tab:** Curation Classification Targets.
    - **Profiles tab (new):** Worker health indicator, Domain Diagnostics table (from Task 3), `<GeneratedProfilesPanel>` (currently unmounted — wire it in here), and the "Open Profile Builder" entry points. This is where `ProfileProposalDrawer` was previously triggered; the drawer is retained as a fallback but the primary entry becomes the workspace.
    - Keep the existing `DomainDetailPanel` accordion under the Profiles tab.
  - **Acceptance:** All four tabs render their sections; no section is lost; `GeneratedProfilesPanel` is now visible; navigation between tabs doesn't refetch data unnecessarily.
  - **Complexity:** Medium. Mostly moving JSX blocks into conditional renders; the file is large so care is needed to preserve handlers.

---

## Files to Modify

- `src/server/routes/onboarding-routes.ts` — Add worker proxy routes (snapshot, validate) + single-domain diagnostics route (Task A, Task 3).
- `src/client/onboarding-api.ts` — Add `getExtractionWorkerHealth`, `snapshotPageForBuilder`, `validateProfileDraft`, `getDomainDiagnosticsForDomain`, and retry-preview client functions (Tasks A, 3, 4).
- `src/client/components/PipelineBoard.tsx` — Extraction status badges + `onOpenProfileBuilder` prop (Task 2).
- `src/client/components/Onboarding.tsx` — Wire `ProfileBuilderWorkspace` overlay + pass callback to `PipelineBoard` (Task 2).
- `src/client/components/OnboardingSettings.tsx` — Tab restructure, worker health indicator, Profile Health column, "Open Profile Builder" button, render workspace (Tasks 3, 5).
- `src/shared/schemas/onboarding.ts` — Add `ProfileBlockedItemSchema` (Task 4, contract-only).

## New Files

- `src/client/components/ProfileBuilderWorkspace.tsx` — Domain-first profile building surface (Task 1).
- `src/client/components/DomainProfileSummary.tsx` — Reusable domain header + profiles list subcomponent (Task 1).
- `src/client/components/ProfileRetryPreview.tsx` — Blocked-items retry preview (Task 4).

## Dependencies

- Task A (proxy routes) is a **hard prerequisite** for Task 1's snapshot/validate features and Task 3's worker-health indicator (health route already exists, but the client function does not).
- Task 1 (Profile Builder Workspace) is a **hard prerequisite** for Task 2's deep-link target and Task 3's "Open Profile Builder" button (they open the workspace).
- Task 2 (badges) depends on Task 1 for the open-workspace callback target, but the badge rendering itself is independent and can land first with a no-op callback.
- Task 3 (single-domain diagnostics route) is a **soft prerequisite** for Task 1's efficient domain fetch; Task 1 can fall back to filtering the full diagnostics list until the route lands.
- Task 4 (Retry Preview) UI is independent of Tasks 1–3 but its backend endpoint is a **blocking external dependency** (not scoped here).
- Task 5 (tab restructure) depends on Task 3's additions being in `OnboardingSettings` so they land in the right tab.

## Suggested implementation order

1. **Task A** (proxy routes + client functions) — unblocks everything worker-related. (P0)
2. **Task 1** (ProfileBuilderWorkspace + DomainProfileSummary) — the flagship surface; build against Task A's client functions. (P0)
3. **Task 2** (Pipeline Board badges + Onboarding wiring) — quick once the workspace exists. (P0)
4. **Task 3** (Domain Diagnostics enhancements + single-domain route) — enhances the settings surface. (P1)
5. **Task 5** (tab restructure) — reorganize now that the Profiles tab has content. (P1)
6. **Task 4** (Profile Retry Preview) — UI against contract; backend is a separate follow-up. (P1)

## Risks

- **R-A1 — Artifact refs are file paths, not URLs.** `SnapshotResponse.screenshotRef` / `htmlRef` are `artifact://...` or filesystem paths under `<workspace>/.shopsite-cms/artifacts/...`. The browser cannot `<img src>` a file path. The workspace's screenshot/image preview will need either (a) a Bun route that streams artifact files by ref, or (b) the worker to return base64 data URLs. **This is an unscoped backend dependency for the image-preview portion of Task 1.** Mitigation: render the screenshot ref as a labelled "screenshot captured (open in workspace dir)" placeholder until an artifact-serving route exists; flag as P1 backend follow-up.
- **R-A2 — Worker `/propose` not implemented (F2).** The "Generate profile proposal" button uses the existing Bun-side LLM generate path, which is inconsistent with the worker's eventual proposal model. Document this clearly in the UI (e.g., button label "Generate profile proposal (LLM)") and plan a swap-in when worker Phase 6 lands.
- **R-A3 — Profile Health derivation is approximate (F3).** Without a real per-profile health field, the derived badge may mislabel domains (e.g., a profile that exists but failed validation shows "Healthy"). The heuristic should err toward "Needs review" rather than "Healthy" to stay fail-closed. A schema extension adding `profileHealth` to `DomainDiagnosticsEntry` is the proper fix (P1).
- **R-A4 — Extraction failure-reason heuristic is fragile (F4).** Pattern-matching `errorMessage` strings couples the UI to backend wording. If the extraction pipeline changes its error messages, badges will silently regress to plain error text. Mitigation: keep the heuristic in one well-tested helper function and add a unit test for the patterns; push for a structured `extractionFailReason` field as a P1 backend follow-up.
- **R-A5 — Profile Retry Preview backend does not exist (F5).** The UI will be non-functional until a backend query + retry endpoint lands. The component must degrade gracefully (show an "unavailable" state, not a crash).
- **R-A6 — `OnboardingSettings` is ~1536 lines.** Tab restructure (Task 5) risks breaking handler closures and shared state. Mitigation: do the restructure last, after Tasks 3's additions are stable; verify with `bun run typecheck` and manual click-through of every tab.
- **R-A7 — `ProfileProposalDrawer` deprecation surface area.** The drawer is referenced by `OnboardingSettings`. The workspace replaces its primary role, but removing the drawer outright risks breaking the existing `onReviewProposal` flow. Mitigation: keep the drawer as a secondary path during transition; remove only after the workspace covers all its flows (field-level approve/reject + feedback revision — which it does via embedded `ProfileGenerationReview`).
- **R-A8 — Multiple profiles per domain.** CONTEXT.md says a domain may have multiple Domain Extractor Profiles, but the current `ExtractorProfile` schema and `findProfileByDomain` assume one. The workspace's "existing profiles list" (Task 1 section 2) is designed for multiple but the backend returns one. This is a forward-compatible UI that will simply show one row until the backend supports multiple. No risk to current behavior.

---

## Acceptance Report

This is a planning-only task. No code was changed, no tests added, no commands run beyond read/grep/find/ls for analysis. All findings are written to the authoritative output path.
