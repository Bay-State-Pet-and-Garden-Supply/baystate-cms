import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { loadClassificationConfig, saveClassificationConfig } from '../../classification/config-loader';
import { migrateLegacyToClassificationConfig } from '../../classification/legacy-migration';
import { processRefreshQueue } from '../../classification/refresh-queue-processor';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import {
  applyCurationTargetsToConfig,
  listCurationTargetCandidates,
} from '../../classification/curation-targets';

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
    const config = loadClassificationConfig(ws.workspacePath);
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
