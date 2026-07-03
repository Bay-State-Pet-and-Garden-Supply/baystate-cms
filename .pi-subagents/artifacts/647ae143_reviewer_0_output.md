I now have a complete, evidence-backed picture. Let me compile the final review.

## Review

### Correct (with evidence)

**ProfileBuilderWorkspace redesign (`5dfb312`)**
- TypeScript compiles cleanly (`tsc --noEmit` passes). Tab type is `('build' | 'review' | 'advanced')`, default `'build'`, and the body dispatch (`activeTab === 'build' && renderBuild()`, etc.) is consistent — no orphaned `'overview'`/`'snapshot'` tab references remain (verified via grep).
- `pickedSelectors` state (`Record<string, { selector: string; stability: string }>`) is correctly set in each `ElementPickerButton` `onPicked` and read for display. `ElementPickerButton`'s prop signature (`field: 'title'|'description'|'images'`, `url`, `onPicked: (r: PickElementResponse) => void`, optional `onCancel`) matches usage, and `PickElementResponse` has both `selector` and `stability` fields (`extraction-worker.ts:95-99`).
- The runtime/screenshot/network state (`snapshotRuntime='rendered'`, `captureScreenshot=true`, `captureNetwork=true`) is still consumed by `handleSnapshot` (lines 390-392), so removing the toggle UI preserves behavior via sensible defaults.

**job-queue.ts profile check (`4520941`)**
- `findProfileByDomain` imported from the correct path (`../db/repositories/extractor-profile-repo`); verified exported at HEAD (`extractor-profile-repo.ts:42`), and uncommitted WIP does not touch it.
- Error message `No extractor profile for ${domain} — profile required` matches `deriveProfileFailReason`'s regex `/profile.*required/i` (`PipelineBoard.tsx:58`), so the badge **will render**.
- Badge condition verified end-to-end: `updateItemStageStatus` sets only `stage_status` (not `stage`), so `item.stage` stays `'extraction'`; the badge requires `stage==='extraction' && stageStatus==='failed'` (`PipelineBoard.tsx:586`) — both satisfied.
- Domain extraction `new URL(item.sourceUrl).hostname.replace(/^www\./,'')` is correct; `findProfileByDomain` additionally lowercases/strips `www.` internally, and `URL.hostname` is already lowercase — no case mismatch. The fail-fast block mirrors the existing `!item.sourceUrl` guard directly above it.

**OnboardingSettings overlay fixes (`07e1efb` + `1aeafcd`)**
- `ProfileBuilderWorkspace` now renders directly (no nested fixed-position scrollable wrapper), matching `Onboarding.tsx`.
- `onReviewProposal` arrow-function syntax fixed (proper block body with braces).
- Drawer↔workspace mutual exclusion works: "Open Profile Builder" clears `drawerState`; `onReviewProposal` clears `workspaceDomain`.

**resetItemsToStage (`ab9c495`)**
- SQL uses parameterized placeholders (`?`) — injection-safe; sets `stage` + `stage_status='completed'`, preserving data.
- Route `validStages = ['discovery','extraction','curation','review','promotion']` exactly matches `PipelineStageEnum` (`onboarding.ts:99-105`).
- `PipelineStage` is a type-only import (`import type`), used only in the `as PipelineStage` cast. Client return type `{ success: boolean; reset: number }` matches route response.

### Blockers
None. The code compiles, the logic is correct, the profile-required badge renders, overlays are mutually exclusive in practice, and the SQL is safe.

### Notes (non-blocking)

1. **3 NEW lint errors in ProfileBuilderWorkspace** — the redesign removed the runtime/screenshot/network toggle UI but left `setSnapshotRuntime`, `setSnapshotCaptureScreenshot`, `setSnapshotCaptureNetwork` declared; these setters are now never called (verified: 7 call sites at baseline → only 3 declarations now). Dead code; values still used via defaults.
2. **Misleading CTA text (new)** — the redesign added a progress indicator saying "Go to the Review tab to save and approve your selections" (`ProfileBuilderWorkspace.tsx:774-777`), but `renderReview` does **not** consume `pickedSelectors` (shows AI "Profile Generations" instead). The missing save-persist flow is **pre-existing** (baseline also never persisted `pickedSelectors`), but the misleading text is newly introduced by this commit.
3. **Stale JSDoc header** (`ProfileBuilderWorkspace.tsx:5`) still says "tabbed workspace (Overview, Snapshot, Review)".
4. **OnboardingSettings mutual-exclusion gap (not reachable)** — "Open Profile Builder" and `onReviewProposal` don't clear `retryPreviewDomain` (only `onShowRetryPreview` clears all three). Not practically reachable because `ProfileRetryPreview` is a blocking `position:fixed; zIndex:1100` overlay, so the underlying trigger buttons can't be clicked while it's open.
5. **resetItemsToStage minor issues** — returns `itemIds.length` (input count) rather than actual rows affected (could over-report if IDs don't exist); and is placed under the `// ─── DEPRECATED ───` section banner, which is misleading for a new function.
6. **Behavior change in job-queue** — extraction now fail-fasts without a profile instead of using JSON-LD/meta-tag fallbacks. Intended per the commit, but items that previously extracted via fallback will now surface as "Profile required."
7. **8 test failures are NOT caused by the reviewed commits.** The working tree has **36 unstaged modifications + 443 untracked files** (WIP), including uncommitted changes to `migrations.ts` (+253 lines), `domain-status-repo.ts` (+26), `extraction-validator.ts`, and `extraction-remedies.test.ts` (+64) — the exact files the failing tests depend on. The reviewed commits touched **none** of these (0 commits each in `4b6a0ad..HEAD`). The `44fd140` commit message explicitly states "259 tests pass, 8 pre-existing failures unchanged," matching the current run (259 pass / 8 fail / 267 total) exactly. `domain-diagnostics-service.test.ts` and `domain-diagnostics-service.ts` are **untracked** (never committed).
8. **Lint (191 errors)** — mostly pre-existing. The `44fd140` fallow cleanup removed `export` from `deleteBrandSite`/`saveExtractorProfile`/`deleteExtractorProfile`/`completeReviewStage` in `onboarding-api.ts` (converting unused exports to unused locals) rather than deleting the dead code; typecheck still passes.