All files are in place and verified. Let me confirm the complete file list:

**Phase 1 (Shared Module):**
- `src/shared/selector-utils.ts` — extracted `buildStableSelector` + helpers
- `src/onboarding/profile-generator.ts` — imports from shared module
- `src/tests/unit/selector-utils.test.ts` — 32 tests

**Phase 2 (Paste-Element):**
- `src/shared/schemas/extraction-worker.ts` — `GenerateSelectorRequest`/`Response` schemas
- `src/extraction-worker/routes/generate-selector.ts` — worker route
- `src/extraction-worker/server.ts` — route registered
- `src/server/extraction-worker-client.ts` — client function
- `src/server/routes/onboarding-routes.ts` — proxy + fetch-html routes (with SSRF protection)
- `src/client/onboarding-api.ts` — API functions
- `src/client/components/ProfileRevisionFeedbackForm.tsx` — paste-element UI section
- `src/onboarding/profile-governance-service.ts` — wires manual selector into revision

**Phase 3 (Visual Picker):**
- `src/shared/schemas/extraction-worker.ts` — `PickElementRequest`/`Response` schemas
- `src/extraction-worker/routes/pick-element.ts` — headful Playwright worker route
- `src/extraction-worker/server.ts` — route registered
- `src/server/extraction-worker-client.ts` — client function (120s timeout)
- `src/server/routes/onboarding-routes.ts` — proxy route
- `src/client/onboarding-api.ts` — `pickElementVisually()` API function
- `src/client/components/ElementPickerButton.tsx` — clickable UI component
- `src/client/components/ProfileProposalDrawer.tsx` — per-field integration
- `src/client/components/ProfileBuilderWorkspace.tsx` — snapshot tab integration