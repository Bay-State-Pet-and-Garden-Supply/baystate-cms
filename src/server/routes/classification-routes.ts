import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { loadClassificationConfig } from '../../classification/config-loader';
import { migrateLegacyToClassificationConfig } from '../../classification/legacy-migration';
import { processRefreshQueue } from '../../classification/refresh-queue-processor';

const router = new Hono();

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
    const config = loadClassificationConfig(ws.workspacePath);
    return c.json({ config });
  } catch (err) {
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
