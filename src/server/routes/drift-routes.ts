import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { detectDrift, acceptRemoteForDrift } from '../../shopsite/drift';
import { listDrift, findDriftById, resolveDrift, countOpenDrift, countBlockingDrift, linkDriftToChangeSet } from '../../db/repositories/drift-repo';
import { hashJson } from '../../git/deterministic-json';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { createSyncJob, addSyncJobEvent, completeSyncJob } from '../../db/repositories/sync-job-repo';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import { deterministicStringify } from '../../git/deterministic-json';

const route = new Hono();

/**
 * POST /api/drift/check - Pull remote ShopSite data and detect drift.
 * Accepts remote XML as body text for testing; uses ShopSite HTTP client when not provided.
 */
route.post('/drift/check', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({})) as { remoteXml?: string };
  let xmlToCheck = (body.remoteXml ?? '').trim();

  if (!xmlToCheck) {
    // Try saved connection for live pull
    const { findConnection } = await import('../../db/repositories/connection-repo');
    const { ShopSiteHttpClient } = await import('../../shopsite/shopsite-http-client');
    const connection = findConnection(workspace.id);
    if (connection?.cgiBaseUrl && connection.merchantId && connection.passwordSecretRef) {
      const client = new ShopSiteHttpClient({
        cgiBaseUrl: connection.cgiBaseUrl,
        merchantId: connection.merchantId,
        password: connection.passwordSecretRef,
      });
      const result = await client.fetchProductsXml();
      if (!result.success || !result.data) {
        return c.json({ error: `Failed to pull remote ShopSite data: ${result.error ?? 'unknown error'}` }, 400);
      }
      xmlToCheck = result.data;
    } else {
      return c.json({
        error: 'No remote XML provided and no ShopSite connection configured. ' +
          'Paste ShopSite XML text into the Drift view, or configure a direct sync connection in Setup.',
      }, 400);
    }
  }

  const job = createSyncJob({ workspaceId: workspace.id, kind: 'pull_drift' });
  addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Starting drift detection...' });

  try {
    const result = detectDrift(workspace.id, workspace.workspacePath, xmlToCheck);

    if (result.errors.length > 0 && result.drifts.length === 0) {
      addSyncJobEvent({ syncJobId: job.id, level: 'error', message: result.errors.join('; ') });
      completeSyncJob(job.id, 'failed', { errorSummary: result.errors.join('; ') });
      return c.json({ error: result.errors.join('; '), jobId: job.id }, 500);
    }

    addSyncJobEvent({
      syncJobId: job.id, level: 'info',
      message: `Drift detection complete: ${result.driftCount} product(s) differ from remote.`,
    });

    completeSyncJob(job.id, 'succeeded', { productCount: result.driftCount });

    addAuditLog({
      workspaceId: workspace.id,
      entityType: 'workspace',
      entityId: workspace.id,
      action: 'drift_check',
      message: `Drift check found ${result.driftCount} product(s) with remote changes`,
      detailsJson: JSON.stringify({ driftCount: result.driftCount, skus: result.drifts.map(d => d.sku) }),
    });

    return c.json({
      success: true,
      jobId: job.id,
      driftCount: result.driftCount,
      driftSkus: result.drifts.map(d => ({ id: d.id, sku: d.sku, status: d.status })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSyncJobEvent({ syncJobId: job.id, level: 'error', message: msg });
    completeSyncJob(job.id, 'failed', { errorSummary: msg });
    return c.json({ error: msg, jobId: job.id }, 500);
  }
});

/**
 * GET /api/drift - List open drift.
 */
route.get('/drift', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const status = c.req.query('status') || undefined;
  const limitVal = c.req.query('limit');
  const offsetVal = c.req.query('offset');
  
  const limit = limitVal ? parseInt(limitVal, 10) : 100;
  const offset = offsetVal ? parseInt(offsetVal, 10) : undefined;

  const drifts = listDrift(
    workspace.id,
    status,
    isNaN(limit) ? 100 : limit,
    offset !== undefined && !isNaN(offset) ? offset : undefined
  );
  const _blockingCount = countBlockingDrift(workspace.id);
  const openCount = countOpenDrift(workspace.id);

  // Load additional context for each drift
  const enriched = drifts.map(d => {
    const localProduct = d.localJson ? JSON.parse(d.localJson) : null;
    const remoteProduct = d.remoteJson ? JSON.parse(d.remoteJson) : null;
    return {
      ...d,
      localProductName: localProduct?.core?.name ?? null,
      remoteProductName: remoteProduct?.core?.name ?? null,
      localPrice: localProduct?.core?.price ?? null,
      remotePrice: remoteProduct?.core?.price ?? null,
    };
  });

  return c.json({ drifts: enriched, openCount });
});

