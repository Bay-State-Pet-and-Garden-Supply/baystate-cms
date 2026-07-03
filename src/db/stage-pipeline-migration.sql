-- Stage Pipeline Migration
-- Replaces the flat onboarding_items.status field with stage + stage_status.
-- Also removes batch lifecycle status since batches no longer control the pipeline.

-- Step 1: Add new columns
ALTER TABLE onboarding_items ADD COLUMN stage TEXT NOT NULL DEFAULT 'discovery';
ALTER TABLE onboarding_items ADD COLUMN stage_status TEXT NOT NULL DEFAULT 'pending';

-- Step 2: Migrate existing data from status -> (stage, stage_status)
UPDATE onboarding_items SET stage = 'discovery',  stage_status = 'pending'     WHERE status = 'imported';
UPDATE onboarding_items SET stage = 'discovery',  stage_status = 'in_progress' WHERE status = 'discovering';
UPDATE onboarding_items SET stage = 'discovery',  stage_status = 'completed'   WHERE status IN ('source_found', 'source_confirmed');
UPDATE onboarding_items SET stage = 'extraction', stage_status = 'in_progress' WHERE status = 'extracting';
UPDATE onboarding_items SET stage = 'extraction', stage_status = 'completed'   WHERE status = 'extracted';
UPDATE onboarding_items SET stage = 'curation',   stage_status = 'in_progress' WHERE status = 'curating';
UPDATE onboarding_items SET stage = 'curation',   stage_status = 'completed'   WHERE status IN ('needs_review', 'curated');
UPDATE onboarding_items SET stage = 'review',     stage_status = 'completed'   WHERE status = 'ready';
UPDATE onboarding_items SET stage = 'promotion',  stage_status = 'completed'   WHERE status = 'promoted';

-- Step 3: Handle failed/skipped — infer actual stage from available evidence
-- For items that failed during extraction, they likely had a source_url
UPDATE onboarding_items SET stage = 'discovery',  stage_status = 'failed' WHERE status = 'failed' AND source_url IS NULL AND extraction_data_json IS NULL;
UPDATE onboarding_items SET stage = 'extraction', stage_status = 'failed' WHERE status = 'failed' AND source_url IS NOT NULL AND extraction_data_json IS NULL;
UPDATE onboarding_items SET stage = 'curation',   stage_status = 'failed' WHERE status = 'failed' AND extraction_data_json IS NOT NULL AND curation_data_json IS NULL;
UPDATE onboarding_items SET stage = 'review',     stage_status = 'failed' WHERE status = 'failed' AND curation_data_json IS NOT NULL;

-- For items that were skipped, infer stage from available evidence
UPDATE onboarding_items SET stage = 'discovery',  stage_status = 'skipped' WHERE status = 'skipped' AND source_url IS NULL AND extraction_data_json IS NULL;
UPDATE onboarding_items SET stage = 'extraction', stage_status = 'skipped' WHERE status = 'skipped' AND source_url IS NOT NULL AND extraction_data_json IS NULL;
UPDATE onboarding_items SET stage = 'curation',   stage_status = 'skipped' WHERE status = 'skipped' AND extraction_data_json IS NOT NULL;

-- Step 4: Normalize batch statuses — batches no longer control pipeline lifecycle
-- Map legacy batch statuses to the minimal active/archived set
UPDATE onboarding_batches SET status = 'active'   WHERE status IN ('imported', 'discovering', 'source_found', 'source_confirmed', 'extracting', 'extracted', 'curating', 'curated', 'needs_review', 'ready');
UPDATE onboarding_batches SET status = 'archived' WHERE status IN ('completed', 'promoted');
-- Any remaining statuses (e.g. 'failed') go to active so items can be retried
UPDATE onboarding_batches SET status = 'active'   WHERE status NOT IN ('active', 'archived');

-- Step 5: Create an index on the new columns for worker polling
CREATE INDEX IF NOT EXISTS idx_onboarding_items_stage_status ON onboarding_items(stage, stage_status);

-- Step 6: Drop old status column (we no longer need it)
-- Leaving the old 'status' column for now — can be dropped in a follow-up migration
-- once all code paths use stage + stage_status.
