/**
 * Downloads product images from extraction results to the workspace Git repo.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';

interface DownloadedImage {
  originalUrl: string;
  localPath: string;  // relative to workspace root
  fileName: string;
  sizeBytes: number;
}

/**
 * Download product images to the workspace.
 * Images are stored in products/{sku}/images/ within the workspace.
 */
export async function downloadImages(
  workspacePath: string,
  sku: string,
  imageUrls: string[],
  brand?: string,
): Promise<DownloadedImage[]> {
  if (imageUrls.length === 0) return [];

  const brandDir = brand ? brand.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_') : 'unknown';
  const imagesDir = path.join(workspacePath, 'products', 'images', brandDir, sku);
  fs.mkdirSync(imagesDir, { recursive: true });

  const downloaded: DownloadedImage[] = [];
  const seenHashes = new Set<string>();

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    try {
      const result = await downloadSingleImage(url, imagesDir, i, seenHashes);
      if (result) {
        downloaded.push({
          ...result,
          localPath: path.join('products', 'images', brandDir, sku, result.fileName),
        });
      }
    } catch (err) {
      console.error(`[ImageDownloader] Failed to download ${url}:`, err);
      // Continue with remaining images
    }
  }

  return downloaded;
}

async function downloadSingleImage(
  url: string,
  destDir: string,
  index: number,
  seenHashes: Set<string>,
): Promise<{ originalUrl: string; fileName: string; sizeBytes: number } | null> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ShopSiteCMS/1.0)',
      'Accept': 'image/*',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  // Skip SVGs
  if (contentType.includes('svg')) return null;

  // Determine file extension from content type
  const ext = getExtensionFromContentType(contentType) ?? getExtensionFromUrl(url) ?? '.jpg';

  const buffer = Buffer.from(await response.arrayBuffer());

  // Skip tiny files (likely icons/spacers)
  if (buffer.length < 1024) return null; // Less than 1KB

  // Deduplicate by hash
  const hash = createHash('md5').update(buffer).digest('hex');
  if (seenHashes.has(hash)) return null;
  seenHashes.add(hash);

  // Generate filename
  const fileName = index === 0 ? `primary${ext}` : `image-${index}${ext}`;
  const destPath = path.join(destDir, fileName);

  fs.writeFileSync(destPath, buffer);

  return {
    originalUrl: url,
    fileName,
    sizeBytes: buffer.length,
  };
}

function getExtensionFromContentType(contentType: string): string | null {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/tiff': '.tiff',
  };

  for (const [mime, ext] of Object.entries(map)) {
    if (contentType.includes(mime)) return ext;
  }
  return null;
}

function getExtensionFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  } catch { /* skip */ }
  return null;
}
