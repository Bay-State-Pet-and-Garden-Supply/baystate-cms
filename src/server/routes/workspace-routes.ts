import { Hono } from 'hono';
import { getCurrentWorkspace, loadWorkspace } from '../services/workspace-service';

const route = new Hono();

/**
 * GET /api/workspace - Get store workspace metadata.
 */
route.get('/workspace', (c) => {
  const ws = getCurrentWorkspace();
  return c.json({
    workspace: ws ?? null,
    message: ws ? 'Store loaded' : 'No store loaded',
  });
});

/**
 * POST /api/workspace/init - Deprecated stub for workspace init.
 */
route.post('/workspace/init', (c) => {
  const ws = getCurrentWorkspace();
  return c.json({ success: true, workspace: ws });
});

/**
 * POST /api/workspace/open - Deprecated stub for workspace open.
 */
route.post('/workspace/open', (c) => {
  const ws = loadWorkspace();
  return c.json({ success: true, workspace: ws });
});

/**
 * POST /api/workspace/close - Deprecated stub for workspace close.
 */
route.post('/workspace/close', (c) => {
  return c.json({ success: true, message: 'Store database open' });
});

/**
 * GET /api/workspace/recent - Deprecated stub.
 */
route.get('/workspace/recent', (c) => {
  return c.json({ success: true, workspaces: [] });
});

/**
 * POST /api/workspace/recent/remove - Deprecated stub.
 */
route.post('/workspace/recent/remove', (c) => {
  return c.json({ success: true });
});

export default route;
