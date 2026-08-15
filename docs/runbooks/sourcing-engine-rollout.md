# Sourcing Engine Rollout Runbook (ADR 0014 + Amendment A)

How the Multi-Distributor Sourcing engine behaves and how to enable it safely.
**The capability is DEFAULT ON** (Amendment A): a missing
`BAYSTATE_CMS_SOURCING_ENABLED` means enabled with mode `automatic`. Every
existing installation MUST pin `BAYSTATE_CMS_SOURCING_ENABLED=false` before
upgrading (see the rollout sequence); the env flag is the outer kill gate.

## Quick reference

| Action | Command / location |
|---|---|
| Kill switch (OFF) | `BAYSTATE_CMS_SOURCING_ENABLED=false` + restart |
| Mode | `BAYSTATE_CMS_SOURCING_MODE=observe\|manual\|automatic` (default `automatic`) |
| Capability status | `GET /api/onboarding/capabilities` → `sourcing.{engineEnabled, mode, configurationReason, entryPolicyVersion}` |
| Connections UI | Settings → **Distributors** tab |
| Conflicts / manual hold UI | Item drawer → Sourcing stage |
| Distributor extraction fallback | Item drawer → Extraction stage → **Continue with Official Site Discovery** |

### Flag parsing (fail-closed)

The flag is re-read from the environment per call.

| Input | Effective state | `configurationReason` |
|---|---|---|
| env key absent | enabled, mode `automatic` | `default_on` |
| `true` / `1` / `yes` (trimmed, case-insensitive) | enabled | `env_enabled` |
| `false` / `0` / `no` (trimmed, case-insensitive) | disabled (kill switch) | `env_disabled` |
| empty / whitespace / unparseable | disabled | `malformed_config` |
| enabled but mode empty/whitespace/invalid | disabled | `invalid_mode` |
| in-memory runtime override in effect | per override | `override` |

`BAYSTATE_CMS_SOURCING_MODE` accepts `observe`, `manual`, or `automatic`;
absent defaults to `automatic`; empty/whitespace/invalid modes fail closed
(effective disabled, `invalid_mode`). Runtime overrides pass the same
validation — they can never manufacture a valid mode. Reason codes are stable
and non-secret (they expose no credentials or connection details).

## What the engine does

- **Entry policy.** New imports derive their entry stage from the effective
  capability: `manual`/`automatic` → **Sourcing**; `observe`, disabled, or
  malformed → **Discovery**. Import call sites write
  `sourcing_entry_policy_version = 1` (the current
  `SOURCING_ENTRY_POLICY_VERSION`); rows without the marker (version `0`,
  including the 148 legacy rows) are NEVER claimed or observed and stay on the
  audited **Continue to Official Site Discovery** path.
- **Lookup.** The worker runs the provider-neutral engine against every
  **enabled** connection in the workspace (Phase 1: Phillips REST
  `x-api-key`, BCI/OrderCloud OAuth2; Phase 2: Orgill/PFX SFTP — not yet
  approved). Lookups are **exact normalized UPC/GTIN first**; brand hints and
  brand profiles are advisory only. All enabled connections are queried per
  generation — the worker never stops at the first found record. The item is
  bounded to a 60-second budget and per-attempt `duration_ms` is persisted.
- **Evidence.** Attempts are immutable and generation-scoped
  (`sourcing_generations`); a retry **supersedes** the generation and starts a
  fresh one. Superseded evidence stays visible as history and can never
  influence decisions. Hard identity conflicts (upc/gtin/MPN/weight/size/
  count/packCount/brand, plus variant axes incl. flavor/formula and
  connector-declared axes) persist durably per generation.
- **Qualification.** A distributor record qualifies for Discovery-skip ONLY
  through the deterministic projection authority
  (`distributor-record-projection.ts`): exact normalized identifier equality,
  current-generation accepted evidence, a nonblank product name, complete
  provenance (connection, catalog version, observation time, generation,
  accepted attempts), and no open hard conflict. Confidence never grants
  acceptance. Unknown/undeclared variant axes make a record insufficient
  rather than silently soft.

### Routes (normative table)

