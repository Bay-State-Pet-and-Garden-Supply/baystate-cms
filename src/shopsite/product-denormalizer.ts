import type { Product } from '@/shared/types';
import { sanitizeXml } from './xml-sanitizer';
import { isValidXmlTagName, escapeCdata } from './multipart-upload';

/**
 * Generate an HTML file name from a product name.
 * Slugifies the name, truncates to 80 chars, adds .html extension.
 */
function generateFileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) + '.html';
}

export interface DenormalizedResult {
  xml: string;
  warnings: string[];
}

/**
 * Denormalize a Product back into ShopSite product XML.
 * Preserves advanced blocks and unknown elements from original import.
 * Overlays changed core fields and custom fields.
 */
export function denormalizeProduct(product: Product): DenormalizedResult {
  const warnings: string[] = [];
  const lines: string[] = [];

  lines.push('<Product>');

  // Core identity
  lines.push(`  <SKU>${escapeXml(product.sku)}</SKU>`);

  // GTIN — read from customFields first, fall back to numeric SKU
  const gtinValue = product.customFields['GTIN']
    || product.customFields['GoogleGTIN']
    || (product.sku && /^\d{8,14}$/.test(product.sku) ? product.sku : null);
  if (gtinValue) {
    lines.push(`  <GTIN>${escapeXml(gtinValue)}</GTIN>`);
  }
  // GoogleGTIN — only emit when the product explicitly has a GoogleGTIN custom field
  // (never auto-generated from SKU; <GTIN> alone satisfies Google Shopping requirements)
  if (product.customFields['GoogleGTIN']) {
    lines.push(`  <GoogleGTIN>${escapeXml(product.customFields['GoogleGTIN'])}</GoogleGTIN>`);
  }

  lines.push(`  <Name>${escapeXml(product.core.name)}</Name>`);

  // FileName — product detail HTML page name, always slugged from product name
  // Never use the extractor's URL-derived filename; generate our own from the curated name.
  const fileName = generateFileName(product.core.name);
  lines.push(`  <FileName>${escapeXml(fileName)}</FileName>`);
  // Price / SaleAmount — omit entirely when null or empty (DTD marks both as optional)
  if (product.core.price != null && product.core.price !== '') {
    lines.push(`  <Price>${escapeXml(product.core.price)}</Price>`);
  }
  if (product.core.salePrice != null && product.core.salePrice !== '') {
    lines.push(`  <SaleAmount>${escapeXml(product.core.salePrice)}</SaleAmount>`);
  }

  // Description - escape CDATA terminators (omit empty)
  if (product.core.description) {
    lines.push(`  <ProductDescription><![CDATA[${escapeCdata(product.core.description)}]]></ProductDescription>`);
  }

  // MoreInformationText — sync from description when not already preserved
  if (product.core.description && !product.shopsite.preserved.unknownElements['MoreInformationText']) {
    lines.push(`  <MoreInformationText><![CDATA[${escapeCdata(product.core.description)}]]></MoreInformationText>`);
  }

  // Status
  lines.push(`  <ProductDisabled>${product.status === 'active' ? 'uncheck' : 'checked'}</ProductDisabled>`);

  // Taxable
  lines.push(`  <Taxable>${product.core.taxable ? 'checked' : 'uncheck'}</Taxable>`);

  // MinimumQuantity — required by ShopSite DTD
  lines.push('  <MinimumQuantity>0</MinimumQuantity>');

  // ProductType — default to Tangible for physical goods
  if (!product.customFields['ProductType'] && !product.shopsite.preserved.unknownElements['ProductType']) {
    lines.push('  <ProductType>Tangible</ProductType>');
  }

  // QuantityOnHand
  if (product.core.inventory.quantityOnHand != null) {
    lines.push(`  <QuantityOnHand>${product.core.inventory.quantityOnHand}</QuantityOnHand>`);
  }

  // Weight
  if (product.core.weight != null && product.core.weight !== '') {
    lines.push(`  <Weight>${escapeXml(product.core.weight)}</Weight>`);
  }

  // Availability
  if (product.core.availability) {
    lines.push(`  <Availability>${escapeXml(product.core.availability)}</Availability>`);
  }

  // Image
  if (product.core.media.primary) {
    lines.push(`  <Graphic>${escapeXml(product.core.media.primary)}</Graphic>`);
    if (!product.shopsite.preserved.unknownElements['MoreInformationGraphic']) {
      lines.push(`  <MoreInformationGraphic>${escapeXml(product.core.media.primary)}</MoreInformationGraphic>`);
    }
  } else {
    lines.push('  <Graphic>none</Graphic>');
    if (!product.shopsite.preserved.unknownElements['MoreInformationGraphic']) {
      lines.push('  <MoreInformationGraphic>none</MoreInformationGraphic>');
    }
  }

  // Additional images (up to 20 slots) — only emit when populated
  for (let i = 0; i < 20; i++) {
    const img = product.core.media.additional?.[i];
    if (img) {
      lines.push(`  <MoreInfoImage${i + 1}>${escapeXml(img)}</MoreInfoImage${i + 1}>`);
    }
  }

  // SEO - escape CDATA terminators
  if (product.core.seo.searchKeywords) {
    lines.push(`  <SearchKeywords><![CDATA[${escapeCdata(product.core.seo.searchKeywords)}]]></SearchKeywords>`);
  }

  // ProductField mappings from customFields - validate tag names
  for (const [field, value] of Object.entries(product.customFields)) {
    if (!value) continue;
    if (!isValidXmlTagName(field)) {
      warnings.push(`Skipping custom field "${field}" because it is not a valid XML tag name.`);
      continue;
    }
    if (field.startsWith('ProductField') && value) {
      lines.push(`  <${field}>${escapeXml(value)}</${field}>`);
    }
  }

  // Preserved advanced blocks — skip ProductOnPages (handled below with proper Name tags)
  const preserved = product.shopsite.preserved;
  for (const [blockName, blockXml] of Object.entries(preserved.advancedBlocks)) {
    if (blockName === 'ProductOnPages') continue;
    if (blockName === 'productOnPages') continue;
    lines.push(`  ${blockXml}`);
  }

  // Preserved unknown elements - validate tag names
  for (const [tag, rawValue] of Object.entries(preserved.unknownElements)) {
    if (tag === 'ProductOnPages') continue;
    if (tag === 'GTIN' || tag === 'GoogleGTIN' || tag === 'Google_GTIN') continue; // handled above
    if (!isValidXmlTagName(tag)) {
      warnings.push(`Skipping unknown element "${tag}" because it is not a valid XML tag name.`);
      continue;
    }
    const stringVal = rawValue != null ? String(rawValue) : '';
    if (stringVal) {
      lines.push(`  <${tag}>${escapeXml(stringVal)}</${tag}>`);
    }
  }

  // ProductOnPages — extract page names from any source, emit DTD-compliant <Name> children
  const pageNames = extractPageNames(product);
  if (pageNames.length > 0) {
    lines.push(`  <ProductOnPages>`);
    for (const pageName of pageNames) {
      lines.push(`    <Name>${escapeXml(pageName)}</Name>`);
    }
    lines.push(`  </ProductOnPages>`);
  }

  lines.push('</Product>');

  const rawXml = lines.join('\n');

  return {
    xml: sanitizeXml(rawXml),
    warnings,
  };
}