/**
 * POST /api/drift/:id/resolve - Resolve a drift row.
 * Options: keep_local, accept_remote, create_change_set
 */
route.post('/drift/:id/resolve', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const driftId = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { action?: string };
  const action = body.action || 'keep_local';

  const drift = findDriftById(driftId);
  if (!drift) return c.json({ error: 'Drift record not found.' }, 404);
  if (drift.status !== 'open') return c.json({ error: `Drift status is "${drift.status}", not open.` }, 400);

  switch (action) {
    case 'keep_local':
      resolveDrift(driftId, 'kept_local');
      addAuditLog({
        workspaceId: workspace.id,
        entityType: 'drift',
        entityId: driftId,
        action: 'kept_local',
        message: `Kept local version for SKU "${drift.sku}" (remote changes discarded)`,
        detailsJson: JSON.stringify({ sku: drift.sku }),
      });
      return c.json({ success: true, action: 'kept_local', sku: drift.sku });

    case 'accept_remote': {
      const accepted = acceptRemoteForDrift(workspace.workspacePath, drift);
      resolveDrift(driftId, 'accepted_remote');
      addAuditLog({
        workspaceId: workspace.id,
        entityType: 'drift',
        entityId: driftId,
        action: 'accepted_remote',
        message: `Accepted remote version for SKU "${drift.sku}" into local Git catalog`,
        detailsJson: JSON.stringify({ sku: drift.sku, commitHash: accepted.commitHash }),
      });
      return c.json({ success: true, action: 'accepted_remote', sku: drift.sku, commitHash: accepted.commitHash });
    }

    case 'create_change_set': {
      // Create a draft change set with the remote data for manual reconcile
      const baseCommit = workspace.baselineCommit || 'unknown';
      const cs = createChangeSet({
        workspaceId: workspace.id,
        title: `Drift reconcile: ${drift.sku}`,
        baseCommit,
      });

      if (drift.remoteJson) {
        const remoteProduct = JSON.parse(drift.remoteJson);
        const draftHash = hashJson(remoteProduct);
        upsertChangeSetItem({
          changeSetId: cs.id,
          sku: drift.sku,
          operation: 'update',
          draftJson: deterministicStringify(remoteProduct),
          baseJson: drift.localJson,
          draftHash,
        });
      }

      // Set status to in_reconcile (still blocking) until reconcile change set is approved
      linkDriftToChangeSet(driftId, cs.id, 'in_reconcile');

      addAuditLog({
        workspaceId: workspace.id,
        entityType: 'drift',
        entityId: driftId,
        action: 'created_reconcile_change_set',
        message: `Created reconcile change set for SKU "${drift.sku}"`,
        detailsJson: JSON.stringify({ sku: drift.sku, changeSetId: cs.id, status: 'in_reconcile' }),
      });
      return c.json({ success: true, action: 'created_reconcile_change_set', sku: drift.sku, changeSetId: cs.id });
    }

    default:
      return c.json({ error: `Unknown action "${action}". Use: keep_local, accept_remote, create_change_set` }, 400);
  }
});

/**
 * POST /api/drift/bulk-resolve - Accept remote changes in bulk for products with no local unpushed modifications.
 */
