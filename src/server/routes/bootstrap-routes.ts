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

  const body = await c.req.json().catch(() => ({}));
  const { xml } = body as { xml?: string };
  if (!xml || typeof xml !== 'string' || xml.trim().length === 0) {
    return c.json({ error: 'XML content is required.' }, 400);
  }

  const result = bootstrapFromXml(workspace, xml, 'xml_text');
  return c.json(result, result.success ? 200 : 500);
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

  const result = bootstrapFromXml(workspace, xml, 'xml_file');
  return c.json(result, result.success ? 200 : 500);
});

/**
 * GET /api/bootstrap/status
 * Get bootstrap status from workspace.
 */
route.get('/bootstrap/status', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }
  return c.json({
    bootstrapStatus: workspace.bootstrapStatus,
    baselineCommit: workspace.baselineCommit,
  });
});

export default route;
