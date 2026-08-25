# bay-state-v4 Shadow Divergence Report — Initial Observation

**Date:** 2026-08-24
**Workspace:** `storage/catalog` (pre-pin → active arm = v3 default path)
**Method:** `buildV4ShadowDiffSummary` (production observer code) + live `page_index` cross-check
**Raw JSONL:** `storage/catalog/store/classification/shadow/v4-shadow.jsonl`

## 1. Config-level delta (active v3 arm vs compiled bay-state-v4)

| Dimension | Active (v3) | V4 | Delta |
|---|---|---|---|
| Product types | 73 | 74 | +1 (`fish-food`) |
| Attributes | 25 | 27 | +2 (compiled projections) |
| Export mappings | 17 | 19 | +2 (PF13/PF14) |

- **Types added:** `fish-food` only. **Types removed: none.**
- **Attributes added:** `canonical-category-id`, `canonical-breadcrumb` (the PF13/PF14 projection pair). **Removed: none.**
- **Mapping changes:** exactly those two additions (`→ ProductField13`, `→ ProductField14`). All 17 existing attribute→field mappings byte-identical.

**Verdict: pure additive superset.** No type, attribute, or mapping that exists today changes meaning or destination under v4.

## 2. Page-dynamics cross-check (live registry vs static projection)

Live verified+available pages: **211** (plus 152 name-only/unverified). Ratified projection: **153**.

- **Covered:** 154/211 verified pages have a ratified role entry.
- **Unratified (live, no entry): 57** — enumerated below. **Zero are product-listing leaf pages**: all are utility/system (order status, 404, search, returns, privacy), brand hubs, content/marketing (events, blog, Q&A), service pages, and test/example pages. None would qualify as `canonical_leaf`, so none can affect PF13/PF14 even after that seam is wired.
- **Stale (projected but no longer live): 0.** The projection is fully contained in the current verified set.
- Removed/renamed-page handling is unchanged from pre-v4 behavior: identity-keyed demotion on import activation; proposals referencing demoted pages fail visibly per existing gates.

**Conclusion: page sync dynamics are fully decoupled from the release artifact, and current drift carries zero assignment risk.**

## 3. PF13/PF14 wiring status

The projection join (`resolveCanonicalPageProjections`) is built and validated but deliberately **not consumed** by any proposal/draft seam yet (plan B.P4.2 scope boundary). Pinning v4 today therefore writes nothing new to ShopSite fields.

## 4. Gate status (runbook §rollout)

| Gate | Status |
|---|---|
| Config-level shadow diff reviewed | ✅ this document — clean additive superset |
| Live-page drift measured | ✅ 57 unratified (all non-leaf utilities), 0 stale |
| Proposal-level divergence (≥N batches, zero unexplained verified-page-join divergences) | ⬜ pending — requires scratch-pin step or extended proposal-level observer |
| Scratch-workspace promotion smoke | ⬜ pending |
| Production pin | ⬜ blocked until above two pass |

## 5. Recommendation

Config-level evidence supports proceeding to the scratch-pin step when ready. Before production: run at least one full cohort through the pinned-scratch workspace and confirm promotion output including (once wired) PF13/PF14 emission. Re-run `bun /tmp`-equivalent audit or the server observer after any store re-sync that adds product-listing pages; fold new leaf pages into the next release via `scripts/classification-author-release.ts`.
