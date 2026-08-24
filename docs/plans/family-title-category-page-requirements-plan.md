# Family Title Consistency and Category Page Correctness — Requirements Plan

**Status:** Approved requirements (adjudicated 2026-08-22) — Phase A authorized, Phase B pending gold-set freeze  
**Scope lock:** Only family title consistency + correct category page for every product. QoL filters deferred.  
**Decisions recorded below capture the Store Manager adjudication from the interactive walkthrough.**

## 1. Objective

Improve only:

1. **Family title consistency:** titles within an existing durable `product-family-v1` cohort use a harmonized family structure while preserving each SKU’s real variant facts.
2. **Category Page correctness:** every product has at least one correct, accepted, verified primary Category Page before review can complete or promotion can proceed.

This phase does not redesign extraction, family grouping, Product Types, attributes, descriptions, other curated fields, or operator filters.

## 1a. Adjudicated decisions (2026-08-22)

All 10 open questions + 2 follow-ups are now decided:

| # | Question | Decision |
|---|---:|---|
| 1 | Title skeleton | **Brand → Line → Form → Flavor → Size/Count** (e.g. `BetterBone Soft Beef Small`). All siblings share ordered slots. |
| 2 | Soft/Hard/Classic/Hypo visibility | **Always visible** — unified BetterBone family keeps hardness/sub-line per SKU when evidenced. |
| 3 | Primary category cardinality | **Multiple co-primary allowed for dual-species** — products legitimately for dogs *and* cats may have co-primary Pages (see P3 amendment). Single-category products have exactly one primary. |
| 3a | Dual-species guard | Co-primary only when **frozen evidence explicitly proves dual use** (not generic duplication). |
| 4 | Brand — Pages | **Optional secondary only**, never substitute for primary. Canonical brand identity controls it. |
| 5 | Shop All vs specific child | **Child only** — specific child (`Bones / Bully Sticks`) is primary, `Shop All` excluded unless policy explicitly requires both. |
| 6 | Abstention gate | **No — block Review** — abstained/missing primary → `needs_input`, Review cannot complete. |
| 7 | Adjudicator | **You / Store Manager** — sign off skeleton, tokens, correct Page IDs with rationale. |
| 8 | Re-run policy | **New revisions only** — existing `completed` cohorts stay historical truth; only new/future cohorts use new rules. |
| 9 | Incident census | **Export all known bad** title inconsistencies + wrong-Page cases from verified backup/read-only clone → you curate. |
| 10 | Ambiguous Pages | **Manual selection OK** — reviewer picks from current verified Page IDs; no new taxonomy this phase. |
| 11 | Gold-set split | **By whole family** (never by SKU) train/test/holdout to prevent leakage. |

---

## 2. Grounded current-state findings

| Severity | Finding | Evidence |
|---|---|---|
| **Blocker** | A coordinated title set can be structurally valid but internally inconsistent. `validateCohortResponse` checks complete UPC coverage, non-empty safe strings, and duplicate titles, but does not validate a shared family skeleton, canonical brand spelling, slot order, or sibling token leakage. | `src/onboarding/cohort-name-coordinator.ts` — `validateCohortResponse`; `src/onboarding/title-prompt-template.ts` |
| **Blocker** | Category Page validation proves that a returned Page exists, not that it is semantically correct for the product. Deterministic post-processing mainly covers stable identity, duplicate removal, “Shop All,” brand-page insertion, and cross-species names. A wrong same-species page can pass. | `src/classification/page-assignment-llm.ts` — `validatePageResponseEntries`, `normalizePageAssignments`; `src/classification/cohort-page-coordinator.ts` |
| **High** | Cohort semantic validation compares each member to its own durable LLM output. It intentionally does not check sibling title structure and does not independently judge whether the durable Page is appropriate. Thus a consistently materialized wrong answer passes correspondence validation. | `src/classification/cohort-semantic-validator.ts`; `src/tests/unit/cohort-semantic-validator.test.ts` |
| **High** | A Page abstention is durable and can count as a completed Curation result. The review gate has no specific requirement for an accepted Category Page; failure can be deferred until promotion. | `src/shared/schemas/cohorts.ts` — `CohortPageOutputSchema`; `src/classification/review-completion-gate.ts`; `src/onboarding/draft-promoter.ts` |
| **High** | Parent Page authority uses `spreadsheetIdentity.brandHint`, while the legacy single-product context can resolve brand from canonical, official, distributor, spreadsheet, and OCR evidence. This can omit or misapply optional brand landing pages. | `src/onboarding/cohort-page-hash.ts` — `pageAuthorityFromProjectionMember`; `src/classification/page-assignment-llm.ts` — `extractProductContext` |
| **High** | The legacy/rollback path contains a name-only, hard-coded Page fallback based on broad tokens such as `chew`, `dog treat`, `churu`, and `cat food`, including a direct SQL read. It does not share the durable Page correctness authority. | `src/onboarding/product-curator.ts` around the empty-`suggestedPages` fallback |
| **High** | Existing evaluation fixtures are insufficient to prove these outcomes. The 148-row family fixture explicitly says it is synthetic. The curation gold set uses `GOLD-*` examples, Page names rather than stable IDs, and its tests mostly validate fixture shape/token presence rather than execute title/Page decision code. | `src/tests/fixtures/family-grouping-accuracy-148.json`; `src/tests/fixtures/curation-goldset.json`; `src/tests/unit/curation-goldset.test.ts` |

