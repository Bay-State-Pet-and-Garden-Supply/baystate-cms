# Phase 2 Handoff — Profile Generator Core

## Summary

Implemented all 6 Phase 2 tasks (Tasks 6–11) from the plan at
`/Users/nickborrello/Desktop/Projects/shopsite-cms/.pi-subagents/artifacts/c687aeb3_planner_0_output.md`.

The new module `src/onboarding/profile-generator.ts` provides:

1. **Type definitions** for the LLM-assisted selector flow.
2. **A feature flag** that is off by default (`SHOPSITE_CMS_PROFILE_GENERATION_ENABLED`).
3. **DOM minimization** that strips scripts, styles, header/footer/nav, etc. but
   preserves product-relevant scripts (JSON-LD, Shopify `productJSON`, variant
   blobs). A separate "kept scripts" buffer is appended after scoping so head
   scripts survive even when the minimized body is scoped to a product container.
4. **Stable selector candidate generation** with a strict priority order:
   unique non-generated id → `data-testid`/`data-test`/`data-product-*` →
   `itemprop` → semantic class combinations → ancestor+child → `nth-of-type`
   (low-stability fallback).
5. **LLM integration** that asks the model to pick selectors from the
   candidate list (reducing prompt-injection risk) and parses plain or
   fenced JSON. Returns `null` on every failure path so callers can
   default to safe behavior.
6. **Validation** that requires a non-empty title, accepts price only when
   the extracted text looks like a currency, runs `validateExtraction` on
   the extracted title when an expected product is supplied, and sets
   `canPromote` only when confidence ≥ 0.8 and no low-stability selectors
   were used.

44 unit tests pass via both `bun test` and `vitest run`. `bun run typecheck`
is clean for the new file; the two pre-existing errors in `page-extractor.ts`
are unchanged and out of scope for this phase.

## Changed Files

| File | Change |
|------|--------|
| `src/onboarding/profile-generator.ts` | **New.** 940 lines. Contains all types, the feature-flag helper, `getMinimizedDom`, `buildSelectorCandidates`, the internal `buildStableSelector` priority ladder, `generateExtractorProfile` (LLM-driven), and `validateGeneratedProfile`. |
| `src/tests/unit/profile-generator.test.ts` | **New.** 545 lines, 44 tests. Mocks `../../onboarding/llm-client` so no network is touched. Covers every behavior the plan and the task contract require. |

No other files were modified. Phase 1's audit repository and table are
consumed via the types/imports only when the Phase 3 integration writes
to `profile_generations`; this phase does not insert audit rows.

## Validation

| Command | Result |
|---------|--------|
| `bun run typecheck` | 0 errors in `src/onboarding/profile-generator.ts` and `src/tests/unit/profile-generator.test.ts`. 2 pre-existing errors in `src/onboarding/page-extractor.ts:1154` and `:1159` (out of scope, unchanged from before Phase 1). |
| `bun test src/tests/unit/profile-generator.test.ts` | 44 pass, 0 fail, 81 `expect()` calls, ~90ms. |
| `bunx vitest run src/tests/unit/profile-generator.test.ts` | 44 pass, 0 fail (~32ms). |
| `bun test src/tests/unit/<existing repo tests>` | 97 pass, 0 fail (no regressions). |

## Design Decisions / Notes

- **Kept-script buffer.** `getMinimizedDom` removes only the noisy tags
  and explicit-noise scripts, then buffers the kept scripts
  (`application/ld+json`, `productJSON`, `variants`, `ShopifyAnalytics`,
  `Shopify.theme`, `window.Shopify`) and re-appends them after the
  scoping step. This was necessary because the original implementation
  scoped the output to `<main>`/`.product`/`.pdp`, which discards the
  head; tests caught this and it was fixed in a single edit.
- **Selector priority ladder.** The plan called for the priority list
  id → data-attr → itemprop → class → ancestor+child → nth-of-type. The
  implementation uses cheerio's `$(...)` to verify uniqueness at the id
  step (`matches.length === 1`) so a non-unique id falls through rather
  than producing an over-broad selector. A regex-based id escape is used
  instead of `CSS.escape` (which is not available in this Node runtime).
