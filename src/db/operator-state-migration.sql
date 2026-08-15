-- Operator Work-State Migration (epic #46, Phases 1/7/8)
--
-- Durable human review/approval state, independent of the pipeline stage.
-- The work-state projection (`src/onboarding/onboarding-work-state.ts`)
-- derives `reviewState` from this table, and bulk approval writes here.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS — safe to re-run.

CREATE TABLE IF NOT EXISTS onboarding_review_state (
  item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  -- Durable human review record (written on review-complete).
  reviewed_at TEXT,
  reviewed_by TEXT,
  -- A consequential edit (name/source/price/extraction/curation) after a
  -- review invalidates the review: the item must be re-reviewed and is never
  -- bulk-approvable while invalidated.
  review_invalidated_at TEXT,
  review_invalidation_reason TEXT,
  -- Bulk approval release decision (epic #46 Phase 7). Approval does NOT
  -- imply export: promoted drafts / export remain separate actions.
  approved_at TEXT,
  approved_by TEXT,
  approval_origin TEXT NOT NULL DEFAULT 'bulk',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onboarding_review_state_batch
  ON onboarding_review_state(batch_id);

-- Index for the "ready to export / exported" projection joins: look up
-- change-set rows by onboarding SKU. The change-set items table already has
-- an index on sku in schema.sql (idx_change_set_items_sku); this is a
-- convenience index for the reverse join by change-set status.
CREATE INDEX IF NOT EXISTS idx_change_set_items_sku
  ON change_set_items(sku);
