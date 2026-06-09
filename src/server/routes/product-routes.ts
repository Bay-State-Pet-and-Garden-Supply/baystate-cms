import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import {
  getProductWithDraft, listProductIndex, autosaveDraft, bulkImportDrafts,
  validateCatalogHealth, getCatalogHealthReport,
  getHealthConfig, saveHealthConfig,
} from '../services/product-service';

const route = new Hono();

/**
 * GET /api/products - List products from index with optional filters.
 */
route.get('/products', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const status = c.req.query('status');
  const search = c.req.query('search');
  const limit = c.req.query('limit');
  const offset = c.req.query('offset');

  const { products, total } = listProductIndex({
    status: status || undefined,
    search: search || undefined,
    limit: limit !== undefined ? Number(limit) : undefined,
    offset: offset !== undefined ? Number(offset) : undefined,
  });

  return c.json({ products, total });
});

/**
 * GET /api/products/:sku - Get product detail with optional draft overlay.
 */
route.get('/products/:sku', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const sku = c.req.param('sku');
  const { approved, draft, merged } = getProductWithDraft(
    workspace.id, workspace.workspacePath, sku,
  );

  if (!approved && !draft) {
    return c.json({ error: 'Product not found' }, 404);
  }

  return c.json({
    approved,
    draft,
    product: merged,
    hasDraft: !!draft,
    changeSetId: draft?.changeSetId ?? null,
  });
});

/**
 * PUT /api/products/:sku/draft - Autosave a product draft.
 */
route.put('/products/:sku/draft', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const sku = c.req.param('sku');
  const body = await c.req.json().catch(() => ({}));
  const { changes, operation } = body as {
    changes?: Record<string, unknown>;
    operation?: string;
  };

  if (!changes) {
    return c.json({ error: 'Changes object is required.' }, 400);
  }

  try {
    const result = autosaveDraft(
      workspace.id,
      workspace.workspacePath,
      sku,
      changes as any,
      operation as any,
    );
    return c.json({
      success: true,
      changeSetId: result.changeSetId,
      draftHash: result.draftHash,
    });
  } catch (err) {
    return c.json({
      error: `Failed to save draft: ${err instanceof Error ? err.message : String(err)}`,
    }, 500);
  }
});

/**
 * POST /api/products/:sku/archive - Add archive operation to active change set.
 */
route.post('/products/:sku/archive', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const sku = c.req.param('sku');
  try {
    const result = autosaveDraft(workspace.id, workspace.workspacePath, sku, {} as any, 'archive');
    return c.json({
      success: true,
      changeSetId: result.changeSetId,
      message: `Product "${sku}" added to archive operation in change set.`,
    });
  } catch (err) {
    return c.json({
      error: `Failed to archive product: ${err instanceof Error ? err.message : String(err)}`,
    }, 500);
  }
});

/**
 * POST /api/products/bulk-import - Bulk import products into the active change set.
 */
route.post('/products/bulk-import', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const { products } = body as { products?: any[] };

  if (!products || !Array.isArray(products)) {
    return c.json({ error: 'Products array is required.' }, 400);
  }

  try {
    const result = bulkImportDrafts(
      workspace.id,
      workspace.workspacePath,
      products,
    );
    return c.json({
      success: true,
      changeSetId: result.changeSetId,
      imported: result.imported,
      skipped: result.skipped,
    });
  } catch (err) {
    return c.json({
      error: `Failed to import products: ${err instanceof Error ? err.message : String(err)}`,
    }, 500);
  }
});

/**
 * POST /api/catalog/health - Run catalog-wide health check validation.
 */
route.post('/catalog/health', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }
  try {
    const report = validateCatalogHealth(workspace.id, workspace.workspacePath);
    return c.json(report);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/catalog/health - Get the current catalog health report.
 */
route.get('/catalog/health', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }
  try {
    const report = getCatalogHealthReport();
    return c.json(report);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/catalog/health/config - Retrieve catalog health configuration.
 */
route.get('/catalog/health/config', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }
  try {
    const config = getHealthConfig(workspace.workspacePath);
    return c.json(config);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/catalog/health/config - Save catalog health configuration.
 */
route.post('/catalog/health/config', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const { rules } = body as { rules?: any[] };
    if (!rules || !Array.isArray(rules)) {
      return c.json({ error: 'Rules array is required.' }, 400);
    }
    const result = saveHealthConfig(workspace.workspacePath, rules);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default route;
