import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { getCurrentWorkspace } from '../services/workspace-service';
import { getChangeSetDetail } from '../services/change-set-service';
import { createExportPackage } from '../../shopsite/export-package';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import type { Product } from '../../shared/types';

const route = new Hono();

/**
 * POST /api/export/change-set/:id - Generate export package for an approved change set.
 */
route.post('/export/change-set/:id', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const changeSetId = c.req.param('id');
  const { changeSet } = getChangeSetDetail(changeSetId);
  if (!changeSet) {
    return c.json({ error: 'Change set not found' }, 404);
  }

  if (changeSet.status !== 'approved') {
    return c.json({
      error: `Change set must be 'approved' before export. Current status: "${changeSet.status}"`,
    }, 400);
  }

  const items = listChangeSetItems(changeSetId);
  const products: Product[] = [];

  for (const item of items) {
    try {
      const product = JSON.parse(item.draftJson) as Product;
      products.push(product);
    } catch {
      return c.json({ error: `Failed to parse draft JSON for SKU "${item.sku}"` }, 500);
    }
  }

  if (products.length === 0) {
    return c.json({ error: 'No products in change set to export.' }, 400);
  }

  try {
    const exportResult = await createExportPackage(
      workspace.workspacePath,
      changeSetId,
      products,
      { changeSetTitle: changeSet.title },
    );

    return c.json({
      success: true,
      exportDir: exportResult.exportDir,
      xmlPath: exportResult.xmlPath,
      manifestPath: exportResult.manifestPath,
      instructionsPath: exportResult.instructionsPath,
      zipPath: exportResult.zipPath,
      productCount: exportResult.productCount,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Export failed' }, 500);
  }
});

/**
 * GET /api/export/change-set/:id/images-zip - Download the brand-organized images ZIP.
 */
route.get('/export/change-set/:id/images-zip', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const changeSetId = c.req.param('id');
  const zipPath = path.join(workspace.workspacePath, 'exports', changeSetId, 'shopsite-images.zip');

  if (!fs.existsSync(zipPath)) {
    return c.json({ error: 'Images ZIP not found. Generate an export package first.' }, 404);
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const fileBuffer = fs.readFileSync(zipPath);

  return new Response(fileBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="shopsite-images-${dateStr}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
});

export default route;
