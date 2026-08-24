-- pi-decommission-audit.sql — Phase 0 (PR 0.1) read-only audit queries.
--
-- Run against the workspace DB in READ-ONLY mode:
--   sqlite3 "file:storage/catalog/.shopsite-cms/app.db?mode=ro" < scripts/pi-decommission-audit.sql
--
-- Purpose: prove Product Intelligence (Agent Lab) data is inert and record
-- baseline row counts before the decommission phases (see
-- docs/plans/agent-lab-decommission-plan.md §Phase 0). Every query here is a
-- pure SELECT — no mutation of any kind.

.headers on
.mode column

-- ── 1. Run census ────────────────────────────────────────────────────────────
SELECT 'product_intelligence_runs' AS census, COUNT(*) AS n FROM product_intelligence_runs;

-- Runs by status, if the column exists (schema: migrations.ts ~line 2677)
SELECT status, COUNT(*) AS n FROM product_intelligence_runs GROUP BY status;

-- ── 2. Import census (total / active) ────────────────────────────────────────
SELECT 'product_intelligence_imports_total' AS census, COUNT(*) AS n FROM product_intelligence_imports;
SELECT 'product_intelligence_imports_active' AS census, COUNT(*) AS n
  FROM product_intelligence_imports WHERE status = 'active';

-- Imports joined to non-terminal onboarding items (promotion-gate exposure).
-- Non-terminal = not yet promoted/failed per onboarding_items.status.
SELECT i.status AS import_status, oi.status AS item_status, COUNT(*) AS n
  FROM product_intelligence_imports i
  JOIN onboarding_items oi ON oi.id = i.onboarding_item_id
 GROUP BY i.status, oi.status;

-- ── 3. Onboarding items holding PI evidence ──────────────────────────────────
SELECT 'onboarding_items_with_pi_evidence' AS census, COUNT(*) AS n
  FROM onboarding_items
 WHERE extraction_data_json LIKE '%productIntelligenceEvidence%';

SELECT oi.status, COUNT(*) AS n
  FROM onboarding_items oi
 WHERE oi.extraction_data_json LIKE '%productIntelligenceEvidence%'
 GROUP BY oi.status;

-- ── 4. Assets by declared source tier / extraction method ────────────────────
SELECT source_type AS origin, COUNT(*) AS n FROM product_intelligence_assets GROUP BY source_type;
SELECT rights_status, COUNT(*) AS n FROM product_intelligence_assets GROUP BY rights_status;
SELECT extraction_method, COUNT(*) AS n FROM product_intelligence_assets GROUP BY extraction_method;

-- ── 5. Policy decisions, events, tool_calls, sources, evidence ───────────────
SELECT 'product_intelligence_policy_decisions' AS census, COUNT(*) AS n FROM product_intelligence_policy_decisions;
SELECT 'product_intelligence_events' AS census, COUNT(*) AS n FROM product_intelligence_events;
SELECT 'product_intelligence_steps' AS census, COUNT(*) AS n FROM product_intelligence_steps;
SELECT 'product_intelligence_tool_calls' AS census, COUNT(*) AS n FROM product_intelligence_tool_calls;
SELECT 'product_intelligence_sources' AS census, COUNT(*) AS n FROM product_intelligence_sources;
SELECT 'product_intelligence_evidence' AS census, COUNT(*) AS n FROM product_intelligence_evidence;
SELECT 'product_intelligence_conflicts' AS census, COUNT(*) AS n FROM product_intelligence_conflicts;
SELECT 'product_intelligence_results' AS census, COUNT(*) AS n FROM product_intelligence_results;
SELECT 'product_intelligence_comparisons' AS census, COUNT(*) AS n FROM product_intelligence_comparisons;

-- ── 6. PI policy/retention/review side tables ────────────────────────────────
SELECT 'pi_approved_policies' AS census, COUNT(*) AS n FROM pi_approved_policies;
SELECT 'pi_budget_policies' AS census, COUNT(*) AS n FROM pi_budget_policies;
SELECT 'pi_evaluation_runs' AS census, COUNT(*) AS n FROM pi_evaluation_runs;
SELECT 'pi_image_candidates' AS census, COUNT(*) AS n FROM pi_image_candidates;
SELECT 'pi_page_artifacts' AS census, COUNT(*) AS n FROM pi_page_artifacts;
SELECT 'pi_retention_policies' AS census, COUNT(*) AS n FROM pi_retention_policies;
SELECT 'pi_reuse_policies' AS census, COUNT(*) AS n FROM pi_reuse_policies;
SELECT 'pi_review_decisions' AS census, COUNT(*) AS n FROM pi_review_decisions;
SELECT 'pi_source_authorities' AS census, COUNT(*) AS n FROM pi_source_authorities;

-- ── 7. Agent-training family tables (deleted with agent-training schema in P3)
SELECT 'agent_corrections' AS census, COUNT(*) AS n FROM agent_corrections;
SELECT 'agent_evaluation_cases' AS census, COUNT(*) AS n FROM agent_evaluation_cases;
SELECT 'agent_evaluation_snapshots' AS census, COUNT(*) AS n FROM agent_evaluation_snapshots;
SELECT 'agent_teaching_events' AS census, COUNT(*) AS n FROM agent_teaching_events;
SELECT 'agent_version_snapshots' AS census, COUNT(*) AS n FROM agent_version_snapshots;
SELECT 'agent_version_states' AS census, COUNT(*) AS n FROM agent_version_states;

-- ── 8. benchmark_* shared tables (classification program #14 co-owns these;
--       later phases must NOT drop them — counts recorded as a tamper check) ──
SELECT 'benchmark_datasets' AS census, COUNT(*) AS n FROM benchmark_datasets;
SELECT 'benchmark_eval_runs' AS census, COUNT(*) AS n FROM benchmark_eval_runs;
SELECT 'benchmark_examples' AS census, COUNT(*) AS n FROM benchmark_examples;
SELECT 'benchmark_prediction_bundles' AS census, COUNT(*) AS n FROM benchmark_prediction_bundles;
SELECT 'benchmark_qualification_receipts' AS census, COUNT(*) AS n FROM benchmark_qualification_receipts;
