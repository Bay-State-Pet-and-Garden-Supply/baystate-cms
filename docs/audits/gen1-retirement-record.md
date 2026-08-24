# Gen1 Retirement Record (P5 — classification roadmap)

**Date:** 2026-08-24 · **Executed by:** classification fleet (owner-directed, ahead of the
plan's "one full cycle on v4" prerequisite — route/table inventory makes the early timing safe)

## Inventory findings (verified at HEAD)

### 1. Legacy `product_types` / `product_type_fields` tables → ARCHIVED
- **Zero production consumers** outside `src/classification/legacy-migration.ts` (read-only
  source for the candidate-only bridge `POST /api/classification/migrate-legacy`, itself 403'd
  behind the taxonomy freeze).
- No routes ever served these tables; no repository writes them outside tests.
- Action taken: archive banner comments in `src/db/schema.sql`; tables **retained** (no DROP —
  history + migration source). Destructive drop is an explicit owner follow-up requiring its own
  migration + `db-migration.test.ts` coverage.

### 2. `field_registry` surface → RETAINED (not Gen1-superseded)
The plan assumed field-registry routes would be dead after P1. Inventory disproved this:
`field_registry` is the live **Catalog Field** observation store feeding:
- sync/normalizer registry observations (`sync-service.ts`)
- catalog/product routes, catalog-insight-service
- store-manager assistant/scope/preference/report/context services
- attestation projection (`store/field-registry.json`) with lazy repair
- the P1 Settings → Catalog Fields editor (`GET/PUT /api/field-registry*`)

CONTEXT.md's "Legacy Field Map" avoid-term refers to the old per-type mapping *model*
(`product_types`/`product_type_fields`), not to Catalog Fields themselves, which remain
first-class domain objects. Retiring these routes would break current product behavior.

### 3. Route removals
None required — no Gen1 HTTP surface exists to remove. Acceptance criterion
"all Gen1 HTTP surfaces return structured 404" is vacuously satisfied.

## Test impact
- `db-migration.test.ts`: schema change is comment-only; markers must not alter migrations.
- No suites removed or weakened.

## Follow-ups for owner
- Optional: destructive DROP migration for the two archived tables (needs backup verification).
- Revisit `field_metadata_service` curated-fields merge if a future release model absorbs
  display-label curation.
