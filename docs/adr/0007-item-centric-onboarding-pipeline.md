# Adopt item-centric pipeline with Kanban board for onboarding

The original onboarding pipeline was batch-driven: batches controlled the lifecycle, items passively followed, and advancing through stages required changing batch status. This was rigid — you couldn't selectively advance individual products without hacking the batch state. We replaced the flat `status` field with `stage` + `stage_status` on each item, giving every product an independent linear path through six declared stages (Sourcing → Discovery → Extraction → Curation → Review → Promotion). Advancement is always manual. The UI became a Kanban board with one column per stage, rendering one batch at a time. Batches became grouping containers with derived progress, not lifecycle controllers. The worker polls for items with `stage_status = 'pending'` regardless of batch membership and processes them within their current stage, but never auto-transitions between stages.

**Status**: accepted

**Considered Options**:
- Item-centric pipeline (chosen) — each item tracks its own stage independently
- Keep batch-orchestrated pipeline — batch status drives everything, items auto-follow
- Hybrid — items track stages but batches still control certain stages

The batch-orchestrated model was rejected because it forced all-or-nothing advancement: you couldn't advance a subset of items without hacking item statuses. The hybrid model added complexity without clear benefit.

**Consequences**:
- `onboarding_items.status` replaced by (stage, stage_status) pair
- `onboarding_batches.status` removed — progress is derived from items
- Worker no longer checks batch status, only item stage_status
- UI changes from a flat table to a Kanban board with stage columns
- Batch remains the view lens: the board shows one batch at a time

**Amendment (sourcing safety patch + engine, ADR 0014)**: The Sourcing stage is present in the state model and capability-gated: its distributor-evidence engine is now IMPLEMENTED (`src/onboarding/sourcing/`, ratified in `docs/adr/0014-multi-distributor-sourcing.md`) but remains gated by `BAYSTATE_CMS_SOURCING_ENABLED`, which defaults to OFF. While OFF: imports enter Discovery directly (never stranding at `sourcing/pending`), reset/retry on a Sourcing item performs an audited `fallback_to_discovery` operator-override transition, and the UI offers only "Continue to Official Site Discovery". When ON: the worker runs exact UPC/GTIN-first lookups (brand advisory only), reconciles identity-critical fields, persists durable generation-scoped evidence and conflicts, and routes adjacent-only (coherent evidence → `evidence_to_discovery`; no evidence / provider errors → audited fallback; hard conflicts → `sourcing/needs_input` until operator resolution). Direct Sourcing → Curation routing (legacy `bundle_to_curation`) is prohibited and unactionable everywhere; a structured-record fallback requires its own ADR. The capability may only default ON after the rollout gates in `docs/runbooks/sourcing-engine-rollout.md`.