---

## 3. Governing contracts to preserve

- Existing durable candidate families remain defined by `product-family-v1`.
- Extraction is assumed correct and complete; no extraction redesign or crawl work is permitted.
- Every run uses its existing frozen evidence, Page catalog, model plan, and configuration snapshot.
- `classification_cohort_outputs` remain immutable and write-once.
- A changed title/Page rule or prompt creates a new authority hash and cohort revision; old rows are never updated in place.
- Page identity remains a verified stable Page ID from the frozen active ShopSite Page import. Names are display data only.
- Model confidence remains audit information, never acceptance authority.
- A failure to prove correctness produces an explicit blocked/needs-input outcome, never a guessed answer.
- No taxonomy or `storage/catalog/store/classification/**` activation is planned. If implementation proves such a change necessary, stop for a separate scope decision and use only the sanctioned scoped catalog commit path.

---

# Focus 1 — Family Title Consistency

## 4. Problem statement

The system coordinates all members in one call and stores the result durably, but “coordinated” currently means produced together—not mechanically proven to use one title convention.

A family may therefore contain:

- inconsistent brand spelling or spacing;
- different ordering of product line, form, flavor, size, or count;
- lost variant tokens;
- tokens copied from one sibling to another;
- structurally different titles that are nevertheless unique and non-empty.

## 5. Current versus desired behavior

### Illustrative BetterBone case

Existing grouping correctly places all of these in one family:

- `BETTER BONE SOFT BEEF SM`
- `BETTER BONE HARD VNSN LG`
- `BETTER BONE CLASSIC VEGGIE MD`

A response such as the following can currently pass basic structural validation:

- `BetterBone Small Soft Beef`
- `Better Bone Hard Venison Large`
- `BetterBone Classic Medium Veggie`

**Decided desired output (Brand → Line → Form → Flavor → Size, always-visible modifiers):**

- `BetterBone Soft Beef Small`
- `BetterBone Hard Venison Large`
- `BetterBone Classic Veggie Medium`

Invariant: all siblings use the same slot order and canonical shared terms while retaining their own evidenced modifiers (Soft/Hard/Classic/Hypo always kept when evidenced).

## 6. Success criteria

1. Every multi-member family has one deterministically testable title style contract.
2. All sibling titles share: canonical brand rendering; canonical product-line rendering; same ordered semantic slots (`Brand → Product Line → Form/Species → Flavor/Color/Sub-line → Size/Weight/Count`); same punctuation, unit, count, and casing conventions.
3. Every member retains all required identity-bearing variant tokens supported by its own frozen evidence — Soft/Hard/Classic/Hypo always visible when evidenced.
4. No member receives a variant token evidenced only for another sibling.
5. No family title set is committed unless every expected member passes the same validator.
6. A deterministic fallback is allowed only if the complete fallback set passes the same contract.
7. Rerunning the same frozen authority produces the same canonical title artifact.
8. Singleton behavior remains unchanged except for shared token-safety rules.

## 7. Testable title requirements

### T1 — Existing family identity is authoritative

**Given** a finalized `product-family-v1` cohort  
**When** title processing begins  
**Then** it uses exactly the frozen cohort membership and does not regroup from live rows.

