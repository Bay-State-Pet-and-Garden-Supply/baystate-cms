import fs from 'fs';
import os from 'os';
import path from 'path';
import { ZipArchive } from 'archiver';
import type { Product } from '../shared/types';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Creates a ZIP file containing the images for a set of products.
 * The images in the ZIP are organized into folders by brand name.
 */
export async function createImagesZip(
  workspacePath: string,
  products: Product[],
  zipPath: string,
): Promise<void> {
  const dir = path.dirname(zipPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 5 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      resolve();
    });

    archive.on('error', (err: Error) => {
      reject(err);
    });

    archive.pipe(output);

    const addedPaths = new Set<string>();

    for (const product of products) {
      const brandName = product.customFields['ProductField16'] || 'unbranded';
      const brandFolder = slugify(brandName) || 'unbranded';

      const images: string[] = [];
      if (product.core.media.primary) {
        images.push(product.core.media.primary);
      }
      for (const img of product.core.media.additional) {
        if (img) images.push(img);
      }

      for (const imgPath of images) {
        if (!imgPath) continue;
        
        // Normalize image paths (strip leading slashes or prefix differences)
        let cleanPath = imgPath;
        if (cleanPath.startsWith('/')) {
          cleanPath = cleanPath.slice(1);
        }
        if (cleanPath.startsWith('products/images/')) {
          cleanPath = cleanPath.slice('products/images/'.length);
        }

        if (addedPaths.has(cleanPath)) continue;
        addedPaths.add(cleanPath);

        // Ensure file is organized under brand folder
        const fileName = path.basename(cleanPath);
        const archiveName = `${brandFolder}/${fileName}`;
        // Images are downloaded to ~/Downloads/{brandFolder}/{filename} by draft-promoter
        const localFilePath = path.join(os.homedir(), 'Downloads', cleanPath);
        if (fs.existsSync(localFilePath)) {
          archive.file(localFilePath, { name: archiveName });
        } else {
          console.warn(`[ZipGenerator] Local image file not found: ${localFilePath}`);
        }
      }
    }

    archive.finalize();
  });
}