| Condition | Route | Target |
|---|---|---|
| Kill switch OFF; new import | no decision | `discovery/pending` |
| Marker-v0 row; operator continues | `fallback_to_discovery` | `discovery/pending` |
| No usable UPC / no enabled connection | `fallback_to_discovery` | `discovery/pending` |
| All providers `not_stocked` | `fallback_to_discovery` | `discovery/pending` |
| Provider errors, no qualified record | `degraded_fallback_to_discovery` | `discovery/pending` |
| Accepted evidence below the qualification floor | `evidence_to_discovery` | `discovery/pending` |
| ≥1 qualified record, no hard conflict | `distributor_record_to_extraction` | `extraction/pending` |
| Qualified record + other provider errors | `distributor_record_to_extraction` + warnings | `extraction/pending` |
| Any hard identity/variant conflict | `needs_input_conflict` | `sourcing/needs_input` |
| Final operator resolution yields a qualified projection | `distributor_record_to_extraction` | `extraction/pending` |
| Final resolution leaves no qualified projection | `evidence_to_discovery` / `fallback_to_discovery` | `discovery/pending` |
| Explicit bounded retry | `retry_provider_errors` | `sourcing/pending` |
| Distributor materialization integrity failure | stable materialization code | `extraction/failed` |

`bundle_to_curation` is prohibited and unactionable everywhere; no helper,
schema, API, or UI can create or act on a Sourcing → Curation route.

### Modes (implemented, `BAYSTATE_CMS_SOURCING_MODE`)

| Mode | Mutation boundary | Operator surface |
|---|---|---|
| `observe` | Writes ONLY a sourcing generation + evidence attempts (with `duration_ms`). ZERO decisions, acceptances, conflicts, transitions, or extraction rows. Observation failures never fail Discovery. | None new; items continue through official Discovery. |
| `manual` | The worker persists current-generation acceptances and holds every non-conflict outcome at `sourcing/needs_input` with a server-derived qualification view. | Drawer shows the qualification view + **Use distributor record** (`POST /onboarding/items/:id/resolve-sourcing { action: "use_distributor_record" }`) and **Continue to Official Site Discovery**. The server recomputes qualification; client-supplied ids/hash/providers are ignored. |
| `automatic` | Full route table applied by the worker. | Conflict resolution UI (Use candidate / Custom value / Dismiss) for hard conflicts; conflicts always stay manual. |

Manual/observe do not apply to marker-v0 rows: legacy items expose only
**Continue to Official Site Discovery** (no Retry, no Use-distributor-record).

### Distributor-record Extraction (identity-only materializer)

When a qualified record routes to Extraction, the item's source type becomes
`distributor_record` with `source_url = NULL` (never a fake URL), and the
worker calls the materializer (`distributor-record-materializer.ts`) inside a
transaction that rechecks workspace ownership, stage, the strict V2 decision,
current non-superseded generation, relational acceptance equality, full
attempt schema validity, connection ownership, open conflicts, and a
recomputed canonical projection hash equal to the decision hash. The
materialized `ExtractionData` carries ONLY identity fields: title, noncanonical
brand, weight, distributor SKU, manufacturer part number, and whitelisted
variant attributes — with a dedicated `distributorRecordProvenance`
(generation, evidence hash, sorted accepted attempt/provider ids, catalog
versions). Description, bullets, price, images, and OCR fields stay empty;
confidence is zero and non-authoritative. NO fetch, extractor profile, DOM
scrape, OCR, VLM, LLM, or image processing ever runs in the distributor branch.

Integrity failures fail closed with a stable reason and mark the item
`extraction/failed` with zero partial writes; they are never blindly retried
as official extraction. Stable materialization error codes:

```
distributor_materialization:not_owned            distributor_materialization:wrong_stage
distributor_materialization:wrong_decision       distributor_materialization:malformed_decision
distributor_materialization:internal_error       distributor_materialization:stale_generation
distributor_materialization:superseded_generation
distributor_materialization:acceptance_mismatch  distributor_materialization:invalid_attempt
distributor_materialization:open_conflict        distributor_materialization:hash_mismatch
distributor_materialization:already_completed    distributor_materialization:stored_payload_diverged
```

Operators can leave the distributor path at any time via
**Continue with Official Site Discovery**
(`POST /onboarding/items/:id/continue-with-official-discovery`): one guarded
transaction sets source type back to `official_page`, keeps the URL null,
clears the active item extraction payload, moves the item to
`discovery/pending`, and records an audited operator-override decision.
Generations, attempts, conflicts, acceptances, and prior extraction audit rows
are preserved. Later-stage items must use the existing reviewed send-back
flow; there is no post-Review history rewrite.

