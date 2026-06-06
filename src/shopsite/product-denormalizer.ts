import type { Product } from '@/shared/types';
import { sanitizeXml } from './xml-sanitizer';
import { isValidXmlTagName, escapeCdata } from './multipart-upload';

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
  lines.push(`  <Name>${escapeXml(product.core.name)}</Name>`);
  if (product.core.price != null) {
    lines.push(`  <Price>${escapeXml(product.core.price)}</Price>`);
  } else {
    lines.push('  <Price></Price>');
  }
  if (product.core.salePrice != null) {
    lines.push(`  <SaleAmount>${escapeXml(product.core.salePrice)}</SaleAmount>`);
  } else {
    lines.push('  <SaleAmount></SaleAmount>');
  }

  // Description - escape CDATA terminators
  if (product.core.description) {
    lines.push(`  <ProductDescription><![CDATA[${escapeCdata(product.core.description)}]]></ProductDescription>`);
  } else {
    lines.push('  <ProductDescription></ProductDescription>');
  }

  // Status
  lines.push(`  <ProductDisabled>${product.status === 'active' ? 'uncheck' : 'checked'}</ProductDisabled>`);

  // Taxable
  lines.push(`  <Taxable>${product.core.taxable ? 'checked' : 'uncheck'}</Taxable>`);

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
    lines.push(`  <MoreInformationGraphic>${escapeXml(product.core.media.primary)}</MoreInformationGraphic>`);
  } else {
    lines.push('  <Graphic>none</Graphic>');
    lines.push('  <MoreInformationGraphic>none</MoreInformationGraphic>');
  }

  // Additional images
  for (let i = 0; i < product.core.media.additional.length && i < 20; i++) {
    lines.push(`  <MoreInfoImage${i + 1}>${escapeXml(product.core.media.additional[i])}</MoreInfoImage${i + 1}>`);
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

  // Preserved advanced blocks
  const preserved = product.shopsite.preserved;
  for (const [, blockXml] of Object.entries(preserved.advancedBlocks)) {
    lines.push(`  ${blockXml}`);
  }

  // Preserved unknown elements - validate tag names
  for (const [tag, rawValue] of Object.entries(preserved.unknownElements)) {
    if (tag === 'ProductOnPages') continue;
    if (!isValidXmlTagName(tag)) {
      warnings.push(`Skipping unknown element "${tag}" because it is not a valid XML tag name.`);
      continue;
    }
    const stringVal = rawValue != null ? String(rawValue) : '';
    if (stringVal) {
      lines.push(`  <${tag}>${escapeXml(stringVal)}</${tag}>`);
    }
  }

  // ProductOnPages - always include blank if no data
  if ('ProductOnPages' in preserved.unknownElements) {
    const pagesVal = preserved.unknownElements['ProductOnPages'];
    if (pagesVal) {
      lines.push(`  <ProductOnPages>${String(pagesVal)}</ProductOnPages>`);
    } else {
      lines.push('  <ProductOnPages></ProductOnPages>');
    }
  } else {
    lines.push('  <ProductOnPages></ProductOnPages>');
  }

  lines.push('</Product>');

  const rawXml = lines.join('\n');

  return {
    xml: sanitizeXml(rawXml),
    warnings,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