### T2 — Shared title skeleton

**Given** two or more members in the same family  
**When** their variant values are replaced with typed placeholders  
**Then** the normalized title skeleton must be identical across all members — `Brand → Product Line → Form/Species → Flavor/Color/Sub-line → Size/Weight/Count`.

### T3 — Canonical shared terms

- Brand and product-line spelling/casing must be identical across the family.
- Shared phrases must occur in the same position.

### T4 — Variant fidelity

**Given** a member with evidenced `Soft`, `Hard`, `Classic`, `Hypoallergenic`, flavor, color, size, weight, or count  
**Then** every required identity-bearing token appears exactly once in that member’s title, in its configured slot.

### T5 — No sibling leakage

**Given** sibling A is Beef Small and sibling B is Venison Large  
**Then** A must not receive Venison or Large, and B must not receive Beef or Small, unless independently evidenced for that member.

### T6 — No invention to force uniqueness

If two SKUs have indistinguishable title evidence, the system must block with an “ambiguous variants” finding. It must not invent a distinguishing flavor, size, form, or marketing phrase.

### T7 — All-or-nothing validation

**Given** one invalid title in an otherwise complete LLM response  
**Then** no `curated_title` row from that candidate set is committed.

The coordinator may try the deterministic family fallback. If that complete set also fails, the family is blocked for a new revision/manual resolution.

### T8 — Durable authority

- Title policy, prompt, post-processing rule, and executed operation parameters must participate in the title authority/version.
- A committed set with a mismatched authority continues to fail closed.
- Historical rows remain untouched.

### T9 — Review gate

Review cannot complete when: family title validation is missing/malformed; skeleton inconsistent; required variant token missing; sibling leakage or invented differentiation detected.

### T10 — Grouping boundary

This work must not change `extractNameStem`, brand grouping, grouping version, membership rules, or BetterBone grouping corrections.

---

# Focus 2 — Correct Category Page for Every Product

## 8. Problem statement

The current Page path strongly validates Page identity but only weakly validates Page meaning. An LLM-selected Page can be real, verified, and species-compatible while still being the wrong merchandising category. An automated abstention can survive Curation and only become a hard failure at promotion.

## 9. Current versus desired behavior

### Illustrative same-species error

A BetterBone chew could be assigned to `Jerky Dog Treats` (real, dog-safe) while correct is `Dog Treats Bones Bully Sticks & Natural Chews`.

Desired: stable Page identity is necessary but not sufficient; selected primary Page must be supported by member’s frozen product identity; chew/jerky, toy/treat, wet/dry incompatibilities must not be accepted merely because all are dog Pages; ambiguity → visible Page decision requiring review.

## 10. Success criteria

1. Every product has at least one accepted, verified primary Category Page before Review completes (co-primary allowed only for evidenced dual-species).
2. Zero products in the attested gold set receive an incorrect primary Page ID.
3. A Page assignment must pass identity, hierarchy, and product-compatibility validation.
4. Optional brand or campaign landing pages never substitute for the primary merchandising category.
5. A specific valid child Page supersedes its generic “Shop All” ancestor.
6. Every automated abstention reaches Review as an actionable unresolved Page decision (Review cannot complete on abstention).
7. Promotion revalidates Page currentness and refuses missing, stale, unverified, or incompatible assignments.
8. Family siblings may legitimately receive different Pages when their own evidence warrants it; no union/majority/sibling copying.
9. Automatic coverage is reported separately from correctness. Coverage pressure must never force a wrong assignment.

## 11. Testable Category Page requirements

### P1 — Verified frozen catalog only

**Given** no verified frozen Page catalog  
**Then** Page assignment produces a blocked/needs-input result and performs no assignment.

### P2 — Stable identity

- Automated Page output must identify a Page from the frozen verified Page set.
- Unknown IDs, mismatched ID/name pairs, ambiguous name-only output, deleted identities, and foreign-import IDs fail closed.

### P3 — Required primary category

Each product must have at least one designated primary merchandising Category Page before review completion.

- Single-species products: exactly one primary.
- Dual-species products (e.g., dogs + cats): co-primary allowed **only when frozen evidence explicitly proves dual use** — at most one primary per species, each verified.
- Optional secondary categories and brand landing pages must be separately represented and validated; secondary Pages cannot satisfy a missing primary category.

