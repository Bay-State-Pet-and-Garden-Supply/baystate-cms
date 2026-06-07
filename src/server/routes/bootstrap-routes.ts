import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { bootstrapFromXml } from '../services/sync-service';

const route = new Hono();

/**
 * POST /api/bootstrap/xml
 * Bootstrap from raw XML text sent in the request body.
 */
route.post('/bootstrap/xml', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded. Create or open a workspace first.' }, 400);
  }
  if (workspace.bootstrapStatus === 'running') {
    return c.json({ error: 'A bootstrap process is already running in the background.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const { xml } = body as { xml?: string };
  if (!xml || typeof xml !== 'string' || xml.trim().length === 0) {
    return c.json({ error: 'XML content is required.' }, 400);
  }

  const { updateBootstrapStatus } = await import('../../db/repositories/workspace-repo');
  updateBootstrapStatus(workspace.id, 'running');

  Promise.resolve().then(() => {
    bootstrapFromXml(workspace, xml, 'xml_text');
  }).catch(err => {
    console.error('Background bootstrap error:', err);
    updateBootstrapStatus(workspace.id, 'failed');
  });

  return c.json({ success: true, status: 'running' });
});

/**
 * POST /api/bootstrap/file
 * Bootstrap from an XML file path on disk.
 */
route.post('/bootstrap/file', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded. Create or open a workspace first.' }, 400);
  }
  if (workspace.bootstrapStatus === 'running') {
    return c.json({ error: 'A bootstrap process is already running in the background.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const { filePath } = body as { filePath?: string };
  if (!filePath || typeof filePath !== 'string') {
    return c.json({ error: 'filePath is required.' }, 400);
  }

  let xml: string;
  try {
    const fs = await import('fs');
    xml = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return c.json({
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    }, 400);
  }

  const { updateBootstrapStatus } = await import('../../db/repositories/workspace-repo');
  updateBootstrapStatus(workspace.id, 'running');

  Promise.resolve().then(() => {
    bootstrapFromXml(workspace, xml, 'xml_file');
  }).catch(err => {
    console.error('Background bootstrap error:', err);
    updateBootstrapStatus(workspace.id, 'failed');
  });

  return c.json({ success: true, status: 'running' });
});

/**
 * GET /api/bootstrap/status
 * Get bootstrap status from workspace.
 */
route.get('/bootstrap/status', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  let errorMsg = null;
  if (workspace.bootstrapStatus === 'failed') {
    const { listSyncJobs } = await import('../../db/repositories/sync-job-repo');
    const jobs = listSyncJobs(workspace.id);
    const bootstrapJob = jobs.find(j => j.kind === 'bootstrap');
    errorMsg = bootstrapJob?.errorSummary || 'Unknown bootstrap error';
  }

  return c.json({
    bootstrapStatus: workspace.bootstrapStatus,
    baselineCommit: workspace.baselineCommit,
    error: errorMsg,
  });
});

/**
 * POST /api/bootstrap/pull
 * Fetch product catalog XML from the live store connection and bootstrap from it.
 */
route.post('/bootstrap/pull', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded. Create or open a workspace first.' }, 400);
  }
  if (workspace.bootstrapStatus === 'running') {
    return c.json({ error: 'A bootstrap process is already running in the background.' }, 400);
  }

  const { findConnection } = await import('../../db/repositories/connection-repo');
  const connection = findConnection(workspace.id);
  if (!connection?.cgiBaseUrl || !connection.merchantId || !connection.passwordSecretRef) {
    return c.json({ error: 'ShopSite connection is not configured. Please save and test your credentials first.' }, 400);
  }

  const { ShopSiteHttpClient } = await import('../../shopsite/shopsite-http-client');
  const client = new ShopSiteHttpClient({
    cgiBaseUrl: connection.cgiBaseUrl,
    merchantId: connection.merchantId,
    password: connection.passwordSecretRef,
  });

  const { updateBootstrapStatus } = await import('../../db/repositories/workspace-repo');
  updateBootstrapStatus(workspace.id, 'running');

  Promise.resolve().then(async () => {
    const downloadResult = await client.fetchProductsXml();
    if (!downloadResult.success || !downloadResult.data) {
      updateBootstrapStatus(workspace.id, 'failed');
      const { createSyncJob, completeSyncJob, addSyncJobEvent } = await import('../../db/repositories/sync-job-repo');
      const job = createSyncJob({
        workspaceId: workspace.id,
        kind: 'bootstrap',
        metadataJson: JSON.stringify({ source: 'xml_text', timestamp: new Date().toISOString() }),
      });
      addSyncJobEvent({ syncJobId: job.id, level: 'error', message: downloadResult.error || 'Download failed' });
      completeSyncJob(job.id, 'failed', { errorSummary: downloadResult.error || 'Failed to download live XML' });
      return;
    }

    bootstrapFromXml(workspace, downloadResult.data, 'xml_text');
  }).catch(err => {
    console.error('Background bootstrap pull error:', err);
    updateBootstrapStatus(workspace.id, 'failed');
  });

  return c.json({ success: true, status: 'running' });
});

export default route;
