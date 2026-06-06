import { XMLParser } from 'fast-xml-parser';

export interface ParsedProduct {
  rawXml: string;
  fields: Record<string, string | null>;
  unknownElements: Record<string, unknown>;
  advancedBlocks: Record<string, string>;
  hasAdvanced: boolean;
}

export interface ParsedProductList {
  productXmlVersion: string;
  products: ParsedProduct[];
}

/**
 * Parse a ShopSite Products XML document into parsed product records.
 * Generic - preserves unknown tags and advanced element blocks as-is.
 */
export function parseProductsXml(xmlText: string): ParsedProductList {
  const result: ParsedProductList = {
    productXmlVersion: '15.0',
    products: [],
  };

  // First pass: extract version from root
  const versionMatch = xmlText.match(/<ShopSiteProducts[^>]*\sversion="([^"]+)"/i);
  if (versionMatch) {
    result.productXmlVersion = versionMatch[1];
  }

  // Extract individual product blocks for raw preservation
  const productBlocks: string[] = [];
  const productRegex = /<(?:product|Product)>([\s\S]*?)<\/(?:product|Product)>/gi;
  let match: RegExpExecArray | null;
  while ((match = productRegex.exec(xmlText)) !== null) {
    productBlocks.push(match[0]);
  }

  if (productBlocks.length === 0) {
    return result;
  }

  // Known core field tags
  const coreFields = new Set([
    'SKU', 'sku', 'Name', 'name', 'Price', 'price', 'SaleAmount', 'saleAmount',
    'ProductDescription', 'description', 'Weight', 'weight',
    'Graphic', 'MoreInformationGraphic',
    'QuantityOnHand', 'quantity_on_hand', 'Quantity',
    'ProductDisabled', 'productDisabled',
    'Taxable', 'MinimumQuantity',
    'SearchKeywords', 'Availability',
    'ProductID', 'ProductGUID',
    'GoogleGTIN',
  ]);

  // Advanced/block-level tags that should be preserved as whole blocks
  const blockTags = new Set([
    'Subproducts', 'subproducts',
    'ProductOptions', 'Options', 'options',
    'ProductOnPages', 'productOnPages',
  ]);

  for (const block of productBlocks) {
    const product: ParsedProduct = {
      rawXml: block,
      fields: {},
      unknownElements: {},
      advancedBlocks: {},
      hasAdvanced: false,
    };

    // Use fast-xml-parser for structured parsing
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      preserveOrder: false,
      trimValues: true,
      parseTagValue: false,
      isArray: () => false,
    });

    // Wrap in root for parsing
    const wrapped = `<Root>${block}</Root>`;
    let parsed: Record<string, unknown>;
    try {
      parsed = parser.parse(wrapped) as Record<string, unknown>;
    } catch {
      // Fall back to regex-based extraction for edge cases
      extractFieldsFallback(block, product);
      continue;
    }

    const root = parsed?.Root as Record<string, unknown> | undefined;
    if (!root) {
      extractFieldsFallback(block, product);
      continue;
    }

    const productData = (root.Product ?? root.product ?? root) as Record<string, unknown>;

    for (const [tagName, tagValue] of Object.entries(productData)) {
      if (tagName.startsWith('@_')) continue;
      if (tagName === 'Product' || tagName === 'product') continue;

      if (blockTags.has(tagName)) {
        // Preserve as raw XML block
        const blockRegex = new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`, 'i');
        const blockMatch = block.match(blockRegex);
        if (blockMatch) {
          product.advancedBlocks[tagName] = blockMatch[0];
          product.hasAdvanced = true;
        }
        continue;
      }

      const stringValue = tagValue != null ? String(tagValue).trim() : null;

      if (coreFields.has(tagName)) {
        product.fields[tagName] = stringValue;
      } else {
        product.fields[tagName] = stringValue;
        product.unknownElements[tagName] = stringValue;
      }
    }

    result.products.push(product);
  }

  return result;
}

/**
 * Fallback regex-based field extraction for products that fail XML parsing.
 */
function extractFieldsFallback(xml: string, product: ParsedProduct): void {
  const fieldRegex = /<(\w+)>([^<]*)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRegex.exec(xml)) !== null) {
    const [, tag, value] = m;
    product.fields[tag] = value.trim() || null;
    product.unknownElements[tag] = value.trim() || null;
  }
}
