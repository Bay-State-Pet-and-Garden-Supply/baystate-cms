# Cohort Curation v2 — Shadow Rollout Runbook

**Epic #30 cohort-centric, type-first curation (issues #30, PR1–PR13).** How to
observe family grouping and cohort Execution Product Type resolution, then
operate the cohort-active default.

## Current default (post-#30 rollout)

After shadow validation (PR12) the system defaults to **cohort-active** for new
batches (issue #30 rollout commitment):

```
BAYSTATE_CMS_COHORT_CURATION_V2=true  (default)
BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY=false  (default)
```

- Curation is **cohort-claimed EXCLUSIVELY**: the per-item Curation claim
  path stops; ownership flows `refreshCandidateCohorts → reconcile →
  claimReadyCurationCohorts → processCohort`.
- The parent op runs `ensureCohortTitlesCoordinated` — ONE consistent title set
  per multi-item family, written to `classification_cohort_outputs`
  (write-once; drift fails closed with `CohortTitleAuthorityDriftError` — a bad
  title set is NEVER silently replaced; re-run the cohort revision instead).
- Members consume the coordinated titles via the `preComputedTitle` seam.

Byte-identical legacy per-item Curation remains available via explicit flag OFF
for rollback — see Rollback below.

## What shadow mode does (opt-in observation)

Set explicitly to re-enable observation without cohort claiming:

```
BAYSTATE_CMS_COHORT_CURATION_V2=true
BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY=true
```

- **Per-item Curation is unchanged** (byte-identical legacy path): every item is
  still curated individually through `product-curator.ts`.
- The worker's curation poll additionally runs the **deterministic-only** cohort
  Execution Product Type resolver (`observeCohortTypeShadow` /
  `observeCohortShadowTypeResolution`) over every **ready, non-superseded**
  cohort, then persists **one `cohort_shadow_observations` row per cohort per
  state CHANGE** (the repo dedupes against the latest row for the cohort, so a
  re-poll of an unchanged world writes nothing).
- **No cohort runs are claimed**, no `classification_cohort_runs` /
  `classification_cohort_outputs` rows are created, no model calls are made,
  and no coordinated titles are written. The parent title coordinator
  (`ensureCohortTitlesCoordinated`) only runs in ACTIVE mode.

Shadow mode is now opt-in. New batches no longer require an operator flag flip
to get cohort-active behavior.

## Checking the observations

After a shadow-enabled batch has been processed, against the live DB:

```sql
SELECT observed_at, group_key, status, member_count, outcome, execution_type_id, grouping_version
FROM cohort_shadow_observations
WHERE workspace_id = (SELECT id FROM workspaces LIMIT 1)
ORDER BY observed_at DESC
LIMIT 50;
```

**Does family grouping look right?** The `group_key` column is
`<normalized-brand>::<normalized-name-stem>`. Siblings that should be ONE family
must share one `group_key`. Known failure shapes (now fixed by the grouping
normalization round): attached size tokens (`md vnsnlg` vs `md vnsnsm`), brand
splits (`betterbone::` vs `no-brand::` for the same stem), and typos
(`vegggie` vs `veggie`). Any family still split across two `group_key`s in the
shadow rows is a grouping defect to fix before active mode.

**Which cohorts would coordinate titles?** Any cohort row with `member_count > 1`
is a multi-item family that, in active mode, would go through the parent title
coordinator. `member_count = 1` cohorts are singletons and are never coordinated
(DECISION-O). `outcome` shows the deterministic type resolution:
`coherent` / `coherent_with_abstentions` / `conflicted` / `abstained` — a
`conflicted` or `abstained` family would block or abstain in active mode too, so
those need human attention regardless.

## Flipping to active mode (legacy path)

Active was previously opt-in via:

```
BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY=false
```

This is now the default. New deployments without explicit env overrides
automatically run cohort-active. To force a batch back to legacy per-item with
observation, set the shadow pair above.

## Rollback

Set both flags false (or remove them and set `BAYSTATE_CMS_COHORT_CURATION_V2=false`
explicitly) and restart the worker: the byte-identical legacy per-item path resumes.

```
BAYSTATE_CMS_COHORT_CURATION_V2=false
BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY=true
# or simply BAYSTATE_CMS_COHORT_CURATION_V2=false (shadow flag irrelevant when OFF)
```

Shadow observation rows are harmless history — no cleanup required.

## Legacy cleanup

PR12 left the per-item curation claim and the transient family-barrier
(`holdWaitingFamilyMembers`) behind flags for rollback. After a confidence period
of default-on operation, those paths are candidates for deletion. Tracked as
follow-up — not required to close #30's rollout gate, which is satisfied by
measurable default-on operation with a reversible kill switch.
