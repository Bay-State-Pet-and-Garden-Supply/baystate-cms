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
  const drifts = listDrift(workspace.id, status);
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

export default route;
