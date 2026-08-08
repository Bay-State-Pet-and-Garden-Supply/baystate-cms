import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { loadClassificationConfig, saveClassificationConfig, loadRuntimeConfig, createRuntimeActivationContext } from '../../classification/config-loader';
import { migrateLegacyToClassificationConfig } from '../../classification/legacy-migration';
import { processRefreshQueue } from '../../classification/refresh-queue-processor';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import {
  applyCurationTargetsToConfig,
  listCurationTargetCandidates,
} from '../../classification/curation-targets';
import { getRun, getStageResults, getEvidenceByRun, getLiveDecisionsByRun, getProposalsByRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';

import { evaluateClassificationReadiness } from '../../classification/config-validation';
import { normalizeClassificationReadinessReport } from '../../classification/readiness';

const router = new Hono();

/**
 * GET /api/classification/readiness
 * Returns classification configuration readiness report for the active workspace.
 */
router.get('/classification/readiness', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    const activationContext = createRuntimeActivationContext(ws.workspacePath, ws.id);
    const readiness = evaluateClassificationReadiness(config, {
      mode: config.manifest?.schemaVersion === 2 ? 'active' : 'preview',
      catalogFields: activationContext.catalogFields,
      verifyCatalogEvidence: activationContext.verifyCatalogEvidence,
      verifiedPageIds: activationContext.verifiedPageIds,
    });
    return c.json({ readiness: normalizeClassificationReadinessReport(readiness) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/classification/config
 * Returns the current loaded classification configuration.
 */
router.get('/classification/config', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    return c.json({ config });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * PUT /api/classification/config
 * Updates the current classification configuration (attributes, mappings, etc.)
 */
router.put('/classification/config', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const body = await c.req.json();
    const config = body.config;
    if (!config) {
      return c.json({ error: 'Missing configuration payload' }, 400);
    }

    saveClassificationConfig(ws.workspacePath, config);
    syncConfigToCache(ws.id, config);

    return c.json({ success: true, config });
  } catch (err) {
    console.error('[ClassificationRoutes] Save configuration failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/classification/curation-targets
 * Returns manager-selected curation targets plus live-store candidates.
 */
router.get('/classification/curation-targets', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    const candidates = listCurationTargetCandidates(ws.id, config);
    return c.json({ targets: config.curationTargets ?? [], candidates });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * PUT /api/classification/curation-targets
 * Saves which classification targets the curation stage should fill.
 */
router.put('/classification/curation-targets', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const body = await c.req.json();
    const targets = Array.isArray(body?.targets) ? body.targets : [];
    const currentConfig = loadClassificationConfig(ws.workspacePath);
    const nextConfig = applyCurationTargetsToConfig(currentConfig, targets, ws.id);
    saveClassificationConfig(ws.workspacePath, nextConfig);
    syncConfigToCache(ws.id, nextConfig);
    return c.json({
      success: true,
      targets: nextConfig.curationTargets,
      candidates: listCurationTargetCandidates(ws.id, nextConfig),
    });
  } catch (err) {
    console.error('[ClassificationRoutes] Save curation targets failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/classification/migrate-legacy
 * Migrates existing product_types, product_type_fields, and field_registry
 * into a ClassificationConfig under store/classification/.
 */
router.post('/classification/migrate-legacy', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const config = migrateLegacyToClassificationConfig(ws.workspacePath, ws.id);
    if (!config) {
      return c.json({ message: 'Classification config already exists. Use overwrite=true to force migration.' }, 200);
    }

    return c.json({
      success: true,
      summary: {
        productTypes: config.productTypes.length,
        attributes: config.attributes.length,
        attributeProfiles: config.attributeProfiles.length,
        attributeMappings: config.attributeMappings.length,
      },
    });
  } catch (err) {
    console.error('[ClassificationRoutes] Migration failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/classification/runs/:id
 *
 * Workspace-scoped run detail (issue #17 work item E). Returns the run, stage
 * results, evidence, proposals, live decisions, model calls, a runtime
 * snapshot summary (version/digests — never prompt bodies or credentials),
 * and config/source drift flags. A run that belongs to another workspace
 * returns 404 (no existence leak).
 */
router.get('/classification/runs/:id', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }
  const runId = c.req.param('id');
  const run = getRun(runId);
  if (!run || run.workspaceId !== ws.id) {
    return c.json({ error: 'Run not found' }, 404);
  }

  const evidence = getEvidenceByRun(runId);
  const proposals = getProposalsByRun(runId);
  const stageResults = getStageResults(runId);
  const decisions = getLiveDecisionsByRun(runId);
  const modelCalls = getModelCallsByRun(runId);

  // Runtime snapshot summary: version + digests only. Never the full config
  // (which embeds allowed values etc.) and never prompt/response bodies.
  let snapshotSummary = null;
  if (run.configSnapshotHash) {
    const snap = getRuntimeSnapshotByHash(ws.id, run.configSnapshotHash);
    if (snap) {
      snapshotSummary = {
        schemaVersion: snap.schemaVersion,
        snapshotHash: snap.snapshotHash,
        createdAt: snap.createdAt,
        configAuthorityKind: snap.configAuthorityKind,
        sourceCatalogCommit: snap.sourceCatalogCommit,
        catalogEvidenceHash: snap.catalogEvidenceHash,
        modelExecutionPlanDigest: snap.modelExecutionPlan?.digest ?? null,
        runtimeRuleVersionsDigest: snap.runtimeRuleVersions?.digest ?? null,
        pageImportId: snap.pageImportId,
        pageImportHash: snap.pageImportHash,
      };
    } else {
      snapshotSummary = { unavailable: 'snapshot_unavailable', configSnapshotHash: run.configSnapshotHash };
    }
  }

  // Model-call projection: hashes/versions only — prompt hashes, never bodies.
  const modelCallsView = modelCalls.map(call => ({
    id: call.id,
    status: call.status,
    operation: call.operation,
    stageName: call.stage_name,
    attempt: call.attempt,
    provider: call.provider,
    model: call.model,
    locality: call.locality,
    snapshotHash: call.snapshot_hash,
    modelPolicyDigest: call.model_policy_digest,
    promptTemplateVersion: call.prompt_template_version,
    ruleVersion: call.rule_version,
    systemPromptHash: call.system_prompt_hash,
    userPromptHash: call.user_prompt_hash,
    startedAt: call.started_at,
    endedAt: call.ended_at,
    durationMs: call.duration_ms,
    promptTokens: call.prompt_tokens,
    completionTokens: call.completion_tokens,
    errorMessage: call.error_message,
    estimatedCostUsd: call.estimated_cost_usd,
    costBasis: call.cost_basis,
  }));

  return c.json({
    run: {
      id: run.id,
      workspaceId: run.workspaceId,
      sourceKind: run.sourceKind,
      productSku: run.productSku,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      errorMessage: run.errorMessage,
      sourceProductHash: run.sourceProductHash,
      configSnapshotHash: run.configSnapshotHash,
    },
    evidence,
    proposals,
    decisions,
    stageResults,
    modelCalls: modelCallsView,
    snapshotSummary,
    drift: {
      configDrift: false,
      sourceDrift: false,
    },
  });
});

/**
 * POST /api/classification/process-refresh-queue
 * Processes pending classification refresh queue items for the current workspace.
 */
router.post('/classification/process-refresh-queue', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const count = await processRefreshQueue(ws.id, ws.workspacePath);
    return c.json({ success: true, processed: count });
  } catch (err) {
    console.error('[ClassificationRoutes] Refresh queue failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default router;