### P4 — Member-owned evidence

Every assignment is judged from the member’s own frozen evidence plus existing frozen Execution Product Type context. Family membership may provide coordinated execution, but not semantic evidence for copying a sibling’s Page.

### P5 — Semantic compatibility

A primary Page is valid only when no frozen evidence contradicts its product meaning. Required negative cases include: dog vs cat/bird/fish/reptile; food vs treat vs toy vs supply; wet vs dry where Page distinguishes; product vs accessory/refill; incompatible life-stage/form when explicitly represented by Page taxonomy.

The requirements phase must prove these distinctions are available from existing frozen inputs. If not, implementation stops rather than inventing a hidden taxonomy/profile system.

### P6 — Specificity and hierarchy

**Given** a valid specific child and its generic ancestor  
**Then** the child is primary and the “Shop All” Page is excluded (policy: child only, not both).

### P7 — Brand Page separation

- Canonical brand identity—not an unverified raw brand hint—controls optional `Brand - …` assignment.
- A brand Page is secondary and cannot displace or replace the primary category.
- This phase: brand Pages are **optional secondaries** (per adjudication), not ignored, but never primary.

### P8 — Confidence is non-authoritative

A high LLM confidence cannot override a deterministic incompatibility, missing evidence, or an ambiguous Page choice.

### P9 — Per-member outcome

Every cohort Page output must produce one of: `assigned` (valid primary + any valid secondaries); `needs_input` (no safe unique primary); `blocked` (missing/corrupt authority or contradiction). A single ambiguous member must not cause another member to inherit its Page.

### P10 — Review completion

**Given** an abstained, missing, stale, rejected, or unverified primary Page decision  
**When** review completion is requested  
**Then** the request is refused with a Page-specific reason. A reviewer correction may satisfy the gate only when it resolves to a current verified Page ID.

### P11 — Promotion defense in depth

Promotion must recompute Page currentness and refuse the item before writing product drafts, `product_pages`, or `ProductOnPages` when the accepted primary Page is no longer valid.

### P12 — Legacy parity

The legacy/rollback path must not use hard-coded name-only Page suggestions as acceptance authority. It must either use the same correctness validator or abstain.

---

# 12. Requirements-phase artifacts

No source files should be changed until the following are approved.

## Proposed new planning files

- `specs/epics/e09-family-title-page-correctness/epic.yaml`
- `specs/epics/e09-family-title-page-correctness/e09s01-requirements.md`
- `specs/epics/e09-family-title-page-correctness/e09s01-tasks.yaml`
- `specs/epics/e09-family-title-page-correctness/e09s02-implementation.md`
- `specs/epics/e09-family-title-page-correctness/e09s02-tasks.yaml`
- `specs/epics/e09-family-title-page-correctness/e09s03-validation.md`
- `specs/epics/e09-family-title-page-correctness/e09s03-tasks.yaml`

## Proposed attested evaluation artifacts

- `src/tests/fixtures/family-title-page-goldset-v2.json`
- `specs/metrics/family-title-page-eval-v1.json`

The gold set must: come from a read-only export of the affected real batch or a verified backup clone; include all known failing families and wrong-Page cases (export all known bad per adjudication); retain frozen evidence/snapshot hashes; use stable expected Page IDs and active Page import hash, not Page names alone; record reviewer, review timestamp, and adjudication rationale; split train/test/holdout by whole family, never by SKU; clearly label synthetic scenarios separately from production-attested examples.

---

# 13. Phased delivery plan

## Phase A — Requirements and adjudication

### Work items

1. Export all known title inconsistencies and Page misapplications from a verified backup/read-only clone (incident census: all known bad).
2. Store Manager (You) marks: approved family skeleton (**Brand → Line → Form → Flavor → Size**), required/optional variant tokens (Soft/Hard/Classic/Hypo always visible), correct primary Page ID(s) — co-primary for evidenced dual-species — allowed secondary Page IDs (brand landing optional secondary), reason for each decision; ambiguous Pages get manual selection from verified IDs.
3. Freeze and hash the gold set (by whole family).
4. Approve the Given/When/Then requirements before implementation starts.

### Acceptance

