# Variant Resolution Rollout Runbook (Issue #90)

## Flags — deprecated/ignored (always-on since #90 follow-up)
- `BAYSTATE_CMS_VARIANT_RESOLUTION_MODE` and `BAYSTATE_CMS_VARIANT_INTERACTION_ENABLED` are ignored — resolution is always `active` with interaction default-off unless test override.
- Real rollback is revert commit, not env.

## Preflight (historical — flags now always-on, see Flags above)
1. Stop writer / queue.
2. Backup DB: copy file + `-wal`/`-shm` or `sqlite3 .backup`, run `PRAGMA quick_check`, record size/hash.
3. Deploy code — `onboarding_variant_resolutions` migration now always active (previously `mode off` created table with no behavior).

## Observe (historical — env `observe` deprecated, now diagnostics-only via code; no source/stage mutations in this phase)
- Previously `Set observe, interaction false`. Now always-on diagnostics are code-gated; no env to set.
- Monitor parse success, ambiguity, duplicate GTIN, fetch latency, 5 MB bound.
- No source/stage mutations in historical observe.

## Monitor
- Dashboard: `platformVariantCount`, `hasVariant` presence, `?variant` stripping occurrences, duplicate-GTIN hits per batch, `identityMatrixHash` churn, `.js` 429 rate, extraction latency p50/p95.
- Alerts: `too_many_variants` >0, `inconsistent_identifiers` >0, stale selection >5% of cohort.
- Logs: stable reason codes only, no GTIN/PII, no raw HTML.

## Active (historical — `active` now always-on, allowlist still applies)
- Previously `Set active for one workspace/domain cohort`. Now variant resolution is always `active`; allowlist is workspace/domain cohort still.
- Verify 3 distinct BetterBone deep links and payload receipts.
- Require zero wrong auto-selection in reviewed sample before broadening.

## Rollback — env flags deprecated
1. Revert commit `f53fcdc`/`7163062` (structured resolution removed; variant rows kept)
2. No env-based `observe`/`off` — always-on.

## Smoke checklist
- `bunx vitest run src/tests/unit/product-url-identity.test.ts src/tests/unit/variant-flags.test.ts src/tests/unit/variant-resolution-schema.test.ts`
- `bunx vitest run src/tests/unit/variant-resolver.test.ts`
- `bunx vitest run src/tests/unit/variant-url-resolver.test.ts src/tests/unit/source-discovery-variant-resolution.test.ts src/tests/unit/sitemap-matcher.test.ts`
- `bunx vitest run src/tests/unit/extraction-ladder.test.ts src/tests/unit/extraction-worker-variant-selection.test.ts src/tests/unit/selected-variant-materializer.test.ts src/tests/unit/profile-runner.test.ts`
- `bunx vitest run src/tests/unit/variant-interaction.test.ts src/tests/unit/onboarding-variant-selection-route.test.ts src/tests/unit/choose-variant-panel.test.tsx`
- `bunx vitest run src/tests/integration/onboarding-betterbone-variant-flow.test.ts`
- `bun test src/tests/unit/onboarding-variant-resolution-migration.test.ts src/tests/unit/onboarding-variant-resolution-repo.test.ts`
- `bun run typecheck && bun run lint` (expect 2803 lint issues; 2794 pre-existing + 9 from variant-resolution tests)
- Manual: BetterBone SM/LG/MINI three distinct deepLinks, three distinct payloads, duplicate-GTIN parks only that member in `needs_attention/choose_variant`
