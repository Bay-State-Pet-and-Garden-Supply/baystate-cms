# e10s05 — Flag rollout & legacy retirement

## Goal
Ship everything behind `VITE_REVIEW_UI_V2` following the exact dual-capability precedent of
`src/client/onboarding-feature-flags.ts`; formalize the legacy `ReviewDrawerShell` retirement.

## Files
- **Edit:** `src/client/onboarding-feature-flags.ts` — add `reviewUiV2` flag
  (`envFlag('VITE_REVIEW_UI_V2', false)`, computed once at module load; 'false'/'0'/'no' kill
  switch identical to siblings).
- **Edit:** `ReviewWorkspace.tsx` / panels — conditional rendering per story specs; flag off ⇒
  today's exact tree.
- Docs: retirement note in this spec is the record; no code touches legacy drawer in v1.

## Rollout sequence
1. e10s01 ships dark (server hardening benefits both surfaces; not user-visible).
2. e10s02+e10s03 behind flag, default off → dev verification → operator smoke on one real batch.
3. Flip default to true in a subsequent release after smoke sign-off.
4. Remove flag only after a full default-on cycle (Batch Workspace precedent).

## Legacy ReviewDrawerShell policy
- Frozen at V1: bug-fix-only, zero feature parity work, remains diagnostics-only behind
  Pipeline Board (`pr10-drawer-render.test.tsx` stays green).
- Retirement PR (post-default-on): remove `pipeline-drawer/ReviewDrawerShell.tsx` +
  `CurationStagePanel.tsx` from PipelineBoard diagnostics view (board itself stays); delete/
  update `pr10-drawer-render.test.tsx`. Gate: one release cycle with no reported diagnostics use.

## Tests
- Extend `src/tests/unit/onboarding-feature-flags.test.ts`: parsing matrix incl. kill-switch
  values and default-off.
- Full suite green with flag on AND off (`bun run test`, `bun run typecheck`, `bun run lint`).

## Acceptance criteria
- Instant rollback: setting `VITE_REVIEW_UI_V2=false` restores pre-epic behavior exactly.
- No second live review surface exists at any point (no drift burden by construction).