/**
 * Extract page names from any preserved ProductOnPages source and normalize them.
 * Handles multiple tag variants (Name, PageName, PageLink) to produce DTD-compliant output.
 */
function extractPageNames(product: Product): string[] {
  const names = new Set<string>();
  const preserved = product.shopsite.preserved;

  // 1. Check unknownElements (set by draft-promoter)
  const fromUnknown = preserved.unknownElements['ProductOnPages'];
  if (fromUnknown) {
    const raw = String(fromUnknown);
    // Extract from <Name>, <PageName>, or <PageLink> tags
    const tagRegex = /<(?:Name|PageName|PageLink)>([^<]*)<\/(?:Name|PageName|PageLink)>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(raw)) !== null) {
      const name = m[1].trim();
      if (name) names.add(name);
    }
    // Fallback: if no tags matched but there's text, try splitting by newlines
    if (names.size === 0) {
      const cleaned = raw.replace(/<[^>]+>/g, '').trim();
      if (cleaned) {
        for (const line of cleaned.split(/\n+/)) {
          const trimmed = line.trim();
          if (trimmed) names.add(trimmed);
        }
      }
    }
  }

  // 2. Check advancedBlocks (from original ShopSite import)
  const fromAdvanced = preserved.advancedBlocks['ProductOnPages'] || preserved.advancedBlocks['productOnPages'];
  if (fromAdvanced) {
    const tagRegex = /<(?:Name|PageName|PageLink)>([^<]*)<\/(?:Name|PageName|PageLink)>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(fromAdvanced)) !== null) {
      const name = m[1].trim();
      if (name) names.add(name);
    }
    // Fallback: extract product page references from raw elements
    if (names.size === 0) {
      const elemRegex = /<\w+[^>]*>([^<]+)<\/\w+>/g;
      let em: RegExpExecArray | null;
      while ((em = elemRegex.exec(fromAdvanced)) !== null) {
        const val = em[1].trim();
        if (val && !val.startsWith('<?') && !val.startsWith('<')) names.add(val);
      }
    }
  }

  return Array.from(names);
}

function escapeXml(str: string): string {

  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
