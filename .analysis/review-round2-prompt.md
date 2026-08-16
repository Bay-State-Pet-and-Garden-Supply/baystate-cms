# Review round 2 — implementation review (epic #46 follow-ups)

Attached: `.analysis/review-round2.diff` — the COMPLETE unified diff of everything
since your last review (Phases 4–6, commit 60edf76). 31 files, +2695/−77, 8 commits.
Please review the diff file carefully and post the COMPLETE review as ONE final
message.

## What the round contains (8 commits, in order)

1. **`f49489d` + `5644134` — Distributor imagery (PI-6)**: the review drawer now
   renders the rights-attested `distributorImageApprovals` (Amendment B addendum 3)
   the materializer already wrote; new `verifyDistributorImageryForBatch` runs the
   deterministic PI-6 `verifyImageCandidate` pipeline over approved URLs (gateway
   fetch → sharp decode → byte-bound packaging-OCR identity when a local VLM is
   configured → rights via seeded supplier-tier reuse grants → commerceApproved),
   persisting durable `product_intelligence_assets` rows (origin
   'onboarding_distributor', item-linked, idempotent per item+URL). Migration
   rebuilds the assets table (nullable run_id, origin, onboarding_item_id,
   same-run trigger, partial unique index). New batch endpoint + workspace button.
2. **`d3428fb` — Review-drawer clarity + classification honesty**: abstentions are
   informational (no accept/reject — the completion route auto-accepts them);
   proposal values humanized (no raw JSON); identical pending proposals merged;
   confidence chips (High/Moderate/Low + %). Server: freeText/measured attribute
   values must be grounded in the target's own evidence (attribute id OR
   source_field matching attr id or catalog field) — the old `?? text` fallback
   proposed the whole product description as "Brand"/"Product Type" for all 66
   items in the live batch; LLM ranker refuses picks below 0.5 confidence
   (`LLM_PROPOSE_MIN_CONFIDENCE`) since keyword matching already failed by then.
3. **`4191ebb` — docs**: the live-batch quality analysis prompt (for your earlier
   verdict).
4. **`75f019a` — Family grouping normalization**: attached size tokens split
   (`MD VNSNLG` → stem `better bone`), distributor abbreviation expansion
   (vnsn→venison, chkn→chicken…), name-embedded brand fallback when brandHint is
   empty (kills `betterbone::` vs `no-brand::` family splits), constrained typo
   merge (single token ≥4 chars, Levenshtein ≤1). New `product-line-token-normalizer.ts`.
5. **`915bf0b` — Durable cohort shadow**: shadow mode previously logged and wrote
   NOTHING; now persists `cohort_shadow_observations` (one row per cohort per
   state change, dedupe vs latest row), exposed via the cohort API, plus a rollout
   runbook. `.env` flags intentionally COMMENTED OUT (bun test auto-loads .env →
   active flags poisoned 53 flag-OFF assertions).
6. **`6e6364c` — Taxonomy + margin abstention**: `bee-supplies` (Bee Supplies &
   Apiary) added to the ACTIVE v2 bundle via the sanctioned config-store recipe
   (buildFocusedFiles → fileVersions → bundleHash → active validation → write;
   committed separately in the workspace git repo e8d7e6d7a) and to the new-
   workspace seed. Ranker prompt now asks for optional per-candidate `scores`;
   new `LLM_PROPOSE_MARGIN_MIN = 0.1` gate: when scores come back, a top pick not
   clearly ahead of the runner-up is an abstention (raw-score spread, since the
   single-mode slice hides the runner-up); malformed/missing scores skip the gate.
7. **`7859808` — test registration**: a stray untracked bun:test suite found by
   the runner registered in vitest excludes + test:db chain.

## Verification status (all local)
- Vitest: 2334 passed / 1 skipped, 149 files green (known `pi-network-boundary`
  P0-1 flake only).
- bun test:db: 1860 passed / 1 fail (same flake).
- tsc clean, eslint clean.

## Focus areas for this review
1. **Distributor imagery**: the migration (assets table rebuild + trigger
   recreation + partial unique index) — any risk for existing PI-6 runs/assets?
   The `insertOnboardingPiAsset` INSERT OR IGNORE idempotency; the
   `runIdentity`/evidence resolver wiring; whether `verifyImageCandidate`'s
   commerceApproved path is truly safe for onboarding-origin assets (rights from
   seeded grants, byte-bound OCR facts only); the button UX in the review bulk bar.
2. **freeText grounding change**: does requiring evidence to match
   attributeId/source_field risk dropping legitimate freeText proposals anywhere
   (e.g. evidence stamped with the attribute name vs catalog field)? Any caller of
   the shared processor that relied on the old fallback?
3. **Ranker gates (0.5 confidence + 0.1 margin)**: edge cases — the margin gate
   uses RAW scores (the slice hides the runner-up in single mode); is skipping the
   gate on malformed scores the right fail-open vs fail-closed call? Interaction
   with the retry path?
4. **Grouping normalization**: `splitAttachedSizeTokens` + abbreviation expansion
   — can any of the new token rewrites merge families that should stay separate
   (e.g. "BEEF" expansions colliding with brand tokens, `lg` splits breaking
   "SML5CT" handled cases)? The typo-merge pass (single token, ≥4 chars, ≤1 edit)
   — false-merge risk across genuinely different stems? The brand fallback from
   name prefix — could it attribute a wrong brand to a family?
5. **Cohort shadow**: the dedupe-vs-latest-row insert; route exposure; any
   interaction between shadow observations and the active-mode claiming path.
6. **Bee-supplies bundle edit**: the workspace-only commit bypassed the
   preview/stage/activate flow — is mutating the ACTIVE bundle directly (the
   attribute-editor recipe) safe here, and are fileVersions/bundleHash semantics
   preserved? (manifest.product-types fileVersion recomputed; semantic bundle hash
   covers authority fields only.)
7. Anything else you see in the diff — especially the client panel rewrite and the
   distributor-imagery service (src/onboarding/distributor-imagery.ts is new, 341
   lines).

Verdict format as before: BLOCKER / HIGH / MEDIUM / LOW with file:line references
and concrete fixes, then a one-paragraph go/no-go.
