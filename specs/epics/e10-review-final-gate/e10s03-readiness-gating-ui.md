# e10s03 — Readiness checklist, jump-to-fix, final confirmation gate

## Goal
Give reviewers a record-level readiness signal wired to the e10s01 gate codes, jump-to-field
fixing, and a final confirmation before "Looks Good & Next". /impeccable Operate mode:
scanable, consistent, zero decoration that competes with the decision.

## Files
- **New:** `src/client/components/onboarding/review/review-readiness.ts` — pure derivation from
  item detail → `{ ready, blockers, warnings }` using shared codes from e10s01 (client advisory,
  server authoritative).
- **New:** `src/client/components/onboarding/review/ReviewReadinessPanel.tsx` — mandatory
  checklist (5 gates) + warnings list; each entry names the field in text; blocker entries are
  focus targets.
- **Edit:** `ReviewActions.tsx` — Looks Good / bulk-approve affordances disabled while blockers
  exist, with text reason (`aria-disabled` + explanation), not color-only.
- **Edit:** `ReviewWorkspace.tsx` — confirm step before durable review when session-dirty:
  compact effective-value diff (Name/Price/Brand/Primary image/Pages, pre-edit vs current) +
  warnings; "no changes" short-circuits to approve.
- Jump-to-fix: registry of field refs per gate code; activation focuses first offending field
  (`focus()` + `scrollIntoView`).

## Accessibility contract (WCAG 2.2)
- SC 3.3.1/3.3.3: errors in text tied via `aria-invalid` on inputs + `aria-describedby` to
  message nodes; SC 1.4.1: status never color-only (icon + text).
- Checklist panel is a labelled landmark region; keyboard parity with existing shortcuts;
  Escape cancels edit with dirty-confirm.
- /impeccable craft floor applies at implementation time (load reference/craft-floor.md before
  UI editing; bounded verify passes: one batched inspection round + one fix round).

## Tests
- Extend `src/tests/unit/review-panel-gating.test.tsx`: blockers disable approve with text
  reason; checklist renders each code's text; jump-to-fix moves focus; confirm step appears iff
  edited; clean-pass short-circuit.
- Extend `src/tests/unit/review-logic.test.ts`: readiness derivation incl. stale-snapshot
  handling when server rejects with codes.

## Acceptance criteria
- A reviewer cannot approve an item with blocking errors through any UI path; every blocker
  names its field and offers one-interaction navigation to it; warnings are visible but never
  block.
