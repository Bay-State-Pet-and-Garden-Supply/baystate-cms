# Classification quality review — first live batch (NEWFORNICK081226)

We need your analysis of why our classification results are so off, and a prioritized
recommendation. We already fixed a few things this round (committed); the remaining
questions are about naming/family coordination and taxonomy.

## System context (Baystate CMS, onboarding pipeline)

- Batch spreadsheet (distributor export, 148 items) → Sourcing → Discovery → Extraction
  → **Curation** → Review (human) → Promotion (ShopSite product drafts).
- Curation has TWO architectures:
  - **Per-item path** (`src/onboarding/product-curator.ts` → modular pipeline): each item
    independently runs name-consolidation + product-type/attribute/category stages.
    This is what ran for the entire live batch.
  - **Cohort v2 path** (`src/onboarding/cohort-curator.ts`, issue #30): forms product
    families (`curation_cohorts`, grouping_version `product-family-v1`), and a parent
    `processCohort` op runs a durable **title coordinator**
    (`src/onboarding/cohort-title-coordinator.ts`) that produces ONE consistent title
    set per family. Gated by env `BAYSTATE_CMS_COHORT_CURATION_V2` — **NOT SET in the
    live .env, so the coordinator NEVER ran**. `classification_cohort_runs` and
    `classification_cohort_outputs` are both empty (0 rows) in the live DB.
- Family grouping (`src/db/repositories/curation-cohort-repo.ts:181-184`):
  `groupKey = normalizeBrand(item.brandHint) || 'no-brand' :: extractNameStem(item.name)`.
  Stemmer (`src/onboarding/product-line-grouper.ts`): strips standalone size adjectives
  (small/medium/large/sm/lg/md/...), weight patterns, flavor words (chicken/beef/...),
  attached `SM5CT`-style tokens, trailing colors. NOT typo-tolerant.
- Per-item title sources (live titleSource distribution of 66 curated items):
  `web` 45 (VERBATIM web-page titles, no casing normalization), `cohort_fallback` 16
  (title-cased distributor name fallback), `llm_cohort` 5 (legacy LLM family
  coordination). 82 items not yet curated (still earlier stages).
- Review UI: proposal accept/reject drawer (we just made it readable).

## Live-batch evidence (66 curated items in Review)

### 1. Family fragmentation (user's exact complaint)
"BetterBone Medium Venison Chew Dog Toy **Large**" and "... **Small**" should be one
family; instead they're separate products with separate names. Cohort stems:
- `better bone vnsnlg` (from "BETTER BONE MD VNSNLG") vs `better bone vnsnsm`
  (from "BETTER BONE MD VNSNSM") — the attached size token (`lg`/`sm` glued to the
  flavor abbreviation `vnsn`) lands IN the stem. Standalone "SM"/"LG" are stripped,
  attached ones are not. The venison abbreviation `vnsn` is also not in FLAVOR_WORDS.
- `betterbone::better bone hard vnsn` vs `no-brand::better bone hard vnsn` — the SAME
  line split because one item's `brandHint` resolved to "BetterBone" and the sibling's
  was empty (→ 'no-brand'). The brand is clearly embedded in the raw names
  ("BETTER BONE HARD VNSN SM") but grouping never falls back to name-embedded brands.
- `better bone soft classic veggie` vs `better bone soft classic vegggie` — the source
  spreadsheet contains a typo ("VEGGGIE"); no typo tolerance, so two families.
- Result: ~20 cohort rows for one brand, half `superseded` — regrouping churn as items
  flow through stages, plus permanently split families.

### 2. Inconsistent names within the same line
- "BetterBone Medium Venison **Chew Dog Toy** Large" (web-derived suffix present)
- "Better Bone Hard Beef Large" (no suffix)
- "BetterBone Soft Classic Veggie **Hypoallergenic** Chew Dog Toy Large"
- Brand token spelled "BetterBone" vs "Better Bone".
These all come from the same distributor brand; per-item curation picked whatever source
(title vs web vs LLM) was available per item with no family-level consistency.

### 3. Casing
31 of 66 curated titles are ALL-CAPS verbatim web titles, e.g.:
"PETARMOR EXTEND FLEA AND TICK COLLAR FOR CATS", "WELLNESS CAT COMPLETE HEALTH GRILLED
SALMON AND CHICKEN ENTREE C..." (source 'web'). Distributor-name fallbacks ARE
title-cased ("Better Bone Hard Beef Large"). No title-casing step on web titles.

### 4. Product type quality
- ALL 66 primary_product_type proposals have EMPTY `matchedWords` — the deterministic
  keyword matcher NEVER fires because evidence text is distributor abbreviations
  ("BUTCHERS PUP FRZN DINNER CHKN 3LB") with no token overlap against labels like
  "Wet Dog Food". Every pick comes from the LLM ranker (local qwen2.5vl).
- 11 of 66 at the 0.35 confidence floor, including clear misses: frozen **Quail Eggs**
  → "Poultry Feed" (it's a dog treat), a beehive frame feeder → "Poultry Feed".
- **Taxonomy gap**: 72 product types, NONE for beekeeping ("Bee"/"Apiary" → nothing);
  the store sells Little Giant beekeeping supplies, so those items CANNOT be right.
- (Fixed this round, committed: LLM picks below 0.5 confidence now abstain instead of
  proposing; the stage emits a reviewable abstention with a reason.)

### 5. Attribute proposals (fixed this round, committed)
All 132 field_assignment proposals (2 per item: brand + product-type) had the FULL
product title/description as their value — the freeText path fell back to the whole
evidence packet when no field-grounded evidence existed. Now values must be grounded in
the target's own evidence (attribute id or matching source_field) or the target
abstains. Live evidence DOES carry brand values ("LITTLE GIANT", source_field='brand'),
so grounding recovers them.

### 6. Weight (minor)
curatedWeight values in curation_data are raw: 5, 0.53, 0.31, 0.19, 7, 6.73, 3.5, 24…
The operator rule is: structured weight ALWAYS pounds, exactly 2 decimals (a
normalization layer exists at promotion/materialization, Phases 1-3 of a prior round,
but curation_data itself holds raw values).

## Questions

1. Priority order for the remaining fixes — what do we do first, and what's the
   highest-leverage single change for "names that look like one product line"?
2. Is enabling cohort curation v2 (`BAYSTATE_CMS_COHORT_CURATION_V2`) the right move
   for the NEXT batch, with a shadow-mode step first? Any rollout risks (the title
   coordinator is write-once with drift fail-closed)?
3. Family grouping: for attached size tokens ("md vnsnlg"), name-embedded brand
   fallback when brandHint is empty, and typo tolerance ("vegggie") — which are safe
   deterministic changes vs. needing LLM assistance? Any tokenization tricks for
   abbreviation-heavy distributor names (VNSN=venison, CHKN=chicken, TRKY=turkey)?
4. Title casing: should ALL sources (web included) go through a title-casing step in
   name-consolidation? Risks for brand names ("Purina ONE", "xMiles")?
5. Taxonomy: add Bee/Apiary product types now? How should taxonomy evolution work —
   config-only, or should the ranker signal "no good option" (abstain) when the best
   match is weak, instead of picking a wrong-but-closest type?
6. Anything about the keyword matcher never firing on this evidence format — is that
   acceptable (LLM does the work) or should the evidence packet include the curated
   title for matching?

Please post the COMPLETE review as ONE final message: verdict, prioritized action plan
with effort/risk per item, and what to defer.
