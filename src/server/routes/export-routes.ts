import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { getCurrentWorkspace } from '../services/workspace-service';
import { getChangeSetDetail } from '../services/change-set-service';
import { createExportPackage } from '../../shopsite/export-package';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { getDb } from '../../db/connection';
import type { Product } from '../../shared/types';

interface ProcessedImageResult {
  primaryImage: string | null;
  additionalImages: string[];
}

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

/**
 * POST /api/export/change-set/:id/repair-images
 *
 * Re-downloads images for an approved change set from the original onboarding
 * extraction data. This repairs missing image files for change sets that were
 * promoted before the workspace-backed image storage was introduced.
 *
 * For each change set item, looks up the onboarding item by SKU, reads the
 * extraction data URLs, and re-downloads images to:
 *   {workspacePath}/products/images/{brandFolder}/{filename}
 */
route.post('/export/change-set/:id/repair-images', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const changeSetId = c.req.param('id');
  const { changeSet } = getChangeSetDetail(changeSetId);
  if (!changeSet) {
    return c.json({ error: 'Change set not found.' }, 404);
  }

  const items = listChangeSetItems(changeSetId);
  if (items.length === 0) {
    return c.json({ error: 'Change set has no items.' }, 400);
  }

  const db = getDb();
  const results: Array<{ sku: string; primaryImage: string | null; imagesDownloaded: number; error?: string }> = [];

  for (const item of items) {
    try {
      // Look up onboarding item by SKU (upc) to get extraction data
      const row = db.query(
        'SELECT extraction_data_json, brand_hint FROM onboarding_items WHERE upc = ? LIMIT 1',
      ).get(item.sku) as { extraction_data_json: string | null; brand_hint: string | null } | undefined;

      if (!row?.extraction_data_json) {
        results.push({ sku: item.sku, primaryImage: null, imagesDownloaded: 0, error: 'No extraction data found' });
        continue;
      }

      const extractionData = JSON.parse(row.extraction_data_json);
      const primaryUrl: string | null = extractionData.primaryImage || null;
      const additionalUrls: string[] = extractionData.additionalImages || [];

      if (!primaryUrl && additionalUrls.length === 0) {
        results.push({ sku: item.sku, primaryImage: null, imagesDownloaded: 0, error: 'No image URLs in extraction data' });
        continue;
      }

      // Resolve brand folder from the draftJson's ProductField16, or fall back to brand_hint
      let product: Product;
      try {
        product = JSON.parse(item.draftJson) as Product;
      } catch {
        results.push({ sku: item.sku, primaryImage: null, imagesDownloaded: 0, error: 'Failed to parse product JSON' });
        continue;
      }

      const brandName = product.customFields?.['ProductField16'] || row.brand_hint || 'unbranded';
      const brandFolder = slugify(brandName) || 'unbranded';

      // Derive the image stem from the existing media reference if available
      let imageStem: string;
      const existingPrimary = product.core?.media?.primary;
      if (existingPrimary) {
        // Extract stem from existing path: 'brandfolder/filename.jpg' → 'filename'
        imageStem = path.basename(existingPrimary, path.extname(existingPrimary));
      } else {
        imageStem = slugify(product.core?.name || product.sku) || slugify(item.sku) || 'product';
      }

      // Download images using the same logic as draft-promoter
      const imagesDir = path.join(workspace.workspacePath, 'products', 'images', brandFolder);
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
      }

      const processed = await downloadAndProcessImagesForRepair(
        workspace.workspacePath,
        item.sku,
        brandFolder,
        imageStem,
        primaryUrl,
        additionalUrls,
      );

      results.push({
        sku: item.sku,
        primaryImage: processed.primaryImage,
        imagesDownloaded: (processed.primaryImage ? 1 : 0) + processed.additionalImages.length,
      });
    } catch (err) {
      results.push({
        sku: item.sku,
        primaryImage: null,
        imagesDownloaded: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const totalDownloaded = results.reduce((s, r) => s + r.imagesDownloaded, 0);
  const failedCount = results.filter(r => r.error).length;

  return c.json({
    success: failedCount < results.length,
    summary: `Repaired ${totalDownloaded} image(s) across ${results.length} product(s)` +
      (failedCount > 0 ? ` (${failedCount} failure(s))` : ''),
    results,
  });
});

/**
 * Slugify helper (mirrors the one in zip-generator and draft-promoter).
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Download and process images for repair. Mirrors the logic in draft-promoter.ts
 * but uses fetch directly (avoids circular deps).
 */
async function downloadAndProcessImagesForRepair(
  workspacePath: string,
  sku: string,
  brandFolder: string,
  imageStem: string,
  primaryUrl: string | null,
  additionalUrls: string[],
): Promise<ProcessedImageResult> {
  const imagesDir = path.join(workspacePath, 'products', 'images', brandFolder);
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const result: ProcessedImageResult = {
    primaryImage: null,
    additionalImages: [],
  };

  const allUrls: string[] = [];
  if (primaryUrl) allUrls.push(primaryUrl);
  for (const url of additionalUrls) {
    if (url && url !== primaryUrl) allUrls.push(url);
  }

  // Ensure unique image stem
  let finalImageStem = imageStem;
  const primaryFile = path.join(imagesDir, `${finalImageStem}.jpg`);
  if (fs.existsSync(primaryFile)) {
    finalImageStem = `${imageStem}-${sku}`;
  }

  for (let index = 0; index < allUrls.length; index++) {
    const url = allUrls[index];
    if (!url) continue;

    // Skip non-HTTP URLs (treat as already-downloaded relative paths)
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      if (index === 0) result.primaryImage = url;
      else result.additionalImages.push(url);
      continue;
    }

    const imageSuffix = index === 0 ? '' : `-${index + 1}`;
    const filename = `${finalImageStem}${imageSuffix}.jpg`;
    const destPath = path.join(imagesDir, filename);

    // Path containment check
    if (!path.resolve(destPath).startsWith(path.resolve(imagesDir))) {
      console.warn(`[RepairImages] Skipping path traversal: ${filename}`);
      continue;
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BaystateCMS/1.0)',
          'Accept': 'image/*',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        console.warn(`[RepairImages] HTTP ${response.status} for ${url}`);
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        console.warn(`[RepairImages] Non-image content type for ${url}: ${contentType}`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Process with sharp if available, otherwise save raw
      let finalBuffer: Buffer;
      try {
        const sharp = (await import('sharp')).default;
        finalBuffer = await sharp(buffer)
          .flatten({ background: '#ffffff' })
          .resize(1000, 1000, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          })
          .jpeg({ quality: 90 })
          .toBuffer();
      } catch {
        // If sharp fails (e.g., unsupported format), save the raw buffer
        finalBuffer = buffer;
      }

      fs.writeFileSync(destPath, finalBuffer);

      const relativePath = `${brandFolder}/${filename}`;
      if (index === 0) result.primaryImage = relativePath;
      else result.additionalImages.push(relativePath);
    } catch (err) {
      console.error(`[RepairImages] Error downloading ${url}:`, err);
    }
  }

  return result;
}

export default route;