### Images (PI-6 boundary)

Raw distributor evidence URLs — including accepted/current ones — contribute
ZERO downloads. The promotion boundary never appends raw attempt images and
the distributor downloader arguments are always empty, so no raw URL reaches
`downloadAndProcessImages`. A durable PI-6 `commerceApproved` asset is the
sole path for distributor imagery to enter commerce; official extracted images
and the verified Product Intelligence import gate are separate and unchanged.

### Provenance (cohorts/classification)

Cohort freezes write `execution-evidence-v2` members carrying item/extraction
source types, nullable URLs, the sourcing generation, sorted accepted
attempt/provider ids, and the distributor evidence hash; historical
`execution-evidence-v1` snapshots stay parse-only and normalize to official
provenance (never rewritten). Classification records distributor identity with
source `distributor_record`, a null classification URL, identity-only fields,
and per-field provenance — never labeled `official_product_page`, and never
elevating description/bullets/images/claims/composition. Mandatory Review
remains in the path, and promotion revalidates extraction provenance
(generation/hash/accepted ids) before drafting.

## Rollout and rollback sequence

1. **Pre-upgrade pin (mandatory for every existing installation).** Set
   `BAYSTATE_CMS_SOURCING_ENABLED=false`, restart, and verify capabilities
   report disabled with reason `env_disabled`. Inventory enabled connections;
   do not rely on the new missing-flag default during upgrade.
2. **Quiesce and verify backup.** Stop API/workers, checkpoint WAL through the
   existing approved procedure, verify free space, then use the existing
   SQLite backup verifier against the exact DB path. Example operator form
   (replace paths):
   ```bash
   bun run classification:integrity backup --db <absolute-app.db> --backup <absolute-timestamped-backup.db>
   ```
   Require a passing manifest/hash, `integrity_check`, protected-table
   counts/digests, source identity, and no WAL/SHM sidecar on the backup.
   Abort on any failure or source drift.
3. **Migrate while pinned OFF.** Start only the sanctioned migration path;
   verify `default_on_sourcing_schema_version` and
   `sourcing_variant_axes_schema_version` markers, columns, row counts,
   `foreign_key_check`, the policy-0 legacy count, and the disabled
   capability. Roll back from the verified backup rather than editing rows if
   migration fails.
4. **Configure disabled connections.** Create provider connections disabled,
   provision secret references server-side, run offline fixture/security
   tests, then perform the documented controlled health check. Enabling is a
   separate operator action.
5. **Observe one workspace/provider.** Set the flag true and mode `observe`;
   existing/new items continue through official Discovery. Collect at least
   100 labeled observations per connector (≥30 found; ≥20 negative/wrong-
   variant), error rate, duration p95, conflict/fallback accuracy, and
   credential/image incidents. Observe mode writes no item decision/source/
   acceptance/conflict/extraction changes by construction.
6. **Gate to manual.** Require all quantitative thresholds below. Set mode
   `manual` for fresh policy-v1 imports only; review every qualification and
   conflict and explicitly select Extraction or Discovery. Legacy policy-0
   rows remain Continue-to-Discovery.
7. **Automatic canary.** After manual evidence passes, set mode `automatic`
   for one workspace/provider for at least seven days and 100 real items.
   Review every item at the normal Review stage and compare route and
   materialization against labels.
8. **Broaden provider by provider.** Repeat gates independently. A passing
   connector never vouches for another connector or variant-axis map.
9. **Kill/incident action.** Set `BAYSTATE_CMS_SOURCING_ENABLED=false` and
   restart. Abort in-flight calls; do not delete evidence or rewrite
   completed/reviewed history. New imports go to Discovery. Inventory
   `sourcing/pending|in_progress|needs_input`, `extraction/pending|failed`
   distributor items, and reviewed distributor items; quarantine/Continue
   explicitly. Preserve attempts, generations, conflicts, decisions,
   extraction rows, and incident measurements.
10. **Rollback code/schema only from verified evidence.** Code rollback keeps
    the kill switch false. Schema/data rollback uses the verified backup and
    documented downtime; never ad hoc SQL, never a repair script over the 148
    rows, and never evidence deletion.