- **Auto-generated id filter.** `isLikelyGeneratedId` rejects ids that
  start with `_` (React/Vue/Svelte), contain `__` (CSS modules), contain
  `--` (Tailwind arbitrary values), are pure hex, are pure digits, or
  match `section-…` with digits (Shopify sections). This prevents
  brittle selectors from ever reaching the LLM prompt.
- **Supported syntax whitelist.** `isSupportedSelectorSyntax` rejects
  XPath, JS execution, and browser-only pseudo-selectors
  (`:has(`, `:is(`, `:where(`, `:focus`, `:hover`) because the
  validators run via Cheerio and cannot evaluate them. Anything else is
  passed through and Cheerio's own evaluation will fail loud if the
  selector is malformed.
- **Candidate list passed to the LLM.** Up to 80 candidates are
  serialized into a compact `index — tag — selector — hints — text` list
  for the prompt. The model is explicitly told to choose from this
  list and not to invent selectors — this both keeps the prompt small
  and reduces prompt-injection risk (the model has no reason to read
  arbitrary HTML once it has the candidate list).
- **Confidence model.** Title alone is 0.40; expected-validation pass
  adds 0.10; each valid optional field adds 0.05–0.15; bad price text
  subtracts 0.10; bad syntax subtracts 0.05. Clamped to [0, 1].
  `canPromote` requires ≥ 0.8 and no `:nth-of-type(...)` selector.
- **Failure-closed everywhere.** Missing title, empty title, empty
  HTML, blocked/offline/mismatch expected-validation, missing LLM
  config, LLM exception, malformed JSON, missing titleSelector, or any
  unsupported selector syntax in the response all return a "fail" result
  rather than proceeding with a weak guess. The caller can always choose
  to ignore the failure, but cannot accidentally promote a bad profile.
- **No audit row inserted from this module.** Writing to
  `profile_generations` is the responsibility of the Phase 3 integration
  so that the safety gate stays explicit at the call site. The
  generator returns either a `GeneratedSelectorProfile` or `null`; the
  integration decides whether to audit it.

## Risks / Open Follow-ups

- **Cheerio selector compatibility.** Some modern CSS pseudo-classes
  work in real browsers but are partially or completely unsupported by
  Cheerio. The current implementation rejects the most common offenders
  (`:has`, `:is`, `:where`, `:focus`, `:hover`). If we discover other
  Cheerio-incompatible selectors in production, the
  `isSupportedSelectorSyntax` function should be extended.
- **The two pre-existing `page-extractor.ts` typecheck errors** will
  matter to Phase 3, which modifies the same file. They are not
  introduced by this phase.
- **`cheerio` is a transitive dep** (via `crawlee`). It is currently
  used directly by both `page-extractor.ts` (since before Phase 1) and
  this new module, so adding it to `package.json` as a direct dep is
  the right follow-up. The plan's risk section called this out and the
  fix should land alongside the Phase 3 work, since both files use it.
- **`getMinimizedDom` truncates at 200 KB.** If a typical product page
  exceeds this after minimization, the LLM will see a truncated body
  and may produce lower-quality selectors. The 200 KB cap is a
  deliberate token-cost guardrail; if real-world pages regularly need
  more, the cap can be raised and/or scoped to the product container
  only.
- **No `column 0` or `:checked` filtering** beyond what
  `isSupportedSelectorSyntax` lists. If the LLM returns an exotic
  selector the validator will fail loud at the Cheerio-evaluation step,
  which is the intended fail-closed behavior.

## No Staged Files

