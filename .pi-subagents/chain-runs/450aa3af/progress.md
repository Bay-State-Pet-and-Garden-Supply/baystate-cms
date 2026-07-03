# Oracle Analysis: Visual Element Picker vs AI Selector Generation

## Status: COMPLETE

## Phase 1: Context Reconstruction (DONE)
- Reviewed profile-generator.ts: LLM generates CSS selectors from minimized DOM text
- Reviewed buildStableSelector (line 318): already generates stable selectors from DOM elements using priority hierarchy (id → data-* → itemprop → semantic class → ancestor → nth-of-type)
- Reviewed page-extractor.ts: Playwright/HTTP extraction with layered approach
- Reviewed profile-promoter.ts: Per-field approval, never auto-promote invariant
- Reviewed profile-governance-service.ts: Multi-sample validation, revision versioning
- Reviewed extraction-worker/server.ts: Separate Node.js HTTP server (port 3032), bearer-token auth
- Reviewed extraction-worker-client.ts: Bun server proxies to worker, client never talks to worker directly
- Reviewed snapshot.ts: Playwright rendered runtime with screenshot capture
- Reviewed ProfileBuilderWorkspace.tsx, ProfileProposalDrawer.tsx, ProfileRevisionFeedbackForm.tsx: UI scaffolding for review
- Reviewed shared/schemas/extraction-worker.ts: Zod schemas for all worker requests/responses
- Reviewed shared/schemas/onboarding.ts: SelectorField enum, SELECTOR_FIELDS, profile generation schemas

## Phase 2: Key Findings (DONE)
1. buildStableSelector already exists and can generate stable selectors from any DOM element
2. Playwright is already in the extraction worker with rendered runtime
3. The worker is a separate Node.js process — cannot import bun:sqlite
4. The system is LOCAL (127.0.0.1) — headful browser is feasible
5. The snapshot route pattern provides a template for new worker routes
6. The extraction-worker-client.ts provides the proxy pattern
7. The ProfileProposalDrawer already has per-field preview/approve/reject UI
8. The ProfileRevisionFeedbackForm already has a manualSelectorHint input (buried/advanced)

## Phase 3: Recommendation (DONE)
- Hybrid: AI proposes + user visually corrects via headful Playwright browser
- Intermediate step: paste-element-to-selector using existing buildStableSelector
- Full end state: click-to-select overlay in headful browser
- All existing invariants preserved

## Risks
- Headful browser may not work in all deployment contexts
- Element-to-selector mapping needs live DOM uniqueness checking
- Full visual picker requires new worker route + client component + UI integration
