import { sanitizeXml } from './xml-sanitizer';
import { denormalizeProduct } from './product-denormalizer';
import type { Product } from '../shared/types';

/**
 * Build ShopSite XML document for a set of products.
 * Generates only the changed products, wrapped in ShopSiteProducts root.
 */
export function buildProductsXml(
  products: Product[],
  options?: { xmlVersion?: string; newProductTag?: string },
): string {
  const xmlVersion = options?.xmlVersion ?? '15.0';
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">');
  lines.push(`<ShopSiteProducts version="${escapeAttr(xmlVersion)}">`);
  lines.push('<Products>');

  for (const product of products) {
    lines.push(buildProductXml(product, options?.newProductTag));
  }

  lines.push('</Products>');
  lines.push('</ShopSiteProducts>');

  return sanitizeXml(lines.join('\n'));
}

/**
 * Build a single Product XML element from the normalized Product model.
 * Uses the denormalizer for the product block.
 */
function buildProductXml(product: Product, _newProductTag?: string): string {
  const result = denormalizeProduct(product);
  return result.xml;
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