`git status --short | grep '^[A-Z]'` returns nothing. The two new files
appear as untracked (`??`) and are ready for review.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Implemented only Phase 2 (Tasks 6-11). No edits to migrations, repos, llm-client, extraction-validator, page-extractor, or any other file outside the new module + new test. The diff is bounded to src/onboarding/profile-generator.ts and src/tests/unit/profile-generator.test.ts."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "44/44 unit tests pass (81 expect() calls) under both bun test and vitest run. bun run typecheck is clean for both new files. All 97 pre-existing bun-test cases still pass. Every behavior called out in the plan is exercised by a named test (DOM minimization, candidate generation, stable-selector priority, fenced/plain JSON, invalid JSON, missing titleSelector, no LLM, blocked/offline/mismatch propagation, canPromote gating on stability, feature flag)."
    }
  ],
  "changedFiles": [
    "src/onboarding/profile-generator.ts",
    "src/tests/unit/profile-generator.test.ts"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/profile-generator.test.ts"
  ],
  "commandsRun": [
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "0 errors in new files; 2 pre-existing errors in page-extractor.ts unchanged from before this work"
    },
    {
      "command": "bun test src/tests/unit/profile-generator.test.ts",
      "result": "passed",
      "summary": "44 pass, 0 fail, 81 expect() calls, ~90ms"
    },
    {
      "command": "bunx vitest run src/tests/unit/profile-generator.test.ts",
      "result": "passed",
      "summary": "44 pass, 0 fail under vitest runner"
    },
    {
      "command": "bun test src/tests/unit/{db-migration,catalog-health,phase2-change-set,phase3-sync-drift,onboarding-repos,draft-promoter,onboarding-duplicate-skip,extractor-profiles,extraction-remedies,classification-pipeline,source-discovery,profile-generation-repo}.test.ts",
      "result": "passed",
      "summary": "97 pass, 0 fail; no regressions"
    },
    {
      "command": "git status --short | grep '^[A-Z]'",
      "result": "passed",
      "summary": "no staged files"
    }
  ],
  "validationOutput": [
    "profile-generator.test.ts getMinimizedDom (6 tests): noise removed, JSON-LD preserved, productJSON preserved, tracking removed, large output truncated, empty input handled",
    "profile-generator.test.ts buildSelectorCandidates (8 tests): finds title/price/description/brand/image candidates, limit enforced, no duplicate selectors",
    "profile-generator.test.ts buildStableSelector (4 tests): prefers unique id, avoids generated ids, prefers itemprop, marks nth-of-type",
    "profile-generator.test.ts generateExtractorProfile (10 tests): feature flag off, no LLM config, plain JSON, fenced JSON, invalid JSON, missing titleSelector, LLM exception, XPath rejection, browser-only pseudo rejection, non-object response",
    "profile-generator.test.ts validateGeneratedProfile (11 tests): missing title, empty title, all-fields pass, bad price text, blocked/offline/mismatch propagation, canPromote high-confidence, canPromote false for nth-of-type, unsupported syntax, empty HTML",
    "profile-generator.test.ts isProfileGenerationEnabled (5 tests): true/1/yes case-insensitive, other values rejected, unset env rejected"
  ],
  "residualRisks": [
    "Two pre-existing TypeScript errors in src/onboarding/page-extractor.ts (lines 1154 and 1159) remain; they are out of scope for Phase 2 but Phase 3 will touch the same file.",
    "cheerio is used as a transitive dependency (via crawlee); the plan called for promoting it to a direct dependency in package.json alongside Phase 3 work.",
    "getMinimizedDom truncates at 200 KB to bound token cost; product pages that produce larger minimized bodies will see a truncated body and may yield lower-quality selectors.",
    "Selector syntax whitelist currently rejects :has(, :is(, :where(, :focus, :hover only. Other Cheerio-incompatible selectors will fail loud at validation time, which is the intended fail-closed behavior but may surface in production.",
    "The 200 KB cap is deliberately conservative; if typical product pages regularly exceed it the cap should be revisited."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added a new 940-line profile generator module (types, feature flag, DOM minimization with kept-script buffer, stable selector candidate generation with id/data-attr/itemprop/class/ancestor/nth-of-type priority ladder, LLM prompt+JSON parsing, and fail-closed validation) and a 545-line test suite with 44 passing tests under both bun and vitest runners.",
  "reviewFindings": [
    "no blockers",
    "minor: buildStableSelector uses a small regex-based id escape instead of CSS.escape because CSS.escape is not available in this Node runtime. The escape covers quote, backslash, whitespace, square brackets, colon, and dot. Sufficient for typical e-commerce ids.",
    "minor: the kept-script buffer in getMinimizedDom is a deliberate choice so JSON-LD and productJSON survive scoping. Worth a code comment during review.",
    "minor: prompt intentionally caps candidates at 80 (down from CANDIDATE_LIMIT=100) to keep the prompt compact. If larger products need more candidates, raise both together."
  ],
  "manualNotes": "Phase 2 is complete. Phase 3 (Tasks 12-19) can now build on top of this module. Phase 3 should also (a) fix the two pre-existing page-extractor.ts typecheck errors, (b) consider promoting cheerio to a direct dependency in package.json, and (c) wire the new profile-generation-repo insert/update calls from page-extractor.ts."
}
```
