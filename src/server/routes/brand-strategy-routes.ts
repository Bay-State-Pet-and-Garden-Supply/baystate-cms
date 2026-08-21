// story: e08s01 — Brand Strategy aggregation projection (singleton workspace, exact normalized-brand authority)
import { Hono } from 'hono';
import { listBrandStrategies } from '../../onboarding/brand-hub/brand-strategy-service';
import { MultipleWorkspacesError } from '../../db/repositories/workspace-singleton';

export const brandStrategyRoutes = new Hono();

brandStrategyRoutes.get('/onboarding/brands/strategy', (c) => {
  try {
    const strategies = listBrandStrategies();
    return c.json({ strategies });
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
    throw err;
  }
});