- No implementation files changed.
- Every known incident is represented in the gold set.
- Every member has a reviewed expected title contract and primary Page ID(s).
- Synthetic fixtures are not presented as production proof.
- Page cardinality (single vs evidenced co-primary) and title style are explicitly signed off per adjudication above.

---

## Phase B — Implementation

One sequential writer; TDD before integration.

### B1 — Pure family title contract

**Recommended new file:** `src/classification/family-title-consistency.ts`

**Expected existing files:** `src/onboarding/cohort-name-coordinator.ts`, `src/onboarding/title-prompt-template.ts`, `src/onboarding/cohort-title-coordinator.ts`, `src/onboarding/cohort-title-hash.ts`, `src/classification/cohort-semantic-validator.ts`, `src/classification/model-operation-registry.ts`, `src/shared/schemas/cohorts.ts`, `src/shared/schemas/onboarding.ts`

**Acceptance:** Pure validator consumes frozen member facts and candidate titles. Invalid candidate or fallback sets produce zero durable title rows. New prompt/rule versions invalidate reuse safely. Existing `product-family-v1` partitions remain unchanged.

### B2 — Pure Category Page correctness contract

**Recommended new file:** `src/classification/category-page-correctness.ts`

**Expected existing files:** `src/classification/cohort-page-coordinator.ts`, `src/onboarding/cohort-page-coordinator.ts`, `src/onboarding/cohort-page-hash.ts`, `src/classification/page-assignment-llm.ts`, `src/classification/curation-target-processor.ts`, `src/classification/stages/category-page-proposals.ts`, `src/classification/species-guard.ts`, `src/classification/cohort-semantic-validator.ts`, `src/classification/model-operation-registry.ts`, `src/shared/schemas/cohorts.ts`

**Acceptance:** Existing-ID-but-wrong-category cases fail. Brand Pages cannot replace the primary category. Assigned output identifies a verified primary Page. Ambiguity becomes needs-input rather than a guessed Page. No retrieval/embeddings/reranking activation or new Product Type Profile is introduced. Dual-species co-primary only when evidenced.

### B3 — Review and promotion gates

**Files:** `src/onboarding/cohort-curator.ts`, `src/onboarding/product-curator.ts`, `src/classification/review-completion-gate.ts`, `src/classification/promotion-gate.ts`, `src/onboarding/draft-promoter.ts`, `src/client/components/onboarding/review/ReviewClassificationPanel.tsx` only if a minimal existing Review message is needed

**Acceptance:** Review cannot complete without valid family-title status and an accepted primary Page. Promotion remains a final stable-ID/current-import gate. Legacy name-only heuristic output cannot satisfy Page acceptance. No new filters, boards, drawers, or QoL navigation work is added. New revisions only—existing `completed` cohorts not re-run.

### Migration boundary

No schema migration is expected: diagnostics may use existing output/curation JSON. If implementation requires altering write-once table semantics or adding Page taxonomy metadata, stop and write a separate ADR before proceeding.

---

## Phase C — Validation and controlled rollout

### Test files to add or update

**New:** `src/tests/unit/family-title-consistency.test.ts`, `src/tests/unit/category-page-correctness.test.ts`, `src/tests/unit/family-title-page-goldset.test.ts`

**Update:** `src/tests/unit/cohort-name-coordinator.test.ts`, `src/tests/unit/cohort-title-coordinator.test.ts`, `src/tests/unit/cohort-page-coordinator.test.ts`, `src/tests/unit/cohort-page-prompt.test.ts`, `src/tests/unit/cohort-semantic-validator.test.ts`, `src/tests/unit/category-page-proposals.test.ts`, `src/tests/unit/classification-pipeline.test.ts`, `src/tests/unit/draft-promoter.test.ts`, `src/tests/unit/promotion-gate.test.ts`, `src/tests/unit/pr7-acceptance.test.ts`, `src/tests/unit/pr8-acceptance.test.ts`, `src/tests/unit/pr9-acceptance.test.ts`, `src/tests/unit/pr10-acceptance.test.ts`, `src/tests/unit/pr13-acceptance.test.ts`

### Required assertions

