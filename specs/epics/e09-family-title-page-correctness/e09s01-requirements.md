# e09s01 — Requirements & Adjudication Scaffold

> Implements Phase A of `docs/plans/family-title-category-page-requirements-plan.md` (adjudicated 2026-08-22). One sequential writer; **no `src/` code changes** in s01.

## Scope lock

Only:

1. Family title consistency — harmonized skeleton preserving variant facts.
2. Correct, verified primary Category Page for every product before Review/Promotion.

Deferred: extraction, `product-family-v1` grouping, Product Type/Attribute Profiles, taxonomy activation, other curated fields, embeddings/retrieval, QoL filters.

## Adjudicated skeleton ( §1a — Store Manager)

| Decision | Value |
|---|---|
| Title skeleton | **Brand → Line → Form/Species → Flavor/Color/Sub-line → Size/Weight/Count** (all siblings share ordered slots, typed placeholders) |
| Modifier visibility | **Soft / Hard / Classic / Hypoallergenic always visible** when evidenced — unified BetterBone family keeps per-SKU hardness/sub-line |
| Primary Page cardinality | **Multiple co-primary allowed for dual-species only when frozen evidence explicitly proves dual use** (at most one per species). Single-species → exactly one primary. |
| Brand Pages | **Optional secondary only** — `Brand - …` never substitutes primary; canonical brand identity controls it |
| Specificity | **Child > Shop All** — specific child is primary; `Shop All` excluded unless policy explicitly requires both |
| Abstention | **Blocks Review** — `needs_input`/`blocked` primary → Review cannot complete |
| Re-run policy | **New revisions only** — existing `completed` cohorts stay historical truth |
| Ambiguous Pages | **Manual reviewer selection OK** from current verified Page IDs; no new taxonomy this phase |
| Gold-set split | **By whole family** train/test/holdout (never by SKU) to prevent leakage |
| Adjudicator | Store Manager |
| Incident census | **Export all known bad** title inconsistencies + wrong-Page cases from verified backup/read-only clone |

## Grounded findings (blocking)

- `validateCohortResponse` proves coverage/duplicates but not skeleton/brand/slot order/leakage (`cohort-name-coordinator.ts`).
- `validatePageResponseEntries`/`normalizePageAssignments` prove identity but not semantic correctness (`page-assignment-llm.ts`); same-species wrong category (`Jerky` vs `Bones/Bully Sticks`) can pass.
- Abstention is durable and can count as `completed`; Review gate has no primary-Page requirement (`CohortPageOutputSchema`, `review-completion-gate.ts`).

## Testable contracts (verbatim referenceable)

### Titles — T1-T10

- **T1** Existing family identity is authoritative — frozen `product-family-v1` membership only.
- **T2** Shared skeleton — variant values replaced with typed placeholders must be identical across siblings.
- **T3** Canonical shared terms — brand/product-line spelling/casing identical, same position.
- **T4** Variant fidelity — evidenced Soft/Hard/Classic/Hypo/flavor/size/weight/count appears exactly once in correct slot (always-visible).
- **T5** No sibling leakage — Beef Small sibling never gets Venison Large unless independently evidenced.
- **T6** No invention — indistinguishable evidence → `blocked` with ambiguous-variants finding, never invent distinguishing token.
- **T7** All-or-nothing — one invalid title → zero `curated_title` rows committed; fallback tried as complete set or family blocked for new revision.
- **T8** Durable authority — title policy/prompt/post-processing/version participates in authority hash; historical rows untouched.
- **T9** Review gate — missing/malformed skeleton, inconsistent skeleton, missing required token, leakage, invention all block Review.
- **T10** Grouping boundary — no change to `extractNameStem`, brand grouping, `GROUPING_VERSION`, BetterBone corrections.

### Pages — P1-P12

- **P1** Verified frozen catalog only — no verified catalog → blocked/needs_input.
- **P2** Stable identity — Page ID from frozen verified import; unknown/mismatched/ambiguous/deleted/foreign IDs fail closed; name ≠ identity.
- **P3** Required primary — at least one verified primary; dual-species co-primary only when evidenced; secondary/brand cannot satisfy missing primary.
- **P4** Member-owned evidence — judged from member's own frozen evidence + frozen Execution Product Type context; family gives execution only, not semantic copy.
- **P5** Semantic compatibility — dog vs cat/bird/fish/reptile, food vs treat vs toy vs supply, wet vs dry, product vs refill, life-stage/form when Page distinguishes — no contradiction allowed; if frozen evidence insufficient, stop vs invent taxonomy.
- **P6** Specificity — valid specific child supersedes generic `Shop All` (child only).
- **P7** Brand Page separation — canonical brand controls optional `Brand - …` secondary, never primary (now scoped as optional secondary).
- **P8** Confidence non-authoritative — cannot override incompatibility/missing/ambiguity.
- **P9** Per-member outcome — `assigned` | `needs_input` | `blocked`; one ambiguous member must not leak its Page to another.
- **P10** Review completion — abstained/missing/stale/rejected/unverified primary → refused with Page-specific reason; reviewer correction only via current verified ID.
- **P11** Promotion defense — recompute currentness before writing drafts/`product_pages`/`ProductOnPages`; refuse stale/incompatible.
- **P12** Legacy parity — legacy/rollback name-only fallback is not acceptance authority; must use same validator or abstain.

## Governing contracts (preserved)

`product-family-v1`, extraction frozen, per-run frozen evidence/Page catalog/model plan/snapshot, `classification_cohort_outputs` write-once, new authority hash → new revision, Page identity = stable ID, model confidence audit-only, fail-closed on ambiguity, no `storage/catalog/store/classification/**` commit.

## Known constraint — T1 grouping equivalence (round-3 FIX 3)

Production title/page coordination groups via `groupByProductLine(frozenItems)` → `familyGroupingIdentityFor` → `extractNameStem`. This is BYTE-EQUIVALENT to durable `product-family-v1` membership ONLY while `GROUPING_VERSION` and the frozen raw inputs are unchanged. The `authoritativeCohortId` seam in `coordinateCohortItems` exists for future direct-cohort callers; any divergence between re-derived stems and frozen cohort membership (e.g. manual membership corrections) MUST route through that seam instead of relying on this equivalence.

## Out of scope (explicit)

Extraction/profiles/OCR/distributor materialization; `product-family-v1` → `product-family-v2`; Product Type/Attribute Profiles/taxonomy; attributes/descriptions/keywords/weights/images; retrieval/embeddings/reranking; new Page taxonomy unless separately approved; QoL filters/boards/drawers; auto-approval/publication/ShopSite sync; mutation of write-once outputs; live DB writes in s01.

## Artifacts (this story)

- `src/tests/fixtures/family-title-page-goldset-v2.json` — by-family scaffold per Plan §12 (stable Page IDs, import hash, reviewer/rationale, `isSynthetic` explicit, by-family split)
- `specs/metrics/family-title-page-eval-v1.json` — placeholder metrics (version 1, `goldsetHash`, `counts`, `splits`)
- `specs/epics/e09-*/epic.yaml` + `e09s01-tasks.yaml` — planned status only

See `docs/plans/family-title-category-page-requirements-plan.md` §12-§17 for full phased plan.
