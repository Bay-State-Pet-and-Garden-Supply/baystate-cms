/**
 * XML sanitization for ShopSite data.
 * Handles unencoded ampersands, HTML entities that break XML parsers, etc.
 * Based on observed ShopSite export patterns but kept generic.
 */

export function sanitizeXml(xml: string): string {
  if (!xml) return '';

  let sanitized = xml;

  // Fix unencoded ampersands not followed by an entity pattern
  sanitized = sanitized.replace(/&(?![a-zA-Z0-9#]+;)/g, '&amp;');

  // Replace common HTML entities that break XML parsing
  const htmlEntities: Record<string, string> = {
    '&nbsp;': '&#160;',
    '&copy;': '&#169;',
    '&reg;': '&#174;',
    '&trade;': '&#8482;',
    '&bull;': '&#8226;',
    '&hellip;': '&#8230;',
    '&ndash;': '&#8211;',
    '&mdash;': '&#8212;',
    '&lsquo;': '&#8216;',
    '&rsquo;': '&#8217;',
    '&ldquo;': '&#8220;',
    '&rdquo;': '&#8221;',
    '&middot;': '&#183;',
    '&deg;': '&#176;',
    '&uuml;': '&#252;',
  };

  for (const [entity, replacement] of Object.entries(htmlEntities)) {
    sanitized = sanitized.split(entity).join(replacement);
  }

  return sanitized;
}
