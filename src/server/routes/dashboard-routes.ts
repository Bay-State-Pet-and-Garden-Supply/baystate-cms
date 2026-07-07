import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { getDashboardStatsData } from '../services/dashboard-service';

const route = new Hono();

/**
 * GET /api/dashboard/stats - Get catalog metrics and recent logs for the manager dashboard.
 */
route.get('/dashboard/stats', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  try {
    const stats = getDashboardStatsData(workspace.id);
    return c.json(stats);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default route;
