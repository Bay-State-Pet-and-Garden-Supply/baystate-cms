import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { readProductFile } from '../../git/workspace-files';
import { classifyCatalogProduct } from '../../classification/catalog-product-classifier';
import { computeProductHash } from '../../classification/catalog-product-source';
import { getDb } from '../../db/connection';
import { getRecentCatalogRun, getEvidenceByRun, getProposalsByRun, getStageResults } from '../../db/repositories/classification-run-repo';
import { loadClassificationConfig } from '../../classification/config-loader';
import { computeConfigHash } from '../../db/repositories/classification-config-repo';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { validateCatalogReviewCompletionGate } from '../../classification/review-completion-gate';
import { applyCatalogClassification } from '../../classification/catalog-product-application';

const route = new Hono();

/**
 * GET /api/products/:sku/classification
 * Get the latest catalog classification run detail for a product SKU.
 */
route.get('/products/:sku/classification', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');
  const run = getRecentCatalogRun(workspace.id, sku);

  if (!run) {
    return c.json({ run: null, configDrift: false, sourceDrift: false, evidence: [], proposals: [], decisions: [], stageResults: [] });
  }

  const evidence = getEvidenceByRun(run.id);
  const proposals = getProposalsByRun(run.id);
  const stageResults = getStageResults(run.id);

  // Get decisions
  const decisions: Array<{ id: string; proposalId: string; decision: string }> = [];
  for (const p of proposals) {
    const decRows = getDb()
      .query('SELECT * FROM classification_proposal_decisions WHERE proposal_id = ? ORDER BY created_at DESC')
      .all(p.id) as Record<string, any>[];
    for (const d of decRows) {
      decisions.push({
        id: String(d.id),
        proposalId: String(d.proposal_id),
        decision: String(d.decision),
      });
    }
  }

  // Drift detection — must use same hash functions as the classifier
  let sourceDrift = false;
  let configDrift = false;

  if (run.sourceProductHash && (run.status === 'completed' || run.status === 'completed_with_abstentions')) {
    const product = readProductFile(workspace.workspacePath, sku);
    if (product) {
      const currentHash = computeProductHash(product);
      if (currentHash !== run.sourceProductHash) sourceDrift = true;
    }
  }

  if (run.configSnapshotHash) {
    const classConfig = loadClassificationConfig(workspace.workspacePath);
    const currentHash = computeConfigHash(classConfig);
    if (currentHash !== run.configSnapshotHash) configDrift = true;
  }

  return c.json({
    run: {
      id: run.id,
      status: run.status,
      productSku: run.productSku,
      sourceKind: run.sourceKind,
      configSnapshotHash: run.configSnapshotHash,
      sourceProductHash: run.sourceProductHash,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      errorMessage: run.errorMessage,
    },
    configDrift,
    sourceDrift,
    evidence,
    proposals,
    decisions,
    stageResults,
  });
});

/**
 * POST /api/products/:sku/classification/runs
 * Run classification for a product SKU.
 */
route.post('/products/:sku/classification/runs', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');

  // Read product
  const product = readProductFile(workspace.workspacePath, sku);
  if (!product) return c.json({ error: `Product not found: ${sku}` }, 404);

  // Check for existing running catalog run
  const runningRun = getDb().query(
    `SELECT id FROM classification_runs
     WHERE workspace_id = ? AND product_sku = ? AND source_kind = 'catalog_product' AND status = 'running'`,
  ).get(workspace.id, sku);
  if (runningRun) {
    return c.json({ error: 'A classification run is already in progress for this product.' }, 409);
  }

  try {
    const result = await classifyCatalogProduct(workspace.id, workspace.workspacePath, product);
    if (!result.success) {
      return c.json({ error: result.error || 'Classification failed.' }, 409);
    }
    return c.json(result);
  } catch (err: any) {
    console.error(`[CatalogClassificationRoutes] Classification failed for ${sku}:`, err);
    return c.json({ error: err.message || 'Classification failed.' }, 500);
  }
});

/**
 * POST /api/products/:sku/classification/runs/:runId/decisions
 */
route.post('/products/:sku/classification/runs/:runId/decisions', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');
  const runId = c.req.param('runId');

  const run = getRecentCatalogRun(workspace.id, sku);
  if (!run || run.id !== runId) {
    return c.json({ error: 'Run not found for this SKU and workspace.' }, 404);
  }

  let body: any;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  if (!body || !Array.isArray(body.decisions) || body.decisions.length === 0) {
    return c.json({ error: 'At least one decision is required in the decisions array.' }, 400);
  }

  // Validate each decision entry shape
  const validDecisions = new Set(['accepted', 'rejected', 'deferred']);
  const decisions: Array<{ proposalId: string; decision: 'accepted' | 'rejected' | 'deferred'; reviewerNote?: string | null; revisedValue?: unknown }> = [];
  for (const d of body.decisions) {
    if (!d || typeof d !== 'object') {
      return c.json({ error: `Invalid decision entry: expected object, got ${typeof d}` }, 400);
    }
    if (typeof d.proposalId !== 'string' || !d.proposalId.trim()) {
      return c.json({ error: 'Each decision must have a valid proposalId string.' }, 400);
    }
    if (!validDecisions.has(d.decision)) {
      return c.json({ error: `Invalid decision "${d.decision}". Must be one of: accepted, rejected, deferred.` }, 400);
    }
    decisions.push({
      proposalId: d.proposalId,
      decision: d.decision as 'accepted' | 'rejected' | 'deferred',
      reviewerNote: d.reviewerNote ?? null,
      revisedValue: d.revisedValue,
    });
  }

  const result = submitProposalDecisions({
    workspaceId: workspace.id,
    productSku: sku,
    runId,
    sourceKind: 'catalog_product',
    decisions,
  });

  if (!result.ok) {
    return c.json({ error: result.reason, code: result.code }, 400);
  }

  return c.json({ ok: true, decisions: result.decisions });
});

/**
 * POST /api/products/:sku/classification/runs/:runId/apply
 */
route.post('/products/:sku/classification/runs/:runId/apply', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');
  const runId = c.req.param('runId');

  const gate = validateCatalogReviewCompletionGate({
    workspaceId: workspace.id,
    productSku: sku,
    runId,
  });

  if (!gate.ok) {
    return c.json({ error: gate.reason, code: gate.code }, 400);
  }

  try {
    const result = await applyCatalogClassification(workspace.workspacePath, workspace.id, sku, runId);
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    console.error(`[CatalogClassificationRoutes] Apply failed for ${sku}:`, err);
    return c.json({ error: err.message || 'Apply failed.' }, 400);
  }
});

export default route;
