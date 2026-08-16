You previously produced the implementation plan for the deferred onboarding throughput items (thread context). Phases 1–3 (identity normalization) are now IMPLEMENTED and shipped. The attached `phase1-3.diff` is the complete unified diff (2 commits: b70a614 + 79b7781 on top of ba8fe5f).

Review the implementation against YOUR OWN plan + the operator's authoritative rule:

> The structured weight identity field is ALWAYS pounds (Lbs), stored to exactly two decimal places, converted from any accepted unit. NEVER normalize the product name/title ("Butcher's Pup 16 oz" stays). Fail-closed on unparseable values.

What was built:
- `src/onboarding/normalization/weight.ts` — `normalizeWeightToLbs` / `parseWeightToLbs` / `roundToTwoDecimals` (lb/lbs/pound(s)/oz/ounce(s)/g/kg + unitless→lbs; strict scalar regex; business rounding; rejects ranges/fractions/multipacks/zero/negative/unknown units)
- `src/onboarding/normalization/brand.ts` — comparison-only case/whitespace fold
- `src/onboarding/normalization/pack-count.ts` — unsigned integer canonical form
- `src/onboarding/normalization/identity.ts` — field router + IDENTITY_NORMALIZATION_VERSION
- `src/onboarding/sourcing-reconciler.ts` — conflict classification compares canonical values; suppressed conflicts emit an explainable "agree after normalization (rule vN)" warning; raw values still persisted in conflict candidates
- `src/onboarding/sourcing/distributor-record-projection.ts` — the projection core's OWN hard-conflict loop (the qualification authority) now uses the same canonical comparison
- `src/onboarding/sourcing/distributor-record-materializer.ts` — `canonicalMaterializedWeight` in both v1/v2 builders; `payloadsEquivalentAfterWeightNormalization` keeps legacy raw-format rows passing the byte-for-byte idempotency invariant
- Tests: onboarding-normalization.test.ts (38 cases incl. every live-batch format), 7 reconciler suppression tests, e2e (16 oz vs 1.0000 lb → qualified → weight "1.00", name preserved), materializer helper tests

Review questions (be specific and honest):
1. Correctness of the normalization rules vs your plan (rounding, unitless, fail-closed, edge cases). Any wrong conversions or missing formats from the live batch?
2. Seam placement: reconciler + projection + materializer — any comparison point still comparing RAW values that could resurrect false weight conflicts (or worse, silently pass true ones)?
3. The legacy-row idempotency carve-out (`payloadsEquivalentAfterWeightNormalization`): is it sound, or does it weaken the fail-closed invariant anywhere (e.g., could a diverged payload slip through)?
4. The materializer boundary test allowlist addition (`../normalization/`) — acceptable?
5. Any test gaps or over-tests?
6. Anything that should be fixed BEFORE Phases 4–6 proceed?

Post the COMPLETE review as ONE final message: numbered findings with severity (BLOCKER/HIGH/MEDIUM/LOW/NIT), verdict per question, and a final go/no-go for Phases 4–6.