**Honest note:** the per-connector quantitative gates (100 labeled
observations, ≥30 found, ≥20 negative/wrong-variant, zero false accepts, ≤10%
source errors, p95 within the 60-second budget) and the seven-day/100-item
canary are OPERATOR-RUN measurements over the persisted data below — there is
no automatic gate engine in this build. Nothing is activated on model
self-reported confidence.

### Read-only observation queries (never write)

Run these against the offline backup or a read replica; they only SELECT.

```sql
-- Attempts + measured latency per provider (p95 source)
SELECT provider_id,
       COUNT(*) AS attempts,
       SUM(CASE WHEN outcome = 'found' THEN 1 ELSE 0 END) AS found,
       SUM(CASE WHEN outcome IN ('source_error','not_stocked') THEN 1 ELSE 0 END) AS negative,
       AVG(duration_ms) AS avg_ms
FROM onboarding_evidence_attempts
WHERE sourcing_generation_id IS NOT NULL
GROUP BY provider_id;

-- Wrong-variant / conflict accuracy candidates
SELECT i.id, i.upc, c.field, c.severity, c.status AS conflict_status, g.status AS generation_status
FROM onboarding_evidence_conflicts c
JOIN onboarding_items i ON i.id = c.item_id
JOIN sourcing_generations g ON g.id = c.sourcing_generation_id
WHERE g.status = 'completed';

-- Routes actually taken per batch
SELECT i.batch_id, i.id, i.stage, i.stage_status, i.sourcing_entry_policy_version
FROM onboarding_items i
WHERE i.sourcing_entry_policy_version = 1
ORDER BY i.created_at DESC LIMIT 500;

-- Distributor materialization outcomes
SELECT e.item_id, e.extraction_method, e.source_type, e.evidence_hash,
       e.sourcing_generation_id, e.accepted_evidence_attempt_ids_json
FROM onboarding_extractions e
WHERE e.source_type = 'distributor_record';

-- Image boundary audit: any distributor payload carrying image fields?
SELECT i.id, i.source_type
FROM onboarding_items i
WHERE i.source_type = 'distributor_record'
  AND i.extraction_data_json LIKE '%primaryImage%';
```

### Incident quarantine checklist

1. Set the kill switch OFF and restart (stop in-flight connector calls).
2. Inventory (queries above): stranded `sourcing/*`, distributor
   `extraction/pending|failed`, and reviewed distributor items.
3. Quarantine or explicitly Continue each inventory item — never bulk
   rewrite, never a repair script.
4. Preserve attempts, generations, conflicts, decisions, extraction rows, and
   incident measurements for post-incident review.
5. Confirm no raw distributor image entered any downloader/draft; if it did,
   quarantine the affected items and route through PI-6 review.
6. Record before/after capabilities (`configurationReason`) and reconnect
   only after the per-connector gates pass again.

## Existing rows (the stranded cohort)

- No automatic migration of historical `sourcing/pending` rows. The 148
  legacy rows carry `sourcing_entry_policy_version = 0` and are never
  claimed, observed, or backfilled by the worker.
- Operators use the bulk/single **Continue to Official Site Discovery** action
  (audited `fallback_to_discovery` operator-override decisions).
- The engine applies to **post-amendment imports only** (policy version 1).
  Retrofitting historical items requires a separately reviewed,
  backup-verified operator action.

## Boundaries (what the engine never does)

- No direct Sourcing → Curation routing (`bundle_to_curation` is unactionable
  everywhere); no new Pipeline Stage or Brand authority.
- No fake source URLs: distributor items keep `source_url = NULL`; a real
  distributor URL is evidence-only (`EvidenceAttempt.evidenceUrl`).
- Distributor materialization never emits description, bullets, marketing
  claims, price, inventory, images, arbitrary provider fields, or canonical
  Brand assignment.
- Distributor images are display-only until a PI-6 rights-and-identity
  verification pass approves them as `commerceApproved` assets.
- No commerce price/inventory authority (deferred); no live provider call
  during CI or migration; connections store only `secret_ref`.
- Evidence rows are audit records: never deleted automatically; `expires_at`
  governs cache reuse only.
- No historical-item backfill, live-DB repair, or automatic reprocessing of
  the 148 rows; no rewrite of persisted V1 cohort snapshots or historical
  `bundle_to_curation` decisions.
