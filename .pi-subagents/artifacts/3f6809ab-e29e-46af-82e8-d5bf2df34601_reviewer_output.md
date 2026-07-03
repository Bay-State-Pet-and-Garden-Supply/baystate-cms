I now have all the evidence I need. Let me compile the final review.

## Review

### Correct (with evidence)

- **Domain-first ProfileBuilderWorkspace**: `ProfileBuilderWorkspace` takes a `domain: string` prop and organizes around one domain, not one product item. This aligns with CONTEXT.md line 703: *"A Profile Builder Workspace is organized around one domain, not one product item."* and line 714: *"A Profile Builder Workspace is separate from the product review drawer."* The `seedItem`/`seedSampleUrl` props are optional seed inputs only.

- **PipelineBoard fail-reason badges**: `deriveProfileFailReason()` (PipelineBoard.tsx:33-39) classifies extraction failures into `no_profile`, `ambiguous_match`, and `structure_mismatch`, rendering distinct badges ("⚠ Profile required" + "Open Profile Builder →" link, "⚠ Ambiguous match", "⚠ Structure mismatch"). This aligns with CONTEXT.md's Profile-Blocked Item and Fail-Closed Extraction concepts. The `onOpenProfileBuilder` callback is optional and only surfaces for `no_profile` failures.

- **OnboardingSettings Profiles tab**: The 4-tab restructure (general/llm/curation/profiles) preserves all existing sections. The Profiles tab includes worker health indicator, domain health badge (`domainHealthBadgeStyle`), profile health badge (`deriveProfileHealth`), and the "Open Profile Builder" button per domain row.

- **Backend auth gating**: The global middleware in `app.ts:27-36` exempts GET/HEAD and gates all other methods with `Authorization: Bearer <token>`. The new routes follow this convention correctly: `GET /extraction-worker/health` (exempt, returns only version/capabilities — no host/port/token), `GET /domain-diagnostics/:domain` (exempt, read-only), `GET /profile-retry-preview/:domain` (exempt, read-only), `POST /profile-tooling/snapshot` (gated), `POST /profile-tooling/validate` (gated), `POST /profile-retry-preview/:domain/retry` (gated, mutating). No sensitive data (worker host, bearer token, ShopSite credentials) is exposed to the frontend.

- **Type safety**: `npx tsc --noEmit --skipLibCheck` exits 0 with no errors. All imports resolve (`ProfileGenerationReview`, `ImagePreviewGrid`, `ProfileProposalDrawer`, `LlmTaskConfigPanel` all exist).

- **Backward compatibility**: All existing DomainDetailPanel handlers preserved (`onTest`, `onSave`, `onGenerateProfile`, `onReviewProposal`, `onAddBrand`, `onDeleteBrand`, `onCancel`). New handlers (`onShowRetryPreview`) are optional. ProfileProposalDrawer still wired. The `DomainDetailPanel` subcomponent fetches latest proposal via `getLatestProposalForDomain` unchanged.

- **Tests**: All 203 tests across 13 files pass. No React component test files exist in the codebase (0 `.test.tsx`), so the absence of UI component tests is consistent with existing patterns. Backend service/repo tests cover the underlying layers.

- **Zod validation on proxy routes**: Both `POST /profile-tooling/snapshot` and `POST /profile-tooling/validate` validate request bodies with `SnapshotRequestSchema.safeParse()` / `ValidateRequestSchema.safeParse()` before forwarding, returning 400 with flattened error details on failure.

### Blocker
None. The code compiles, tests pass, and the core flows are functional.

### Notes (non-blocking, evidence-backed)

1. **Seed URL not wired from PipelineBoard** (`Onboarding.tsx:1168`): `setProfileBuilderSeed({ item })` omits the `url` property, but line 1177 reads `seedSampleUrl={profileBuilderSeed?.url}` which is always `undefined`. When opening the Profile Builder from a failed extraction card, the Snapshot URL field starts empty and the Validation tab errors with "No sample URLs available." Fix: `setProfileBuilderSeed({ url: item.sourceUrl, item })` or read `profileBuilderSeed?.item?.sourceUrl`.

2. **Validation results table field-key mismatch** (`ProfileBuilderWorkspace.tsx`, validation tab): The per-sample table maps over `['title','price','description','brand']` and looks up `fields['title']`, but the worker's `validate.ts` returns `fieldResults` keyed by the actual selector names (`titleSelector`, `priceSelector`, etc. — see `validate.ts:276-278`). All per-field status cells render "—" instead of PASS/WARN/FAIL. The promote gate works because it checks both `titleSelector` and `title` variants (line ~334). Summary cards also work (from the `summary` object).

3. **Overview health badge always "unknown"** (`ProfileBuilderWorkspace.tsx`, `renderOverview`): The code casts governance to access `_healthStatus` (`governance as unknown as { _healthStatus?: DomainHealthStatus }`), but `DomainProfileGovernanceSchema` has no such field. The badge always renders "UNKNOWN" regardless of actual domain health.

4. **Fabricated image URLs in validation tab** (`ProfileBuilderWorkspace.tsx`): The image preview section constructs placeholder URLs (`${r.sampleUrl}/img-${i}`) because `ValidateResponse` returns only `candidateCount`, not actual image URLs. These broken links would fail to load in `ImagePreviewGrid`.

5. **Retry endpoint missing JSON parse guard** (`onboarding-routes.ts:1958`): `const body = await c.req.json()` has no try/catch, unlike the snapshot/validate routes which return 400 on invalid JSON. Invalid JSON would cause an unhandled 500.

6. **Retry endpoint ignores `:domain` param** (`onboarding-routes.ts:1957`): The domain URL parameter is not validated against the itemIds being retried — any itemIds from any domain can be reset. Low risk for a local admin tool but inconsistent with the route shape.

7. **Retry endpoint uses raw SQL** (`onboarding-routes.ts:1970`): `db.query('UPDATE onboarding_items SET error_message = NULL, retry_count = 0 WHERE id = ?').run(itemId)` bypasses the repository pattern (AGENTS.md: "Avoid direct SQL queries outside of these repositories").

8. **Double overlay nesting** (`Onboarding.tsx:1172-1180`, `OnboardingSettings.tsx`): The outer wrapper div creates a second `rgba(0,0,0,0.5)` backdrop on top of `ProfileBuilderWorkspace`'s own `rgba(0,0,0,0.4)` overlay, making the backdrop darker than intended. The outer container's `90vw/90vh` sizing is redundant since the modal uses `position: fixed` with `top/left/right/bottom: 24`.

9. **Misleading error message** (`ProfileRetryPreview.tsx`, error box): States "Retry preview is not yet fully implemented" but the backend endpoint is implemented and functional. Should say "Failed to load blocked items" instead.