/**
 * SKU filename encoding/decoding utilities.
 * SKUs may contain filesystem-hostile characters (slashes, spaces, etc.)
 * so they need reversible encoding for use as filenames.
 */

const FILENAME_SAFE_RE = /^[a-zA-Z0-9._-]+$/;

export function encodeSkuForFilename(sku: string): string {
  if (FILENAME_SAFE_RE.test(sku)) {
    return sku;
  }
  // Percent-encode but keep dots and hyphens readable
  let result = '';
  for (let i = 0; i < sku.length; i++) {
    const ch = sku[i];
    if (FILENAME_SAFE_RE.test(ch)) {
      result += ch;
    } else {
      result += '%' + sku.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return result;
}

export function decodeSkuFromFilename(filename: string): string {
  // Simple percent-decoding
  try {
    return decodeURIComponent(filename);
  } catch {
    // Manual decode as fallback
    return filename.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
}

export function stripJsonExtension(filename: string): string {
  if (filename.endsWith('.json')) {
    return filename.slice(0, -5);
  }
  return filename;
}

export function skuToProductFilePath(sku: string): string {
  return `products/${encodeSkuForFilename(sku)}.json`;
}

export function productFilePathToSku(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath;
  const withoutExt = stripJsonExtension(basename);
  return decodeSkuFromFilename(withoutExt);
}