- Valid title variants differ only in approved variant slots with skeleton `Brand → Line → Form → Flavor → Size`.
- Inconsistent slot order, brand rendering, missing Soft/Hard/Classic/Hypo, leakage, and invention fail.
- Invalid title set writes no partial outputs.
- Existing-ID wrong-category, same-species wrong-category (chew vs jerky), generic-over-specific, wrong brand Page, missing primary, stale Page import, and name-only Page cases fail.
- Legitimate sibling Page differences and evidenced dual-species co-primary remain valid.
- Same frozen run replays without new model calls and produces the same canonical artifact.
- BetterBone/SZ/MINI/JUMBO/LGHARVEST grouping regressions remain green.
- No Page or title outcome depends on model confidence.

### Validation commands

```bash
bunx vitest run \
  src/tests/unit/product-line-grouper.test.ts \
  src/tests/unit/family-grouping-accuracy.test.ts \
  src/tests/unit/cohort-name-coordinator.test.ts \
  src/tests/unit/cohort-title-coordinator.test.ts \
  src/tests/unit/cohort-page-coordinator.test.ts \
  src/tests/unit/cohort-page-prompt.test.ts \
  src/tests/unit/cohort-semantic-validator.test.ts \
  src/tests/unit/family-title-consistency.test.ts \
  src/tests/unit/category-page-correctness.test.ts \
  src/tests/unit/family-title-page-goldset.test.ts
```

```bash
bun run typecheck
bun run test
bun run lint
bash scripts/validate-specs-yaml.sh
```

Run replay and affected-batch validation against a backup clone first. No live re-run occurs without approval and a verified SQLite backup. New revisions only — no automatic backfill of completed cohorts.

---

# 14. Explicitly out of scope

- Extraction behavior, profiles, selectors, OCR, distributor materialization, or source acquisition.
- `product-family-v1` grouping changes or `product-family-v2`.
- Product Type redesign, Product Type Profiles, Attribute Profiles, or taxonomy expansion.
- Attributes, descriptions, keywords, weights, images, claims, or other curated fields.
- Retrieval, embeddings, reranking, calibration, or ML feature activation.
- New Page taxonomy/profile authoring unless separately approved after requirements prove existing inputs insufficient.
- QoL filters, bulk filter controls, navigation redesign, dashboard work, or unrelated Review UI cleanup.
- Automatic approval, publication, ShopSite sync, or catalog repair.
- Mutation of existing write-once outputs.
- Live database writes during requirements and offline validation.
- Any staging or commit outside the sanctioned `storage/catalog/store/classification/**` path; no catalog commit is currently planned.

---

# 15. Dependencies and assumptions

1. Extraction data is correct and is treated as immutable frozen input.
2. Existing Page import identity and hierarchy are accurate.
3. `product-family-v1` membership is accepted for this phase.
4. Existing cohort freeze, lease, write-once output, supersession, and promotion-currentness machinery remains intact.
5. Store Manager adjudication is available for ambiguous title style and expected Page labels.
6. Existing frozen evidence contains enough product meaning to distinguish the expected Pages. If it does not, implementation stops rather than silently introducing broader field classification — manual selection from verified IDs is allowed per adjudication.
7. Dirty worktree state must be preserved. One sequential writer performs implementation.
8. No network, crawl, model download, or paid service is needed for requirements or deterministic validation.

---

# 16. Risks

- Wrong family membership; harmonization could damage unrelated products. Family semantic conflict must block rather than rewrite.
- Over-normalization; meaningful modifiers such as Soft, Hard, Classic, or Hypoallergenic could be dropped — always-visible rule mitigates but requires strict required-token fidelity gate.
- Under-specified Page taxonomy; Page ID/name/parent alone may not encode “toy versus treat” distinctions.
- Gold-set bias; synthetic and very small fixtures can give false confidence.
- Write-once recovery cost; correcting a committed bad result requires a new cohort revision (new revisions only).
- Automation coverage pressure; demanding 100% automated assignment could increase wrong Pages. Required 100% applies at reviewed completion, not automatic coverage.
- Legacy divergence; rollback behavior remains unsafe unless brought under same contracts.
- Brand Page ambiguity; brand landing pages currently mix with category selection and may consume a result slot — now scoped as optional secondary only.

---

# 17. Open questions — RESOLVED 2026-08-22

All 10 original questions + 2 follow-ups are decided per the adjudication table in §1a. No further approval needed before Phase A export. Remaining implementation question: whether to export incident census now or await your explicit SKU list — decided as **export all known bad** from backup clone.

QoL filters should be planned only after these correctness requirements pass validation.