route.post('/drift/bulk-resolve', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({})) as { action?: string };
  const action = body.action || 'accept_remote';

  if (action !== 'accept_remote') {
    return c.json({ error: 'Only accept_remote action is supported for bulk resolution.' }, 400);
  }

  // 1. Get all open drifts
  const openDrifts = listDrift(workspace.id, 'open');
  if (openDrifts.length === 0) {
    return c.json({ success: true, message: 'No open drifts found.', resolvedCount: 0 });
  }

  // Dynamic imports
  const { writeProductFile } = await import('../../git/workspace-files');
  const { skuToProductFilePath } = await import('../../git/product-file-path');
  const { findProductBySku, updateProductIndex } = await import('../../db/repositories/product-index-repo');
  const { GitClient } = await import('../../git/git-client');
  const { getDb } = await import('../../db/connection');
  const { findWorkspace } = await import('../../db/repositories/workspace-repo');
  const type_shared = await import('../../shared/types');

  // 2. Identify SKUs with active drafts in change sets
  const db = getDb();
  const draftedSkusRows = db.query(
    `SELECT sku FROM change_set_items 
     WHERE change_set_id IN (SELECT id FROM change_sets WHERE workspace_id = ? AND status = 'draft')`
  ).all(workspace.id) as { sku: string }[];
  const draftedSkus = new Set(draftedSkusRows.map(r => r.sku));

  // 3. Filter drifts that have no local modifications
  const cleanDrifts = openDrifts.filter(d => {
    if (draftedSkus.has(d.sku)) return false;

    const indexRow = findProductBySku(d.sku);
    if (indexRow && indexRow.syncStatus === 'not_synced') {
      return false; // Local has unpushed changes
    }

    return true;
  });

  if (cleanDrifts.length === 0) {
    return c.json({ success: true, message: 'No clean drifts available for bulk auto-resolution.', resolvedCount: 0 });
  }

  // 4. Batch write product files and update indices
  const resolvedSkus: string[] = [];
  const filesToCommit: string[] = [];
  const now = new Date().toISOString();

  for (const drift of cleanDrifts) {
    try {
      const remoteProduct = JSON.parse(drift.remoteJson) as any;
      if (!remoteProduct.sku) continue;

      writeProductFile(workspace.workspacePath, remoteProduct);
      filesToCommit.push(skuToProductFilePath(remoteProduct.sku));

      const productHash = hashJson(remoteProduct);
      const existing = findProductBySku(remoteProduct.sku);
      if (existing) {
        updateProductIndex({
          sku: remoteProduct.sku,
          title: remoteProduct.core.name,
          status: remoteProduct.status,
          price: remoteProduct.core.price,
          inventoryQuantity: remoteProduct.core.inventory.quantityOnHand,
          primaryImage: remoteProduct.core.media.primary,
          productHash,
          lastPulledRemoteHash: drift.remoteHash,
          lastSyncedRemoteHash: drift.remoteHash,
          lastSyncedAt: now,
          syncStatus: 'synced',
          hasAdvancedBlocks: Object.keys(remoteProduct.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
        });
      }

      resolveDrift(drift.id, 'accepted_remote');
      resolvedSkus.push(drift.sku);
    } catch (err) {
      console.error(`Failed to bulk resolve drift for SKU ${drift.sku}:`, err);
    }
  }

  // 5. Commit all resolved changes in a single Git commit
  let commitHash: string | null = null;
  if (filesToCommit.length > 0) {
    const git = new GitClient(workspace.workspacePath);
    if (git.isRepo()) {
      git.add(filesToCommit);
      const gitStatus = git.status();
      if (gitStatus) {
        git.commit(`Accept remote ShopSite drifts [bulk]: ${resolvedSkus.length} products`);
        commitHash = git.getHeadHash();

        // Update lastApprovedCommit with the new commit hash
        for (const sku of resolvedSkus) {
          updateProductIndex({ sku, lastApprovedCommit: commitHash });
        }
      }
    }
  }

  addAuditLog({
    workspaceId: workspace.id,
    entityType: 'drift',
    entityId: workspace.id,
    action: 'bulk_accepted_remote',
    message: `Accepted remote versions for ${resolvedSkus.length} products (bulk)`,
    detailsJson: JSON.stringify({ resolvedSkus, commitHash }),
  });

  return c.json({
    success: true,
    resolvedCount: resolvedSkus.length,
    commitHash,
    message: `Accepted remote versions for ${resolvedSkus.length} product(s) successfully.`,
  });
});

export default route;
